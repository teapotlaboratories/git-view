package com.gitview.app.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.AppViewModel
import com.gitview.app.LOG_LIMIT
import com.gitview.app.Reachability
import com.gitview.app.Screen
import com.gitview.app.WorkspacePane
import com.gitview.app.data.CommitSummary
import com.gitview.app.ui.workspace.DraggableSplit
import com.gitview.app.data.Connection
import com.gitview.app.data.FsEntry
import com.gitview.app.data.FsRoot
import com.gitview.app.data.RepoSummary
import com.gitview.app.data.AgentInfo
import com.gitview.app.data.SessionInfo
import com.gitview.app.ui.eink.EinkPaginator
import com.gitview.app.ui.state.EmptyState
import com.gitview.app.ui.state.SkeletonCards
import com.gitview.app.ui.state.SkeletonLine
import com.gitview.app.ui.state.StatusBanner
import com.gitview.app.ui.chat.ChatTranscript
import com.gitview.app.ui.terminal.TerminalPane
import com.gitview.app.ui.chat.PendingPermission
import com.gitview.app.ui.chat.toolDisplayName
import com.gitview.app.ui.permission.ApprovalButtons
import com.gitview.app.ui.permission.CostBar
import com.gitview.app.ui.permission.TierList
import com.gitview.app.ui.theme.DisplayProfile
import com.gitview.app.ui.theme.DisplayProfileManager
import com.gitview.app.ui.theme.GitViewTheme

@Composable
fun AppRoot(vm: AppViewModel, profiles: DisplayProfileManager) {
    val ui = vm.ui
    val snackbar = remember { SnackbarHostState() }
    val eink = profiles.active.isEink
    // Per-line (not per-token) chat batching follows the "Reduce motion" toggle, not the profile —
    // an 80Hz E-Ink can stream per token; a calmed screen batches per line to cut repaints.
    val reduceMotion = profiles.settings.reduceMotion
    LaunchedEffect(reduceMotion) { vm.setDisplayEink(reduceMotion) }

    // System back navigates within the app (no top app bar); on the root screen it exits.
    BackHandler(enabled = ui.screen != Screen.CONNECTIONS) { vm.go(back(ui.screen)) }

    LaunchedEffect(ui.error) {
        val e = ui.error
        if (e != null && e != "PAIR_NEEDED") { snackbar.showSnackbar(e); vm.clearError() }
    }
    LaunchedEffect(ui.notice) {
        val n = ui.notice
        if (n != null) { snackbar.showSnackbar(n); vm.clearNotice() }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            // Live-channel loss: a reconnect banner in the workspace (editing goes read-only meanwhile,
            // buffer preserved — the editor's own read-only state handles that). Auto-reconnects.
            if (ui.disconnected && ui.screen == Screen.WORKSPACE) {
                StatusBanner("Connection lost — reconnecting…")
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            }
            when (ui.screen) {
                Screen.CONNECTIONS -> ConnectionsScreen(vm, profiles)
                Screen.REPOS -> ReposScreen(vm, profiles)
                Screen.WORKSPACE -> WorkspaceScaffold(vm, eink, profiles)
            }
        }
    }

    if (ui.error == "PAIR_NEEDED") PairingDialog(vm, onDismiss = vm::dismissPairing)
    if (ui.historyOpen) HistoryOverlay(vm)
    // DiffOverlay is composed AFTER HistoryOverlay so a commit diff opened from History draws ON TOP of it
    // (and its BackHandler wins) — closing the diff returns to the still-open History list.
    if (ui.diffOpen) DiffOverlay(vm)
    if (ui.commitOpen) CommitOverlay(vm)
    if (ui.viewingAttachment != null) AttachmentViewerOverlay(vm)
    ui.renameTarget?.let { n -> RenameDialog(n.name, n.isDir, onRename = { vm.renameNode(n, it) }, onDismiss = vm::dismissNodeAction) }
    ui.deleteTarget?.let { n -> DeleteConfirmDialog(n.name, onConfirm = { vm.deleteNode(n) }, onDismiss = vm::dismissNodeAction) }
    ui.createTarget?.let { t -> NewNodeDialog(t.isFolder, onCreate = { vm.createNode(t, it) }, onDismiss = vm::dismissNodeAction) }
    if (ui.showFolderBrowser) FolderBrowserOverlay(vm)
    if (ui.chatDialog) ChatSettingsDialog(vm, profiles, onDismiss = vm::closeChatSettings)
    if (ui.claudeDialog) ClaudeAgentDialog(vm)
    ui.pendingInit?.let { p ->
        GitInitDialog(
            onConfirm = { vm.ui.fsRoot?.let { r -> vm.openWorkspaceAt(r, p, initGit = true) } },
            onDismiss = vm::dismissPendingInit,
        )
    }
}

@Composable
private fun DiffOverlay(vm: AppViewModel) {
    val ui = vm.ui
    val diff = ui.diffText.orEmpty()
    val hasDiff = !ui.diffLoading && !ui.diffError && diff.isNotBlank()
    // Reset tree/jump/scroll state on the diff's IDENTITY, not its text — a same-diff refetch (e.g. an
    // auto-reconnect) churns diffText content→null→content and must not snap the tree closed or lose scroll.
    val diffId = "${ui.diffKind}|${ui.diffRef}|${ui.diffLabel}"
    // A commit diff (opened from History) lands on the file TREE first — you browse the changed files,
    // then tap one to see its diff. Working-tree/staged diffs open on the diff itself (tree via the toggle).
    var showTree by remember(diffId) { mutableStateOf(ui.diffKind == "commit") }
    var pendingJump by remember(diffId) { mutableStateOf<Int?>(null) }
    val listState = remember(diffId) { LazyListState() }
    // Back closes the file tree first (phone), then the whole overlay.
    BackHandler(enabled = true) { if (showTree) showTree = false else vm.closeDiff() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        // Overlays render outside the Scaffold's inset padding, so inset here or a bottom pager footer
        // hides behind the system nav bar.
        BoxWithConstraints(Modifier.fillMaxSize().systemBarsPadding()) {
            val wide = maxWidth >= 720.dp // tablet: tree + diff side by side; phone: tree toggles over the diff
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = vm::closeDiff, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                        Icon(Icons.Filled.Close, "close diff", tint = MaterialTheme.colorScheme.onSurface)
                    }
                    Text("Diff · ${ui.diffLabel}", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, modifier = Modifier.weight(1f))
                    // Phone-only "Files" tree toggle (the tablet shows the tree as a permanent side panel).
                    if (hasDiff && !wide) IconButton(onClick = { showTree = !showTree }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                        Icon(
                            Icons.AutoMirrored.Filled.List, if (showTree) "hide file tree" else "show file tree",
                            tint = if (showTree) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when {
                        ui.diffLoading -> SkeletonCards(6, Modifier.padding(12.dp))
                        ui.diffError -> EmptyState(
                            "Couldn't load the diff", subtitle = "The bridge didn't answer.",
                            actionLabel = "Retry", onAction = { vm.showDiff(ui.diffKind, ui.diffRef, ui.diffLabel) },
                        )
                        // Empty diff (e.g. a clean tree): "No changes", no file tree on any form factor.
                        !hasDiff -> DiffView(diff, Modifier.fillMaxSize())
                        wide -> Row(Modifier.fillMaxSize()) {
                            DiffFileTree(diff, onOpenFile = { pendingJump = it }, Modifier.width(300.dp).fillMaxHeight())
                            VerticalDivider(color = MaterialTheme.colorScheme.outline)
                            DiffView(diff, Modifier.weight(1f).fillMaxHeight(), listState, pendingJump) { pendingJump = null }
                        }
                        else -> {
                            // Phone: the diff stays mounted (keeps scroll state); the tree overlays it on toggle.
                            DiffView(diff, Modifier.fillMaxSize(), listState, pendingJump) { pendingJump = null }
                            if (showTree) DiffFileTree(
                                diff, onOpenFile = { pendingJump = it; showTree = false },
                                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The single slim bar per screen — replaces the old Material top app bar. */
@Composable
private fun ScreenBar(
    profiles: DisplayProfileManager,
    onBack: (() -> Unit)? = null,
    onClaudeSettings: (() -> Unit)? = null, // workspace-only extra item in the ⋮ menu
    onChatSettings: (() -> Unit)? = null,   // workspace-only: autonomy tier + cost meter
    leading: @Composable RowScope.() -> Unit = {},
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) IconButton(onClick = onBack, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "back", tint = MaterialTheme.colorScheme.onSurface)
        }
        leading()
        Spacer(Modifier.weight(1f))
        trailing()
        OverflowMenu(profiles, onClaudeSettings, onChatSettings)
    }
}

/**
 * The bar's trailing "⋮" menu. Holds the quick display-profile switch plus "Display settings…" (the
 * E-Ink comfort toggles) — moved out of the bar so the toolbar's action chips don't crowd it off a
 * narrow phone.
 */
@Composable
private fun OverflowMenu(
    profiles: DisplayProfileManager,
    onClaudeSettings: (() -> Unit)? = null,
    onChatSettings: (() -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.Filled.MoreVert, "more options", tint = MaterialTheme.colorScheme.onSurface)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val eink = profiles.active.isEink
            DropdownMenuItem(
                text = { Text(if (eink) "Switch to Standard display" else "Switch to E-Ink display") },
                onClick = {
                    open = false
                    profiles.setOverride(if (eink) DisplayProfile.STANDARD else DisplayProfile.COLOR_EINK)
                },
            )
            DropdownMenuItem(
                text = { Text("Display settings…") },
                onClick = { open = false; settingsOpen = true },
            )
            // Workspace-only: chat autonomy tier + cost meter.
            if (onChatSettings != null) {
                DropdownMenuItem(
                    text = { Text("Chat settings…") },
                    onClick = { open = false; onChatSettings() },
                )
            }
            // Workspace-only: configure the host agent's model + Claude credential.
            if (onClaudeSettings != null) {
                DropdownMenuItem(
                    text = { Text("Claude agent…") },
                    onClick = { open = false; onClaudeSettings() },
                )
            }
        }
    }
    if (settingsOpen) DisplaySettingsDialog(profiles, onDismiss = { settingsOpen = false })
}

/**
 * The E-Ink comfort toggles (pagination / calm editor / reduced motion). These are user settings, not
 * profile-forced — the Bigme B7 Pro is an 80Hz panel that handles scroll + motion, so they default OFF
 * and are opt-in (ADR-028). The E-Ink profile still owns 56dp targets, weight/underline, paper palette.
 */
@Composable
private fun DisplaySettingsDialog(profiles: DisplayProfileManager, onDismiss: () -> Unit) {
    val s = profiles.settings
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("Display settings") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "E-Ink comfort — off by default (the panel is 80Hz). Turn on for a calmer screen.",
                    fontSize = 12.sp, color = GitViewTheme.colors.textLow,
                )
                Spacer(Modifier.size(6.dp))
                SettingSwitch("Paginate long lists", "Page through chat & lists instead of scrolling",
                    s.paginate, profiles::setPaginate)
                SettingSwitch("Calm editor", "Page footer; no blinking caret or fling",
                    s.editorCalm, profiles::setEditorCalm)
                SettingSwitch("Reduce motion", "Still animations, ripple, and overscroll",
                    s.reduceMotion, profiles::setReduceMotion)
            }
        },
    )
}

/**
 * Chat settings — the agent's autonomy tier + the cost-meter toggle. Workspace-only (⋮ menu). The tier
 * picker is the full risk-metered [TierList] (moved out of the composer bar); the critical `Unrestricted`
 * tier still requires a long-press to select. Scrollable so the six tiers + toggle fit any screen.
 */
@Composable
private fun ChatSettingsDialog(vm: AppViewModel, profiles: DisplayProfileManager, onDismiss: () -> Unit) {
    val s = profiles.settings
    val col = GitViewTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
        title = { Text("Chat settings") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // Agent (chat provider) picker — Claude today; Codex etc. appear here once the bridge offers them.
                if (vm.ui.agents.isNotEmpty()) {
                    Text("Agent", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = col.textHi)
                    Text("Which AI drives the chat. Sessions are separate per agent.", fontSize = 12.sp, color = col.textLow)
                    Spacer(Modifier.size(2.dp))
                    vm.ui.agents.forEach { agent ->
                        AgentRow(agent, selected = agent.id == vm.ui.selectedAgent) { vm.setAgent(agent.id) }
                    }
                    HorizontalDivider(color = col.border, modifier = Modifier.padding(vertical = 8.dp))
                }
                Text("Autonomy", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = col.textHi)
                Text(
                    "How much Claude can do before asking. Higher tiers act with fewer prompts — hold to pick Unrestricted.",
                    fontSize = 12.sp, color = col.textLow,
                )
                Spacer(Modifier.size(2.dp))
                TierList(vm.ui.profile, onSelect = vm::setProfile)
                HorizontalDivider(color = col.border, modifier = Modifier.padding(vertical = 8.dp))
                SettingSwitch("Show cost meter", "The running Turn / Session cost under the chat",
                    s.showCost, profiles::setShowCost)
            }
        },
    )
}

/** One selectable chat-provider row in Chat settings. */
@Composable
private fun AgentRow(agent: AgentInfo, selected: Boolean, onSelect: () -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = GitViewTheme.spacing.touchTarget)
            .clickable(onClick = onSelect).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(agent.label, Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = col.textHi)
        if (selected) Icon(Icons.Filled.Check, "selected", Modifier.size(20.dp), tint = col.primary)
    }
}

@Composable
private fun SettingSwitch(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = GitViewTheme.spacing.touchTarget)
            .clickable { onChange(!checked) }.padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(subtitle, fontSize = 11.sp, color = GitViewTheme.colors.textLow)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/**
 * Human-friendly name for a model id: `claude-opus-4-8` → `Opus 4.8`, `claude-sonnet-5` → `Sonnet 5`.
 *
 * Derived rather than table-driven so a new model id reads correctly without a code change: drop the
 * vendor prefix, title-case the name words, and rejoin a TRAILING run of numeric segments with dots —
 * those are the version (`4-8` is 4.8), while interior dashes are word separators.
 *
 * The SDK does expose `ModelInfo.displayName`, but it is only reachable from a live `Query` handle
 * (`Query.supportedModels()`), it costs a CLI spawn, and it returns unversioned aliases — "Opus" for
 * `opus`, not "Opus 4.8" for a pinned id — so it cannot label this curated, version-pinned list.
 *
 * PURELY COSMETIC: the raw id is what state holds, what is sent to the bridge, and what
 * [MODEL_CHOICES] membership is tested against, so a relabel can never change the selected model.
 */
private fun modelLabel(id: String): String {
    val parts = id.removePrefix("claude-").split('-').filter { it.isNotEmpty() }
    if (parts.isEmpty()) return id
    val version = parts.takeLastWhile { it.all(Char::isDigit) }
    val words = parts.dropLast(version.size)
    // An all-numeric id has no name words — fall back to the digits rather than emitting "".
    if (words.isEmpty()) return version.joinToString(".")
    val name = words.joinToString(" ") { it.replaceFirstChar(Char::uppercase) }
    return if (version.isEmpty()) name else "$name ${version.joinToString(".")}"
}

/**
 * Human-friendly name for an effort level. Same cosmetic-only contract as [modelLabel] — the raw
 * wire value (`xhigh`) is what gets stored and sent; only the rendering changes.
 */
private fun effortLabel(level: String): String = when (level) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    "xhigh" -> "Extra high"
    "max" -> "Maximum"
    else -> level.replaceFirstChar(Char::uppercase)
}

/** Reasoning-effort levels the Agent SDK accepts (sdk.d.ts: EffortLevel). Support varies by model —
 *  `xhigh` is Opus 4.7 only and `max` is limited too; the SDK silently downgrades an unsupported level,
 *  and the Model field takes custom ids, so the app hints rather than filtering the list per model. */
private val EFFORT_CHOICES = listOf("low", "medium", "high", "xhigh", "max")

/** Common Claude models offered in the picker. The field also has a "Custom…" escape for any other id
 *  (and typing still works there), so this list going stale never blocks selecting a newer model. */
private val MODEL_CHOICES = listOf(
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-fable-5",
)

/**
 * Configure the host agent's Claude model + credential. Model empty = reset to the config default; the
 * 3-way auth selector maps to the wire modes host / api-key / subscription. The bridge never returns the
 * raw secret (only a masked [ClaudeSettings.hint]), so the fields never pre-fill a stored key. Themed via
 * GitViewTheme tokens; selection is carried by the SegmentedButton's shape/weight so it reads on E-Ink.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ClaudeAgentDialog(vm: AppViewModel) {
    val ui = vm.ui
    val col = GitViewTheme.colors
    val s = ui.claudeSettings

    // Initial GET still in flight (no data yet) → a small placeholder rather than an empty shell.
    if (s == null) {
        AlertDialog(
            onDismissRequest = vm::closeClaudeSettings,
            title = { Text("Claude agent") },
            text = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (ui.claudeBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Text(if (ui.claudeBusy) "Loading…" else "Couldn't load settings.", fontSize = 13.sp, color = col.textLow)
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = vm::closeClaudeSettings) { Text("Cancel") } },
        )
        return
    }

    // Pre-fill the Model field with the *override* only (empty when it just matches config), so saving a
    // credential without touching Model doesn't silently pin the model and defeat later config.yaml edits.
    var model by rememberSaveable(s.model) { mutableStateOf(if (s.model == s.configModel) "" else s.model) }
    // Model picker: a dropdown of known models + Default + Custom. `custom` reveals a free-text field for
    // any id not in the list; start there if a pinned override isn't a known choice.
    var custom by rememberSaveable(s.model) { mutableStateOf(model.isNotBlank() && model !in MODEL_CHOICES) }
    var modelMenu by remember { mutableStateOf(false) }
    // Effort: like Model, hold the OVERRIDE only ("" = follow the config default) so saving an unrelated
    // field can't silently pin a level and defeat later config.yaml edits.
    var effort by rememberSaveable(s.effort) {
        mutableStateOf(if (s.effort == null || s.effort == s.configEffort) "" else s.effort)
    }
    var effortMenu by remember { mutableStateOf(false) }
    var mode by rememberSaveable(s.auth) { mutableStateOf(s.auth) }
    // In-memory only (NOT rememberSaveable): the raw key/token must never land in the saved-instance Bundle.
    var secret by remember(s.auth) { mutableStateOf("") }
    // The pasted OAuth code is sensitive too — in-memory only, keyed on the login attempt so a new login clears it.
    var loginCode by remember(ui.claudeLogin.loginId) { mutableStateOf("") }
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current

    val modes = listOf("host" to "Host login", "api-key" to "API key", "subscription" to "Subscription token")
    // A PUT to api-key / subscription REQUIRES a non-blank secret (wire contract); guard so Save can't 400.
    val secretNeeded = mode != "host"
    val valid = !secretNeeded || secret.isNotBlank()

    AlertDialog(
        onDismissRequest = vm::closeClaudeSettings,
        title = { Text("Claude agent") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (custom) {
                    OutlinedTextField(
                        value = model, onValueChange = { model = it },
                        label = { Text("Model") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text(s.configModel, color = col.textLow) },
                        trailingIcon = {
                            // Back to the list WITHOUT discarding what was typed (the read-only field shows it).
                            IconButton(onClick = { custom = false }) {
                                Icon(Icons.Filled.ArrowDropDown, contentDescription = "choose from list")
                            }
                        },
                    )
                    Text("Custom model id  ·  leave empty to reset to ${s.configModel}", fontSize = 11.sp, color = col.textLow)
                } else {
                    Box {
                        OutlinedTextField(
                            value = if (model.isBlank()) "Default · ${modelLabel(s.configModel)}" else modelLabel(model),
                            onValueChange = {}, readOnly = true, singleLine = true,
                            label = { Text("Model") }, modifier = Modifier.fillMaxWidth(),
                            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = "choose model") },
                        )
                        // A read-only OutlinedTextField doesn't emit clicks — a transparent overlay opens the menu.
                        Box(Modifier.matchParentSize().clickable { modelMenu = true })
                        DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Default · ${modelLabel(s.configModel)}") },
                                onClick = { model = ""; modelMenu = false },
                            )
                            MODEL_CHOICES.forEach { m ->
                                DropdownMenuItem(text = { Text(modelLabel(m)) }, onClick = { model = m; modelMenu = false })
                            }
                            HorizontalDivider(color = col.border)
                            DropdownMenuItem(
                                // Keep the current value as the starting point to edit (don't wipe it).
                                text = { Text("Custom…") },
                                onClick = { custom = true; modelMenu = false },
                            )
                        }
                    }
                }

                Box {
                    OutlinedTextField(
                        value = if (effort.isBlank()) "Default · ${s.configEffort?.let(::effortLabel) ?: "Claude CLI default"}" else effortLabel(effort),
                        onValueChange = {}, readOnly = true, singleLine = true,
                        label = { Text("Effort") }, modifier = Modifier.fillMaxWidth(),
                        trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = "choose effort") },
                    )
                    // Read-only fields don't emit clicks — same transparent overlay trick as Model above.
                    Box(Modifier.matchParentSize().clickable { effortMenu = true })
                    DropdownMenu(expanded = effortMenu, onDismissRequest = { effortMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("Default · ${s.configEffort?.let(::effortLabel) ?: "Claude CLI default"}") },
                            onClick = { effort = ""; effortMenu = false },
                        )
                        EFFORT_CHOICES.forEach { e ->
                            DropdownMenuItem(text = { Text(effortLabel(e)) }, onClick = { effort = e; effortMenu = false })
                        }
                    }
                }
                Text(
                    "How much reasoning Claude applies  ·  Extra high / Maximum need a model that supports them",
                    fontSize = 11.sp, color = col.textLow,
                )

                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    modes.forEachIndexed { i, (value, label) ->
                        SegmentedButton(
                            selected = mode == value, onClick = { mode = value },
                            shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                        ) { Text(label, fontSize = 11.sp, maxLines = 1) }
                    }
                }

                when (mode) {
                    "host" -> {
                        val signedIn = if (s.host.credentials) "Signed in on the host ✓" else "No host login detected"
                        val envNote = if (s.host.apiKeyEnv) "  ·  ANTHROPIC_API_KEY set in bridge env" else ""
                        Text(
                            signedIn + envNote, fontSize = 12.sp,
                            fontWeight = if (col.hueless && s.host.credentials) FontWeight.SemiBold else FontWeight.Normal,
                            color = col.textMid,
                        )
                    }
                    "api-key" -> OutlinedTextField(
                        value = secret, onValueChange = { secret = it },
                        label = { Text("API key") }, placeholder = { Text("sk-ant-api…") },
                        singleLine = true, visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    "subscription" -> {
                        OutlinedTextField(
                            value = secret, onValueChange = { secret = it },
                            label = { Text("Subscription token") }, placeholder = { Text("sk-ant-oat…") },
                            singleLine = true, visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text("Run  claude setup-token  on the host and paste the token.",
                            fontSize = 11.sp, color = col.textLow)

                        // ---- "Log in with subscription" (PTY-driven OAuth) — an ADDITION to the manual paste. ----
                        val login = ui.claudeLogin
                        HorizontalDivider(color = col.border)
                        if (login.url == null) {
                            // Not started (or between attempts): a single button that kicks off the flow.
                            Button(
                                onClick = vm::startClaudeLogin,
                                enabled = !login.busy,
                                modifier = Modifier.fillMaxWidth().heightIn(min = GitViewTheme.spacing.touchTarget),
                            ) {
                                if (login.busy) {
                                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text("Log in with subscription")
                            }
                        } else {
                            // Awaiting the code: open/copy the URL, then paste + submit.
                            Text("Open this URL, approve, then paste the code:", fontSize = 12.sp, color = col.textMid)
                            Text(
                                login.url,
                                fontSize = 12.sp,
                                color = col.textMid,
                                textDecoration = TextDecoration.Underline,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = GitViewTheme.spacing.touchTarget)
                                    .clickable {
                                        runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(login.url))) }
                                    }
                                    .padding(vertical = 6.dp),
                            )
                            TextButton(onClick = { clipboard.setText(AnnotatedString(login.url)) }) { Text("Copy") }
                            OutlinedTextField(
                                value = loginCode, onValueChange = { loginCode = it },
                                label = { Text("Code") }, placeholder = { Text("Paste code") },
                                singleLine = true, modifier = Modifier.fillMaxWidth(),
                            )
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Button(
                                    onClick = { vm.submitClaudeLogin(loginCode) },
                                    enabled = !login.busy && loginCode.isNotBlank(),
                                ) {
                                    if (login.busy) {
                                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                        Spacer(Modifier.width(8.dp))
                                    }
                                    Text("Submit")
                                }
                                TextButton(onClick = vm::cancelClaudeLogin, enabled = !login.busy) { Text("Cancel") }
                            }
                        }
                        if (login.error != null) {
                            Text(
                                login.error, fontSize = 12.sp, color = col.remove,
                                fontWeight = if (col.hueless) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                    }
                }

                if (s.hint != null) {
                    Text("Current: ${s.auth} ${s.hint}", fontSize = 11.sp, color = col.textLow)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { vm.saveClaudeSettings(model.trim(), effort, mode, secret) },
                enabled = valid && !ui.claudeBusy,
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = vm::closeClaudeSettings) { Text("Cancel") } },
    )
}

@Composable
fun ConnectionsScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
    // Probe reachability only while this screen is visible (start on enter, stop on leave).
    DisposableEffect(Unit) {
        vm.startReachabilityPolling()
        onDispose { vm.stopReachabilityPolling() }
    }
    var adding by rememberSaveable { mutableStateOf(false) }
    var pendingRemove by remember { mutableStateOf<Connection?>(null) }
    Column(Modifier.fillMaxSize()) {
      ScreenBar(profiles, leading = { Text("GitView", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) })
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)
      Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
      Column(
        Modifier.widthIn(max = 640.dp).fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel("BRIDGES")
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(vm.ui.connections, key = { it.id }) { c ->
                BridgeCard(
                    c, vm.ui.reachability[c.id],
                    onSelect = { vm.selectConnection(c) },
                    onRetry = { vm.retryReachability(c) },
                    onRemove = { pendingRemove = c },
                )
            }
            if (vm.ui.connections.isEmpty()) item {
                Text("No bridges yet — add one below.", fontSize = 13.sp,
                    color = GitViewTheme.colors.textLow, modifier = Modifier.padding(vertical = 8.dp))
            }
        }
        if (adding) AddBridgeForm(onAdd = { n, u -> vm.addConnection(n, u); adding = false }, onCancel = { adding = false })
        else AddBridgeRow { adding = true }
      }
      }
    }
    pendingRemove?.let { c ->
        RemoveBridgeDialog(c.name, onConfirm = { vm.removeConnection(c); pendingRemove = null }, onDismiss = { pendingRemove = null })
    }
}

@Composable
private fun SectionLabel(text: String) =
    Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

/**
 * A saved bridge: live status (dot + latency), name, URL, and when it was last used. Tapping the card
 * selects it. Status/hue is suppressed on E-Ink (glyph shape + weight carry the meaning); latency +
 * retry stay text.
 */
@Composable
private fun BridgeCard(
    c: Connection, reach: Reachability?,
    onSelect: () -> Unit, onRetry: () -> Unit, onRemove: () -> Unit,
) {
    val col = GitViewTheme.colors
    Card(
        onClick = onSelect,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(start = 14.dp, top = 8.dp, end = 8.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(reach)
                Text(c.name, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(c.lastUsedAt?.let { "used ${relativeMillis(it)}" } ?: "never used",
                    fontSize = 11.sp, color = col.textLow, maxLines = 1)
                BridgeOverflow(onRemove = onRemove)
            }
            Text(c.baseUrl, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = col.textMid,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(statusLabel(reach), fontSize = 12.sp, color = col.textMid,
                    fontWeight = if (reach?.online == true) FontWeight.Medium else FontWeight.Normal, maxLines = 1)
                if (reach != null && !reach.online && !reach.checking && reach.checkedAt > 0L) {
                    Text("Retry", fontSize = 12.sp, fontWeight = FontWeight.Medium,
                        color = if (col.hueless) col.textHi else col.primary,
                        modifier = Modifier.clip(RoundedCornerShape(4.dp)).clickable(onClick = onRetry)
                            .padding(horizontal = 6.dp, vertical = 2.dp))
                }
            }
        }
    }
}

/** ●/○ status glyph — filled = online, hollow = offline, ◌ = never probed. Hued only off E-Ink. */
@Composable
private fun StatusDot(r: Reachability?) {
    val col = GitViewTheme.colors
    val (glyph, tint) = when {
        r == null || (r.checkedAt == 0L) -> "◌" to col.textLow
        r.online -> "●" to (if (col.hueless) col.textHi else col.add)
        else -> "○" to (if (col.hueless) col.textHi else col.warning)
    }
    Text(glyph, color = tint, fontSize = 13.sp)
}

private fun statusLabel(r: Reachability?): String = when {
    r == null -> "not checked"
    r.checkedAt == 0L -> if (r.checking) "checking…" else "not checked"
    r.online -> "online" + (r.latencyMs?.let { " · $it ms" } ?: "")
    else -> "offline"
}

/** Per-bridge overflow (⋮). Currently one action — Remove — which forgets the saved URL + token. */
@Composable
private fun BridgeOverflow(onRemove: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.Filled.MoreVert, "bridge options", tint = GitViewTheme.colors.textMid)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Remove bridge", color = MaterialTheme.colorScheme.error) },
                onClick = { open = false; onRemove() },
            )
        }
    }
}

/** Dashed "+ Add a bridge" affordance; taps reveal [AddBridgeForm]. */
@Composable
private fun AddBridgeRow(onClick: () -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)
            .dashedRoundBorder(col.border).padding(vertical = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("+  Add a bridge", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = col.textMid)
    }
}

@Composable
private fun AddBridgeForm(onAdd: (String, String) -> Unit, onCancel: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("http://100.x.y.z:8787") }
    val ready = name.isNotBlank() && url.isNotBlank()
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel("ADD A BRIDGE")
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(url, { url = it }, label = { Text("Base URL (Tailscale)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { if (ready) onAdd(name.trim(), url.trim()) }, enabled = ready, modifier = Modifier.weight(1f)) { Text("Save") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

/** A rounded dashed outline (Compose has no built-in dashed border modifier). */
private fun Modifier.dashedRoundBorder(color: Color, radius: Dp = 12.dp, stroke: Dp = 1.dp): Modifier =
    drawBehind {
        drawRoundRect(
            color = color,
            style = Stroke(width = stroke.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(18f, 12f))),
            cornerRadius = CornerRadius(radius.toPx(), radius.toPx()),
        )
    }

@Composable
fun ReposScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
  LaunchedEffect(Unit) { vm.refreshRepos() } // re-sync with the bridge on every entry (opened workspaces persist there)
  var pendingRemove by remember { mutableStateOf<RepoSummary?>(null) }
  Column(Modifier.fillMaxSize()) {
    ScreenBar(profiles, onBack = { vm.go(Screen.CONNECTIONS) },
        leading = { Text("Repositories", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) })
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    val ui = vm.ui
    Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
        when {
            ui.reposLoading -> SkeletonCards(4, Modifier.widthIn(max = 640.dp).padding(12.dp))
            ui.reposError -> EmptyState(
                "Couldn't reach the bridge", subtitle = "Check it's running and try again.",
                actionLabel = "Retry", onAction = vm::retryRepos,
            )
            ui.repos.isEmpty() -> EmptyState(
                "No repositories", subtitle = "This bridge isn't serving any repos yet.",
            )
            else -> EinkPaginator(
                paginate = GitViewTheme.settings.paginate,
                modifier = Modifier.widthIn(max = 640.dp).fillMaxHeight(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(ui.repos, key = { it.id }) { r ->
                    Card(
                        onClick = { vm.openRepo(r.id) },
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(start = 14.dp, top = 4.dp, end = 4.dp, bottom = 14.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(r.name, fontWeight = FontWeight.Medium, maxLines = 1,
                                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                // Opened workspaces can be un-registered; config repos (removable=false) cannot.
                                if (r.removable) RepoOverflow(onRemove = { pendingRemove = r })
                            }
                            RepoStateChips(r)
                            Text(r.profile.name.lowercase().replace('_', ' '),
                                fontSize = 12.sp, color = GitViewTheme.colors.textLow)
                        }
                    }
                }
            }
        }
    }
    // "Open a folder" — browse the host filesystem + open a folder as a workspace. Bridge-gated: only
    // shown when the connected bridge reports the feature on (workspaceRoots configured).
    if (ui.features?.workspaces == true) {
        Box(Modifier.fillMaxWidth(), Alignment.TopCenter) {
            Box(Modifier.widthIn(max = 640.dp).fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp)) {
                OpenFolderRow(onClick = vm::openFolderBrowser)
            }
        }
    }
  }
  pendingRemove?.let { r ->
      RemoveWorkspaceDialog(r.name, onConfirm = { vm.removeWorkspace(r); pendingRemove = null }, onDismiss = { pendingRemove = null })
  }
}

/** Per-workspace overflow (⋮) — shown only on removable (opened) workspaces. Un-registers, keeps files. */
@Composable
private fun RepoOverflow(onRemove: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.Filled.MoreVert, "workspace options", tint = GitViewTheme.colors.textMid)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Remove workspace", color = MaterialTheme.colorScheme.error) },
                onClick = { open = false; onRemove() },
            )
        }
    }
}

/** Confirm un-registering an opened workspace. Copy is explicit that files on disk are untouched. */
@Composable
private fun RemoveWorkspaceDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Remove workspace") },
        text = { Text("Remove \"$name\" from GitView? The folder and its files stay on disk; you can re-open it anytime.") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Remove", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Dashed "+ Open a folder" affordance under the repos list; taps open the [FolderBrowserOverlay]. */
@Composable
private fun OpenFolderRow(onClick: () -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)
            .dashedRoundBorder(col.border).heightIn(min = GitViewTheme.spacing.touchTarget).padding(vertical = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("+  Open a folder", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = col.textMid)
    }
}

/** `main · ↑2 ↓1 · 3 dirty` — live working-tree state from RepoSummary. Dirty is weight/hued on Standard. */
@Composable
private fun RepoStateChips(r: RepoSummary) {
    val col = GitViewTheme.colors
    val ahead = r.ahead ?: 0
    val behind = r.behind ?: 0
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            r.branch.ifBlank { r.defaultBranch }, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium, color = col.textMid, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (ahead > 0 || behind > 0) {
            val ab = buildString {
                if (ahead > 0) append("↑$ahead")
                if (ahead > 0 && behind > 0) append(" ")
                if (behind > 0) append("↓$behind")
            }
            Text(ab, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = col.textMid, maxLines = 1)
        }
        if (r.dirty > 0) {
            Text("${r.dirty} dirty", fontSize = 12.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium,
                color = if (col.hueless) col.textHi else col.warning, maxLines = 1)
        } else {
            Text("clean", fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = col.textLow, maxLines = 1)
        }
    }
}

// ---- Workspace (Files ⇄ Chat) ----------------------------------------------

/**
 * The unified Workspace. Phone / E-Ink: a Files ⇄ Chat `SegmentedButton` swaps a full-screen pane —
 * the agent is one tap away. Tablet (Standard, ≥720dp): tree + editor + chat shown together with a
 * user-draggable, persisted divider. Diff / History / Commit are overlays over this (see AppRoot).
 */
@Composable
fun WorkspaceScaffold(vm: AppViewModel, eink: Boolean, profiles: DisplayProfileManager) {
    val ui = vm.ui
    val holder = remember(ui.activePath) { EditorHolder() }
    // The divider is DRAGGABLE by default (even on E-Ink — the 80Hz panel handles it); "Reduce motion"
    // switches it to the discrete tap-to-cycle grip. So the split interaction follows the toggle, not the profile.
    val reduceMotion = GitViewTheme.settings.reduceMotion
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val tabletSplit = maxWidth >= 720.dp // tree + editor + chat split on wide screens (both profiles)
        Column(Modifier.fillMaxSize()) {
            WorkspaceToolbar(vm, holder, profiles, phoneSegment = !tabletSplit)
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (tabletSplit) {
                // Two adjustable dividers — tree | editor | chat — via nested DraggableSplits.
                DraggableSplit(
                    ratio = ui.treeRatio, onRatioChange = vm::setTreeRatio,
                    handleColor = MaterialTheme.colorScheme.outline, eink = reduceMotion,
                    minRatio = 0.12f, maxRatio = 0.4f, einkPresets = listOf(0.15f, 0.22f, 0.32f),
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    left = { ExplorerPane(vm, Modifier.fillMaxSize()) },
                    right = {
                        DraggableSplit(
                            ratio = ui.splitRatio, onRatioChange = vm::setSplitRatio,
                            handleColor = MaterialTheme.colorScheme.outline, eink = reduceMotion,
                            modifier = Modifier.fillMaxSize(),
                            left = { EditorColumn(vm, eink, holder) },
                            right = { ChatPane(vm, eink) },
                        )
                    },
                )
            } else {
                when (ui.activePane) {
                    WorkspacePane.FILES -> FilesPane(vm, eink, holder, Modifier.weight(1f).fillMaxWidth())
                    WorkspacePane.CHAT -> ChatPane(vm, eink, Modifier.weight(1f).fillMaxWidth())
                    WorkspacePane.TERMINAL -> {
                        LaunchedEffect(Unit) { vm.openTerminalIfNeeded() } // open a shell on first show
                        TerminalPane(
                            ui.terminal, ui.terminalExited,
                            onInput = vm::terminalInput,
                            onNewShell = { vm.closeTerminal(); vm.openTerminalIfNeeded() },
                            modifier = Modifier.weight(1f).fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

/** Phone Files pane: open-file tabs + the explorer tree or the editor (toggle via the toolbar list icon). */
@Composable
private fun FilesPane(vm: AppViewModel, eink: Boolean, holder: EditorHolder, modifier: Modifier = Modifier) {
    val ui = vm.ui
    Column(modifier) {
        if (ui.openFiles.isNotEmpty())
            TabBar(ui.openFiles, ui.activePath, vm::selectTab, vm::closeTab, Modifier.fillMaxWidth())
        if (ui.showExplorer || ui.activeFile == null) ExplorerPane(vm, Modifier.weight(1f))
        else EditorArea(vm, eink, holder, Modifier.weight(1f))
    }
}

/** Tablet editor pane: open-file tabs + the editor. */
@Composable
private fun EditorColumn(vm: AppViewModel, eink: Boolean, holder: EditorHolder) {
    val ui = vm.ui
    Column(Modifier.fillMaxSize()) {
        if (ui.openFiles.isNotEmpty())
            TabBar(ui.openFiles, ui.activePath, vm::selectTab, vm::closeTab, Modifier.fillMaxWidth())
        EditorArea(vm, eink, holder, Modifier.weight(1f))
    }
}

/**
 * Two bars on the phone so nothing is pushed off a narrow width: the top bar holds the Files ⇄ Chat
 * segment + overflow (the profile toggle stays reachable); a slim path/ref bar below holds the branch
 * chip + save + Git menu. The tablet is wide enough for a single bar.
 */
@Composable
private fun WorkspaceToolbar(vm: AppViewModel, holder: EditorHolder, profiles: DisplayProfileManager, phoneSegment: Boolean) {
    val ui = vm.ui
    // The "Claude agent…" dialog (model + credential + login) is Claude-specific — hide it when the active
    // agent supports neither a model pin nor in-app login (a future non-Claude provider).
    val claudeApplies = ui.agents.find { it.id == ui.selectedAgent }?.capabilities?.let { it.modelPin || it.inAppLogin } ?: true
    val onClaude: (() -> Unit)? = if (claudeApplies) ({ vm.openClaudeSettings() }) else null
    // A SINGLE top bar for every form factor: back · branch · … · [files-tree] · [save] · Git · ⋮.
    // Files/Chat lives inside the Git menu (its "View" section) and the branch chip is width-capped, so
    // the whole toolbar fits one row even on a narrow phone.
    ScreenBar(
        profiles,
        onBack = { vm.go(Screen.REPOS) },
        onClaudeSettings = onClaude,
        onChatSettings = vm::openChatSettings,
        // Cap the branch label tightly on the phone (crowded single bar) but generously on the tablet.
        leading = { BranchChip(vm, maxLabelWidth = if (phoneSegment) 108.dp else 220.dp) },
        trailing = {
            SaveButton(vm, holder)
            // Phone: the right-side menu is "View" — Files/Chat + the tree/editor toggle + Git actions,
            // all folded into one dropdown. Tablet shows both panes with a permanent tree, so it's a
            // plain "Git" menu.
            if (phoneSegment) GitMenu(vm, ui.activePane, vm::setActivePane) else GitMenu(vm)
        },
    )
}

@Composable
private fun SaveButton(vm: AppViewModel, holder: EditorHolder) {
    val ui = vm.ui; val f = ui.activeFile
    if (f != null && !ui.readOnly && !f.binary && f.dirty) {
        FilledIconButton(onClick = { vm.editActive(holder.read()); vm.saveActive() }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.Filled.Save, "save", Modifier.size(18.dp))
        }
    }
}

/** `main ▾` branch picker — real checkout via the bridge; "New branch…" creates + switches. */
@Composable
private fun BranchChip(vm: AppViewModel, maxLabelWidth: Dp) {
    val ui = vm.ui
    var open by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { open = true },
            // Width-capped + ellipsized so a long branch name can't crowd the action chips off the single
            // top bar; the dropdown still shows every branch in full.
            label = {
                Text(
                    ui.currentBranch ?: "detached", fontSize = 12.sp, maxLines = 1,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = maxLabelWidth),
                )
            },
            leadingIcon = { Icon(Icons.Filled.AccountTree, null, Modifier.size(16.dp)) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, "switch branch", Modifier.size(18.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            ui.branches.forEach { b ->
                DropdownMenuItem(
                    text = { Text(b) },
                    trailingIcon = { if (b == ui.currentBranch) Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) },
                    onClick = { open = false; if (b != ui.currentBranch) vm.checkout(b) },
                )
            }
            HorizontalDivider()
            DropdownMenuItem(text = { Text("New branch…") }, onClick = { open = false; naming = true })
        }
    }
    if (naming) NewBranchDialog(onCreate = { vm.checkout(it, create = true); naming = false }, onDismiss = { naming = false })
}

@Composable
private fun NewBranchDialog(onCreate: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    val valid = name.trim().isNotEmpty() && !name.trim().startsWith("-")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New branch") },
        text = { OutlinedTextField(name, { name = it }, label = { Text("Branch name") }, singleLine = true) },
        confirmButton = { TextButton(onClick = { onCreate(name.trim()) }, enabled = valid) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A non-interactive section label inside a [DropdownMenu] — small, muted, weight-based so it reads as
 *  a group heading on both profiles (no hue on E-Ink). */
@Composable
private fun MenuSectionLabel(text: String) {
    Text(
        text,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = GitViewTheme.colors.textLow,
    )
}

/**
 * The single right-side workspace menu — diff kinds, history, commit, push. On the phone/E-Ink workspace
 * it is the **"View"** menu: it also hosts the Files ⇄ Chat switch and the explorer-tree ⇄ editor toggle
 * at the top (a "View" section, each with a check), folding what used to be separate controls into one
 * dropdown. The tablet split shows both panes with a permanent tree, so it passes no pane, the View
 * section is omitted, and the chip stays labelled "Git".
 */
@Composable
private fun GitMenu(
    vm: AppViewModel,
    activePane: WorkspacePane? = null,
    onSelectPane: ((WorkspacePane) -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    val hasView = activePane != null && onSelectPane != null
    // On the phone/E-Ink workspace the chip mirrors the current pane (Files/Chat/Terminal) so the label
    // tracks what you're looking at; the tablet split has no pane switch, so it stays "Git".
    val chipLabel = if (hasView) paneLabel(activePane!!) else "Git"
    Box {
        AssistChip(
            onClick = { open = true },
            label = { Text(chipLabel, fontSize = 12.sp) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, if (hasView) "view menu" else "git actions", Modifier.size(18.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (activePane != null && onSelectPane != null) {
                MenuSectionLabel("View")
                WorkspacePane.entries.forEach { pane ->
                    // Terminal only when the bridge advertises it (config.terminal.enabled → /v1/health).
                    if (pane == WorkspacePane.TERMINAL && vm.ui.features?.terminal != true) return@forEach
                    DropdownMenuItem(
                        text = { Text(paneLabel(pane)) },
                        trailingIcon = { if (pane == activePane) Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) },
                        onClick = { open = false; if (pane != activePane) onSelectPane(pane) },
                    )
                }
                // Files pane with an open file: toggle the explorer tree ⇄ editor (was a toolbar icon).
                // Checked = the tree is showing; unchecked = the editor.
                if (activePane == WorkspacePane.FILES && vm.ui.activeFile != null) {
                    DropdownMenuItem(
                        text = { Text("File tree") },
                        trailingIcon = { if (vm.ui.showExplorer) Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) },
                        onClick = { open = false; vm.toggleExplorer() },
                    )
                }
                HorizontalDivider()
                MenuSectionLabel("Git")
            }
            DropdownMenuItem(text = { Text("Working-tree diff") }, onClick = { open = false; vm.showDiff("worktree") })
            DropdownMenuItem(text = { Text("Staged diff") }, onClick = { open = false; vm.showDiff("staged") })
            DropdownMenuItem(text = { Text("History…") }, onClick = { open = false; vm.showHistory() })
            HorizontalDivider()
            DropdownMenuItem(text = { Text("Commit…") }, onClick = { open = false; vm.openCommit() })
            DropdownMenuItem(text = { Text("Push") }, onClick = { open = false; vm.push() })
        }
    }
}

/** Human-friendly name for a workspace pane — used for both the View menu items and the chip label. */
private fun paneLabel(pane: WorkspacePane): String = when (pane) {
    WorkspacePane.FILES -> "Files"; WorkspacePane.CHAT -> "Chat"; WorkspacePane.TERMINAL -> "Terminal"
}

/** History overlay: recent commits over the Workspace; tapping one opens its diff (stacked overlay). */
@Composable
private fun HistoryOverlay(vm: AppViewModel) {
    val ui = vm.ui
    val commits = ui.logOverlay.orEmpty()
    BackHandler(enabled = true) { vm.closeHistory() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = vm::closeHistory, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.Close, "close history", tint = MaterialTheme.colorScheme.onSurface)
                }
                Text("History", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            when {
                ui.logLoading -> SkeletonCards(6, Modifier.widthIn(max = 640.dp).padding(12.dp))
                ui.logError -> EmptyState(
                    "Couldn't load history", subtitle = "The bridge didn't answer.",
                    actionLabel = "Retry", onAction = vm::showHistory,
                )
                commits.isEmpty() -> EmptyState("No commits yet", subtitle = "Commits will appear here once you make one.")
                else -> Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
                    EinkPaginator(
                        paginate = GitViewTheme.settings.paginate,
                        modifier = Modifier.widthIn(max = 640.dp).fillMaxHeight(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(commits, key = { it.oid }) { c ->
                            Card(
                                // Tap a commit → its diff (grouped view + changed-files tree inside).
                                onClick = { vm.showCommitDiff(c) },
                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(Modifier.padding(14.dp)) {
                                    Text(c.subject, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    val meta = MaterialTheme.colorScheme.onSurfaceVariant
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text("${c.shortOid} · ", fontSize = 12.sp, color = meta, fontFamily = FontFamily.Monospace, maxLines = 1)
                                        Text(
                                            c.author, Modifier.weight(1f, fill = false),
                                            fontSize = 12.sp, color = meta, fontFamily = FontFamily.Monospace,
                                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                        Text(" · ${relativeTime(c.date)}", fontSize = 12.sp, color = meta, fontFamily = FontFamily.Monospace, maxLines = 1)
                                    }
                                    CommitStat(c)
                                }
                            }
                        }
                        if (commits.size >= LOG_LIMIT) {
                            item {
                                Text(
                                    "Showing the latest $LOG_LIMIT commits",
                                    Modifier.fillMaxWidth().padding(8.dp),
                                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** `1 file · +7 −1` per-commit stat from `git log --shortstat`. Off E-Ink, +/− carry hue too. */
@Composable
private fun CommitStat(c: CommitSummary) {
    if (c.files == 0 && c.additions == 0 && c.deletions == 0) return
    val col = GitViewTheme.colors
    Row(
        Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("${c.files} ${if (c.files == 1) "file" else "files"}", fontSize = 12.sp, color = col.textLow, fontFamily = FontFamily.Monospace)
        if (c.additions > 0) Text("+${c.additions}", fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium, color = if (col.hueless) col.textHi else col.add)
        if (c.deletions > 0) Text("−${c.deletions}", fontSize = 12.sp, fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium, color = if (col.hueless) col.textHi else col.remove)
    }
}

/** Commit overlay: stage all changes, then commit with a message. */
@Composable
private fun CommitOverlay(vm: AppViewModel) {
    var msg by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = vm::closeCommit,
        title = { Text("Commit") },
        text = {
            Column {
                Text("Stages all changes, then commits.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(msg, { msg = it }, label = { Text("Message") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
        },
        confirmButton = { TextButton(onClick = { if (msg.isNotBlank()) vm.commit(msg.trim()) }, enabled = msg.isNotBlank()) { Text("Commit") } },
        dismissButton = { TextButton(onClick = vm::closeCommit) { Text("Cancel") } },
    )
}

@Composable
private fun ExplorerPane(vm: AppViewModel, modifier: Modifier = Modifier) {
    val ui = vm.ui
    Box(modifier.background(MaterialTheme.colorScheme.surface)) {
        when {
            ui.treeLoading -> SkeletonCards(5, Modifier.padding(12.dp))
            ui.treeError -> EmptyState(
                "Couldn't load files", subtitle = "The bridge didn't answer.",
                actionLabel = "Retry", onAction = vm::retryRoot,
            )
            else -> Column(Modifier.fillMaxSize()) {
                // Header ＋ creates at the REPO ROOT; per-folder "New file/folder…" lives in each folder's
                // long-press menu. Both hidden on a read-only ref.
                if (!ui.readOnly) ExplorerHeader(onNewFile = { vm.requestNewFile(null) }, onNewFolder = { vm.requestNewFolder(null) })
                if (ui.nodes.isEmpty()) EmptyState("Empty repository", subtitle = "No files on this ref yet.", modifier = Modifier.weight(1f).fillMaxWidth())
                else ExplorerTree(
                    ui.nodes, onToggleDir = vm::toggleDir, onOpenFile = vm::openFile,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    editable = !ui.readOnly, onRename = vm::requestRename, onDelete = vm::requestDelete,
                    onNewFile = { vm.requestNewFile(it) }, onNewFolder = { vm.requestNewFolder(it) },
                )
            }
        }
    }
}

/** Slim explorer header with a ＋ that creates a file/folder at the repo root. */
@Composable
private fun ExplorerHeader(onNewFile: () -> Unit, onNewFolder: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Explorer", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = GitViewTheme.colors.textLow, modifier = Modifier.weight(1f))
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                Icon(Icons.Filled.Add, "new file or folder", tint = MaterialTheme.colorScheme.onSurface)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("New file…") }, onClick = { menu = false; onNewFile() })
                DropdownMenuItem(text = { Text("New folder…") }, onClick = { menu = false; onNewFolder() })
            }
        }
    }
}

@Composable
private fun EditorArea(vm: AppViewModel, eink: Boolean, holder: EditorHolder, modifier: Modifier = Modifier) {
    val ui = vm.ui; val f = ui.activeFile
    Column(modifier.fillMaxSize()) {
        if (f != null && f.path in ui.conflictPaths) SaveConflictBar(f.path, vm)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                f == null -> EmptyState("Pick a file from the tree", subtitle = "Choose a file to view or edit.")
                f.loading -> EditorSkeleton()
                f.binary -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text("binary file — preview unavailable", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> key(f.path) {
                    CodeEditorView(
                        initialText = f.content, path = f.path, editable = !ui.readOnly, eink = eink,
                        holder = holder, onDirty = vm::markActiveDirty, modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}

/** Gutter + code-line skeleton shown while a file's bytes are in flight (Sora mounts on bytes). */
@Composable
private fun EditorSkeleton() {
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val widths = listOf(0.9f, 0.55f, 0.7f, 0.4f, 0.85f, 0.5f, 0.65f, 0.3f)
        repeat(12) { i -> SkeletonLine(fraction = widths[i % widths.size], height = 12.dp) }
    }
}

/**
 * Save-conflict bar: a file open + dirty was changed on disk (spec's editor error state). Keeps the
 * unsaved buffer; offers reload (take theirs), overwrite (keep mine), or diff. Hueless-safe via [StatusBanner].
 */
@Composable
private fun SaveConflictBar(path: String, vm: AppViewModel) {
    val col = GitViewTheme.colors
    Column(
        Modifier.fillMaxWidth()
            .background(if (col.hueless) MaterialTheme.colorScheme.surfaceVariant else col.warning.copy(alpha = 0.14f))
            .then(if (col.hueless) Modifier.border(GitViewTheme.spacing.hairline, col.borderStrong) else Modifier)
            .padding(horizontal = GitViewTheme.spacing.md, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text("Changed on disk while you were editing.", fontSize = 13.sp,
            fontWeight = if (col.hueless) FontWeight.SemiBold else FontWeight.Medium, color = col.textHi)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { vm.reloadConflict(path) }) { Text("Reload") }
            // Overwrite is a write — disabled while the editor is read-only (offline / historical ref).
            TextButton(onClick = { vm.overwriteConflict(path) }, enabled = !vm.ui.readOnly) { Text("Overwrite") }
            TextButton(onClick = { vm.showDiff("worktree") }) { Text("Diff") }
        }
    }
}

/**
 * The chat pane — sessions row + transcript + cost bar + composer. Embedded as the phone Chat segment
 * and the tablet chat column of the [WorkspaceScaffold]. The autonomy tier now lives in Chat settings
 * (⋮ menu), not a bar above the composer.
 */
@Composable
fun ChatPane(vm: AppViewModel, eink: Boolean, modifier: Modifier = Modifier) {
    val ui = vm.ui
    var input by rememberSaveable { mutableStateOf("") }
    // imePadding lifts the whole pane (composer included) above the soft keyboard so the input + Send stay
    // visible while typing (the window is adjustResize, but edge-to-edge Compose still needs the IME inset).
    // While the session picker is up you're choosing a session, not typing — hide the composer entirely.
    val picking = ui.picking && ui.sessions.isNotEmpty()
    Column(modifier.fillMaxSize().imePadding()) {
        SessionsRow(ui.sessions.size, onOpen = vm::openSessionPicker)
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        when {
            // The picker shows whenever `picking` is set (regardless of a loaded transcript) so the
            // Sessions button can switch away from an already-resumed session.
            picking -> SessionPicker(
                ui.sessions, onResume = vm::resumeSession, onNewChat = vm::newChat, onDelete = vm::removeSession,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
            ui.transcript.isEmpty() -> EmptyState(
                "Ask Claude to work on this repo",
                subtitle = "Describe a change and Claude edits the files directly — approvals appear inline.",
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
            else -> ChatTranscript(
                ui.transcript,
                onToggleTool = vm::toggleToolExpanded,
                onPermissionDecision = vm::resolvePermission,
                onAttachmentBytes = vm::attachmentBytes, onViewAttachment = vm::viewAttachment,
                onSaveAttachment = vm::saveAttachment,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        // The agent is paused awaiting a decision → pin its Deny/Allow bar at the bottom (in place of the
        // composer) so it's always reachable, even when Paginate mode freezes the transcript's scroll.
        val pending = if (picking) null else ui.transcript.lastOrNull { it is PendingPermission } as? PendingPermission
        if (!picking) {
            if (GitViewTheme.settings.showCost) CostBar(ui.turnCostUsd, ui.costUsd, ui.budgetUsd)
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (pending != null) {
                ApprovalActionBar(pending, vm::resolvePermission)
            } else Row(
                Modifier.fillMaxWidth().padding(10.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    input, { input = it }, modifier = Modifier.weight(1f),
                    placeholder = { Text("Ask Claude to work on this repo…") }, shape = RoundedCornerShape(20.dp),
                )
                if (ui.busy) AssistChip(onClick = vm::interrupt, label = { Text("Stop") })
                else Button(
                    // Clear the field only if the prompt was actually dispatched (sendPrompt returns false
                    // when the socket isn't connected) — otherwise a dropped send would eat the typed text.
                    onClick = { if (input.isNotBlank() && vm.sendPrompt(input.trim())) input = "" },
                    enabled = !ui.disconnected, // no sending into a dropped socket
                ) { Text("Send") }
            }
        }
    }
}

/**
 * The pinned decision bar shown while the agent is paused on an "Ask first" tool call. Lives outside the
 * (possibly non-scrolling, paginated) transcript so Deny/Allow are always reachable; the transcript card
 * above still carries the full context (path + diff). A short title + ellipsized path recap the target.
 */
@Composable
private fun ApprovalActionBar(item: PendingPermission, onDecision: (requestId: String, allow: Boolean, scope: String) -> Unit) {
    val col = GitViewTheme.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
        Text(
            "Allow ${toolDisplayName(item.kind, item.name)}?",
            style = MaterialTheme.typography.titleSmall, color = col.textHi,
        )
        if (item.path != null) {
            Text(
                item.path, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, color = col.textLow,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(6.dp))
        ApprovalButtons({ allow, scope -> onDecision(item.id, allow, scope) }, Modifier.fillMaxWidth())
    }
}

/**
 * Compact chat-header affordance (where the provider row used to sit): re-opens the session picker so
 * the user can switch to another CLI session or start a new chat. Shows a count when sessions exist.
 * Themed via GitViewTheme.colors; hue is dropped on E-Ink (weight carries it).
 */
@Composable
private fun SessionsRow(sessionCount: Int, onOpen: () -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onOpen) {
            Text(
                if (sessionCount > 0) "Sessions ($sessionCount)" else "Sessions",
                fontSize = 12.sp, fontWeight = FontWeight.Medium,
                color = if (col.hueless) col.textHi else col.primary,
            )
        }
    }
}

/**
 * The resume-a-session picker, shown in the empty chat pane when the repo has prior sessions. A header
 * with a "New chat" affordance over a paginated list of session cards (title, relative time, turns).
 * Tapping a card resumes it; tapping "New chat" starts fresh. Themed via GitViewTheme; hue-free on E-Ink.
 */
@Composable
private fun SessionPicker(
    sessions: List<SessionInfo>,
    onResume: (String) -> Unit,
    onNewChat: () -> Unit,
    onDelete: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val col = GitViewTheme.colors
    var pendingDelete by remember { mutableStateOf<SessionInfo?>(null) }
    Column(modifier) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Resume a session", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            TextButton(onClick = onNewChat) { Text("New chat") }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
            EinkPaginator(
                paginate = GitViewTheme.settings.paginate,
                modifier = Modifier.widthIn(max = 640.dp).fillMaxHeight(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(sessions, key = { it.id }) { s ->
                    Card(
                        onClick = { onResume(s.id) },
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(
                                Modifier.weight(1f).padding(start = 14.dp, top = 14.dp, bottom = 14.dp, end = 4.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(s.title ?: "Untitled session", fontWeight = FontWeight.Medium,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(relativeTime(s.updatedAt), fontSize = 12.sp, color = col.textLow, maxLines = 1)
                                    s.turns?.let { t ->
                                        Text("· $t ${if (t == 1) "turn" else "turns"}", fontSize = 12.sp, color = col.textLow, maxLines = 1)
                                    }
                                }
                            }
                            SessionOverflow(onDelete = { pendingDelete = s })
                        }
                    }
                }
            }
        }
    }
    pendingDelete?.let { s ->
        DeleteSessionDialog(
            s.title ?: "Untitled session",
            onConfirm = { onDelete(s.id); pendingDelete = null },
            onDismiss = { pendingDelete = null },
        )
    }
}

/** Per-session overflow (⋮) — delete removes the chat transcript on the host for good. */
@Composable
private fun SessionOverflow(onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
            Icon(Icons.Filled.MoreVert, "session options", tint = GitViewTheme.colors.textMid)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("Delete session", color = MaterialTheme.colorScheme.error) },
                onClick = { open = false; onDelete() },
            )
        }
    }
}

@Composable
private fun DeleteSessionDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete session") },
        text = { Text("Delete \"$name\"? Its chat transcript on the host is removed for good.") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun PairingDialog(vm: AppViewModel, onDismiss: () -> Unit) {
    val ui = vm.ui
    var code by rememberSaveable { mutableStateOf("") }
    val valid = code.trim().isNotEmpty()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Pair with bridge") },
        text = {
            Column {
                Text("Enter the pairing code shown in the bridge console.")
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(
                    code, { code = it }, label = { Text("Pairing code") }, singleLine = true,
                    isError = ui.pairError != null, enabled = !ui.pairing,
                )
                if (ui.pairError != null) {
                    Spacer(Modifier.size(4.dp))
                    Text(ui.pairError!!, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                }
            }
        },
        // Keeps the dialog open on a bad code (error stays PAIR_NEEDED, message shows inline).
        confirmButton = {
            TextButton(onClick = { vm.pair(code.trim()) }, enabled = valid && !ui.pairing) {
                Text(if (ui.pairing) "Pairing…" else "Pair")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun RenameDialog(currentName: String, isDir: Boolean, onRename: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember(currentName) { mutableStateOf(currentName) }
    val valid = name.trim().isNotEmpty() && !name.contains('/') && name.trim() != currentName
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename ${if (isDir) "folder" else "file"}") },
        text = { OutlinedTextField(name, { name = it }, label = { Text("New name") }, singleLine = true, isError = name.contains('/')) },
        confirmButton = { TextButton(onClick = { onRename(name.trim()) }, enabled = valid) { Text("Rename") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Prompt for a new file/folder name. Empty or slash-containing names are rejected (the bridge confines
 *  paths anyway; a slash would imply nesting the create dialog doesn't handle). */
@Composable
private fun NewNodeDialog(isFolder: Boolean, onCreate: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    val valid = name.trim().isNotEmpty() && !name.contains('/')
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isFolder) "New folder" else "New file") },
        text = {
            OutlinedTextField(
                name, { name = it }, label = { Text("Name") }, singleLine = true, isError = name.contains('/'),
                placeholder = { Text(if (isFolder) "components" else "example.kt") },
            )
        },
        confirmButton = { TextButton(onClick = { onCreate(name.trim()) }, enabled = valid) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeleteConfirmDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete file") },
        text = { Text("Delete \"$name\"? This can't be undone.") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Confirm forgetting a saved bridge — deletes its saved address row and its stored pairing token. */
@Composable
private fun RemoveBridgeDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Remove bridge") },
        text = { Text("Remove \"$name\"? This forgets its saved address and pairing token. You can add it again anytime.") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Remove", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ---- browse host filesystem + open a folder as a workspace -----------------

/**
 * The folder browser: browse the host filesystem within the bridge's configured workspace roots and
 * open a folder as a workspace. A full-screen overlay (over the Scaffold, like Diff/History) with a
 * root selector (when >1), a path crumb + "up", a navigable directory list, "New folder", and a
 * primary "Open this folder" action. Themed through GitViewTheme; hue-free on Color E-Ink.
 */
@Composable
private fun FolderBrowserOverlay(vm: AppViewModel) {
    val ui = vm.ui
    val col = GitViewTheme.colors
    var naming by remember { mutableStateOf(false) }
    BackHandler(enabled = true) { vm.closeFolderBrowser() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = vm::closeFolderBrowser, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.Close, "close folder browser", tint = MaterialTheme.colorScheme.onSurface)
                }
                Text("Open a folder", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (ui.fsRoots.size > 1) {
                FsRootSelector(ui.fsRoots, ui.fsRoot, onSelect = { vm.fsNavigate(it, "") })
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            }
            // Path crumb + "up" (disabled at the root) + New folder.
            val rootLabel = ui.fsRoots.firstOrNull { it.id == ui.fsRoot }?.label ?: ""
            val crumb = if (ui.fsPath.isEmpty()) rootLabel else "$rootLabel/${ui.fsPath}"
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = vm::fsUp, enabled = ui.fsParent != null, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.ArrowUpward, "up one folder",
                        tint = if (ui.fsParent != null) MaterialTheme.colorScheme.onSurface else col.textLow)
                }
                Text(crumb, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = col.textMid,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                TextButton(onClick = { naming = true }) { Text("New folder") }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    ui.fsLoading -> SkeletonCards(6, Modifier.padding(12.dp))
                    ui.fsError -> EmptyState(
                        "Couldn't list this folder", subtitle = "The bridge didn't answer.",
                        actionLabel = "Retry", onAction = vm::fsRetry,
                    )
                    ui.fsEntries.isEmpty() -> EmptyState("Empty folder", subtitle = "No files or subfolders here.")
                    else -> EinkPaginator(paginate = GitViewTheme.settings.paginate, modifier = Modifier.fillMaxSize()) {
                        items(ui.fsEntries, key = { "${it.kind}/${it.name}" }) { e ->
                            FsEntryRow(e, onOpen = { ui.fsRoot?.let { r -> vm.fsNavigate(r, joinPath(ui.fsPath, e.name)) } })
                        }
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Row(Modifier.fillMaxWidth().padding(10.dp)) {
                Button(
                    onClick = { ui.fsRoot?.let { r -> vm.openWorkspaceAt(r, ui.fsPath) } },
                    enabled = ui.fsRoot != null && !ui.fsLoading && !ui.fsOpening, modifier = Modifier.weight(1f),
                ) { Text(if (ui.fsOpening) "Opening…" else "Open this folder") }
            }
        }
    }
    if (naming) NewFolderDialog(onCreate = { vm.fsMkdir(it); naming = false }, onDismiss = { naming = false })
}

/** `label ▾` root picker — only shown when the bridge exposes more than one workspace root. */
@Composable
private fun FsRootSelector(roots: List<FsRoot>, selected: String?, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = roots.firstOrNull { it.id == selected } ?: roots.firstOrNull()
    Box(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
        AssistChip(
            onClick = { open = true },
            label = { Text(current?.label ?: "root", fontSize = 12.sp, maxLines = 1) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, "choose root", Modifier.size(18.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            roots.forEach { r ->
                DropdownMenuItem(
                    text = { Text(r.label) },
                    trailingIcon = { if (r.id == selected) Icon(Icons.Filled.Check, null, Modifier.size(16.dp)) },
                    onClick = { open = false; if (r.id != selected) onSelect(r.id) },
                )
            }
        }
    }
}

/** One filesystem row: directories are tappable (navigate in); files are shown but inert. `repo` is flagged. */
@Composable
private fun FsEntryRow(e: FsEntry, onOpen: () -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = GitViewTheme.spacing.touchTarget) // ≥48dp Standard / 56dp E-Ink
            .then(if (e.isDir) Modifier.clickable(onClick = onOpen) else Modifier)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            fileIcon(e.name, e.isDir), contentDescription = null, modifier = Modifier.size(18.dp),
            tint = if (e.isDir) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.size(8.dp))
        Text(
            e.name, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (e.isDir) MaterialTheme.colorScheme.onSurface else col.textLow,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (e.isRepo) {
            Spacer(Modifier.size(8.dp))
            // A repo folder reads by weight (E-Ink-safe) and hue only off E-Ink.
            Text("repo", fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                color = if (col.hueless) col.textHi else col.primary)
        }
    }
}

@Composable
private fun NewFolderDialog(onCreate: (String) -> Unit, onDismiss: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    val valid = name.trim().isNotEmpty() && !name.contains('/')
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New folder") },
        text = { OutlinedTextField(name, { name = it }, label = { Text("Folder name") }, singleLine = true, isError = name.contains('/')) },
        confirmButton = { TextButton(onClick = { onCreate(name.trim()) }, enabled = valid) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Shown when opening a non-git folder: confirm to `git init` (the app only sends initGit after this). */
@Composable
private fun GitInitDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Not a git repository") },
        text = { Text("Initialize one here?") },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Initialize") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Join a confined rel-path with a child name ("" base → the child itself). */
private fun joinPath(base: String, name: String) = if (base.isEmpty()) name else "$base/$name"

/** A compact relative timestamp for a commit's ISO-8601 author date; falls back to the date. */
private fun relativeTime(iso: String): String = try {
    val then = java.time.OffsetDateTime.parse(iso).toInstant()
    val date = { then.atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString() }
    val secs = java.time.Duration.between(then, java.time.Instant.now()).seconds
    when {
        secs < 0 -> date()          // future author date (clock skew / rebased timestamp)
        secs < 60 -> "just now"
        secs < 3600 -> "${secs / 60}m ago"
        secs < 86_400 -> "${secs / 3600}h ago"
        secs < 2_592_000 -> "${secs / 86_400}d ago"
        else -> date()
    }
} catch (e: Exception) {
    iso.take(10)
}

/** Compact relative label for an epoch-millis timestamp (bridge last-used / last-probed). */
private fun relativeMillis(epochMillis: Long): String {
    val secs = (System.currentTimeMillis() - epochMillis) / 1000
    return when {
        secs < 60 -> "just now"
        secs < 3600 -> "${secs / 60}m ago"
        secs < 86_400 -> "${secs / 3600}h ago"
        secs < 2_592_000 -> "${secs / 86_400}d ago"
        else -> "${secs / 2_592_000}mo ago"
    }
}

private fun back(screen: Screen) = when (screen) {
    Screen.WORKSPACE -> Screen.REPOS
    Screen.REPOS -> Screen.CONNECTIONS
    Screen.CONNECTIONS -> Screen.CONNECTIONS
}
