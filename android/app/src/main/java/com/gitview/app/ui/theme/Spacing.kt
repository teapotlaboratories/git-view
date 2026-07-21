package com.gitview.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The 4dp spacing scale plus the interaction/structure dimensions that differ by profile. Provided
 * via [LocalSpacing]; access via `GitViewTheme.spacing`.
 *
 * [touchTarget] rises from 48dp (Standard) to 56dp (E-Ink) — the handoff fixes today's 34–36dp taps.
 * [hairline] is the drawn divider/border stroke; E-Ink uses 1.5dp because border replaces elevation
 * as the depth cue (the full depth token is deferred to step 2 — see ADR-023).
 */
@Immutable
class Spacing(
    val xs: Dp = 4.dp,    // chip inset
    val sm: Dp = 8.dp,    // list gaps
    val md: Dp = 12.dp,   // card / bubble padding
    val lg: Dp = 16.dp,   // phone gutters
    val xl: Dp = 24.dp,   // section gaps
    val xxl: Dp = 32.dp,  // tablet gutters / sheet padding
    val touchTarget: Dp,  // minimum tap target
    val hairline: Dp,     // drawn divider / border stroke
)

internal val standardSpacing = Spacing(touchTarget = 48.dp, hairline = 1.dp)
internal val einkSpacing = Spacing(touchTarget = 56.dp, hairline = 1.5.dp)

val LocalSpacing = staticCompositionLocalOf { standardSpacing }
