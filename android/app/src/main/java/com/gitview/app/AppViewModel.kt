package com.gitview.app

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.gitview.app.data.BridgeApi
import com.gitview.app.data.BridgeClient
import com.gitview.app.data.CommitSummary
import com.gitview.app.data.Connection
import com.gitview.app.data.ConnectionStore
import com.gitview.app.data.PermissionProfile
import com.gitview.app.data.RepoSummary
import com.gitview.app.data.ServerEvent
import com.gitview.app.data.SessionProvider
import com.gitview.app.data.TreeEntry
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import java.util.UUID

enum class Screen { CONNECTIONS, REPOS, BROWSE, CHAT }

data class ChatMessage(val role: String, val text: String, val streaming: Boolean = false)

/** A row in the flattened, lazily-expanded explorer tree. */
data class TreeNode(
    val path: String,
    val name: String,
    val isDir: Boolean,
    val depth: Int,
    val expanded: Boolean = false,
    val loading: Boolean = false,
)

/** An open editor tab. */
data class OpenFile(
    val path: String,
    val content: String,
    val binary: Boolean,
    val dirty: Boolean = false,
)

data class UiState(
    val screen: Screen = Screen.CONNECTIONS,
    val connections: List<Connection> = emptyList(),
    val activeConnection: Connection? = null,
    val repos: List<RepoSummary> = emptyList(),
    val activeRepo: String? = null,
    val ref: String? = null,          // null => working tree (writable); non-null => historical (read-only)
    val nodes: List<TreeNode> = emptyList(),
    val openFiles: List<OpenFile> = emptyList(),
    val activePath: String? = null,
    val showExplorer: Boolean = true,
    val log: List<CommitSummary> = emptyList(),
    val chat: List<ChatMessage> = emptyList(),
    val profile: PermissionProfile = PermissionProfile.DEFAULT,
    val provider: SessionProvider = SessionProvider.LOCAL_SDK,
    val sessionId: String? = null,
    val costUsd: Double = 0.0,
    val busy: Boolean = false,
    val error: String? = null,
    val diffText: String? = null,     // non-null while the diff overlay is open
    val diffLabel: String = "",
) {
    val readOnly get() = ref != null
    val activeFile get() = openFiles.firstOrNull { it.path == activePath }
}

/**
 * Single source of UI state. Owns the REST [BridgeApi] and live [BridgeClient]. The browser is a
 * lazily-expanded explorer tree with multi-file editor tabs. Historical-ref reads are read-only;
 * writes act on the working tree (req. 5). Chat cost accumulates across resumes (total_cost_usd is
 * a per-query estimate, see docs/API.md §6.2).
 */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val store = ConnectionStore(app)
    private var api: BridgeApi? = null
    private var live: BridgeClient? = null

    var ui by mutableStateOf(UiState())
        private set

    init {
        store.dao.observeAll().onEach { ui = ui.copy(connections = it) }.launchIn(viewModelScope)
    }

    private fun fail(t: Throwable) { ui = ui.copy(error = t.message ?: t.toString(), busy = false) }
    fun clearError() { ui = ui.copy(error = null) }
    fun go(screen: Screen) { ui = ui.copy(screen = screen) }

    // ---- connections --------------------------------------------------------
    fun addConnection(name: String, baseUrl: String) = viewModelScope.launch {
        runCatching { store.dao.upsert(Connection(UUID.randomUUID().toString(), name, baseUrl)) }.onFailure(::fail)
    }

    fun selectConnection(conn: Connection) = viewModelScope.launch {
        val token = store.tokens.get(conn.id)
        api = BridgeApi(conn.baseUrl, token)
        ui = ui.copy(activeConnection = conn, error = null)
        if (token == null) ui = ui.copy(error = "PAIR_NEEDED") else loadRepos()
    }

    fun pair(code: String) = viewModelScope.launch {
        val conn = ui.activeConnection ?: return@launch
        val a = api ?: BridgeApi(conn.baseUrl, null).also { api = it }
        runCatching {
            val token = a.pair(code)
            store.tokens.put(conn.id, token); a.withToken(token); loadRepos()
        }.onFailure(::fail)
    }

    private suspend fun loadRepos() {
        val a = api ?: return
        runCatching { ui = ui.copy(repos = a.repos(), screen = Screen.REPOS, error = null) }.onFailure(::fail)
    }

    // ---- explorer -----------------------------------------------------------
    fun openRepo(repo: String) = viewModelScope.launch {
        ui = ui.copy(activeRepo = repo, ref = null, screen = Screen.BROWSE, showExplorer = true,
            openFiles = emptyList(), activePath = null, nodes = emptyList())
        loadRoot()
    }

    private suspend fun loadRoot() {
        val a = api ?: return; val repo = ui.activeRepo ?: return
        runCatching {
            val entries = a.tree(repo, "", ui.ref).entries
            ui = ui.copy(nodes = entries.map { it.toNode(0) })
        }.onFailure(::fail)
    }

    fun toggleDir(node: TreeNode) {
        val idx = ui.nodes.indexOfFirst { it.path == node.path }
        if (idx < 0) return
        if (node.expanded) {
            val prefix = "${node.path}/"
            val kept = ui.nodes.filterIndexed { i, n -> i <= idx || !n.path.startsWith(prefix) }.toMutableList()
            kept[idx] = node.copy(expanded = false)
            ui = ui.copy(nodes = kept)
        } else {
            val a = api ?: return; val repo = ui.activeRepo ?: return
            val marking = ui.nodes.toMutableList(); marking[idx] = node.copy(loading = true)
            ui = ui.copy(nodes = marking)
            viewModelScope.launch {
                runCatching {
                    val children = a.tree(repo, node.path, ui.ref).entries.map { it.toNode(node.depth + 1) }
                    val cur = ui.nodes.toMutableList()
                    val at = cur.indexOfFirst { it.path == node.path }
                    if (at >= 0) { cur[at] = node.copy(expanded = true, loading = false); cur.addAll(at + 1, children) }
                    ui = ui.copy(nodes = cur)
                }.onFailure(::fail)
            }
        }
    }

    fun openFile(node: TreeNode) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching {
            val existing = ui.openFiles.firstOrNull { it.path == node.path }
            if (existing == null) {
                val blob = a.blob(repo, node.path, ui.ref)
                val of = OpenFile(node.path, if (blob.binary) "" else blob.content, blob.binary)
                ui = ui.copy(openFiles = ui.openFiles + of, activePath = node.path, showExplorer = false)
            } else {
                ui = ui.copy(activePath = node.path, showExplorer = false)
            }
        }.onFailure(::fail)
    }

    fun toggleExplorer() { ui = ui.copy(showExplorer = !ui.showExplorer) }
    fun selectTab(path: String) { ui = ui.copy(activePath = path, showExplorer = false) }

    fun closeTab(path: String) {
        val remaining = ui.openFiles.filterNot { it.path == path }
        val newActive = if (ui.activePath == path) remaining.lastOrNull()?.path else ui.activePath
        ui = ui.copy(openFiles = remaining, activePath = newActive, showExplorer = remaining.isEmpty())
    }

    fun editActive(text: String) {
        val path = ui.activePath ?: return
        ui = ui.copy(openFiles = ui.openFiles.map { if (it.path == path) it.copy(content = text, dirty = true) else it })
    }

    /** Cheap first-edit marker from the editor (no content copy, idempotent). */
    fun markActiveDirty() {
        val path = ui.activePath ?: return
        if (ui.openFiles.any { it.path == path && !it.dirty }) {
            ui = ui.copy(openFiles = ui.openFiles.map { if (it.path == path) it.copy(dirty = true) else it })
        }
    }

    fun saveActive() = viewModelScope.launch {
        if (ui.readOnly) return@launch
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        val f = ui.activeFile ?: return@launch
        runCatching {
            a.saveFile(repo, f.path, f.content)
            ui = ui.copy(openFiles = ui.openFiles.map { if (it.path == f.path) it.copy(dirty = false) else it })
        }.onFailure(::fail)
    }

    fun commit(message: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.stage(repo, listOf(".")); a.commit(repo, message) }.onFailure(::fail)
    }

    /** Show the working-tree diff — for the open file if one is active, otherwise the whole tree. */
    fun showDiff() = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        val path = ui.activeFile?.path
        runCatching {
            val d = a.diff(repo, "worktree", null, path)
            ui = ui.copy(diffText = d, diffLabel = path ?: "working tree")
        }.onFailure(::fail)
    }

    fun closeDiff() { ui = ui.copy(diffText = null) }

    /** Switch between the writable working tree (null) and a historical, read-only ref. */
    fun setRef(ref: String?) { ui = ui.copy(ref = ref, openFiles = emptyList(), activePath = null); viewModelScope.launch { loadRoot() } }

    // ---- chat ---------------------------------------------------------------
    fun setProfile(p: PermissionProfile) { ui = ui.copy(profile = p) }
    fun setProvider(p: SessionProvider) { ui = ui.copy(provider = p) }

    fun connectLive() {
        val conn = ui.activeConnection ?: return
        val token = store.tokens.get(conn.id) ?: return
        live?.close()
        BridgeClient(conn.baseUrl, token).also { live = it }.connect().onEach(::onEvent).launchIn(viewModelScope)
    }

    fun sendPrompt(text: String) {
        val repo = ui.activeRepo ?: return
        if (live == null) connectLive()
        ui = ui.copy(chat = ui.chat + ChatMessage("user", text) + ChatMessage("assistant", "", streaming = true), busy = true)
        live?.sendPrompt(repo, ui.sessionId, ui.provider, ui.profile, text)
    }

    fun interrupt() { ui.sessionId?.let { live?.interrupt(it) } }

    private fun onEvent(e: ServerEvent) {
        ui = when (e) {
            is ServerEvent.SessionInit -> ui.copy(sessionId = e.sessionId)
            is ServerEvent.AssistantDelta -> ui.copy(chat = appendToStreaming(e.text))
            is ServerEvent.AssistantDone -> ui.copy(chat = finishStreaming())
            is ServerEvent.ToolUse -> ui.copy(chat = ui.chat + ChatMessage("tool", "→ ${e.name}"))
            is ServerEvent.ToolResult -> ui.copy(chat = ui.chat + ChatMessage("tool", "← ${e.name} ${if (e.ok) "ok" else "error"}"))
            is ServerEvent.Result -> ui.copy(busy = false, costUsd = ui.costUsd + (e.costUsd ?: 0.0), chat = finishStreaming())
            is ServerEvent.Error -> ui.copy(busy = false, error = e.message, chat = finishStreaming())
            else -> ui
        }
    }

    private fun appendToStreaming(delta: String): List<ChatMessage> {
        val msgs = ui.chat.toMutableList()
        val i = msgs.indexOfLast { it.role == "assistant" && it.streaming }
        if (i >= 0) msgs[i] = msgs[i].copy(text = msgs[i].text + delta)
        return msgs
    }

    private fun finishStreaming(): List<ChatMessage> = ui.chat.map { if (it.streaming) it.copy(streaming = false) else it }

    override fun onCleared() { live?.close() }
}

private fun TreeEntry.toNode(depth: Int) = TreeNode(path, name, isDir, depth)
