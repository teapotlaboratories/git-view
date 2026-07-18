package com.gitview.app.ui

import android.graphics.Typeface
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.gitview.app.ChatMessage
import com.gitview.app.OpenFile
import com.gitview.app.TreeNode
import com.gitview.app.data.PermissionProfile
import com.gitview.app.data.SessionProvider
import com.gitview.app.editor.SyntaxHighlighting
import io.github.rosemoe.sora.event.ContentChangeEvent
import io.github.rosemoe.sora.widget.CodeEditor

/** Lets a Save action read the CURRENT editor buffer without threading edits through state per keystroke. */
class EditorHolder { var read: () -> String = { "" } }

fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)

// ---- code editor ------------------------------------------------------------

/**
 * The editable code component (req. 2): Sora Editor wrapped for Compose with VS Code-grade TextMate
 * highlighting (see [SyntaxHighlighting]). Reports the first edit via [onDirty] so the tab can show a
 * modified marker, without pushing every keystroke through app state.
 */
@Composable
fun CodeEditorView(
    initialText: String,
    path: String,
    editable: Boolean,
    eink: Boolean,
    holder: EditorHolder,
    onDirty: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = if (eink) SyntaxHighlighting.THEME_EINK else SyntaxHighlighting.THEME_DARK
    // Tracks the last `initialText` we pushed into the editor (a plain box, so writing it never
    // triggers recomposition). Lets `update` reset the buffer ONLY when the source content actually
    // changes (external reload / discard) — not on every recomposition, which would wipe live edits.
    val applied = remember(path) { arrayOf(initialText) }
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            CodeEditor(ctx).apply {
                SyntaxHighlighting.colorScheme(theme)?.let { setColorScheme(it) }
                SyntaxHighlighting.languageForPath(path)?.let { setEditorLanguage(it) }
                setTypefaceText(Typeface.MONOSPACE)
                setTextSize(13f)
                setTabWidth(4)
                setLineNumberEnabled(true)
                setWordwrap(path.endsWith(".md") || path.endsWith(".markdown"))
                setText(initialText)
                setEditable(editable)
                holder.read = { text.toString() }
                var reported = false
                subscribeAlways(ContentChangeEvent::class.java) {
                    if (!reported) { reported = true; onDirty() }
                }
            }
        },
        update = { editor ->
            // Only re-apply when the source content changed AND the editor doesn't already hold it,
            // so a dirty-marker recomposition can't clobber the user's in-progress edits.
            if (initialText != applied[0] && editor.text.toString() != initialText) {
                editor.setText(initialText)
            }
            applied[0] = initialText
            editor.setEditable(editable)
        },
    )
}

// ---- explorer tree ----------------------------------------------------------

@Composable
fun ExplorerTree(
    nodes: List<TreeNode>,
    onToggleDir: (TreeNode) -> Unit,
    onOpenFile: (TreeNode) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier) {
        items(nodes, key = { it.path }) { n ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(34.dp)
                    .clickableRow { if (n.isDir) onToggleDir(n) else onOpenFile(n) }
                    .padding(start = (8 + n.depth * 14).dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (n.isDir) {
                    Icon(
                        if (n.expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                        contentDescription = null, modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.size(2.dp))
                } else {
                    Spacer(Modifier.size(20.dp))
                }
                Icon(
                    fileIcon(n.name, n.isDir), contentDescription = null, modifier = Modifier.size(18.dp),
                    tint = if (n.isDir) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(8.dp))
                Text(n.name, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface, maxLines = 1)
            }
        }
    }
}

// ---- editor tabs ------------------------------------------------------------

@Composable
fun TabBar(
    tabs: List<OpenFile>,
    activePath: String?,
    onSelect: (String) -> Unit,
    onClose: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyRow(modifier.background(MaterialTheme.colorScheme.surface)) {
        items(tabs, key = { it.path }) { f ->
            val active = f.path == activePath
            val bg = if (active) MaterialTheme.colorScheme.background else Color.Transparent
            Row(
                Modifier
                    .background(bg)
                    .clickableRow { onSelect(f.path) }
                    .padding(start = 12.dp, end = 6.dp)
                    .height(38.dp)
                    .widthIn(max = 200.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(fileIcon(f.name, false), null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(6.dp))
                Text(
                    f.name, fontSize = 13.sp, maxLines = 1,
                    color = if (active) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.size(6.dp))
                if (f.dirty) {
                    Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                } else {
                    Icon(
                        Icons.Filled.Close, "close", Modifier.size(15.dp).clickableRow { onClose(f.path) },
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    val f = tabs.firstOrNull { it.path == activePath }
    if (f != null) Box(Modifier.fillMaxWidth().height(2.dp).background(MaterialTheme.colorScheme.primary))
}

private val OpenFile.name get() = path.substringAfterLast('/')

// ---- chat -------------------------------------------------------------------

@Composable
fun ChatList(messages: List<ChatMessage>, modifier: Modifier = Modifier) {
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(messages) { m ->
            when (m.role) {
                "tool" -> Text(
                    m.text, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                else -> {
                    val user = m.role == "user"
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
                        Box(
                            Modifier
                                .widthIn(max = 320.dp)
                                .background(
                                    if (user) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(14.dp),
                                )
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                        ) {
                            Text(
                                m.text.ifEmpty { if (m.streaming) "…" else "" },
                                color = if (user) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                                fontSize = 14.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

// ---- selectors --------------------------------------------------------------

@Composable
fun ProfileSelector(selected: PermissionProfile, onSelect: (PermissionProfile) -> Unit, modifier: Modifier = Modifier) {
    LazyRow(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(PermissionProfile.ordered) { p ->
            FilterChip(
                selected = p == selected, onClick = { onSelect(p) },
                label = { Text(profileLabel(p), fontSize = 12.sp) },
                colors = FilterChipDefaults.filterChipColors(),
            )
        }
    }
}

@Composable
fun ProviderSelector(selected: SessionProvider, onSelect: (SessionProvider) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        SessionProvider.entries.forEach { p ->
            FilterChip(
                selected = p == selected, onClick = { onSelect(p) },
                label = { Text(if (p == SessionProvider.REMOTE_CONTROL) "Remote" else "Local SDK", fontSize = 12.sp) },
            )
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

/** File-type icon by extension, IDE-explorer style. */
fun fileIcon(name: String, isDir: Boolean): ImageVector {
    if (isDir) return Icons.Filled.Folder
    return when (name.substringAfterLast('.', "").lowercase()) {
        "kt", "kts", "java", "ts", "tsx", "js", "jsx", "py", "go", "rs", "c", "h", "cpp", "cc", "sh", "groovy", "gradle" -> Icons.Filled.Code
        "json", "jsonc", "yaml", "yml", "toml", "xml", "properties" -> Icons.Filled.DataObject
        "md", "markdown", "txt" -> Icons.AutoMirrored.Filled.Article
        "png", "jpg", "jpeg", "gif", "webp", "svg", "ico" -> Icons.Filled.Image
        else -> Icons.AutoMirrored.Filled.InsertDriveFile
    }
}
