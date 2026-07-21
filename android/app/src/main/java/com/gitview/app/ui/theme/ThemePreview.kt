package com.gitview.app.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/**
 * Two-profile token gallery — the step-1 merge gate (see ADR-023). Renders the stock Material 3
 * components most likely to leak a wrong (baseline-purple) role when the derived scheme is incomplete
 * — TopAppBar, Card, FilterChip, SegmentedButton, Snackbar — plus swatches of the extended
 * [GitViewColors] tokens and the risk ramp, under BOTH profiles. Open in the Android Studio preview
 * pane to confirm both profiles read in-palette. These custom tokens are profile-driven, so pass the
 * profile explicitly — `@Preview(uiMode = NIGHT_YES)` does NOT switch them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThemeGallery() {
    Surface(color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TopAppBar(title = { Text("Bridges") }, actions = { Icon(Icons.Filled.Add, contentDescription = null) })

            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("studio-mini", style = MaterialTheme.typography.titleMedium)
                        Text("Online · used 2m ago", style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = true, onClick = {}, label = { Text("Ask first") })
                    FilterChip(selected = false, onClick = {}, label = { Text("Auto-edit") })
                    AssistChip(onClick = {}, label = { Text("main") })
                }

                SingleChoiceSegmentedButtonRow {
                    SegmentedButton(selected = true, onClick = {},
                        shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("Files") }
                    SegmentedButton(selected = false, onClick = {},
                        shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Chat") }
                }

                Snackbar { Text("Saved auth.ts") }

                HorizontalDivider(color = MaterialTheme.colorScheme.outline)

                // Extended-token swatches.
                val c = GitViewTheme.colors
                Text("Extended tokens", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Swatch(c.textHi); Swatch(c.textMid); Swatch(c.textLow); Swatch(c.textFaint)
                    Swatch(c.border); Swatch(c.borderStrong); Swatch(c.primary); Swatch(c.primarySoft)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Swatch(c.add); Swatch(c.remove); Swatch(c.warning); Swatch(c.info)
                }
                Text("Risk ramp 0..4", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (level in 0..4) Swatch(c.riskColor(level))
                }
            }
        }
    }
}

@Composable
private fun Swatch(color: Color) {
    Spacer(
        Modifier.size(28.dp)
            .background(color, RoundedCornerShape(4.dp)),
    )
}

@Preview(name = "Standard", widthDp = 400, heightDp = 640)
@Composable
private fun StandardThemePreview() {
    GitViewTheme(DisplayProfile.STANDARD) { ThemeGallery() }
}

@Preview(name = "Color E-Ink", widthDp = 400, heightDp = 640)
@Composable
private fun EinkThemePreview() {
    GitViewTheme(DisplayProfile.COLOR_EINK) { ThemeGallery() }
}
