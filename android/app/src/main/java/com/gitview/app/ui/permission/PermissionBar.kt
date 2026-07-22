package com.gitview.app.ui.permission

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gitview.app.data.PermissionProfile
import com.gitview.app.ui.theme.GitViewTheme

/**
 * The persistent bar above the composer: active tier + [RiskMeter] + label; tap opens the tier sheet.
 * The `Unrestricted` (critical) tier paints a persistent red-tinted bar for the whole session.
 */
@Composable
fun PermissionBar(profile: PermissionProfile, onOpenSheet: () -> Unit, modifier: Modifier = Modifier) {
    val tier = tierOf(profile)
    val colors = GitViewTheme.colors
    val critical = tier.risk >= 4
    // The persistent danger cue: a red wash on Standard. On E-Ink (hueless) the wash vanishes, so a
    // tier-colored border + BOLD label carry it (the RiskMeter already shows the "CRITICAL · 4/4" badge).
    val bg = if (critical && !colors.hueless) colors.remove.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface
    Row(
        modifier
            .fillMaxWidth()
            .background(bg)
            .then(if (critical) Modifier.border(GitViewTheme.spacing.hairline, colors.remove) else Modifier)
            .clickable { onOpenSheet() }
            .heightIn(min = GitViewTheme.spacing.touchTarget)
            .padding(horizontal = GitViewTheme.spacing.md, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(
            Icons.Filled.Shield, contentDescription = null, modifier = Modifier.size(16.dp),
            tint = if (critical) colors.remove else colors.textLow,
        )
        Text(
            tier.name, style = MaterialTheme.typography.labelLarge, color = colors.textHi,
            fontWeight = if (critical) FontWeight.Bold else FontWeight.Medium,
        )
        Spacer(Modifier.width(2.dp))
        RiskMeter(tier.risk, tier.riskLabel)
        Spacer(Modifier.weight(1f))
        Icon(
            Icons.Filled.KeyboardArrowUp, contentDescription = "change tier", modifier = Modifier.size(18.dp),
            tint = colors.textLow,
        )
    }
}
