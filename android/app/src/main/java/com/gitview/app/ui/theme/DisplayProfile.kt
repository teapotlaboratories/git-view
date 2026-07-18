package com.gitview.app.ui.theme

import android.os.Build
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * GitView's two display profiles. `ColorEInk` is the alternative view tuned for E Ink Kaleido 3
 * panels — see docs/EINK.md for the full design contract.
 *
 * The profile is provided via [LocalDisplayProfile] and read by the theme, the editor host, the
 * scroll/animation wiring, and the chat streamer. Version-sensitive Compose/Sora/Onyx wiring lives
 * at the call sites (and in EInkRefreshController); this type just carries the knobs.
 */
enum class DisplayMode { STANDARD, COLOR_EINK }

/** Which Sora color scheme + TextMate theme to apply. */
enum class EditorScheme { COLOR, EINK_MONO }

@Immutable
data class DisplayProfile(
    val mode: DisplayMode,
    /** Drives MotionDurationScale=0 and snap() vs real animation specs at call sites. */
    val animationsEnabled: Boolean,
    /** false → provide NoIndication for LocalIndication (kill ripple). */
    val rippleEnabled: Boolean,
    /** false → provide a null overscroll factory (kill glow/stretch). */
    val overscrollEnabled: Boolean,
    /** true → snap/paginate instead of smooth fling scrolling. */
    val snapScrolling: Boolean,
    /** Throttle window for batching streamed Claude tokens before repaint. */
    val streamBatchIntervalMs: Long,
    /** Sora scheme + TextMate theme name (assets/textmate/<name>.json). */
    val editorScheme: EditorScheme,
    val textMateThemeName: String,
    /** Onyx default update mode name (e.g. "REGAL"); consumed by EInkRefreshController. */
    val einkDefaultUpdateMode: String,
    /** Force a full GC clean-flash after this many partial refreshes (0 = never). */
    val cleanFlashEveryN: Int,
) {
    companion object {
        val Standard = DisplayProfile(
            mode = DisplayMode.STANDARD,
            animationsEnabled = true,
            rippleEnabled = true,
            overscrollEnabled = true,
            snapScrolling = false,
            streamBatchIntervalMs = 33,
            editorScheme = EditorScheme.COLOR,
            textMateThemeName = "default",
            einkDefaultUpdateMode = "GC",
            cleanFlashEveryN = 0,
        )

        val ColorEInk = DisplayProfile(
            mode = DisplayMode.COLOR_EINK,
            animationsEnabled = false,
            rippleEnabled = false,
            overscrollEnabled = false,
            snapScrolling = true,
            streamBatchIntervalMs = 300,
            editorScheme = EditorScheme.EINK_MONO,
            textMateThemeName = "eink-mono",
            einkDefaultUpdateMode = "REGAL",
            cleanFlashEveryN = 8,
        )

        /** Auto-pick for a fresh install; a persisted user setting must override this. */
        fun default(): DisplayProfile = if (EInk.isLikelyEInk) ColorEInk else Standard
    }
}

/** staticCompositionLocalOf: the profile changes rarely, so switching re-runs the tree once. */
val LocalDisplayProfile = staticCompositionLocalOf { DisplayProfile.Standard }

/**
 * Heuristic e-ink detection — there is no standard Android capability flag for e-paper.
 * Used only to PRE-SELECT the profile; the user's explicit choice always wins.
 * Keep the brand allowlist maintained as new devices appear (see docs/EINK.md §8).
 */
object EInk {
    private val EINK_BRANDS = setOf(
        "onyx", "rakuten kobo", "boyue", "dasung",
        "remarkable", "bigme", "pocketbook", "barnes & noble",
    )

    val isLikelyEInk: Boolean by lazy {
        val m = Build.MANUFACTURER.lowercase()
        m in EINK_BRANDS ||
            (Build.MANUFACTURER.equals("Amazon", true) && Build.MODEL.startsWith("K")) ||
            runCatching { Class.forName("android.onyx.hardware.EInkDeviceInterface") }.isSuccess
    }

    /** Boox only — the one target with an app-controllable refresh SDK. */
    val isBoox: Boolean get() = Build.MANUFACTURER.equals("ONYX", true)
}
