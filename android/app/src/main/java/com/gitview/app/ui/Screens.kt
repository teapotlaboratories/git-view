package com.gitview.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.AppViewModel
import com.gitview.app.Screen
import com.gitview.app.data.Connection
import com.gitview.app.ui.theme.DisplayProfile
import com.gitview.app.ui.theme.DisplayProfileManager

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppRoot(vm: AppViewModel, profiles: DisplayProfileManager) {
    val ui = vm.ui
    val snackbar = remember { SnackbarHostState() }
    val eink = profiles.active.isEink

    LaunchedEffect(ui.error) {
        val e = ui.error
        if (e != null && e != "PAIR_NEEDED") { snackbar.showSnackbar(e); vm.clearError() }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface,
                ),
                title = { Text(titleFor(ui.screen, ui.activeRepo), fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (ui.screen != Screen.CONNECTIONS) IconButton(onClick = { vm.go(back(ui.screen)) }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "back")
                    }
                },
                actions = { DisplayToggle(profiles) },
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            when (ui.screen) {
                Screen.CONNECTIONS -> ConnectionsScreen(vm)
                Screen.REPOS -> ReposScreen(vm)
                Screen.BROWSE -> BrowseScreen(vm, eink)
                Screen.CHAT -> ChatScreen(vm, eink)
            }
        }
    }

    if (ui.error == "PAIR_NEEDED") PairingDialog(onPair = vm::pair, onDismiss = vm::clearError)
}

@Composable
private fun DisplayToggle(profiles: DisplayProfileManager) {
    AssistChip(
        onClick = {
            profiles.setOverride(if (profiles.active == DisplayProfile.STANDARD) DisplayProfile.COLOR_EINK else DisplayProfile.STANDARD)
        },
        label = { Text(if (profiles.active.isEink) "E-Ink" else "Standard", fontSize = 12.sp) },
        modifier = Modifier.padding(end = 8.dp),
    )
}

@Composable
fun ConnectionsScreen(vm: AppViewModel) {
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("http://100.x.y.z:8787") }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
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
fun ReposScreen(vm: AppViewModel) {
    LazyColumn(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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

@Composable
fun BrowseScreen(vm: AppViewModel, eink: Boolean) {
    val ui = vm.ui
    val holder = remember(ui.activePath) { EditorHolder() }
    val f = ui.activeFile
    Column(Modifier.fillMaxSize()) {
        // slim toolbar
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = { vm.toggleExplorer() }, modifier = Modifier.size(36.dp)) {
                Icon(Icons.AutoMirrored.Filled.List, "explorer", tint = MaterialTheme.colorScheme.onSurface)
            }
            AssistChip(onClick = { vm.setRef(if (ui.readOnly) null else "HEAD") },
                label = { Text(if (ui.readOnly) "@${ui.ref}" else "working tree", fontSize = 12.sp) })
            Spacer(Modifier.weight(1f))
            if (f != null && !ui.readOnly && !f.binary && f.dirty) {
                FilledIconButton(onClick = { vm.editActive(holder.read()); vm.saveActive() }, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Filled.Save, "save", Modifier.size(18.dp))
                }
            }
            AssistChip(onClick = { vm.go(Screen.CHAT) }, label = { Text("Chat", fontSize = 12.sp) })
        }
        if (ui.openFiles.isNotEmpty()) {
            TabBar(ui.openFiles, ui.activePath, onSelect = vm::selectTab, onClose = vm::closeTab, modifier = Modifier.fillMaxWidth())
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
        if (ui.showExplorer || f == null) {
            if (ui.nodes.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) { Text("empty", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else {
                ExplorerTree(ui.nodes, onToggleDir = vm::toggleDir, onOpenFile = vm::openFile, modifier = Modifier.weight(1f))
            }
        } else if (f.binary) {
            Box(Modifier.fillMaxSize(), Alignment.Center) {
                Text("binary file — preview unavailable", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            key(f.path) {
                CodeEditorView(
                    initialText = f.content, path = f.path, editable = !ui.readOnly, eink = eink,
                    holder = holder, onDirty = vm::markActiveDirty, modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@Composable
fun ChatScreen(vm: AppViewModel, eink: Boolean) {
    val ui = vm.ui
    var input by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            AssistChip(onClick = { vm.go(Screen.BROWSE) }, label = { Text("Browse / Edit", fontSize = 12.sp) })
            ProviderSelector(ui.provider, vm::setProvider)
            Spacer(Modifier.weight(1f))
            Text("$${"%.3f".format(ui.costUsd)}", fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
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

private fun titleFor(screen: Screen, repo: String?) = when (screen) {
    Screen.CONNECTIONS -> "GitView"
    Screen.REPOS -> "Repositories"
    Screen.BROWSE -> repo ?: "Browse"
    Screen.CHAT -> "Chat · ${repo ?: ""}"
}

private fun back(screen: Screen) = when (screen) {
    Screen.CHAT -> Screen.BROWSE
    Screen.BROWSE -> Screen.REPOS
    Screen.REPOS -> Screen.CONNECTIONS
    Screen.CONNECTIONS -> Screen.CONNECTIONS
}
