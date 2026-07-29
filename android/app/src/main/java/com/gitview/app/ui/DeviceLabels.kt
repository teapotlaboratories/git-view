package com.gitview.app.ui

import com.gitview.app.data.DeviceSummary
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime

/**
 * Text for the paired-devices list (ADR-035). Pure functions, kept out of the composable so they can
 * be unit-tested — the skew rule below is behaviour worth pinning down, not a formatting detail.
 */

/** "connected now" / "last seen 3h ago". A device that has never connected has no timestamp yet. */
internal fun deviceSubtitle(d: DeviceSummary): String = when {
    d.connected -> "connected now"
    d.lastSeenAt.isBlank() -> "never seen"
    else -> "last seen ${lastSeenText(d.lastSeenAt)}"
}

/**
 * Like [relativeTime], but tolerant of the device clock trailing the bridge's.
 *
 * `lastSeenAt` is stamped by the BRIDGE, so on a phone running even slightly behind it parses as the
 * future — and [relativeTime] (built for commit dates, where a future stamp means a rewritten
 * timestamp) falls back to printing the date. "last seen 2026-07-26" for something seen seconds ago is
 * worse than useless, so a small forward skew reports "just now"; anything beyond [SKEW_GRACE] defers
 * to [relativeTime], which still prints a date for a genuinely wrong clock.
 */
internal fun lastSeenText(iso: String, now: Instant = Instant.now()): String = runCatching {
    val secs = Duration.between(OffsetDateTime.parse(iso).toInstant(), now).seconds
    if (secs < 0 && secs > -SKEW_GRACE) "just now" else relativeTime(iso, now)
}.getOrElse { relativeTime(iso, now) }

/** How far a bridge timestamp may sit in this device's future before it stops reading as "just now". */
private const val SKEW_GRACE = 300L
