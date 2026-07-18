package com.gitview.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.gitview.app.AppViewModel
import kotlinx.coroutines.launch

@Composable
fun ConnectScreen(app: AppViewModel, onConnected: () -> Unit) {
    var url by remember { mutableStateOf(app.baseUrl.ifEmpty { "http://" }) }
    var token by remember { mutableStateOf(app.token) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Connect to a GitView bridge", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Bridge URL") },
            placeholder = { Text("http://192.168.1.10:8799") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Token (BRIDGE_TOKEN)") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
        }
        Button(
            onClick = {
                error = null
                busy = true
                app.connect(url, token)
                scope.launch {
                    val r = runCatching { app.api!!.health() }
                    busy = false
                    r.onSuccess {
                        if (it.ok) onConnected() else error = "Bridge reachable but not healthy"
                    }.onFailure { error = it.message ?: "Could not reach bridge" }
                }
            },
            enabled = !busy && url.isNotBlank() && token.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "Connecting…" else "Connect")
        }
        Text(
            "Run the bridge on your machine, then reach it over Tailscale (https://<machine>.<tailnet>.ts.net) or the LAN IP.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
fun ReposScreen(app: AppViewModel, onOpenRepo: (String) -> Unit, onBack: () -> Unit) {
    val api = app.api
    Column(Modifier.fillMaxSize()) {
        ScreenHeader("Repositories", onBack)
        if (api == null) {
            CenteredMessage("Not connected")
            return
        }
        Loadable(key = app.baseUrl, load = { api.repos() }) { resp ->
            LazyColumn(Modifier.fillMaxSize()) {
                items(resp.repos) { repo ->
                    ListRow(title = repo.name, subtitle = "${repo.id} · ${repo.defaultRef}") {
                        onOpenRepo(repo.id)
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
fun TreeScreen(
    app: AppViewModel,
    repo: String,
    path: String,
    onOpenDir: (String) -> Unit,
    onOpenFile: (String) -> Unit,
    onBack: () -> Unit,
) {
    val api = app.api
    val title = if (path.isEmpty()) repo else "$repo/$path"
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(title, onBack)
        if (api == null) {
            CenteredMessage("Not connected")
            return
        }
        Loadable(key = "$repo:$path", load = { api.tree(repo, path = path.ifEmpty { null }) }) { resp ->
            LazyColumn(Modifier.fillMaxSize()) {
                items(resp.entries) { e ->
                    val isDir = e.type == "tree"
                    ListRow(
                        title = (if (isDir) "📁 " else "📄 ") + e.name,
                        subtitle = if (!isDir) e.size?.let { "$it B" } else null,
                    ) {
                        if (isDir) onOpenDir(e.path) else onOpenFile(e.path)
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
fun FileScreen(app: AppViewModel, repo: String, path: String, onBack: () -> Unit) {
    val api = app.api
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(path.substringAfterLast('/'), onBack)
        if (api == null) {
            CenteredMessage("Not connected")
            return
        }
        Loadable(key = "$repo:$path", load = { api.blob(repo, path = path) }) { blob ->
            when {
                blob.binary -> CenteredMessage("Binary file (${blob.size} B)")
                blob.truncated -> CenteredMessage("File too large to display (${blob.size} B)")
                else -> SelectionContainer {
                    Text(
                        text = blob.content ?: "",
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .horizontalScroll(rememberScrollState())
                            .padding(12.dp),
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}
