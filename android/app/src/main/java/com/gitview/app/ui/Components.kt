package com.gitview.app.ui

import android.graphics.Typeface
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Folder
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.gitview.app.ChatMessage
import com.gitview.app.data.PermissionProfile
import com.gitview.app.data.SessionProvider
import com.gitview.app.data.TreeEntry
import io.github.rosemoe.sora.widget.CodeEditor

/** Lets a Save action read the CURRENT editor buffer without threading edits through state on every keystroke. */
class EditorHolder { var read: () -> String = { "" } }

/** Shared row-click modifier used across lists. */
fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)

/**
 * The editable code component (req. 2): Sora Editor wrapped for Compose. VS Code-grade highlighting
 * comes from Sora's TextMate/tree-sitter modules; on the Color E-Ink profile it is configured mono +
 * weight-based (see docs/EINK.md). Grammar/theme loading is the Phase-1 hook marked below.
 */
@Composable
fun CodeEditorView(
    initialText: String,
    editable: Boolean,
    eink: Boolean,
    holder: EditorHolder,
    modifier: Modifier = Modifier,
) {
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            CodeEditor(ctx).apply {
                setText(initialText)
                setEditable(editable)
                setTypefaceText(Typeface.MONOSPACE)
                holder.read = { text.toString() }
                // TODO(phase 1): load a TextMate grammar for the file's language, and apply the
                // e-ink theme (assets/textmate/eink-mono.json) when `eink` is true; otherwise a
                // normal colored theme. Sora modules: language-textmate / language-treesitter.
            }
        },
        update = { editor ->
            if (editor.text.toString() != initialText) editor.setText(initialText)
            editor.setEditable(editable)
        },
    )
}

@Composable
fun FileTreeList(
    entries: List<TreeEntry>,
    onOpen: (TreeEntry) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier) {
        items(entries, key = { it.path }) { e ->
            ListItem(
                headlineContent = { Text(e.name) },
                supportingContent = e.size?.let { { Text("$it B") } },
                leadingContent = {
                    Icon(
                        if (e.isDir) Icons.Filled.Folder else Icons.AutoMirrored.Filled.InsertDriveFile,
                        contentDescription = null,
                    )
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp).clickable { onOpen(e) },
            )
        }
    }
}

@Composable
fun ChatList(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items(messages) { m ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(10.dp)) {
                    Text(m.role.uppercase(), style = MaterialTheme.typography.labelSmall)
                    // Minimal markdown-ish rendering: code/tool lines use a monospace family.
                    Text(
                        m.text.ifEmpty { if (m.streaming) "…" else "" },
                        fontFamily = if (m.role == "tool") FontFamily.Monospace else FontFamily.Default,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileSelector(selected: PermissionProfile, onSelect: (PermissionProfile) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        PermissionProfile.ordered.forEach { p ->
            FilterChip(selected = p == selected, onClick = { onSelect(p) }, label = { Text(profileLabel(p)) })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProviderSelector(selected: SessionProvider, onSelect: (SessionProvider) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        SessionProvider.entries.forEach { p ->
            AssistChip(onClick = { onSelect(p) }, label = {
                Text((if (p == selected) "● " else "○ ") + if (p == SessionProvider.REMOTE_CONTROL) "Remote" else "Local SDK")
            })
        }
    }
}

private fun profileLabel(p: PermissionProfile) = when (p) {
    PermissionProfile.READ_ONLY -> "read-only"
    PermissionProfile.CONFINED_AGENT -> "confined"
    PermissionProfile.ACCEPT_EDITS -> "acceptEdits"
    PermissionProfile.AUTO -> "auto"
    PermissionProfile.DONT_ASK -> "dontAsk"
    PermissionProfile.BYPASS -> "bypass"
}
