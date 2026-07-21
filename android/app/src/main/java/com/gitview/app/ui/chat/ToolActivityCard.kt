package com.gitview.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.InlineDiff
import com.gitview.app.ui.theme.GitViewTheme

/**
 * A collapsed/expandable tool call. Collapsed: caret + tool name (accent on Standard, weight on
 * E-Ink) + mono path + a result badge (`142 lines ✓`) / spinner (running) / `✕` (error). Expanded:
 * an Edit/Write shows the write as a shared [InlineDiff]; a Read/Bash/Grep shows the (truncated)
 * result preview; otherwise the call args. Standard animates the body; E-Ink is static (no ghosting).
 */
@Composable
fun ToolActivityCard(item: ToolActivity, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val eink = GitViewTheme.profile.isEink
    val colors = GitViewTheme.colors
    val shape = MaterialTheme.shapes.small
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .then(if (eink) Modifier.border(GitViewTheme.spacing.hairline, colors.border, shape) else Modifier),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { onToggle() }.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (item.expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowRight,
                contentDescription = if (item.expanded) "collapse" else "expand",
                modifier = Modifier.size(18.dp), tint = colors.textLow,
            )
            Spacer(Modifier.width(4.dp))
            Text(
                toolDisplayName(item.kind, item.name),
                color = if (eink) colors.textHi else colors.primarySoft,
                fontWeight = if (eink) FontWeight.Medium else FontWeight.SemiBold,
                fontSize = 13.sp,
            )
            Spacer(Modifier.width(8.dp))
            if (item.path != null) {
                Text(
                    item.path, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp,
                    color = colors.textLow, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.width(8.dp))
            ToolBadge(item.status, item.badge, eink)
        }
        if (eink) {
            if (item.expanded) ToolBody(item)
        } else {
            AnimatedVisibility(item.expanded, enter = GitViewTheme.motion.enter, exit = GitViewTheme.motion.exit) {
                ToolBody(item)
            }
        }
    }
}

@Composable
private fun ToolBadge(status: ToolStatus, badge: String?, eink: Boolean) {
    val colors = GitViewTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (badge != null && status != ToolStatus.RUNNING) {
            Text(badge, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, color = colors.textLow, maxLines = 1)
        }
        when (status) {
            ToolStatus.RUNNING ->
                if (eink) Text("…", fontSize = 13.sp, color = colors.textLow)
                else CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.5.dp, color = colors.primary)
            ToolStatus.OK ->
                Text("✓", fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    color = if (colors.hueless) colors.textHi else colors.add)
            ToolStatus.ERROR ->
                Text("✕", fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    color = if (colors.hueless) colors.textHi else colors.remove)
        }
    }
}

@Composable
private fun ToolBody(item: ToolActivity) {
    val colors = GitViewTheme.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp).padding(bottom = 8.dp)) {
        HorizontalDivider(color = colors.border, modifier = Modifier.padding(bottom = 6.dp))
        when {
            item.editDiff != null -> InlineDiff(item.editDiff, Modifier.fillMaxWidth())
            item.preview != null -> PreviewBlock(item.preview)
            item.subtitle != null -> Text(
                item.subtitle, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.textMid,
            )
            item.status == ToolStatus.RUNNING -> Text("running…", fontSize = 12.sp, color = colors.textLow)
            else -> Text("(no details)", fontSize = 12.sp, color = colors.textLow)
        }
    }
}

/**
 * Renders a (truncated) tool result as a mono block. Read results arrive already line-numbered by the
 * tool (`N⇥content`), and Bash/Grep output is raw — so this adds no numbering of its own.
 */
@Composable
private fun PreviewBlock(text: String, maxRows: Int = 40) {
    val colors = GitViewTheme.colors
    val hScroll = rememberScrollState()
    val lines = remember(text) { text.split("\n") }
    Column(Modifier.fillMaxWidth()) {
        val shown = minOf(lines.size, maxRows)
        for (i in 0 until shown) {
            Text(
                lines[i].ifEmpty { " " }, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                color = colors.textMid, softWrap = false, maxLines = 1,
                modifier = Modifier.fillMaxWidth().horizontalScroll(hScroll),
            )
        }
        if (lines.size > maxRows) {
            Text(
                "…${lines.size - maxRows} more lines", fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                color = colors.textLow, modifier = Modifier.padding(top = 2.dp),
            )
        }
    }
}
