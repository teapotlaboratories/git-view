package com.gitview.app.ui.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DragIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp

/**
 * Two side-by-side panes with a movable vertical divider — reused for BOTH Workspace dividers
 * (tree ↔ editor and editor ↔ chat) by nesting. The live [ratio] (left share, 0..1) drives the pane
 * weights, clamped to [[minRatio], [maxRatio]]; the final value is committed via [onRatioChange] so the
 * caller can persist it.
 *
 * On Standard the divider is **draggable** (continuous). On [eink] the split still shows — E-Ink is a
 * co-primary profile — but the divider is **tap-to-cycle** through [einkPresets] instead of a continuous
 * drag, so there's no continuous-motion repaint/ghosting.
 */
@Composable
fun DraggableSplit(
    ratio: Float,
    onRatioChange: (Float) -> Unit,
    handleColor: Color,
    eink: Boolean,
    modifier: Modifier = Modifier,
    minRatio: Float = 0.25f,
    maxRatio: Float = 0.8f,
    einkPresets: List<Float> = listOf(0.35f, 0.5f, 0.65f),
    left: @Composable () -> Unit,
    right: @Composable () -> Unit,
) {
    BoxWithConstraints(modifier) {
        val totalPx = constraints.maxWidth.toFloat().coerceAtLeast(1f)
        var frac by remember { mutableFloatStateOf(ratio) }
        LaunchedEffect(ratio) { frac = ratio } // sync when the persisted value loads/changes externally
        val f = frac.coerceIn(minRatio, maxRatio)
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxHeight().weight(f)) { left() }
            if (eink) {
                // Discrete tap-to-cycle: no continuous drag (avoids EPD ghosting on the split).
                Box(
                    Modifier
                        .width(18.dp)
                        .fillMaxHeight()
                        .background(handleColor)
                        .clickable {
                            val next = einkPresets.firstOrNull { it > f + 0.01f } ?: einkPresets.first()
                            frac = next
                            onRatioChange(next)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.DragIndicator, "adjust split", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                Box(
                    Modifier
                        .width(8.dp)
                        .fillMaxHeight()
                        .background(handleColor)
                        .pointerInput(totalPx) {
                            detectHorizontalDragGestures(
                                onDragEnd = { onRatioChange(frac) },
                            ) { _, dragAmount ->
                                frac = (frac + dragAmount / totalPx).coerceIn(minRatio, maxRatio)
                            }
                        },
                )
            }
            Box(Modifier.fillMaxHeight().weight(1f - f)) { right() }
        }
    }
}
