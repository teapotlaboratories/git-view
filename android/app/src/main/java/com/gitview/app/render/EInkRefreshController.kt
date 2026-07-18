package com.gitview.app.render

import android.view.View
import com.gitview.app.ui.theme.EInk

/**
 * Thin, SDK-free wrapper around the Onyx Boox EPD refresh controller, driven entirely by
 * reflection so the SAME APK compiles and runs on ordinary phones (where it no-ops).
 *
 * Rationale (see docs/EINK.md §6): the Onyx `EpdController` API surface and `UpdateMode` enum are
 * version-sensitive and differ between SDK generations and between MSTAR/RK vs Qualcomm devices, so
 * we never hard-link against `com.onyx.android.sdk:onyxsdk-device`. Every call is guarded and any
 * failure degrades to standard Android rendering.
 *
 * ⚠️ VERIFY on a real current-gen Kaleido 3 Boox: the class path
 * (`com.onyx.android.sdk.api.device.epd.EpdController`), the `UpdateMode` enum members, and whether
 * a Qualcomm device needs the reflection/waveform path + preventSystemRefresh lifecycle hooks.
 */
class EInkRefreshController(private val defaultMode: String = "REGAL") {

    private var partialCount = 0
    private val available = EInk.isBoox && epdClass != null

    /** Make this view's default refresh mode the anti-ghosting reading waveform. */
    fun setDefault(view: View) {
        if (!available) return
        invoke("setViewDefaultUpdateMode", view, updateMode(defaultMode))
    }

    /** One clean full flash (GC) — call on file/page switch, modal close, and stream completion. */
    fun fullFlash(view: View) {
        if (!available) return
        invoke("invalidate", view, updateMode("GC"))
        partialCount = 0
    }

    /**
     * Call after each partial refresh (e.g. a streamed chat flush). Every [cleanFlashEveryN]
     * partials, force a full flash to clear accumulated ghosting. 0 disables the cadence.
     */
    fun onPartialUpdate(view: View, cleanFlashEveryN: Int) {
        if (!available || cleanFlashEveryN <= 0) return
        if (++partialCount >= cleanFlashEveryN) fullFlash(view)
    }

    // ---- reflection plumbing (no compile-time dependency on the Onyx SDK) ----

    private fun invoke(method: String, view: View, mode: Any?) {
        runCatching {
            val cls = epdClass ?: return
            val modeType = updateModeClass ?: return
            cls.getMethod(method, View::class.java, modeType).invoke(null, view, mode)
        }
    }

    // Resolve an UpdateMode enum constant by name via reflection (avoids a compile dependency on
    // the enum type). Uses enumConstants rather than Enum.valueOf() to sidestep generic bounds.
    private fun updateMode(name: String): Any? {
        val cls = updateModeClass ?: return null
        return runCatching {
            cls.enumConstants?.firstOrNull { (it as Enum<*>).name == name }
        }.getOrNull()
    }

    private companion object {
        val epdClass: Class<*>? = runCatching {
            Class.forName("com.onyx.android.sdk.api.device.epd.EpdController")
        }.getOrNull()

        val updateModeClass: Class<*>? = runCatching {
            Class.forName("com.onyx.android.sdk.api.device.epd.UpdateMode")
        }.getOrNull()
    }
}
