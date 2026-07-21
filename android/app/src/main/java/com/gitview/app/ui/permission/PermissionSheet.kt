package com.gitview.app.ui.permission

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.data.PermissionProfile
import com.gitview.app.ui.theme.GitViewTheme

/**
 * The tier picker: a `ModalBottomSheet` listing all six tiers (name, risk meter, description,
 * `was: <old>`, selected check). Tapping a tier selects it; the critical `Unrestricted` tier requires
 * a **hold** (long-press) to select. Rows are ≥ the profile touch target (48dp Std / 56dp E-Ink).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PermissionSheet(current: PermissionProfile, onSelect: (PermissionProfile) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = GitViewTheme.spacing.md, vertical = 4.dp)) {
            Text(
                "Permission tier", style = MaterialTheme.typography.headlineSmall,
                color = GitViewTheme.colors.textHi, modifier = Modifier.padding(vertical = 8.dp),
            )
            PERMISSION_TIERS.forEach { tier ->
                TierRow(tier, selected = tier.profile == current) {
                    onSelect(tier.profile); onDismiss()
                }
            }
            Spacer(Modifier.size(GitViewTheme.spacing.md))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TierRow(tier: TierInfo, selected: Boolean, onSelect: () -> Unit) {
    val colors = GitViewTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GitViewTheme.spacing.touchTarget)
            .combinedClickable(
                onClick = { if (!tier.holdToConfirm) onSelect() },
                onLongClick = { if (tier.holdToConfirm) onSelect() },
            )
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .padding(horizontal = 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(tier.name, style = MaterialTheme.typography.titleMedium, color = colors.textHi)
                RiskMeter(tier.risk, tier.riskLabel)
            }
            Text(tier.description, style = MaterialTheme.typography.bodySmall, color = colors.textLow)
            Text(
                "was: ${tier.was}" + if (tier.holdToConfirm) "  ·  hold to select" else "",
                fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = colors.textFaint,
            )
        }
        if (selected) Icon(Icons.Filled.Check, "selected", modifier = Modifier.size(20.dp), tint = colors.primary)
    }
}
