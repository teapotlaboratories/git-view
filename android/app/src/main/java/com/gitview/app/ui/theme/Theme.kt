package com.gitview.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

private val StandardLight = lightColorScheme()
private val StandardDark = darkColorScheme()

// Color E-Ink: near-mono, maximum contrast. Kaleido 3 colour is muted/low-PPI, so we lean on ink,
// not hue. Accents are dark, backgrounds pure white — legibility over vibrancy.
private val EinkScheme = lightColorScheme(
    primary = Color(0xFF000000),
    onPrimary = Color(0xFFFFFFFF),
    secondary = Color(0xFF222222),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF000000),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF000000),
    surfaceVariant = Color(0xFFEDEDED),
    outline = Color(0xFF000000),
    error = Color(0xFF000000),
)

/**
 * Applies the theme for the active [DisplayProfile]. For Color E-Ink we additionally DISABLE ripple
 * (visual noise + extra EPD refreshes) via LocalRippleConfiguration. Animation/scroll differences are
 * applied at the call sites that read [LocalDisplayProfile].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitViewTheme(profile: DisplayProfile, content: @Composable () -> Unit) {
    val scheme = when (profile) {
        DisplayProfile.COLOR_EINK -> EinkScheme
        DisplayProfile.STANDARD -> if (isSystemInDarkTheme()) StandardDark else StandardLight
    }
    CompositionLocalProvider(
        LocalDisplayProfile provides profile,
        // null disables ripple entirely — no visual noise, fewer EPD refreshes on e-ink.
        LocalRippleConfiguration provides if (profile.isEink) null else RippleConfiguration(),
    ) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
