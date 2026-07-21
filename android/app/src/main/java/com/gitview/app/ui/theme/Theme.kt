package com.gitview.app.ui.theme

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.OverscrollConfiguration
import androidx.compose.foundation.LocalOverscrollConfiguration
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/**
 * GitView's ProfileTheme — the token swap + motion gate for the two co-primary display profiles
 * (Standard dark violet / Color E-Ink paper). It:
 *  - builds a Material 3 [ColorScheme] from the same [StandardPalette]/[EinkPalette] constants as the
 *    extended [GitViewColors], mapping EVERY role so stock components (chips, segmented buttons,
 *    bottom sheets, top bars, snackbars, menus) are correct in both profiles — no baseline purple;
 *  - provides the extended color / spacing / motion tokens, profile-aware typography + shapes;
 *  - gates the ripple (null on E-Ink — no EPD churn). `surfaceTint = Transparent` in both schemes
 *    keeps surfaces flat (no primary-tinted elevation wash; depth is deferred to step 2 — ADR-023).
 *
 * Access tokens via the [GitViewTheme] object, mirroring `MaterialTheme.colorScheme`:
 *   `GitViewTheme.colors.textLow` · `GitViewTheme.spacing.md` · `GitViewTheme.motion.enter`
 *
 * See docs/EINK.md, docs/DECISIONS.md ADR-005 / ADR-023.
 */

// --- Derived Material 3 schemes (built from the palette constants; all roles set) ----------------

private val StandardColorScheme: ColorScheme = darkColorScheme(
    primary = StandardPalette.primary,
    onPrimary = StandardPalette.onPrimary,
    primaryContainer = StandardPalette.primary,           // user chat bubble
    onPrimaryContainer = StandardPalette.onPrimary,
    inversePrimary = StandardPalette.primarySoft,
    secondary = StandardPalette.primarySoft,
    onSecondary = StandardPalette.onPrimary,
    secondaryContainer = StandardPalette.surfaceVariant,  // selected chip / segmented fill
    onSecondaryContainer = StandardPalette.textHi,
    tertiary = StandardPalette.info,
    onTertiary = StandardPalette.onPrimary,
    tertiaryContainer = StandardPalette.surfaceVariant,
    onTertiaryContainer = StandardPalette.textHi,
    background = StandardPalette.background,
    onBackground = StandardPalette.textMid,
    surface = StandardPalette.surface,
    onSurface = StandardPalette.textHi,
    surfaceVariant = StandardPalette.surfaceVariant,
    onSurfaceVariant = StandardPalette.textLow,           // dim / meta text
    surfaceTint = Color.Transparent,                      // flat — no primary elevation wash
    inverseSurface = StandardPalette.textHi,
    inverseOnSurface = StandardPalette.background,
    error = StandardPalette.remove,
    onError = StandardPalette.onPrimary,
    errorContainer = StandardPalette.surfaceVariant,
    onErrorContainer = StandardPalette.remove,
    outline = StandardPalette.border,                     // hairlines / dividers
    outlineVariant = StandardPalette.border,
    scrim = Color(0xCC000000),
    surfaceBright = StandardPalette.surfaceVariant,
    surfaceDim = StandardPalette.background,
    surfaceContainerLowest = StandardPalette.background,
    surfaceContainerLow = StandardPalette.surface,
    surfaceContainer = StandardPalette.surface,           // menus, sheets
    surfaceContainerHigh = StandardPalette.surfaceVariant,
    surfaceContainerHighest = StandardPalette.surfaceVariant,
)

private val EinkColorScheme: ColorScheme = lightColorScheme(
    primary = EinkPalette.accent,
    onPrimary = EinkPalette.onAccent,
    primaryContainer = EinkPalette.surfaceVariant,        // user bubble = filled surface, not violet
    onPrimaryContainer = EinkPalette.inkHi,
    inversePrimary = EinkPalette.accent,
    secondary = EinkPalette.accent,
    onSecondary = EinkPalette.onAccent,
    secondaryContainer = EinkPalette.surfaceVariant,      // selected chip / segmented = filled surface
    onSecondaryContainer = EinkPalette.inkHi,
    tertiary = EinkPalette.inkHi,
    onTertiary = EinkPalette.paper,
    tertiaryContainer = EinkPalette.surfaceVariant,
    onTertiaryContainer = EinkPalette.inkHi,
    background = EinkPalette.background,
    onBackground = EinkPalette.inkHi,
    surface = EinkPalette.surface,
    onSurface = EinkPalette.inkHi,                         // near-black: high contrast, no gray ghosting
    surfaceVariant = EinkPalette.surfaceVariant,
    onSurfaceVariant = EinkPalette.inkMid,                 // still dark, not low-contrast gray
    surfaceTint = Color.Transparent,                       // depth is border on e-ink, never a tint
    inverseSurface = EinkPalette.inkHi,
    inverseOnSurface = EinkPalette.surface,
    error = EinkPalette.inkHi,                              // no hue; destructive conveyed by text/weight
    onError = EinkPalette.paper,
    errorContainer = EinkPalette.surfaceVariant,
    onErrorContainer = EinkPalette.inkHi,
    outline = EinkPalette.border,                          // hairlines (visible on Kaleido)
    outlineVariant = EinkPalette.border,
    scrim = Color(0x33000000),                             // light scrim — heavy black dithers on EPD
    surfaceBright = EinkPalette.surface,
    surfaceDim = EinkPalette.surfaceVariant,
    surfaceContainerLowest = EinkPalette.surface,
    surfaceContainerLow = EinkPalette.surface,
    surfaceContainer = EinkPalette.surface,
    surfaceContainerHigh = EinkPalette.surfaceVariant,
    surfaceContainerHighest = EinkPalette.surfaceVariant,
)

// --- The applier ----------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun GitViewTheme(
    profile: DisplayProfile,
    settings: DisplaySettings = DisplaySettings(),
    content: @Composable () -> Unit,
) {
    val eink = profile.isEink
    // VISUALS follow the profile; MOTION follows the user's "Reduce motion" toggle (default off — the
    // Bigme is 80Hz, see ADR-028). So an E-Ink user can keep smooth motion, and a Standard user can calm it.
    val calm = settings.reduceMotion
    val colorScheme = if (eink) EinkColorScheme else StandardColorScheme
    val gitViewColors = if (eink) einkGitViewColors else standardGitViewColors
    val spacing = if (eink) einkSpacing else standardSpacing
    val motion = if (calm) einkMotion else standardMotion

    CompositionLocalProvider(
        LocalDisplayProfile provides profile,
        LocalDisplaySettings provides settings,
        LocalGitViewColors provides gitViewColors,
        LocalSpacing provides spacing,
        LocalMotion provides motion,
        // null disables the M3 ripple / stretch-overscroll entirely when motion is reduced — no visual
        // noise, fewer EPD refreshes. (DisplayProfile.kt documented "overscroll OFF"; now enforced here.)
        LocalRippleConfiguration provides if (calm) null else RippleConfiguration(),
        LocalOverscrollConfiguration provides if (calm) null else OverscrollConfiguration(),
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = profileTypography(profile),
            shapes = profileShapes(profile),
            content = content,
        )
    }
}

// --- Token accessor (mirrors MaterialTheme.colorScheme) -------------------------------------------

/** Read GitView's extended tokens: `GitViewTheme.colors` / `.spacing` / `.motion` / `.profile`. */
object GitViewTheme {
    val colors: GitViewColors
        @Composable @ReadOnlyComposable get() = LocalGitViewColors.current
    val spacing: Spacing
        @Composable @ReadOnlyComposable get() = LocalSpacing.current
    val motion: Motion
        @Composable @ReadOnlyComposable get() = LocalMotion.current
    val profile: DisplayProfile
        @Composable @ReadOnlyComposable get() = LocalDisplayProfile.current
    val settings: DisplaySettings
        @Composable @ReadOnlyComposable get() = LocalDisplaySettings.current
}
