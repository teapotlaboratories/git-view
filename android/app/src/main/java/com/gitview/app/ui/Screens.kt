package com.gitview.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.AppViewModel
import com.gitview.app.LOG_LIMIT
import com.gitview.app.Screen
import com.gitview.app.data.Connection
import com.gitview.app.ui.theme.DisplayProfile
import com.gitview.app.ui.theme.DisplayProfileManager

@Composable
fun AppRoot(vm: AppViewModel, profiles: DisplayProfileManager) {
    val ui = vm.ui
    val snackbar = remember { SnackbarHostState() }
    val eink = profiles.active.isEink

    // System back navigates within the app (no top app bar); on the root screen it exits.
    BackHandler(enabled = ui.screen != Screen.CONNECTIONS) { vm.go(back(ui.screen)) }

    LaunchedEffect(ui.error) {
        val e = ui.error
        if (e != null && e != "PAIR_NEEDED") { snackbar.showSnackbar(e); vm.clearError() }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            when (ui.screen) {
                Screen.CONNECTIONS -> ConnectionsScreen(vm, profiles)
                Screen.REPOS -> ReposScreen(vm, profiles)
                Screen.BROWSE -> BrowseScreen(vm, eink, profiles)
                Screen.LOG -> LogScreen(vm, profiles)
                Screen.CHAT -> ChatScreen(vm, eink, profiles)
            }
        }
    }

    if (ui.error == "PAIR_NEEDED") PairingDialog(onPair = vm::pair, onDismiss = vm::clearError)
    ui.diffText?.let { d -> DiffOverlay(label = ui.diffLabel, diff = d, onClose = vm::closeDiff) }
}

@Composable
private fun DiffOverlay(label: String, diff: String, onClose: () -> Unit) {
    BackHandler(enabled = true) { onClose() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Close, "close diff", tint = MaterialTheme.colorScheme.onSurface)
                }
                Text("Diff · $label", fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            DiffView(diff, Modifier.weight(1f).fillMaxWidth())
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
        if (onBack != null) IconButton(onClick = onBack, modifier = Modifier.size(36.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "back", tint = MaterialTheme.colorScheme.onSurface)
        }
        leading()
        Spacer(Modifier.weight(1f))
        trailing()
        DisplayToggle(profiles)
    }
}

@Composable
private fun DisplayToggle(profiles: DisplayProfileManager) {
    AssistChip(
        onClick = {
            profiles.setOverride(if (profiles.active == DisplayProfile.STANDARD) DisplayProfile.COLOR_EINK else DisplayProfile.STANDARD)
        },
        label = { Text(if (profiles.active.isEink) "E-Ink" else "Standard", fontSize = 12.sp) },
    )
}

@Composable
fun ConnectionsScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("http://100.x.y.z:8787") }
    Column(Modifier.fillMaxSize()) {
      ScreenBar(profiles, leading = { Text("GitView", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) })
      HorizontalDivider(color = MaterialTheme.colorScheme.outline)
      Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
      Column(
        Modifier.widthIn(max = 640.dp).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel("SAVED BRIDGES")
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(vm.ui.connections, key = { it.id }) { c -> ConnectionCard(c) { vm.selectConnection(c) } }
        }
        Spacer(Modifier.size(4.dp))
        SectionLabel("ADD A BRIDGE")
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(url, { url = it }, label = { Text("Base URL (Tailscale)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { if (name.isNotBlank() && url.isNotBlank()) { vm.addConnection(name.trim(), url.trim()); name = "" } },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Save connection") }
      }
      }
    }
}

@Composable
private fun SectionLabel(text: String) =
    Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun ConnectionCard(c: Connection, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(c.name, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface)
            Text(c.baseUrl, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun ReposScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
  Column(Modifier.fillMaxSize()) {
    ScreenBar(profiles, onBack = { vm.go(Screen.CONNECTIONS) },
        leading = { Text("Repositories", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) })
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
        LazyColumn(
            Modifier.widthIn(max = 640.dp).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(vm.ui.repos, key = { it.id }) { r ->
                Card(
                    onClick = { vm.openRepo(r.id) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(r.name, fontWeight = FontWeight.Medium)
                        Text("${r.provider} · ${r.profile}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
  }
}

@Composable
fun BrowseScreen(vm: AppViewModel, eink: Boolean, profiles: DisplayProfileManager) {
    val ui = vm.ui
    val holder = remember(ui.activePath) { EditorHolder() }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Two-pane IDE layout on wide screens (tablets); single-pane with an explorer toggle on phones.
        val wide = maxWidth >= 720.dp
        Column(Modifier.fillMaxSize()) {
            BrowseToolbar(vm, holder, profiles, showExplorerToggle = !wide)
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            if (wide) {
                Row(Modifier.fillMaxSize()) {
                    ExplorerPane(vm, Modifier.width(320.dp).fillMaxHeight())
                    VerticalDivider(color = MaterialTheme.colorScheme.outline)
                    Column(Modifier.weight(1f).fillMaxHeight()) {
                        if (ui.openFiles.isNotEmpty())
                            TabBar(ui.openFiles, ui.activePath, vm::selectTab, vm::closeTab, Modifier.fillMaxWidth())
                        EditorArea(vm, eink, holder, Modifier.weight(1f))
                    }
                }
            } else {
                if (ui.openFiles.isNotEmpty())
                    TabBar(ui.openFiles, ui.activePath, vm::selectTab, vm::closeTab, Modifier.fillMaxWidth())
                if (ui.showExplorer || ui.activeFile == null) ExplorerPane(vm, Modifier.weight(1f))
                else EditorArea(vm, eink, holder, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun BrowseToolbar(vm: AppViewModel, holder: EditorHolder, profiles: DisplayProfileManager, showExplorerToggle: Boolean) {
    val ui = vm.ui; val f = ui.activeFile
    ScreenBar(
        profiles,
        onBack = { vm.go(Screen.REPOS) },
        leading = {
            if (showExplorerToggle) IconButton(onClick = { vm.toggleExplorer() }, modifier = Modifier.size(36.dp)) {
                Icon(Icons.AutoMirrored.Filled.List, "explorer", tint = MaterialTheme.colorScheme.onSurface)
            }
            AssistChip(onClick = { vm.setRef(if (ui.readOnly) null else "HEAD") },
                label = { Text(if (ui.readOnly) "@${ui.ref}" else "working tree", fontSize = 12.sp) })
        },
        trailing = {
            if (f != null && !ui.readOnly && !f.binary && f.dirty) {
                FilledIconButton(onClick = { vm.editActive(holder.read()); vm.saveActive() }, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Save, "save", Modifier.size(18.dp))
                }
            }
            DiffMenuChip(vm)
            AssistChip(onClick = { vm.go(Screen.CHAT) }, label = { Text("Chat", fontSize = 12.sp) })
        },
    )
}

/** The "Diff" chip: a menu over the three diff kinds — working tree, staged, or commit history. */
@Composable
private fun DiffMenuChip(vm: AppViewModel) {
    var open by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { open = true },
            label = { Text("Diff", fontSize = 12.sp) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, "diff options", Modifier.size(18.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Working tree") }, onClick = { open = false; vm.showDiff("worktree") })
            DropdownMenuItem(text = { Text("Staged") }, onClick = { open = false; vm.showDiff("staged") })
            DropdownMenuItem(text = { Text("History…") }, onClick = { open = false; vm.loadLog() })
        }
    }
}

/** Commit history: recent commits; tapping one opens its diff in the shared overlay. */
@Composable
fun LogScreen(vm: AppViewModel, profiles: DisplayProfileManager) {
    Column(Modifier.fillMaxSize()) {
        ScreenBar(profiles, onBack = { vm.go(Screen.BROWSE) },
            leading = { Text("History", fontWeight = FontWeight.SemiBold, fontSize = 18.sp) })
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        if (vm.ui.log.isEmpty()) {
            Box(Modifier.fillMaxSize(), Alignment.Center) {
                Text("No commits", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return@Column
        }
        Box(Modifier.fillMaxWidth().weight(1f), Alignment.TopCenter) {
            LazyColumn(
                Modifier.widthIn(max = 640.dp).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(vm.ui.log, key = { it.oid }) { c ->
                    Card(
                        onClick = { vm.showCommitDiff(c) },
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Text(c.subject, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            // Author can be long; keep the short SHA and the (most useful) time visible,
                            // ellipsizing only the author in the middle.
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
                        }
                    }
                }
                if (vm.ui.log.size >= LOG_LIMIT) {
                    item {
                        Text(
                            "Showing the latest $LOG_LIMIT commits",
                            Modifier.fillMaxWidth().padding(8.dp),
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ExplorerPane(vm: AppViewModel, modifier: Modifier = Modifier) {
    val ui = vm.ui
    if (ui.nodes.isEmpty()) {
        Box(modifier.background(MaterialTheme.colorScheme.surface), Alignment.Center) {
            Text("empty", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        ExplorerTree(ui.nodes, onToggleDir = vm::toggleDir, onOpenFile = vm::openFile,
            modifier = modifier.background(MaterialTheme.colorScheme.surface))
    }
}

@Composable
private fun EditorArea(vm: AppViewModel, eink: Boolean, holder: EditorHolder, modifier: Modifier = Modifier) {
    val ui = vm.ui; val f = ui.activeFile
    when {
        f == null -> Box(modifier.fillMaxSize(), Alignment.Center) {
            Text("Select a file", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        f.binary -> Box(modifier.fillMaxSize(), Alignment.Center) {
            Text("binary file — preview unavailable", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        else -> key(f.path) {
            CodeEditorView(
                initialText = f.content, path = f.path, editable = !ui.readOnly, eink = eink,
                holder = holder, onDirty = vm::markActiveDirty, modifier = modifier.fillMaxSize(),
            )
        }
    }
}

@Composable
fun ChatScreen(vm: AppViewModel, eink: Boolean, profiles: DisplayProfileManager) {
    val ui = vm.ui
    var input by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        ScreenBar(
            profiles,
            onBack = { vm.go(Screen.BROWSE) },
            leading = { ProviderSelector(ui.provider, vm::setProvider) },
            trailing = {
                Text("$${"%.3f".format(ui.costUsd)}", fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            },
        )
        ProfileSelector(ui.profile, vm::setProfile, Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        ChatList(ui.chat, modifier = Modifier.weight(1f).fillMaxWidth().padding(10.dp))
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
            else Button(onClick = { if (input.isNotBlank()) { vm.sendPrompt(input.trim()); input = "" } }) { Text("Send") }
        }
    }
}

@Composable
private fun PairingDialog(onPair: (String) -> Unit, onDismiss: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Pair with bridge") },
        text = {
            Column {
                Text("Enter the pairing code shown in the bridge console.")
                Spacer(Modifier.size(8.dp))
                OutlinedTextField(code, { code = it }, label = { Text("Pairing code") }, singleLine = true)
            }
        },
        confirmButton = { TextButton(onClick = { onPair(code.trim()) }) { Text("Pair") } },
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

private fun back(screen: Screen) = when (screen) {
    Screen.CHAT -> Screen.BROWSE
    Screen.LOG -> Screen.BROWSE
    Screen.BROWSE -> Screen.REPOS
    Screen.REPOS -> Screen.CONNECTIONS
    Screen.CONNECTIONS -> Screen.CONNECTIONS
}
