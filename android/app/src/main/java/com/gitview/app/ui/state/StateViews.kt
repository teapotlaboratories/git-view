package com.gitview.app.ui.state

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.theme.GitViewTheme

enum class BannerTone { Warning, Info }

/**
 * A full-width status bar (offline / reconnecting / no-network / read-only), optionally with a trailing
 * action. Hueless-safe: Standard gets a tinted wash; E-Ink drops the hue and carries the meaning with a
 * strong border + bold text (same degrade as PermissionBar's critical tier).
 */
@Composable
fun StatusBanner(
    text: String,
    modifier: Modifier = Modifier,
    tone: BannerTone = BannerTone.Warning,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val col = GitViewTheme.colors
    val accent = if (tone == BannerTone.Warning) col.warning else col.info
    val hueless = col.hueless
    val bg = if (hueless) MaterialTheme.colorScheme.surfaceVariant else accent.copy(alpha = 0.14f)
    Row(
        modifier
            .fillMaxWidth()
            .background(bg)
            .then(if (hueless) Modifier.border(GitViewTheme.spacing.hairline, col.borderStrong) else Modifier)
            .padding(horizontal = GitViewTheme.spacing.md, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text, modifier = Modifier.weight(1f), fontSize = 13.sp,
            fontWeight = if (hueless) FontWeight.SemiBold else FontWeight.Medium, color = col.textHi,
        )
        if (actionLabel != null && onAction != null) {
            Text(
                actionLabel, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                color = if (hueless) col.textHi else col.primary,
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .clickable(onClick = onAction)
                    .heightIn(min = GitViewTheme.spacing.touchTarget)
                    .widthIn(min = 44.dp)
                    .padding(horizontal = 8.dp, vertical = 12.dp),
            )
        }
    }
}

/** Centered empty-state: icon + title + optional subtitle + optional action button. */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val col = GitViewTheme.colors
    Column(
        modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = col.textLow, modifier = Modifier.size(40.dp))
            Spacer(Modifier.size(12.dp))
        }
        Text(title, fontWeight = FontWeight.Medium, fontSize = 15.sp, color = col.textHi, textAlign = TextAlign.Center)
        if (subtitle != null) {
            Spacer(Modifier.size(4.dp))
            Text(subtitle, fontSize = 13.sp, color = col.textLow, textAlign = TextAlign.Center)
        }
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.size(16.dp))
            OutlinedButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}
