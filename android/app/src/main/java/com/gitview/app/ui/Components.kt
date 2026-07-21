package com.gitview.app.ui

import android.graphics.Typeface
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import com.gitview.app.ui.eink.EinkPaginator
import com.gitview.app.ui.theme.GitViewTheme
import com.gitview.app.ui.theme.LocalDisplayProfile
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
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
    // "Calm editor" toggle (default off): stop the blinking caret — a blinking caret is the single
    // worst EPD ghosting source. 0 disables blink; 500ms is Sora's normal cadence. See ADR-028.
    val caretPeriod = if (GitViewTheme.settings.editorCalm) 0 else 500
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
                setCursorBlinkPeriod(caretPeriod)
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
            editor.setCursorBlinkPeriod(caretPeriod) // re-apply so toggling "Calm editor" takes effect live
        },
    )
}

// ---- explorer tree ----------------------------------------------------------

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ExplorerTree(
    nodes: List<TreeNode>,
    onToggleDir: (TreeNode) -> Unit,
    onOpenFile: (TreeNode) -> Unit,
    modifier: Modifier = Modifier,
    editable: Boolean = false,
    onRename: (TreeNode) -> Unit = {},
    onDelete: (TreeNode) -> Unit = {},
) {
    EinkPaginator(paginate = GitViewTheme.settings.paginate, modifier = modifier) {
        items(nodes, key = { it.path }) { n ->
            var menu by remember(n.path) { mutableStateOf(false) }
            Box {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = GitViewTheme.spacing.touchTarget) // ≥48dp Standard / 56dp E-Ink
                        .combinedClickable(
                            onClick = { if (n.isDir) onToggleDir(n) else onOpenFile(n) },
                            onLongClick = { if (editable) menu = true },
                        )
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
                if (editable) {
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Rename") }, onClick = { menu = false; onRename(n) })
                        // The bridge's remove is non-recursive, so only files can be deleted.
                        if (!n.isDir) DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; onDelete(n) })
                    }
                }
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
                    .padding(start = 12.dp)
                    .heightIn(min = GitViewTheme.spacing.touchTarget) // ≥48dp Standard / 56dp E-Ink
                    .widthIn(max = 220.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(fileIcon(f.name, false), null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.size(6.dp))
                // Active tab reads by WEIGHT (visible on near-mono paper), not just the faint bg fill.
                Text(
                    f.name, fontSize = 13.sp, maxLines = 1,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (active) MaterialTheme.colorScheme.onBackground else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (f.dirty) {
                    Spacer(Modifier.size(6.dp))
                    Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                    Spacer(Modifier.size(12.dp))
                } else {
                    // A real close target (44dp square) instead of a 15dp icon. NB: a fillMaxHeight box
                    // here would blow up the LazyRow height (unbounded cross-axis) — keep it fixed.
                    Box(
                        Modifier.size(44.dp).clickableRow { onClose(f.path) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Close, "close ${f.name}", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    // A plain hairline under the tab strip (the old full-width accent falsely implied an active tab).
    HorizontalDivider(color = MaterialTheme.colorScheme.outline, thickness = GitViewTheme.spacing.hairline)
}

private val OpenFile.name get() = path.substringAfterLast('/')

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

// ---- unified diff viewer ----------------------------------------------------

// Add/remove colors come from GitViewTheme.colors (spec add/remove roles) — see diffLineStyle.
// DiffLineKind + classifyDiff live in DiffModel.kt (pure logic, unit-tested).

/** Per-line diff styling. On e-ink, add/remove read by weight + strikethrough (ink over hue). */
private data class DiffLineStyle(
    val bg: Color,
    val fg: Color,
    val weight: FontWeight? = null,
    val decoration: TextDecoration? = null,
)

/**
 * Renders a unified diff, one shared h-scroll. Standard profile tints +/- green/red; the Color
 * E-Ink profile drops hue and conveys the same by weight (added = bold) + strikethrough
 * (removed), keeping the +/- gutter symbol, so it stays legible on Kaleido 3's muted color.
 * Lazy: whole-tree diffs can run to thousands of lines, so only visible rows are composed.
 */
@Composable
fun DiffView(diff: String, modifier: Modifier = Modifier) {
    if (diff.isBlank()) {
        Box(modifier, Alignment.Center) { Text("No changes", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        return
    }
    val eink = LocalDisplayProfile.current.isEink
    val lines = remember(diff) { diff.split("\n") }
    val kinds = remember(diff) { classifyDiff(lines) }
    val hScroll = rememberScrollState() // shared so all rows scroll horizontally in sync
    EinkPaginator(paginate = GitViewTheme.settings.paginate, modifier = modifier) {
        items(lines.size) { i -> DiffRow(lines[i], kinds[i], hScroll, eink) }
    }
}

/** One diff line: a gutter-less mono row, tinted (Standard) or weight/strikethrough (E-Ink). Shared. */
@Composable
internal fun DiffRow(line: String, kind: DiffLineKind, hScroll: ScrollState, eink: Boolean) {
    val s = diffLineStyle(kind, eink)
    Box(Modifier.fillMaxWidth().background(s.bg)) {
        Text(
            if (line.isEmpty()) " " else line,
            modifier = Modifier.horizontalScroll(hScroll).padding(horizontal = 10.dp, vertical = 1.dp),
            fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = s.fg,
            fontWeight = s.weight, textDecoration = s.decoration,
            softWrap = false, maxLines = 1,
        )
    }
}

/**
 * A small, NON-lazy diff for embedding inside another scrollable (the chat tool card) — shares the
 * exact [DiffRow] rendering with the full-screen [DiffView]. Caps at [maxRows] with a "…N more" footer
 * so a large write can't blow up the row height inside a LazyColumn item.
 */
@Composable
fun InlineDiff(diff: String, modifier: Modifier = Modifier, maxRows: Int = 40) {
    val eink = LocalDisplayProfile.current.isEink
    val lines = remember(diff) { diff.split("\n") }
    val kinds = remember(diff) { classifyDiff(lines) }
    val hScroll = rememberScrollState()
    Column(modifier) {
        val shown = minOf(lines.size, maxRows)
        for (i in 0 until shown) DiffRow(lines[i], kinds[i], hScroll, eink)
        if (lines.size > maxRows) {
            Text(
                "…${lines.size - maxRows} more lines",
                Modifier.padding(horizontal = 10.dp, vertical = 2.dp),
                fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun diffLineStyle(kind: DiffLineKind, eink: Boolean): DiffLineStyle {
    val cs = MaterialTheme.colorScheme
    val gv = GitViewTheme.colors
    return when (kind) {
        DiffLineKind.HEADER, DiffLineKind.META -> DiffLineStyle(Color.Transparent, cs.onSurfaceVariant)
        DiffLineKind.HUNK ->
            if (eink) DiffLineStyle(cs.surfaceVariant, cs.onSurface, weight = FontWeight.Bold)
            else DiffLineStyle(cs.primary.copy(alpha = 0.14f), cs.primary)
        // E-Ink conveys add/remove by weight + strikethrough (ink over hue); Standard tints with the
        // spec add/remove roles. diffAddTint is the surfaceVariant band on E-Ink, the .13 tint on Standard;
        // diffRemoveTint is transparent on E-Ink (strikethrough carries it).
        DiffLineKind.ADD ->
            if (eink) DiffLineStyle(gv.diffAddTint, cs.onSurface, weight = FontWeight.Bold)
            else DiffLineStyle(gv.diffAddTint, gv.add)
        DiffLineKind.REMOVE ->
            if (eink) DiffLineStyle(gv.diffRemoveTint, cs.onSurface, decoration = TextDecoration.LineThrough)
            else DiffLineStyle(gv.diffRemoveTint, gv.remove)
        DiffLineKind.CONTEXT -> DiffLineStyle(Color.Transparent, cs.onSurface)
    }
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
