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
import com.gitview.app.data.ConnState
import com.gitview.app.data.Connection
import com.gitview.app.data.ConnectionStore
import com.gitview.app.data.PermissionProfile
import com.gitview.app.data.RepoSummary
import com.gitview.app.data.ServerEvent
import com.gitview.app.data.SessionProvider
import com.gitview.app.data.TreeEntry
import com.gitview.app.ui.chat.AssistantMsg
import com.gitview.app.ui.chat.ChatItem
import com.gitview.app.ui.chat.PendingPermission
import com.gitview.app.ui.chat.ToolActivity
import com.gitview.app.ui.chat.ToolStatus
import com.gitview.app.ui.chat.UserMsg
import com.gitview.app.ui.chat.toolEditDiff
import com.gitview.app.ui.chat.toolKindOf
import com.gitview.app.ui.chat.toolPath
import com.gitview.app.ui.chat.toolSubtitle
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.UUID
import java.util.concurrent.TimeUnit

enum class Screen { CONNECTIONS, REPOS, WORKSPACE }

/** Phone Workspace segment: Files (tree/editor) vs Chat. Tablet shows both at once (draggable split). */
enum class WorkspacePane { FILES, CHAT }

/** How many recent commits the history screen requests; a footer flags when the list is capped. */
internal const val LOG_LIMIT = 100

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
    val loading: Boolean = false, // blob fetch in flight → editor shows a gutter skeleton
)

/** Live reachability of a saved bridge — round-trip time of `GET /health`, refreshed while visible. */
data class Reachability(
    val online: Boolean = false,
    val latencyMs: Long? = null,
    val checkedAt: Long = 0L,     // epoch millis of the last probe (0 => never)
    val checking: Boolean = false, // a probe is in flight (drives the "…" affordance)
)

data class UiState(
    val screen: Screen = Screen.CONNECTIONS,
    val connections: List<Connection> = emptyList(),
    val reachability: Map<String, Reachability> = emptyMap(), // by connection id
    val activeConnection: Connection? = null,
    val repos: List<RepoSummary> = emptyList(),
    val activeRepo: String? = null,
    val ref: String? = null,          // null => working tree (writable); non-null => historical (read-only)
    val nodes: List<TreeNode> = emptyList(),
    val openFiles: List<OpenFile> = emptyList(),
    val activePath: String? = null,
    val showExplorer: Boolean = true,
    val activePane: WorkspacePane = WorkspacePane.FILES, // phone segment
    val treeRatio: Float = 0.22f,        // tablet tree:(editor+chat) divider (persisted)
    val splitRatio: Float = 0.55f,       // tablet editor:chat divider (persisted)
    val branches: List<String> = emptyList(),
    val currentBranch: String? = null,   // HEAD branch (from refs)
    val historyOpen: Boolean = false,    // History overlay visible (opens immediately, then loads)
    val logOverlay: List<CommitSummary>? = null, // commit data once loaded (null while logLoading)
    val commitOpen: Boolean = false,     // Commit overlay
    val transcript: List<ChatItem> = emptyList(),
    val profile: PermissionProfile = PermissionProfile.DEFAULT,
    val provider: SessionProvider = SessionProvider.LOCAL_SDK,
    val sessionId: String? = null,
    val costUsd: Double = 0.0,          // running session total (accumulated across turns/resumes)
    val turnCostUsd: Double = 0.0,      // cost of the most recent turn
    val budgetUsd: Double? = null,      // soft cap echoed by the bridge (session.init)
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,       // transient success message (snackbar)
    val diffOpen: Boolean = false,    // Diff overlay visible (opens immediately, then loads)
    val diffText: String? = null,     // diff data once loaded (null while diffLoading)
    val diffLabel: String = "",
    val diffKind: String = "worktree", // remembered so a live repo.changed can refresh the overlay
    val diffRef: String? = null,
    val renameTarget: TreeNode? = null, // non-null while the rename dialog is open
    val deleteTarget: TreeNode? = null, // non-null while the delete-confirm dialog is open
    // ---- step 7: states ----
    val connState: ConnState? = null,    // live-channel state (null = no channel yet); drives reconnect banner
    val reposLoading: Boolean = false,   // repos list fetch in flight
    val reposError: Boolean = false,     // repos fetch failed → inline Retry
    val treeLoading: Boolean = false,    // explorer root load in flight
    val treeError: Boolean = false,      // root load failed → inline Retry
    val openingPath: String? = null,     // a file whose blob is being fetched (loading tab)
    val logLoading: Boolean = false,     // History overlay data in flight
    val logError: Boolean = false,
    val diffLoading: Boolean = false,    // Diff overlay data in flight
    val diffError: Boolean = false,
    val conflictPaths: Set<String> = emptySet(), // open+dirty files changed on disk → save-conflict bar
    val pairing: Boolean = false,        // pair request in flight
    val pairError: String? = null,       // bad code → shown inline, dialog stays open
) {
    // Editing is locked when viewing history OR when the live channel is down (spec: offline → read-only,
    // buffer preserved). The reconnect banner explains why; the unsaved buffer stays in openFiles.
    val disconnected get() = connState == ConnState.DISCONNECTED || connState == ConnState.RECONNECTING
    val readOnly get() = ref != null || disconnected
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
    private val wsPrefs = app.getSharedPreferences("gitview_workspace", android.content.Context.MODE_PRIVATE)
    private var api: BridgeApi? = null
    private var live: BridgeClient? = null

    // Short-timeout client for reachability probes so an unreachable bridge fails fast (the default
    // client's 15s connect timeout is for real work, not a status poll).
    private val probeClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build()
    private var reachJob: Job? = null

    var ui by mutableStateOf(UiState(
        treeRatio = wsPrefs.getFloat("tree", 0.22f),
        splitRatio = wsPrefs.getFloat("split", 0.55f),
    ))
        private set

    // Chat streaming state. The full assistant text accumulates in [streamBuf]; what's PUBLISHED to
    // the transcript is every delta on Standard, but only completed lines on E-Ink (avoid ghosting).
    private var displayEink = false
    private val streamBuf = StringBuilder()
    private var streamMsgId: String? = null
    private var lastPublishedLen = 0

    init {
        store.dao.observeAll().onEach { ui = ui.copy(connections = it) }.launchIn(viewModelScope)
    }

    private fun fail(t: Throwable) { ui = ui.copy(error = t.message ?: t.toString(), busy = false) }
    fun clearError() { ui = ui.copy(error = null, pairError = null) } // dismiss also resets the pairing dialog
    fun clearNotice() { ui = ui.copy(notice = null) }
    fun go(screen: Screen) { ui = ui.copy(screen = screen) }

    /** Persist the tablet editor:chat split ratio (0..1). */
    fun setSplitRatio(ratio: Float) {
        val r = ratio.coerceIn(0.25f, 0.8f)
        ui = ui.copy(splitRatio = r)
        wsPrefs.edit().putFloat("split", r).apply()
    }

    /** Persist the tablet tree:(editor+chat) ratio (0..1). */
    fun setTreeRatio(ratio: Float) {
        val r = ratio.coerceIn(0.12f, 0.4f)
        ui = ui.copy(treeRatio = r)
        wsPrefs.edit().putFloat("tree", r).apply()
    }

    // ---- connections --------------------------------------------------------
    fun addConnection(name: String, baseUrl: String) = viewModelScope.launch {
        runCatching {
            val c = Connection(UUID.randomUUID().toString(), name, baseUrl)
            store.dao.upsert(c); pingOne(c) // probe the new bridge immediately
        }.onFailure(::fail)
    }

    fun selectConnection(conn: Connection) = viewModelScope.launch {
        val token = store.tokens.get(conn.id)
        api = BridgeApi(conn.baseUrl, token)
        runCatching { store.dao.touch(conn.id, System.currentTimeMillis()) } // "used just now"
        ui = ui.copy(activeConnection = conn, provider = conn.provider, error = null)
        if (token == null) ui = ui.copy(error = "PAIR_NEEDED") else loadRepos()
    }

    /** Per-bridge Remote-control / Local-SDK toggle on the Connections screen (persisted). */
    fun setConnectionProvider(conn: Connection, p: SessionProvider) = viewModelScope.launch {
        runCatching { store.dao.setProvider(conn.id, p) }.onFailure(::fail)
        if (ui.activeConnection?.id == conn.id) ui = ui.copy(provider = p)
    }

    // ---- reachability -------------------------------------------------------
    /** Poll every saved bridge's `/health` while the Connections screen is visible (start on enter). */
    fun startReachabilityPolling() {
        if (reachJob?.isActive == true) return
        reachJob = viewModelScope.launch {
            while (isActive) { pingAll(); delay(15_000) }
        }
    }

    fun stopReachabilityPolling() { reachJob?.cancel(); reachJob = null }

    /** Manual "Retry" on one bridge's status row. */
    fun retryReachability(conn: Connection) = viewModelScope.launch { pingOne(conn) }

    private suspend fun pingAll() = coroutineScope {
        ui.connections.map { c -> async { pingOne(c) } }.awaitAll()
    }

    /** Time a `GET /health` round-trip; record online/latency without touching the token store's auth. */
    private suspend fun pingOne(conn: Connection) {
        setReach(conn.id) { it.copy(checking = true) }
        val probe = BridgeApi(conn.baseUrl, null, probeClient)
        val start = android.os.SystemClock.elapsedRealtime()
        val ok = runCatching { probe.health().ok }.getOrDefault(false)
        val latency = android.os.SystemClock.elapsedRealtime() - start
        ui = ui.copy(reachability = ui.reachability + (conn.id to Reachability(
            online = ok, latencyMs = if (ok) latency else null,
            checkedAt = System.currentTimeMillis(), checking = false,
        )))
    }

    private fun setReach(id: String, f: (Reachability) -> Reachability) {
        ui = ui.copy(reachability = ui.reachability + (id to f(ui.reachability[id] ?: Reachability())))
    }

    fun pair(code: String) = viewModelScope.launch {
        val conn = ui.activeConnection ?: return@launch
        val a = api ?: BridgeApi(conn.baseUrl, null).also { api = it }
        ui = ui.copy(pairing = true, pairError = null)
        runCatching { a.pair(code) }
            .onSuccess { token ->
                store.tokens.put(conn.id, token); a.withToken(token)
                ui = ui.copy(pairing = false, error = null) // clears the PAIR_NEEDED sentinel → dialog closes
                loadRepos()
            }
            .onFailure { // keep error = PAIR_NEEDED so the dialog STAYS open with an inline message
                ui = ui.copy(pairing = false, pairError = it.message ?: "Pairing failed")
            }
    }

    private suspend fun loadRepos() {
        val a = api ?: return
        // Navigate to Repos immediately and show a loading skeleton; on failure the screen shows an
        // inline Retry (not just a snackbar over a blank list).
        ui = ui.copy(screen = Screen.REPOS, reposLoading = true, reposError = false, error = null)
        runCatching { a.repos() }
            .onSuccess { ui = ui.copy(repos = it, reposLoading = false) }
            .onFailure { ui = ui.copy(reposLoading = false, reposError = true); fail(it) }
    }

    /** Inline "Retry" on the Repos screen's error state. */
    fun retryRepos() = viewModelScope.launch { loadRepos() }

    // ---- explorer -----------------------------------------------------------
    fun openRepo(repo: String) = viewModelScope.launch {
        ui = ui.copy(activeRepo = repo, ref = null, screen = Screen.WORKSPACE, showExplorer = true,
            activePane = WorkspacePane.FILES, openFiles = emptyList(), activePath = null, nodes = emptyList())
        if (live == null) connectLive() // subscribe to repo.changed while browsing, not just in chat
        loadRoot()
        loadRefs()
    }

    /** Load the branch list + current HEAD for the branch picker. */
    private suspend fun loadRefs() {
        val a = api ?: return; val repo = ui.activeRepo ?: return
        runCatching {
            val refs = a.refs(repo)
            ui = ui.copy(branches = refs.branches, currentBranch = refs.head)
        }
    }

    fun setActivePane(pane: WorkspacePane) { ui = ui.copy(activePane = pane) }

    private suspend fun loadRoot() {
        val a = api ?: return; val repo = ui.activeRepo ?: return
        ui = ui.copy(treeLoading = true, treeError = false)
        runCatching { a.tree(repo, "", ui.ref).entries }
            .onSuccess { ui = ui.copy(nodes = it.map { e -> e.toNode(0) }, treeLoading = false) }
            .onFailure { ui = ui.copy(treeLoading = false, treeError = true); fail(it) }
    }

    /** Inline "Retry" on the explorer's root-load error state. */
    fun retryRoot() = viewModelScope.launch { loadRoot() }

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
        if (ui.openFiles.any { it.path == node.path }) { // already open — just focus it
            ui = ui.copy(activePath = node.path, showExplorer = false); return@launch
        }
        // Open the tab NOW with a loading placeholder so a slow blob fetch gives immediate feedback;
        // the editor shows a gutter skeleton until bytes arrive (spec: "Sora mounts on bytes").
        ui = ui.copy(openFiles = ui.openFiles + OpenFile(node.path, "", binary = false, loading = true),
            activePath = node.path, showExplorer = false)
        runCatching { a.blob(repo, node.path, ui.ref) }
            .onSuccess { blob ->
                ui = ui.copy(openFiles = ui.openFiles.map {
                    if (it.path == node.path) OpenFile(node.path, if (blob.binary) "" else blob.content, blob.binary) else it
                })
            }
            .onFailure {
                // drop the placeholder tab so it isn't stuck "loading"
                val remaining = ui.openFiles.filterNot { f -> f.path == node.path }
                ui = ui.copy(openFiles = remaining, activePath = remaining.lastOrNull()?.path,
                    showExplorer = remaining.isEmpty())
                fail(it)
            }
    }

    fun toggleExplorer() { ui = ui.copy(showExplorer = !ui.showExplorer) }
    fun selectTab(path: String) { ui = ui.copy(activePath = path, showExplorer = false) }

    fun closeTab(path: String) {
        val remaining = ui.openFiles.filterNot { it.path == path }
        val newActive = if (ui.activePath == path) remaining.lastOrNull()?.path else ui.activePath
        ui = ui.copy(openFiles = remaining, activePath = newActive, showExplorer = remaining.isEmpty())
    }

    // ---- rename / delete ----------------------------------------------------
    fun requestRename(node: TreeNode) { ui = ui.copy(renameTarget = node) }
    fun requestDelete(node: TreeNode) { ui = ui.copy(deleteTarget = node) }
    fun dismissNodeAction() { ui = ui.copy(renameTarget = null, deleteTarget = null) }

    /** Rename [node] to [newName] within its own directory; updates the tree + open tabs in place. */
    fun renameNode(node: TreeNode, newName: String) = viewModelScope.launch {
        ui = ui.copy(renameTarget = null) // close the dialog now so a double-tap can't re-fire
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        val clean = newName.trim()
        if (clean.isEmpty() || clean.contains('/') || clean == node.name) return@launch
        val parent = node.path.substringBeforeLast('/', "")
        val to = if (parent.isEmpty()) clean else "$parent/$clean"
        // Refuse a collision client-side (instant feedback + no duplicate tree/tab keys). The bridge
        // also refuses so a name that collides only with an unloaded/collapsed sibling can't clobber.
        if (ui.nodes.any { it.path == to } || ui.openFiles.any { it.path == to }) {
            ui = ui.copy(error = "\"$clean\" already exists"); return@launch
        }
        runCatching { a.rename(repo, node.path, to) }.onSuccess {
            val sub = "${node.path}/"
            fun remap(p: String) = if (p == node.path) to else if (p.startsWith(sub)) to + p.removePrefix(node.path) else p
            ui = ui.copy(
                nodes = ui.nodes.map { n -> if (n.path == node.path) n.copy(path = to, name = clean) else n.copy(path = remap(n.path)) },
                openFiles = ui.openFiles.map { f -> f.copy(path = remap(f.path)) },
                activePath = ui.activePath?.let(::remap),
            )
        }.onFailure(::fail)
    }

    /** Delete [node] (a file); drops it and its descendants from the tree + closes affected tabs. */
    fun deleteNode(node: TreeNode) = viewModelScope.launch {
        ui = ui.copy(deleteTarget = null) // close the dialog now so a double-tap can't re-fire
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.deleteFile(repo, node.path) }.onSuccess {
            val sub = "${node.path}/"
            fun affected(p: String) = p == node.path || p.startsWith(sub)
            val openFiles = ui.openFiles.filterNot { affected(it.path) }
            ui = ui.copy(
                nodes = ui.nodes.filterNot { affected(it.path) },
                openFiles = openFiles,
                activePath = if (ui.activePath != null && affected(ui.activePath!!)) openFiles.lastOrNull()?.path else ui.activePath,
            )
        }.onFailure(::fail)
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
            ui = ui.copy(
                openFiles = ui.openFiles.map { if (it.path == f.path) it.copy(dirty = false) else it },
                conflictPaths = ui.conflictPaths - f.path, // saving resolves the conflict
            )
        }.onFailure(::fail)
    }

    // ---- save conflict (external change to a dirty open file) ---------------
    /** Discard local edits and reload the on-disk version, clearing the conflict. */
    fun reloadConflict(path: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.blob(repo, path, null) }.onSuccess { blob ->
            ui = ui.copy(
                openFiles = ui.openFiles.map {
                    if (it.path == path) OpenFile(path, if (blob.binary) "" else blob.content, blob.binary) else it
                },
                conflictPaths = ui.conflictPaths - path,
            )
        }.onFailure(::fail)
    }

    /** Keep local edits and overwrite the on-disk version (a plain save), clearing the conflict. */
    fun overwriteConflict(path: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        val f = ui.openFiles.firstOrNull { it.path == path } ?: return@launch
        runCatching { a.saveFile(repo, path, f.content) }.onSuccess {
            ui = ui.copy(
                openFiles = ui.openFiles.map { if (it.path == path) it.copy(dirty = false) else it },
                conflictPaths = ui.conflictPaths - path,
            )
        }.onFailure(::fail)
    }

    fun openCommit() { ui = ui.copy(commitOpen = true) }
    fun closeCommit() { ui = ui.copy(commitOpen = false) }

    /** Stage everything and commit; closes the Commit overlay on success. */
    fun commit(message: String) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.stage(repo, listOf(".")); a.commit(repo, message) }
            .onSuccess { ui = ui.copy(commitOpen = false, notice = "Committed") }.onFailure(::fail)
    }

    /** Push the current branch to its upstream (uses the host's git credentials). */
    fun push() = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.push(repo) }.onSuccess { ui = ui.copy(notice = "Pushed ${ui.currentBranch.orEmpty()}".trim()) }.onFailure(::fail)
    }

    /** Real branch switch (or create). The bridge checkout emits repo.changed → tree/tabs refresh. */
    fun checkout(ref: String, create: Boolean = false) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        runCatching { a.checkout(repo, ref, create) }.onSuccess {
            ui = ui.copy(currentBranch = ref, openFiles = emptyList(), activePath = null, notice = "On $ref")
            loadRoot(); loadRefs()
        }.onFailure(::fail)
    }

    /** Show the working-tree diff — for the open file if one is active, otherwise the whole tree. */
    /**
     * Open the diff overlay for one of the three [com.gitview.app.data] diff kinds. `worktree`/
     * `staged` scope to the open file when there is one; `commit` shows the whole commit.
     */
    fun showDiff(kind: String = "worktree", ref: String? = null, label: String? = null) = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        val path = if (kind == "commit") null else ui.activeFile?.path
        val lbl = label ?: when {
            kind == "commit" -> ref?.take(7) ?: "commit"
            kind == "staged" && path != null -> "$path · staged"
            kind == "staged" -> "staged"
            path != null -> path
            else -> "working tree"
        }
        // Open the overlay NOW with a loading state, then fill — so a slow (or failing) fetch shows a
        // spinner/Retry inside the overlay instead of "nothing happened".
        ui = ui.copy(diffOpen = true, diffLoading = true, diffError = false, diffText = null,
            diffLabel = lbl, diffKind = kind, diffRef = ref, error = null)
        runCatching { a.diff(repo, kind, ref, path) }
            .onSuccess { ui = ui.copy(diffText = it, diffLoading = false) }
            .onFailure { ui = ui.copy(diffLoading = false, diffError = true); fail(it) }
    }

    /** Diff a specific commit against its first parent (bridge normalizes merges to 2-way). */
    fun showCommitDiff(c: CommitSummary) = showDiff("commit", c.oid, "${c.shortOid} · ${c.subject}")

    fun closeDiff() { ui = ui.copy(diffOpen = false, diffText = null) }

    /** Open (or refresh) the History overlay with the recent commit list. Opens immediately, then loads. */
    fun showHistory() = viewModelScope.launch {
        val a = api ?: return@launch; val repo = ui.activeRepo ?: return@launch
        ui = ui.copy(historyOpen = true, logLoading = true, logError = false, error = null)
        runCatching { a.log(repo, limit = LOG_LIMIT) }
            .onSuccess { ui = ui.copy(logOverlay = it, logLoading = false) }
            .onFailure { ui = ui.copy(logLoading = false, logError = true); fail(it) }
    }

    fun closeHistory() { ui = ui.copy(historyOpen = false, logOverlay = null) }

    /** Switch between the writable working tree (null) and a historical, read-only ref. */
    fun setRef(ref: String?) { ui = ui.copy(ref = ref, openFiles = emptyList(), activePath = null); viewModelScope.launch { loadRoot() } }

    // ---- chat ---------------------------------------------------------------
    fun setProfile(p: PermissionProfile) { ui = ui.copy(profile = p) }

    /** In-chat provider toggle; also persists to the active bridge so the Connections toggle agrees. */
    fun setProvider(p: SessionProvider) {
        ui = ui.copy(provider = p)
        ui.activeConnection?.let { c -> viewModelScope.launch { runCatching { store.dao.setProvider(c.id, p) } } }
    }

    fun connectLive() {
        val conn = ui.activeConnection ?: return
        val token = store.tokens.get(conn.id) ?: return
        live?.close()
        val client = BridgeClient(conn.baseUrl, token).also { live = it }
        // Reflect connection state for the reconnect banner + editor read-only lock; a drop mid-turn
        // loses the in-flight turn, so clear `busy` whenever we're not solidly CONNECTED.
        client.state.onEach { st ->
            ui = ui.copy(connState = st, busy = if (st == ConnState.CONNECTED) ui.busy else false)
        }.launchIn(viewModelScope)
        client.connect().onEach(::onEvent).launchIn(viewModelScope)
    }

    /** The active display profile drives per-line stream batching on E-Ink; set from the UI. */
    fun setDisplayEink(value: Boolean) { displayEink = value }

    fun sendPrompt(text: String) {
        val repo = ui.activeRepo ?: return
        if (live == null) connectLive()
        // Don't fire into a dropped socket (a silent no-op that would leave a stuck "Thinking…"); tell
        // the user to wait for the auto-reconnect instead.
        if (ui.disconnected) { ui = ui.copy(error = "Not connected — reconnecting…"); return }
        streamBuf.setLength(0); lastPublishedLen = 0
        val thinking = AssistantMsg(newId(), "", streaming = true)
        streamMsgId = thinking.id
        ui = ui.copy(transcript = ui.transcript + UserMsg(newId(), text) + thinking, busy = true, turnCostUsd = 0.0)
        live?.sendPrompt(repo, ui.sessionId, ui.provider, ui.profile, text)
    }

    fun interrupt() { ui.sessionId?.let { live?.interrupt(it) } }

    /** Expand/collapse a tool card. */
    fun toggleToolExpanded(id: String) {
        ui = ui.copy(transcript = ui.transcript.map {
            if (it is ToolActivity && it.id == id) it.copy(expanded = !it.expanded) else it
        })
    }

    private fun onEvent(e: ServerEvent) {
        when (e) {
            is ServerEvent.RepoChanged -> onRepoChanged(e)
            is ServerEvent.SessionInit -> ui = ui.copy(sessionId = e.sessionId, budgetUsd = e.maxBudgetUsd ?: ui.budgetUsd)
            is ServerEvent.AssistantDelta -> onDelta(e.text)
            is ServerEvent.AssistantDone -> finalizeStream()
            is ServerEvent.ToolUse -> onToolUse(e)
            is ServerEvent.ToolResult -> onToolResult(e)
            is ServerEvent.PermissionRequest -> onPermissionRequest(e)
            is ServerEvent.Result -> {
                finalizeStream()
                ui = ui.copy(busy = false, costUsd = ui.costUsd + (e.costUsd ?: 0.0), turnCostUsd = e.costUsd ?: ui.turnCostUsd)
            }
            is ServerEvent.Error -> { finalizeStream(); ui = ui.copy(busy = false, error = e.message) }
            else -> {}
        }
    }

    /**
     * A live `repo.changed` for the active repo: refresh what's on screen without touching unsaved
     * edits — the file tree (expansion preserved), the open diff overlay, the History list, and any
     * NON-dirty open file whose content changed on disk. Ignored for a read-only historical ref.
     */
    private fun onRepoChanged(e: ServerEvent.RepoChanged) {
        if (e.repo != ui.activeRepo || ui.ref != null) return
        val changed = e.paths.toSet()
        // A DIRTY open file that changed on disk is a save conflict — flag it (the editor shows a
        // reload/overwrite/diff bar); reloadChangedOpenFiles only refreshes NON-dirty files, so the
        // unsaved buffer is preserved.
        val newConflicts = ui.openFiles.filter { it.dirty && it.path in changed }.map { it.path }
        if (newConflicts.isNotEmpty()) ui = ui.copy(conflictPaths = ui.conflictPaths + newConflicts)
        viewModelScope.launch {
            refreshTree()
            reloadChangedOpenFiles(changed)
            if (ui.diffOpen) showDiff(ui.diffKind, ui.diffRef, ui.diffLabel)
            if (ui.historyOpen) showHistory()
            loadRefs() // HEAD may have moved (branch/commit)
        }
    }

    /** Rebuild the tree from the bridge, re-expanding the directories that were open. */
    private suspend fun refreshTree() {
        val a = api ?: return; val repo = ui.activeRepo ?: return
        val expanded = ui.nodes.filter { it.isDir && it.expanded }.map { it.path }.toSet()
        val out = ArrayList<TreeNode>()
        suspend fun addLevel(parent: String, depth: Int) {
            val entries = runCatching { a.tree(repo, parent, ui.ref).entries }.getOrElse { return }
            for (entry in entries) {
                val isExp = entry.isDir && entry.path in expanded
                out.add(entry.toNode(depth).copy(expanded = isExp))
                if (isExp) addLevel(entry.path, depth + 1)
            }
        }
        addLevel("", 0)
        ui = ui.copy(nodes = out)
    }

    /** Re-read the content of open, non-dirty, non-binary files whose paths changed on disk. */
    private suspend fun reloadChangedOpenFiles(changed: Set<String>) {
        val a = api ?: return; val repo = ui.activeRepo ?: return
        val targets = ui.openFiles.filter { !it.dirty && !it.binary && it.path in changed }
        for (f in targets) {
            runCatching {
                val blob = a.blob(repo, f.path, null)
                if (!blob.binary) {
                    ui = ui.copy(openFiles = ui.openFiles.map {
                        // re-check dirty: the user may have started editing during the fetch
                        if (it.path == f.path && !it.dirty) it.copy(content = blob.content) else it
                    })
                }
            }
        }
    }

    /**
     * Append a streaming delta to the active assistant bubble (creating one if a tool card closed the
     * previous turn). On E-Ink only completed lines are published, so the panel repaints per line, not
     * per token; the un-published tail stays buffered until a newline arrives or the stream finalizes.
     */
    private fun onDelta(delta: String) {
        streamBuf.append(delta)
        val id = streamMsgId ?: AssistantMsg(newId(), "", streaming = true).let { m ->
            streamMsgId = m.id; lastPublishedLen = 0
            ui = ui.copy(transcript = ui.transcript + m)
            m.id
        }
        val publish = if (displayEink) streamBuf.substringBeforeLastNewline() else streamBuf.toString()
        if (displayEink && publish.length == lastPublishedLen) return // no new complete line — skip repaint
        lastPublishedLen = publish.length
        ui = ui.copy(transcript = ui.transcript.map {
            if (it.id == id && it is AssistantMsg) it.copy(text = publish, streaming = true) else it
        })
    }

    /** Flush the buffered stream into its bubble and mark it done; drop a bubble left empty by a tool-only turn. */
    private fun finalizeStream() {
        val id = streamMsgId ?: return
        val full = streamBuf.toString()
        ui = ui.copy(transcript = ui.transcript.mapNotNull {
            when {
                it.id != id -> it
                it is AssistantMsg && full.isBlank() -> null
                it is AssistantMsg -> it.copy(text = full, streaming = false)
                else -> it
            }
        })
        streamBuf.setLength(0); streamMsgId = null; lastPublishedLen = 0
    }

    private fun onToolUse(e: ServerEvent.ToolUse) {
        finalizeStream() // close any assistant text before the tool card
        val kind = toolKindOf(e.name)
        val path = toolPath(e.input)
        val card = ToolActivity(
            id = e.id.ifBlank { newId() }, kind = kind, name = e.name, path = path,
            subtitle = toolSubtitle(kind, e.input), editDiff = toolEditDiff(kind, path, e.input),
            status = ToolStatus.RUNNING, badge = null, preview = null,
        )
        ui = ui.copy(transcript = ui.transcript + card)
    }

    /** Complete the matching running tool card (by id; falls back to the oldest running one). */
    private fun onToolResult(e: ServerEvent.ToolResult) {
        val matchesById = ui.transcript.any { it is ToolActivity && it.id == e.id && it.status == ToolStatus.RUNNING }
        var applied = false
        ui = ui.copy(transcript = ui.transcript.map { item ->
            if (!applied && item is ToolActivity && item.status == ToolStatus.RUNNING &&
                (if (matchesById) item.id == e.id else true)) {
                applied = true
                item.copy(status = if (e.ok) ToolStatus.OK else ToolStatus.ERROR, badge = e.summary, preview = e.content)
            } else {
                item
            }
        })
    }

    /** The agent paused for approval (an interactive tier) — surface an inline gate card. */
    private fun onPermissionRequest(e: ServerEvent.PermissionRequest) {
        val kind = toolKindOf(e.tool)
        val path = toolPath(e.input)
        ui = ui.copy(
            transcript = ui.transcript + PendingPermission(
                id = e.requestId, kind = kind, name = e.tool, path = path,
                subtitle = toolSubtitle(kind, e.input), editDiff = toolEditDiff(kind, path, e.input),
            ),
        )
    }

    /**
     * Answer a pending permission gate. [scope] is "once" or "session"; an allowed "session" upgrades
     * the tier to Auto-edit (owner-confirmed) so future edits stop prompting.
     */
    fun resolvePermission(requestId: String, allow: Boolean, scope: String) {
        live?.sendPermissionResponse(requestId, allow, scope)
        ui = ui.copy(transcript = ui.transcript.filterNot { it is PendingPermission && it.id == requestId })
        if (allow && scope == "session") setProfile(PermissionProfile.ACCEPT_EDITS)
    }

    private fun newId() = UUID.randomUUID().toString()

    override fun onCleared() { live?.close() }
}

/** All complete lines in the buffer (everything up to the last newline); "" if none yet. */
private fun StringBuilder.substringBeforeLastNewline(): String {
    val i = lastIndexOf("\n")
    return if (i < 0) "" else substring(0, i)
}

private fun TreeEntry.toNode(depth: Int) = TreeNode(path, name, isDir, depth)
