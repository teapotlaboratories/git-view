package com.gitview.app.ui.theme

import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The two CO-PRIMARY device classes. Neither is "the real one" — [Standard] and [ColorEink] are
 * symmetric first-class profiles. Auto-detect picks per device; a persisted user override ALWAYS wins.
 *
 * See docs/EINK.md. The Color E-Ink profile drives: near-mono high-contrast theme, weight/italic/
 * underline syntax highlighting (not hues), animations/ripple/overscroll OFF, pagination instead of
 * smooth scroll, and per-line (not per-token) chat batching.
 */
enum class DisplayProfile { STANDARD, COLOR_EINK;
    val isEink get() = this == COLOR_EINK
}

val LocalDisplayProfile = staticCompositionLocalOf { DisplayProfile.STANDARD }

/** Holds the active profile with auto-detect + persisted override. Override wins. */
class DisplayProfileManager(context: Context) {
    private val prefs = context.getSharedPreferences("gitview_display", Context.MODE_PRIVATE)
    private val detected = EinkDetection.autoDetect(context)

    var overrideProfile: DisplayProfile? by mutableStateOf(readOverride())
        private set

    val active: DisplayProfile get() = overrideProfile ?: detected

    fun setOverride(profile: DisplayProfile?) {
        overrideProfile = profile
        prefs.edit().apply {
            if (profile == null) remove(KEY) else putString(KEY, profile.name)
        }.apply()
    }

    private fun readOverride(): DisplayProfile? =
        prefs.getString(KEY, null)?.let { runCatching { DisplayProfile.valueOf(it) }.getOrNull() }

    private companion object { const val KEY = "override_profile" }
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
