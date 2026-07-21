package com.gitview.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.gitview.app.R

/**
 * The type system: IBM Plex Sans (UI) + JetBrains Mono (code), bundled as static per-weight faces in
 * `res/font` — downloadable Google Fonts silently fall back to system default on the no-GMS /
 * air-gapped e-ink targets. Only the referenced weights ship, and the real 500/Medium face is
 * included so E-Ink's "low-contrast min weight 500" rule doesn't rely on synthesized faux-bold.
 *
 * The handoff's 7-row scale is mapped onto Material 3's [Typography] slots so stock components style
 * coherently. Sizes are in `sp` (respect the system font-scale setting) — a conscious deviation from
 * the spec's literal "dp". E-Ink deltas: body floor 16sp; low-contrast text keeps a 500 minimum. Code
 * (JetBrains Mono) has no M3 slot, so [CodeTextStyle]/[CodeSmallTextStyle] are exposed directly. ADR-023.
 */

val IbmPlexSans = FontFamily(
    Font(R.font.ibm_plex_sans_regular, FontWeight.Normal),
    Font(R.font.ibm_plex_sans_medium, FontWeight.Medium),
    Font(R.font.ibm_plex_sans_semibold, FontWeight.SemiBold),
    Font(R.font.ibm_plex_sans_bold, FontWeight.Bold),
)

val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
)

/** Code token (13 / 400 mono): editor, diffs, tool args. */
val CodeTextStyle = TextStyle(
    fontFamily = JetBrainsMono, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp,
)

/** Code-sm token (11.5 / 400 mono): paths, counts, ids. */
val CodeSmallTextStyle = TextStyle(
    fontFamily = JetBrainsMono, fontWeight = FontWeight.Normal, fontSize = 11.5.sp, lineHeight = 15.sp,
)

/**
 * Build the M3 [Typography] for a profile. [bodySizeSp] is the Body token floor (15 Standard / 16
 * E-Ink); [lowContrastWeight] is the minimum weight for meta/caption text (400 Standard / 500 E-Ink).
 */
private fun buildTypography(bodySizeSp: Int, lowContrastWeight: FontWeight): Typography {
    val ui = IbmPlexSans
    return Typography(
        // Display (62 / 700) — onboarding hero only.
        displayLarge = TextStyle(fontFamily = ui, fontWeight = FontWeight.Bold, fontSize = 62.sp, lineHeight = 68.sp),
        // Headline (22 / 600) — large section headers.
        headlineSmall = TextStyle(fontFamily = ui, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
        // Headline (22 / 600) — screen & sheet titles (TopAppBar reads titleLarge).
        titleLarge = TextStyle(fontFamily = ui, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
        // Title (17 / 600) — card titles, list primary.
        titleMedium = TextStyle(fontFamily = ui, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 24.sp),
        titleSmall = TextStyle(fontFamily = ui, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 20.sp),
        // Body (15 / 400, E-Ink floor 16) — chat text, descriptions.
        bodyLarge = TextStyle(fontFamily = ui, fontWeight = FontWeight.Normal, fontSize = bodySizeSp.sp, lineHeight = (bodySizeSp + 7).sp),
        bodyMedium = TextStyle(fontFamily = ui, fontWeight = FontWeight.Normal, fontSize = bodySizeSp.sp, lineHeight = (bodySizeSp + 6).sp),
        bodySmall = TextStyle(fontFamily = ui, fontWeight = lowContrastWeight, fontSize = 13.sp, lineHeight = 18.sp),
        // Label (13 / 500) — chips, buttons.
        labelLarge = TextStyle(fontFamily = ui, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 16.sp),
        // meta / captions — low-contrast (400 Standard / 500 E-Ink).
        labelMedium = TextStyle(fontFamily = ui, fontWeight = lowContrastWeight, fontSize = 13.sp, lineHeight = 16.sp),
        labelSmall = TextStyle(fontFamily = ui, fontWeight = lowContrastWeight, fontSize = 11.5.sp, lineHeight = 14.sp),
    )
}

internal val StandardTypography = buildTypography(bodySizeSp = 15, lowContrastWeight = FontWeight.Normal)
internal val EinkTypography = buildTypography(bodySizeSp = 16, lowContrastWeight = FontWeight.Medium)

fun profileTypography(profile: DisplayProfile): Typography =
    if (profile.isEink) EinkTypography else StandardTypography
