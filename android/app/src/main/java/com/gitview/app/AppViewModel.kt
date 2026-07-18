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

data class UiState(
    val screen: Screen = Screen.CONNECTIONS,
    val connections: List<Connection> = emptyList(),
    val activeConnection: Connection? = null,
    val repos: List<RepoSummary> = emptyList(),
    val activeRepo: String? = null,
    val cwd: String = "",
    val tree: List<TreeEntry> = emptyList(),
    val openPath: String? = null,
    val openContent: String = "",
    val openBinary: Boolean = false,
    val ref: String? = null,          // null => working tree (writable); non-null => historical (read-only)
    val diff: String? = null,
    val log: List<CommitSummary> = emptyList(),
    val chat: List<ChatMessage> = emptyList(),
    val profile: PermissionProfile = PermissionProfile.DEFAULT,
    val provider: SessionProvider = SessionProvider.LOCAL_SDK,
    val sessionId: String? = null,
    val costUsd: Double = 0.0,
    val busy: Boolean = false,
    val error: String? = null,
) { val readOnly get() = ref != null }

/**
 * Single source of UI state. Owns the REST [BridgeApi] and live [BridgeClient] for the active
 * connection. Historical-ref reads are read-only; writes act on the working tree (req. 5). Chat cost
 * is accumulated across resumes because total_cost_usd is a per-query estimate (see docs/API.md §6.2).
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
        runCatching {
            val conn = Connection(id = UUID.randomUUID().toString(), name = name, baseUrl = baseUrl)
            store.dao.upsert(conn)
        }.onFailure(::fail)
    }

    fun selectConnection(conn: Connection) = viewModelScope.launch {
        val token = store.tokens.get(conn.id)
        api = BridgeApi(conn.baseUrl, token)
        ui = ui.copy(activeConnection = conn, error = null)
        if (token == null) { ui = ui.copy(error = "PAIR_NEEDED") } else loadRepos()
    }

    fun pair(code: String) = viewModelScope.launch {
        val conn = ui.activeConnection ?: return@launch
        val a = api ?: BridgeApi(conn.baseUrl, null).also { api = it }
        runCatching {
            val token = a.pair(code)
            store.tokens.put(conn.id, token)
            a.withToken(token)
            loadRepos()
        }.onFailure(::fail)
    }

    private suspend fun loadRepos() {
        val a = api ?: return
        runCatching { ui = ui.copy(repos = a.repos(), screen = Screen.REPOS, error = null) }.onFailure(::fail)
    }

    // ---- browse -------------------------------------------------------------
    fun openRepo(repo: String) = viewModelScope.launch {
        ui = ui.copy(activeRepo = repo, ref = null, screen = Screen.BROWSE)
        openDir("")
    }

    fun openDir(path: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching {
            val tree = a.tree(repo, path, ui.ref)
            ui = ui.copy(cwd = path, tree = tree.entries, openPath = null, error = null)
        }.onFailure(::fail)
    }

    fun openParent() { if (ui.cwd.isNotEmpty()) openDir(ui.cwd.substringBeforeLast('/', "")) }

    fun openFile(entry: TreeEntry) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching {
            val blob = a.blob(repo, entry.path, ui.ref)
            ui = ui.copy(openPath = entry.path, openContent = if (blob.binary) "" else blob.content, openBinary = blob.binary)
        }.onFailure(::fail)
    }

    fun editContent(text: String) { ui = ui.copy(openContent = text) }

    fun saveOpenFile() = viewModelScope.launch {
        if (ui.readOnly) return@launch
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch; val path = ui.openPath ?: return@launch
        runCatching { a.saveFile(repo, path, ui.openContent) }.onFailure(::fail)
    }

    fun commit(message: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.stage(repo, listOf(".")); a.commit(repo, message) }.onFailure(::fail)
    }

    fun loadLog() = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { ui = ui.copy(log = a.log(repo, ref = ui.ref)) }.onFailure(::fail)
    }

    fun loadDiff(path: String?) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { ui = ui.copy(diff = a.diff(repo, "worktree", null, path)) }.onFailure(::fail)
    }

    /** Switch between the writable working tree (null) and a historical, read-only ref. */
    fun setRef(ref: String?) { ui = ui.copy(ref = ref); openDir("") }

    // ---- chat ---------------------------------------------------------------
    fun setProfile(p: PermissionProfile) { ui = ui.copy(profile = p) }
    fun setProvider(p: SessionProvider) { ui = ui.copy(provider = p) }

    fun connectLive() {
        val conn = ui.activeConnection ?: return
        val token = store.tokens.get(conn.id) ?: return
        live?.close()
        val client = BridgeClient(conn.baseUrl, token).also { live = it }
        client.connect().onEach(::onEvent).launchIn(viewModelScope)
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

    private fun finishStreaming(): List<ChatMessage> =
        ui.chat.map { if (it.streaming) it.copy(streaming = false) else it }

    override fun onCleared() { live?.close() }
}
