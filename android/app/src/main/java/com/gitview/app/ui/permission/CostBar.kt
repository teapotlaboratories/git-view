package com.gitview.app.ui.permission

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.theme.GitViewTheme

/**
 * `Turn $ · Session $` against a budget `LinearProgressIndicator`. At/over budget the row + bar turn
 * to the danger role with a warn line — a soft cap: the current turn still finishes (never hard-stop).
 */
@Composable
fun CostBar(turnUsd: Double, sessionUsd: Double, budgetUsd: Double?, modifier: Modifier = Modifier) {
    val colors = GitViewTheme.colors
    val over = budgetUsd != null && budgetUsd > 0 && sessionUsd >= budgetUsd
    val frac = if (budgetUsd != null && budgetUsd > 0) (sessionUsd / budgetUsd).coerceIn(0.0, 1.0).toFloat() else 0f
    Column(
        modifier.fillMaxWidth().padding(horizontal = GitViewTheme.spacing.md, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Turn $${"%.3f".format(turnUsd)}  ·  Session $${"%.3f".format(sessionUsd)}",
                fontFamily = FontFamily.Monospace, fontSize = 11.5.sp,
                color = if (over) colors.remove else colors.textLow,
            )
            Spacer(Modifier.weight(1f))
            if (budgetUsd != null) {
                Text(
                    "/ $${"%.2f".format(budgetUsd)}", fontFamily = FontFamily.Monospace, fontSize = 11.5.sp,
                    color = colors.textFaint,
                )
            }
        }
        if (budgetUsd != null && budgetUsd > 0) {
            LinearProgressIndicator(
                progress = { frac },
                modifier = Modifier.fillMaxWidth().height(3.dp),
                color = if (over) colors.remove else colors.primary,
                trackColor = colors.border,
            )
        }
        if (over) {
            Text("Budget reached — the current turn will finish.", fontSize = 11.sp, color = colors.remove)
        }
    }
}
