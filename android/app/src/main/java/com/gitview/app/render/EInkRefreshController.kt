package com.gitview.app.render

import android.content.Context
import android.os.Build
import android.util.Log

/**
 * VENDOR-NEUTRAL hardware EPD refresh control. This is the OPTIONAL, best-effort hardware layer that
 * sits BEHIND the software e-ink adaptations (mono theme, pagination, per-line batching), which are
 * the reliable core and need no vendor API.
 *
 * The default is a NO-OP, so nothing breaks off-target — including on the standard LCD build. A
 * device-specific impl is chosen by Build.MANUFACTURER/MODEL. Keeping this interface vendor-neutral
 * lets an Onyx/Boox impl (its official SDK) be added later without touching profile logic.
 *
 * Bigme reality (verified mid-2026, see docs/EINK.md / DECISIONS.md ADR-014): Bigme exposes refresh
 * via a proprietary "xRapid" system and an on-device "E-Ink Center" (per-app modes), but there is NO
 * documented public API. So the Bigme impl below is a discovery scaffold that degrades to a no-op and
 * points the user at the E-Ink Center. Any real programmatic hook must be found EMPIRICALLY on device.
 */
interface EInkRefreshController {
    /** A full clean flash is worthwhile now (file switch, page turn). */
    fun fullRefresh(reason: String)
    /** Enter a fast/dirty update mode for streaming (accepts ghosting for speed). */
    fun beginFastStreaming()
    /** Leave fast mode and clean-flash once (e.g. stream completion, modal close). */
    fun endFastStreaming()

    companion object {
        private const val TAG = "EInkRefresh"

        fun forDevice(context: Context): EInkRefreshController {
            val vendor = (Build.MANUFACTURER + " " + Build.BRAND).lowercase()
            return when {
                vendor.contains("bigme") -> BigmeEInkRefreshController(context.applicationContext)
                // vendor.contains("onyx") || vendor.contains("boox") -> OnyxEInkRefreshController(...)
                else -> NoOpEInkRefreshController
            }
        }
    }
}

/** Does nothing. The app is fully usable with only the software e-ink layer. */
object NoOpEInkRefreshController : EInkRefreshController {
    override fun fullRefresh(reason: String) {}
    override fun beginFastStreaming() {}
    override fun endFastStreaming() {}
}

/**
 * Best-effort Bigme (Kaleido 3 / MediaTek) controller. There is no public SDK, so this attempts a
 * vendor broadcast as a DISCOVERY hook and otherwise no-ops. Replace the intent action / extras once
 * a working hook is found empirically (decompile E-Ink Center, watch logs, XDA Bigme threads). Until
 * then, users set GitView's per-app mode in the on-device E-Ink Center. Never assume this works.
 */
class BigmeEInkRefreshController(private val context: Context) : EInkRefreshController {
    override fun fullRefresh(reason: String) = tryVendorBroadcast("full", reason)
    override fun beginFastStreaming() = tryVendorBroadcast("fast", "stream-begin")
    override fun endFastStreaming() = tryVendorBroadcast("full", "stream-end")

    private fun tryVendorBroadcast(mode: String, reason: String) {
        // PLACEHOLDER action — no confirmed public intent exists. Guarded so a missing receiver is a
        // silent no-op rather than a crash.
        runCatching {
            val intent = android.content.Intent("com.bigme.eink.SET_REFRESH_MODE").apply {
                putExtra("mode", mode)
                setPackage("com.bigme.einkcenter") // guess; unverified
            }
            context.sendBroadcast(intent)
            Log.d("EInkRefresh", "bigme refresh hint mode=$mode reason=$reason (best-effort)")
        }.onFailure { Log.d("EInkRefresh", "bigme refresh hook unavailable; set mode in E-Ink Center") }
        Unit
    }
}
