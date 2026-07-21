package com.gitview.app.ui.permission

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.InlineDiff
import com.gitview.app.ui.chat.PendingPermission
import com.gitview.app.ui.chat.toolDisplayName
import com.gitview.app.ui.theme.GitViewTheme

/**
 * The inline "Ask first" gate: the agent is paused on a specific tool call. Shows the target + an
 * Edit's inline diff (or a command), then Deny / Allow for session / Allow once. "Allow for session"
 * upgrades the tier to Auto-edit. An emphasis border marks it as needing action, on both profiles.
 */
@Composable
fun InlineApprovalCard(
    item: PendingPermission,
    onDecision: (allow: Boolean, scope: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = GitViewTheme.colors
    val shape = MaterialTheme.shapes.medium
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(GitViewTheme.spacing.hairline, colors.borderStrong, shape)
            .padding(GitViewTheme.spacing.md),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            "Allow ${toolDisplayName(item.kind, item.name)}?",
            style = MaterialTheme.typography.titleMedium, color = colors.textHi,
        )
        if (item.path != null) {
            Text(
                item.path, fontFamily = FontFamily.Monospace, fontSize = 11.5.sp, color = colors.textLow,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        when {
            item.editDiff != null -> InlineDiff(item.editDiff, Modifier.fillMaxWidth())
            item.subtitle != null -> Text(
                item.subtitle, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.textMid,
            )
        }
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            TextButton(onClick = { onDecision(false, "once") }) {
                Text("Deny", color = if (colors.hueless) colors.textHi else colors.remove)
            }
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = { onDecision(true, "session") }) { Text("Allow for session") }
            Spacer(Modifier.width(8.dp))
            Button(onClick = { onDecision(true, "once") }) { Text("Allow once") }
        }
    }
}
