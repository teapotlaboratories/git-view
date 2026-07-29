package com.gitview.app.ui

import com.gitview.app.data.DeviceSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** ADR-035 device-list labels. The skew rule is the point here — see [lastSeenText]. */
class DeviceLabelsTest {

    private val now: Instant = Instant.parse("2026-07-27T12:00:00Z")
    private fun at(iso: String) = lastSeenText(iso, now)

    private fun device(
        id: String = "dv_x", label: String = "Pixel 8", lastSeenAt: String = "",
        connected: Boolean = false,
    ) = DeviceSummary(id, label, createdAt = "", lastSeenAt = lastSeenAt, connected = connected)

    // ---- subtitle routing ---------------------------------------------------

    @Test fun `a device that has never connected says so`() {
        assertEquals("never seen", deviceSubtitle(device(lastSeenAt = "")))
    }

    @Test fun `a connected device says so, even with a stale lastSeenAt`() {
        assertEquals("connected now", deviceSubtitle(device(connected = true, lastSeenAt = "2026-01-01T00:00:00Z")))
    }

    @Test fun `a device with no timestamp reads never seen`() {
        assertEquals("never seen", deviceSubtitle(device(lastSeenAt = "")))
    }

    @Test fun `an offline device reports how long ago`() {
        assertTrue(deviceSubtitle(device(lastSeenAt = "2026-07-27T11:00:00Z")).startsWith("last seen "))
    }

    // ---- the clock-skew rule ------------------------------------------------
    // lastSeenAt is stamped by the BRIDGE. A device running slightly behind parses it as the future;
    // relativeTime would then print a DATE ("2026-07-27"), which is useless for something just seen.

    @Test fun `a bridge timestamp slightly in this device's future reads as just now`() {
        assertEquals("just now", at("2026-07-27T12:00:30Z"))   // 30s ahead
        assertEquals("just now", at("2026-07-27T12:04:00Z"))   // 4m ahead, still inside the grace
    }

    @Test fun `a timestamp far in the future is not masked as just now`() {
        // Beyond the grace window this is a genuinely wrong clock — defer to relativeTime, which
        // prints a date rather than pretending the device was seen moments ago.
        val far = at("2026-07-28T12:00:00Z")
        assertTrue("expected a date, got '$far'", far.contains("2026-07-28"))
    }

    @Test fun `ordinary past timestamps are unaffected by the skew rule`() {
        assertEquals("just now", at("2026-07-27T11:59:30Z"))  // 30s ago
        assertEquals("30m ago", at("2026-07-27T11:30:00Z"))
        assertEquals("3h ago", at("2026-07-27T09:00:00Z"))
        assertEquals("2d ago", at("2026-07-25T12:00:00Z"))
    }

    @Test fun `an unparseable timestamp degrades instead of throwing`() {
        assertEquals("not-a-date", at("not-a-date")) // relativeTime's take(10) fallback
    }
}
