package com.gitview.app.ui.theme

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The motion gate. Standard animates (Material 3 emphasized easing, ~250ms, ripple); Color E-Ink is
 * motionless — no ripple/overscroll/shimmer, expand-collapse snaps, streaming commits whole lines —
 * to avoid EPD ghosting and full-refresh churn on Kaleido 3.
 *
 * Rather than a bare on/off flag (which forces `if (enabled) AnimatedVisibility(...) else content()`
 * at every call site — easy to forget, and a stray animation ghosts on e-ink), [Motion] carries
 * ready-built transitions and a spec. Call sites use ONE code path:
 * `AnimatedVisibility(visible, enter = GitViewTheme.motion.enter, exit = GitViewTheme.motion.exit)`.
 * On E-Ink those are `None`/`snap`, so the same code renders instantly with no animation. See ADR-023.
 */

// Material 3 emphasized easing, held as a stable singleton so the @Immutable equality/identity holds.
private val EmphasizedEasing = CubicBezierEasing(0.2f, 0.0f, 0.0f, 1.0f)
private const val DurationMs = 250

@Immutable
class Motion(
    val enabled: Boolean,
    val enter: EnterTransition,
    val exit: ExitTransition,
    val spec: AnimationSpec<Float>,
)

internal val standardMotion = Motion(
    enabled = true,
    enter = fadeIn(tween(DurationMs, easing = EmphasizedEasing)) +
        expandVertically(tween(DurationMs, easing = EmphasizedEasing)),
    exit = fadeOut(tween(DurationMs, easing = EmphasizedEasing)) +
        shrinkVertically(tween(DurationMs, easing = EmphasizedEasing)),
    spec = tween(DurationMs, easing = EmphasizedEasing),
)

internal val einkMotion = Motion(
    enabled = false,
    enter = EnterTransition.None,
    exit = ExitTransition.None,
    spec = snap(),
)

val LocalMotion = staticCompositionLocalOf { standardMotion }
