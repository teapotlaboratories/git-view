package com.gitview.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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
import com.gitview.app.data.RepoSummary
import com.gitview.app.data.SessionProvider
import com.gitview.app.ui.eink.EinkPaginator
import com.gitview.app.ui.state.EmptyState
import com.gitview.app.ui.state.SkeletonCards
import com.gitview.app.ui.state.SkeletonLine
import com.gitview.app.ui.state.StatusBanner
import com.gitview.app.ui.chat.ChatTranscript
import com.gitview.app.ui.permission.CostBar
import com.gitview.app.ui.permission.PermissionBar
import com.gitview.app.ui.permission.PermissionSheet
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
    if (ui.diffOpen) DiffOverlay(vm)
    if (ui.historyOpen) HistoryOverlay(vm)
    if (ui.commitOpen) CommitOverlay(vm)
    ui.renameTarget?.let { n -> RenameDialog(n.name, n.isDir, onRename = { vm.renameNode(n, it) }, onDismiss = vm::dismissNodeAction) }
    ui.deleteTarget?.let { n -> DeleteConfirmDialog(n.name, onConfirm = { vm.deleteNode(n) }, onDismiss = vm::dismissNodeAction) }
}

@Composable
private fun DiffOverlay(vm: AppViewModel) {
    val ui = vm.ui
    BackHandler(enabled = true) { vm.closeDiff() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        // Overlays render outside the Scaffold's inset padding, so inset here or a bottom pager footer
        // hides behind the system nav bar.
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = vm::closeDiff, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.Close, "close diff", tint = MaterialTheme.colorScheme.onSurface)
                }
                Text("Diff · ${ui.diffLabel}", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    ui.diffLoading -> SkeletonCards(6, Modifier.padding(12.dp))
                    ui.diffError -> EmptyState(
                        "Couldn't load the diff", subtitle = "The bridge didn't answer.",
                        actionLabel = "Retry", onAction = { vm.showDiff(ui.diffKind, ui.diffRef, ui.diffLabel) },
                    )
                    else -> DiffView(ui.diffText.orEmpty(), Modifier.fillMaxSize())
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
        OverflowMenu(profiles)
    }
}

/**
 * The bar's trailing "⋮" menu. Holds the quick display-profile switch plus "Display settings…" (the
 * E-Ink comfort toggles) — moved out of the bar so the toolbar's action chips don't crowd it off a
 * narrow phone.
 */
@Composable
private fun OverflowMenu(profiles: DisplayProfileManager) {
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

@Composable
fun ConnectionsScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
    // Probe reachability only while this screen is visible (start on enter, stop on leave).
    DisposableEffect(Unit) {
        vm.startReachabilityPolling()
        onDispose { vm.stopReachabilityPolling() }
    }
    var adding by rememberSaveable { mutableStateOf(false) }
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
                    onProvider = { vm.setConnectionProvider(c, it) },
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
}

@Composable
private fun SectionLabel(text: String) =
    Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

/**
 * A saved bridge: live status (dot + latency), name, URL, when it was last used, and a per-bridge
 * Local/Remote provider toggle. Tapping the card selects it. Status/hue is suppressed on E-Ink
 * (glyph shape + weight carry the meaning); latency + retry stay text.
 */
@Composable
private fun BridgeCard(
    c: Connection, reach: Reachability?,
    onSelect: () -> Unit, onRetry: () -> Unit, onProvider: (SessionProvider) -> Unit,
) {
    val col = GitViewTheme.colors
    Card(
        onClick = onSelect,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusDot(reach)
                Text(c.name, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(c.lastUsedAt?.let { "used ${relativeMillis(it)}" } ?: "never used",
                    fontSize = 11.sp, color = col.textLow, maxLines = 1)
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
                Spacer(Modifier.weight(1f))
                ProviderToggle(c.provider, onProvider)
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

/** Compact two-state Local/Remote provider toggle (selected = filled + bold, the E-Ink-safe signal). */
@Composable
private fun ProviderToggle(provider: SessionProvider, onChange: (SessionProvider) -> Unit) {
    val col = GitViewTheme.colors
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surface).padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        listOf(SessionProvider.LOCAL_SDK to "Local", SessionProvider.REMOTE_CONTROL to "Remote").forEach { (p, label) ->
            val sel = provider == p
            Box(
                Modifier.clip(RoundedCornerShape(6.dp))
                    .background(if (sel) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                    .clickable { onChange(p) }
                    .heightIn(min = GitViewTheme.spacing.touchTarget)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, fontSize = 12.sp, maxLines = 1,
                    fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (sel) MaterialTheme.colorScheme.onSecondaryContainer else col.textMid)
            }
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
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(r.name, fontWeight = FontWeight.Medium)
                            RepoStateChips(r)
                            Text("${providerLabel(r.provider)} · ${r.profile.name.lowercase().replace('_', ' ')}",
                                fontSize = 12.sp, color = GitViewTheme.colors.textLow)
                        }
                    }
                }
            }
        }
    }
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

private fun providerLabel(p: SessionProvider): String = when (p) {
    SessionProvider.LOCAL_SDK -> "Local SDK"
    SessionProvider.REMOTE_CONTROL -> "Remote control"
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
    if (phoneSegment) {
        ScreenBar(
            profiles,
            onBack = { vm.go(Screen.REPOS) },
            leading = { FilesChatSegment(ui.activePane, vm::setActivePane) },
        )
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            if (ui.activePane == WorkspacePane.FILES) {
                IconButton(onClick = { vm.toggleExplorer() }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.AutoMirrored.Filled.List, "files tree", tint = MaterialTheme.colorScheme.onSurface)
                }
            }
            BranchChip(vm)
            Spacer(Modifier.weight(1f))
            SaveButton(vm, holder)
            GitMenu(vm)
        }
    } else {
        ScreenBar(
            profiles,
            onBack = { vm.go(Screen.REPOS) },
            leading = { BranchChip(vm) },
            trailing = { SaveButton(vm, holder); GitMenu(vm) },
        )
    }
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
private fun BranchChip(vm: AppViewModel) {
    val ui = vm.ui
    var open by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { open = true },
            label = { Text(ui.currentBranch ?: "detached", fontSize = 12.sp, maxLines = 1) },
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilesChatSegment(active: WorkspacePane, onSelect: (WorkspacePane) -> Unit) {
    SingleChoiceSegmentedButtonRow(Modifier.height(GitViewTheme.spacing.touchTarget)) {
        SegmentedButton(
            selected = active == WorkspacePane.FILES, onClick = { onSelect(WorkspacePane.FILES) },
            shape = SegmentedButtonDefaults.itemShape(0, 2),
        ) { Text("Files", fontSize = 12.sp) }
        SegmentedButton(
            selected = active == WorkspacePane.CHAT, onClick = { onSelect(WorkspacePane.CHAT) },
            shape = SegmentedButtonDefaults.itemShape(1, 2),
        ) { Text("Chat", fontSize = 12.sp) }
    }
}

/** The "Git" menu: diff kinds, history, commit, push. */
@Composable
private fun GitMenu(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { open = true },
            label = { Text("Git", fontSize = 12.sp) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, "git actions", Modifier.size(18.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Working-tree diff") }, onClick = { open = false; vm.showDiff("worktree") })
            DropdownMenuItem(text = { Text("Staged diff") }, onClick = { open = false; vm.showDiff("staged") })
            DropdownMenuItem(text = { Text("History…") }, onClick = { open = false; vm.showHistory() })
            HorizontalDivider()
            DropdownMenuItem(text = { Text("Commit…") }, onClick = { open = false; vm.openCommit() })
            DropdownMenuItem(text = { Text("Push") }, onClick = { open = false; vm.push() })
        }
    }
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
            ui.nodes.isEmpty() -> EmptyState("Empty repository", subtitle = "No files on this ref yet.")
            else -> ExplorerTree(ui.nodes, onToggleDir = vm::toggleDir, onOpenFile = vm::openFile,
                modifier = Modifier.fillMaxSize(),
                editable = !ui.readOnly, onRename = vm::requestRename, onDelete = vm::requestDelete)
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
 * The chat pane — provider selector + permission bar + transcript + cost bar + composer. Embedded as
 * the phone Chat segment and the tablet chat column of the [WorkspaceScaffold].
 */
@Composable
fun ChatPane(vm: AppViewModel, eink: Boolean, modifier: Modifier = Modifier) {
    val ui = vm.ui
    var input by rememberSaveable { mutableStateOf("") }
    var sheetOpen by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize()) {
        ProviderSelector(ui.provider, vm::setProvider, Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp))
        PermissionBar(ui.profile, onOpenSheet = { sheetOpen = true })
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        if (ui.transcript.isEmpty()) {
            EmptyState(
                "Ask Claude to work on this repo",
                subtitle = "Describe a change and Claude edits the files directly — approvals appear inline.",
                modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        } else {
            ChatTranscript(
                ui.transcript, onToggleTool = vm::toggleToolExpanded,
                onPermissionDecision = vm::resolvePermission, modifier = Modifier.weight(1f).fillMaxWidth(),
            )
        }
        CostBar(ui.turnCostUsd, ui.costUsd, ui.budgetUsd)
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        Row(
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
    if (sheetOpen) PermissionSheet(ui.profile, onSelect = vm::setProfile, onDismiss = { sheetOpen = false })
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
