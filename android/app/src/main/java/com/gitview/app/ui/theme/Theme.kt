package com.gitview.app.ui.theme

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

/**
 * GitView's two themes. Standard is a sleek dark IDE palette tuned to match the Dark+ code editor
 * (one cohesive surface, not light chrome around a dark editor). Color E-Ink is a near-mono,
 * maximum-contrast light theme for Kaleido 3. See docs/EINK.md and ADR-005.
 */

// VS Code-like dark palette.
private object Ide {
    val bg = Color(0xFF1E1E1E)          // editor background
    val panel = Color(0xFF252526)       // side panels / bars
    val elevated = Color(0xFF2D2D30)    // cards / inputs
    val border = Color(0xFF3C3C3C)
    val accent = Color(0xFF0E7ACC)      // VS Code blue
    val accentSoft = Color(0xFF569CD6)
    val text = Color(0xFFD4D4D4)
    val textDim = Color(0xFF9DA5B4)
    val danger = Color(0xFFF48771)
    val green = Color(0xFF4EC9B0)
}

private val IdeDark = darkColorScheme(
    primary = Ide.accentSoft,
    onPrimary = Color(0xFF04263F),
    primaryContainer = Ide.accent,
    onPrimaryContainer = Color.White,
    secondary = Ide.green,
    onSecondary = Color(0xFF04211B),
    background = Ide.bg,
    onBackground = Ide.text,
    surface = Ide.panel,
    onSurface = Ide.text,
    surfaceVariant = Ide.elevated,
    onSurfaceVariant = Ide.textDim,
    surfaceContainer = Ide.panel,
    surfaceContainerHigh = Ide.elevated,
    outline = Ide.border,
    outlineVariant = Ide.border,
    error = Ide.danger,
    onError = Color(0xFF3A0906),
)

// Color E-Ink: near-mono, maximum contrast. Ink over hue (Kaleido 3 is muted/low-PPI).
private val EinkScheme = lightColorScheme(
    primary = Color(0xFF000000),
    onPrimary = Color(0xFFFFFFFF),
    secondary = Color(0xFF222222),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF000000),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF000000),
    surfaceVariant = Color(0xFFEDEDED),
    onSurfaceVariant = Color(0xFF111111),
    outline = Color(0xFF000000),
    error = Color(0xFF000000),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitViewTheme(profile: DisplayProfile, content: @Composable () -> Unit) {
    val scheme = if (profile.isEink) EinkScheme else IdeDark
    CompositionLocalProvider(
        LocalDisplayProfile provides profile,
        // null disables ripple entirely — no visual noise, fewer EPD refreshes on e-ink.
        LocalRippleConfiguration provides if (profile.isEink) null else RippleConfiguration(),
    ) {
        MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
    }
}
