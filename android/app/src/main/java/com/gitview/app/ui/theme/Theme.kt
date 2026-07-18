package com.gitview.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * App theme. Provides the active [DisplayProfile] to the tree. The Color-E-Ink profile's full
 * effects (mono scheme, no-animation, pagination) are wired in Phase 1/8 — see docs/EINK.md.
 */
@Composable
fun GitViewTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
    MaterialTheme(colorScheme = colors) {
        CompositionLocalProvider(LocalDisplayProfile provides DisplayProfile.default()) {
            content()
        }
    }
}
