package com.gitview.app.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import com.gitview.app.ui.theme.GitViewTheme

/**
 * Streaming assistant text. Empty while streaming → a "Thinking" indicator (animated dots on Standard,
 * static on E-Ink, via the motion gate). Non-empty → the markdown body. The per-token (Standard) vs
 * per-line (E-Ink) reveal cadence is decided upstream in the ViewModel; this renders the current text.
 */
@Composable
fun StreamingText(text: String, streaming: Boolean, modifier: Modifier = Modifier) {
    if (text.isEmpty()) {
        if (streaming) ThinkingIndicator(modifier)
        return
    }
    Column(modifier) { MarkdownText(text) }
}

@Composable
private fun ThinkingIndicator(modifier: Modifier = Modifier) {
    val dots = if (GitViewTheme.motion.enabled) {
        val transition = rememberInfiniteTransition(label = "thinking")
        val f by transition.animateFloat(
            initialValue = 0f, targetValue = 3f,
            animationSpec = infiniteRepeatable(tween(1200), RepeatMode.Restart), label = "dots",
        )
        ".".repeat(f.toInt().coerceIn(0, 2) + 1)
    } else {
        "…"
    }
    Text(
        "Thinking$dots",
        modifier = modifier,
        style = MaterialTheme.typography.bodyMedium,
        color = GitViewTheme.colors.textLow,
    )
}
