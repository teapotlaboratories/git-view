package com.gitview.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(titleFor(ui.screen, ui.activeRepo)) },
                navigationIcon = { if (ui.screen != Screen.CONNECTIONS) IconButton(onClick = { vm.go(back(ui.screen)) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "back") } },
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
    TextButton(onClick = {
        val next = if (profiles.active == DisplayProfile.STANDARD) DisplayProfile.COLOR_EINK else DisplayProfile.STANDARD
        profiles.setOverride(next)
    }) { Text(if (profiles.active.isEink) "E-Ink" else "Standard") }
}

@Composable
fun ConnectionsScreen(vm: AppViewModel) {
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("http://100.x.y.z:8787") }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Saved bridges", style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
            items(vm.ui.connections, key = { it.id }) { c ->
                ConnectionRow(c) { vm.selectConnection(c) }
            }
        }
        HorizontalDivider()
        Text("Add a bridge", style = MaterialTheme.typography.titleSmall)
        OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(url, { url = it }, label = { Text("Base URL (Tailscale)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button(onClick = { if (name.isNotBlank() && url.isNotBlank()) { vm.addConnection(name.trim(), url.trim()); name = "" } }) {
            Text("Save connection")
        }
    }
}

@Composable
private fun ConnectionRow(c: Connection, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(c.name) },
        supportingContent = { Text(c.baseUrl) },
        modifier = Modifier.fillMaxWidth(),
    )
    OutlinedButton(onClick = onClick, modifier = Modifier.padding(start = 12.dp)) { Text("Connect") }
}

@Composable
fun ReposScreen(vm: AppViewModel) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(vm.ui.repos, key = { it.id }) { r ->
            ListItem(
                headlineContent = { Text(r.name) },
                supportingContent = { Text("${r.provider} · ${r.profile}") },
                modifier = Modifier.fillMaxWidth().clickableRow { vm.openRepo(r.id) },
            )
        }
    }
}

@Composable
fun BrowseScreen(vm: AppViewModel, eink: Boolean) {
    val ui = vm.ui
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { vm.go(Screen.CHAT) }) { Text("Chat →") }
            OutlinedButton(onClick = { vm.setRef(if (ui.readOnly) null else "HEAD") }) { Text(if (ui.readOnly) "@${ui.ref} (read-only)" else "working tree") }
            Text("/${ui.cwd}", style = MaterialTheme.typography.bodySmall)
        }
        HorizontalDivider()
        val open = ui.openPath
        if (open == null) {
            Row(Modifier.padding(horizontal = 8.dp)) {
                if (ui.cwd.isNotEmpty()) TextButton(onClick = { vm.openParent() }) { Text("..") }
            }
            FileTreeList(ui.tree, onOpen = { e -> if (e.isDir) vm.openDir(e.path) else vm.openFile(e) }, modifier = Modifier.weight(1f))
        } else {
            val holder = remember(open) { EditorHolder() }
            Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { vm.openDir(ui.cwd) }) { Text("← files") }
                Text(open, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                if (!ui.readOnly && !ui.openBinary) Button(onClick = { vm.editContent(holder.read()); vm.saveOpenFile() }) { Text("Save") }
            }
            if (ui.openBinary) {
                Text("(binary file — preview unavailable)", Modifier.padding(12.dp))
            } else {
                CodeEditorView(ui.openContent, editable = !ui.readOnly, eink = eink, holder = holder, modifier = Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
fun ChatScreen(vm: AppViewModel, eink: Boolean) {
    val ui = vm.ui
    var input by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { vm.go(Screen.BROWSE) }) { Text("← Browse/Edit") }
            ProviderSelector(ui.provider, vm::setProvider)
            Text("$${"%.3f".format(ui.costUsd)}", style = MaterialTheme.typography.labelMedium)
        }
        ProfileSelector(ui.profile, vm::setProfile)
        HorizontalDivider()
        ChatList(ui.chat, modifier = Modifier.weight(1f).fillMaxWidth().padding(8.dp))
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(input, { input = it }, modifier = Modifier.weight(1f), placeholder = { Text("Ask Claude to work on this repo…") })
            if (ui.busy) OutlinedButton(onClick = vm::interrupt) { Text("Stop") }
            else Button(onClick = { if (input.isNotBlank()) { vm.sendPrompt(input.trim()); input = "" } }) { Text("Send") }
        }
    }
}

@Composable
private fun PairingDialog(onPair: (String) -> Unit, onDismiss: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Pair with bridge") },
        text = {
            Column {
                Text("Enter the pairing code shown in the bridge console.")
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
