package com.gitview.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Single-activity host. The real app hosts a Compose NavHost:
 *   Connections -> RepoList -> Tree -> FileViewer / DiffViewer / Log  (Browse tab)
 *                                    \-> ChatScreen                    (Chat tab)
 * See android/README.md for the screen map. This is a Phase-0 placeholder.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
                    Column(Modifier.padding(padding).padding(16.dp)) {
                        Text("GitView", style = MaterialTheme.typography.headlineMedium)
                        Text("Connect a bridge to browse a repo and chat with Claude.")
                    }
                }
            }
        }
    }
}

@Composable
private fun Placeholder() {
    // TODO(phase-0): ConnectionsScreen + RepoListScreen + TreeScreen wired via Navigation Compose.
}
