package com.gitview.app.ui.theme

import android.content.Context
import android.os.Build
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The two CO-PRIMARY device classes. Neither is "the real one" — [Standard] and [ColorEink] are
 * symmetric first-class profiles. Auto-detect picks per device; a persisted user override ALWAYS wins.
 *
 * See docs/EINK.md. The Color E-Ink profile drives the always-on VISUALS: near-mono high-contrast theme,
 * weight/italic/underline syntax highlighting (not hues), paper palette, and 56dp touch targets. The
 * motion/scroll comfort behaviors (pagination, calm editor, reduced motion) are NOT forced by the
 * profile — they are user [DisplaySettings] (the Bigme B7 Pro is an 80Hz panel that scrolls fine).
 */
enum class DisplayProfile { STANDARD, COLOR_EINK;
    val isEink get() = this == COLOR_EINK
}

val LocalDisplayProfile = staticCompositionLocalOf { DisplayProfile.STANDARD }

/**
 * E-Ink comfort toggles — user settings, independent of the profile and default OFF. The target
 * Bigme B7 Pro is an 80Hz Kaleido panel that handles scroll + animation fine, so these are opt-in
 * (a slower EPD, or a user who prefers a calmer screen, turns them on). See docs/DECISIONS.md ADR-028.
 */
@Immutable
data class DisplaySettings(
    val paginate: Boolean = false,      // long lists/overlays: discrete full-page repaints, not scroll (EinkPaginator)
    val editorCalm: Boolean = false,    // editor: page prev/next footer + no blinking caret / cursor anim / fling
    val reduceMotion: Boolean = false,  // still animations/ripple/overscroll; per-line (not per-token) chat batching
    val showCost: Boolean = true,       // chat cost meter (Turn/Session $) visible; user can hide it
)

val LocalDisplaySettings = staticCompositionLocalOf { DisplaySettings() }

/** Holds the active profile with auto-detect + persisted override, plus the [DisplaySettings] toggles. */
class DisplayProfileManager(context: Context) {
    private val prefs = context.getSharedPreferences("gitview_display", Context.MODE_PRIVATE)
    private val detected = EinkDetection.autoDetect(context)

    var overrideProfile: DisplayProfile? by mutableStateOf(readOverride())
        private set

    var settings: DisplaySettings by mutableStateOf(readSettings())
        private set

    val active: DisplayProfile get() = overrideProfile ?: detected

    fun setOverride(profile: DisplayProfile?) {
        overrideProfile = profile
        prefs.edit().apply {
            if (profile == null) remove(KEY) else putString(KEY, profile.name)
        }.apply()
    }

    fun setPaginate(v: Boolean) = updateSettings { it.copy(paginate = v) }
    fun setEditorCalm(v: Boolean) = updateSettings { it.copy(editorCalm = v) }
    fun setReduceMotion(v: Boolean) = updateSettings { it.copy(reduceMotion = v) }
    fun setShowCost(v: Boolean) = updateSettings { it.copy(showCost = v) }

    private fun updateSettings(f: (DisplaySettings) -> DisplaySettings) {
        val s = f(settings); settings = s
        prefs.edit()
            .putBoolean(K_PAGINATE, s.paginate)
            .putBoolean(K_EDITOR_CALM, s.editorCalm)
            .putBoolean(K_REDUCE_MOTION, s.reduceMotion)
            .putBoolean(K_SHOW_COST, s.showCost)
            .apply()
    }

    private fun readOverride(): DisplayProfile? =
        prefs.getString(KEY, null)?.let { runCatching { DisplayProfile.valueOf(it) }.getOrNull() }

    private fun readSettings() = DisplaySettings(
        paginate = prefs.getBoolean(K_PAGINATE, false),
        editorCalm = prefs.getBoolean(K_EDITOR_CALM, false),
        reduceMotion = prefs.getBoolean(K_REDUCE_MOTION, false),
        showCost = prefs.getBoolean(K_SHOW_COST, true),
    )

    private companion object {
        const val KEY = "override_profile"
        const val K_PAGINATE = "set_paginate"
        const val K_EDITOR_CALM = "set_editor_calm"
        const val K_REDUCE_MOTION = "set_reduce_motion"
        const val K_SHOW_COST = "set_show_cost"
    }
}

object EinkDetection {
    // Vendors whose devices are e-ink panels. Bigme is the primary target (req. 7b / req. E).
    private val EINK_VENDORS = setOf("bigme", "onyx", "boox", "dasung", "boyue", "meebook", "hisense", "eink")

    /**
     * Best-effort auto-detection: known e-ink manufacturer OR a very low panel refresh rate
     * (Kaleido 3 panels report ~40–45 Hz). Off-target devices fall back to STANDARD.
     */
    fun autoDetect(context: Context): DisplayProfile {
        val vendor = (Build.MANUFACTURER + " " + Build.BRAND + " " + Build.MODEL).lowercase()
        if (EINK_VENDORS.any { vendor.contains(it) }) return DisplayProfile.COLOR_EINK

        @Suppress("DEPRECATION")
        val hz = runCatching {
            val wm = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            wm.defaultDisplay.refreshRate
        }.getOrDefault(60f)
        return if (hz in 1f..48f) DisplayProfile.COLOR_EINK else DisplayProfile.STANDARD
    }
}
