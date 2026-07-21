package com.gitview.app.ui.permission

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.theme.GitViewTheme

/**
 * The 0..4 risk signal. Standard: four bars filled up to [risk] in the risk-ramp color. Color E-Ink:
 * filled/empty squares (ink over hue) plus a `LEVEL · n/4` text label. The label also shows on Standard
 * when [showLabel] is set.
 */
@Composable
fun RiskMeter(risk: Int, riskLabel: String, modifier: Modifier = Modifier, showLabel: Boolean = false) {
    val eink = GitViewTheme.profile.isEink
    val colors = GitViewTheme.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
            for (i in 1..4) {
                val filled = i <= risk
                if (eink) {
                    Box(
                        Modifier.size(11.dp)
                            .border(GitViewTheme.spacing.hairline, colors.textHi, RoundedCornerShape(2.dp))
                            .background(if (filled) colors.textHi else Color.Transparent, RoundedCornerShape(2.dp)),
                    )
                } else {
                    Box(
                        Modifier.size(width = 6.dp, height = 13.dp)
                            .background(if (filled) colors.riskColor(risk) else colors.border, RoundedCornerShape(2.dp)),
                    )
                }
            }
        }
        if (eink || showLabel) {
            Text(
                if (eink) "${riskLabel.uppercase()} · $risk/4" else riskLabel,
                fontSize = 11.sp,
                fontWeight = if (eink) FontWeight.Medium else FontWeight.Normal,
                color = if (eink) colors.textHi else colors.riskColor(risk),
            )
        }
    }
}
