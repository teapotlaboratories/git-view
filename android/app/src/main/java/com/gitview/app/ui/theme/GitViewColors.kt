package com.gitview.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Extended color tokens beyond Material 3's ColorScheme slots: the 4-level text ramp, the two border
 * weights, the semantic add/remove/warning/info roles, the diff line tints, and the 0..4 risk ramp.
 * Provided via [LocalGitViewColors] ALONGSIDE a derived M3 ColorScheme (see [GitViewTheme]); both are
 * built from [StandardPalette]/[EinkPalette] so they never drift.
 *
 * On Color E-Ink the semantic roles have no hue — [hueless] is true and add/remove/warning/info/risk
 * resolve to ink. Components must then carry the meaning by weight / strikethrough / filled squares /
 * text badges, never by these colors. Access via `GitViewTheme.colors` (mirrors MaterialTheme.colorScheme).
 */
@Immutable
class GitViewColors(
    // text ramp (high → faint)
    val textHi: Color,
    val textMid: Color,
    val textLow: Color,
    val textFaint: Color,
    // structure
    val border: Color,
    val borderStrong: Color,
    // accent
    val primary: Color,
    val primarySoft: Color,
    val onPrimary: Color,
    // semantics (ink, not hue, on E-Ink)
    val add: Color,
    val remove: Color,
    val warning: Color,
    val info: Color,
    // diff line backgrounds
    val diffAddTint: Color,
    val diffRemoveTint: Color,
    // 0..4 risk ramp, indexed by level (None, Low, Medium, High, Critical)
    val risk: List<Color>,
    // true on Color E-Ink: semantics carried by weight/decoration, not by the hues above
    val hueless: Boolean,
) {
    /** Risk color for a 0..4 level (clamped). */
    fun riskColor(level: Int): Color = risk[level.coerceIn(0, risk.lastIndex)]
}

internal val standardGitViewColors = GitViewColors(
    textHi = StandardPalette.textHi,
    textMid = StandardPalette.textMid,
    textLow = StandardPalette.textLow,
    textFaint = StandardPalette.textFaint,
    border = StandardPalette.border,
    borderStrong = StandardPalette.borderStrong,
    primary = StandardPalette.primary,
    primarySoft = StandardPalette.primarySoft,
    onPrimary = StandardPalette.onPrimary,
    add = StandardPalette.add,
    remove = StandardPalette.remove,
    warning = StandardPalette.warning,
    info = StandardPalette.info,
    diffAddTint = StandardPalette.addTint,
    diffRemoveTint = StandardPalette.removeTint,
    risk = listOf(
        StandardPalette.riskNone,
        StandardPalette.riskLow,
        StandardPalette.riskMedium,
        StandardPalette.riskHigh,
        StandardPalette.riskCritical,
    ),
    hueless = false,
)

internal val einkGitViewColors = GitViewColors(
    textHi = EinkPalette.inkHi,
    textMid = EinkPalette.inkMid,
    textLow = EinkPalette.inkLow,
    textFaint = EinkPalette.inkLow,          // E-Ink has no 'faint' tier; floor at inkLow (min-weight-500 territory)
    border = EinkPalette.border,
    borderStrong = EinkPalette.borderStrong,
    primary = EinkPalette.accent,
    primarySoft = EinkPalette.accent,
    onPrimary = EinkPalette.onAccent,
    add = EinkPalette.inkHi,                  // semantics via bold, not hue
    remove = EinkPalette.inkHi,               // semantics via strikethrough, not hue
    warning = EinkPalette.inkHi,
    info = EinkPalette.inkHi,
    diffAddTint = EinkPalette.surfaceVariant, // added-line band (surfaceVariant), not a hue tint
    diffRemoveTint = Color.Transparent,       // removed lines read by strikethrough, no band
    risk = listOf(
        EinkPalette.inkHi, EinkPalette.inkHi, EinkPalette.inkHi, EinkPalette.inkHi, EinkPalette.inkHi,
    ),
    hueless = true,
)

/** Default is a concrete value (never `error()`) so previews and detached composables render. */
val LocalGitViewColors = staticCompositionLocalOf { standardGitViewColors }
