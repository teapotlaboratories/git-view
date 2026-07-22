package com.gitview.app.ui.state

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.gitview.app.ui.theme.GitViewTheme

/**
 * Loading placeholders. Per the handoff, loading is a **skeleton** (never a bare blank): a soft pulse on
 * Standard, and **static grey** on E-Ink or when "Reduce motion" is on — both gated by the motion token,
 * so the pulse never ghosts an EPD. Skeletons mirror the shape of the content they stand in for.
 */

/** One grey block. Pulses when motion is enabled; a flat surfaceVariant fill otherwise. */
@Composable
fun SkeletonBox(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(6.dp)) {
    val alpha = if (GitViewTheme.motion.enabled) {
        val t = rememberInfiniteTransition(label = "skeleton")
        val a by t.animateFloat(
            initialValue = 0.35f, targetValue = 0.75f,
            animationSpec = infiniteRepeatable(tween(720, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "pulse",
        )
        a
    } else {
        1f
    }
    androidx.compose.foundation.layout.Box(
        modifier.clip(shape).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = alpha)),
    )
}

/** A single skeleton text line of the given height. */
@Composable
fun SkeletonLine(fraction: Float = 1f, height: Dp = 12.dp, modifier: Modifier = Modifier) {
    SkeletonBox(modifier.fillMaxWidth(fraction).height(height))
}

/** A card-shaped skeleton (title + two meta lines) — for the Connections / Repos / History lists. */
@Composable
fun SkeletonCard(modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SkeletonLine(0.5f, 16.dp)
            SkeletonLine(0.8f, 12.dp)
            SkeletonLine(0.35f, 12.dp)
        }
    }
}

/** A vertical stack of [SkeletonCard]s — the standard "list loading" placeholder. */
@Composable
fun SkeletonCards(count: Int = 3, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) { SkeletonCard() }
    }
}
