# GitView on E-Ink (Color E-Ink DisplayProfile)

The Bigme B7 Pro (7" Kaleido 3 color e-ink, MediaTek Dimensity 1080, Android 14) is a **co-primary**
device class, not a bolt-on. The Color E-Ink profile is a first-class experience, not a theme swap.

## Two layers

### 1. Software adaptations — the reliable core (ships unconditionally)
These need **no vendor API** and work on any Android e-ink device. They are the bulk of the win:

| Concern            | Standard profile           | Color E-Ink profile                                  |
| ------------------ | -------------------------- | ---------------------------------------------------- |
| Theme              | full color Material        | near-mono, maximum-contrast (ink over hue)           |
| Syntax highlighting| pastel hues                | **weight / italic / underline** (`eink-mono.json`)   |
| Semantics          | hue (add/remove/warn/risk) | **weight / underline / strikethrough / filled squares / text badges** (no hue) |
| Touch targets      | 48dp min                   | **56dp** min (`spacing.touchTarget`)                 |
| Animation / ripple | on                         | *Reduce motion* setting → off (ripple + overscroll + animation gated) |
| Scrolling          | smooth scroll              | *Paginate long lists* setting → `EinkPaginator` discrete page turns |
| Editor caret       | blinking                   | *Calm editor* setting → no blink (`setCursorBlinkPeriod(0)`) |
| Chat streaming     | per-token deltas           | **per-line batched** when *Reduce motion* is on      |

**Comfort behaviors are user settings, not profile-forced (ADR-028).** The always-on rows above
(theme, syntax, semantics, 56dp) follow the E-Ink *profile*. But pagination, reduced motion, and the
calm editor are **opt-in toggles** (default OFF), because the target Bigme B7 Pro is an **80Hz** panel
that scrolls and animates fine — a slower EPD (or a user who prefers a calmer screen) turns them on via
⋮ → "Display settings…". They persist in `gitview_display`; `GitViewTheme` gates the motion token,
ripple, and overscroll on the *Reduce motion* setting rather than on `profile.isEink`.

Kaleido 3 color is muted and lower-PPI than its B&W mode (≈150 vs 300 PPI), so the e-ink theme
conveys meaning through **ink weight and style**, not saturated color. The TextMate theme in
`app/src/main/assets/textmate/eink-mono.json` encodes this; load it in the Sora editor when the
active profile is `COLOR_EINK`, and a normal colored theme otherwise.

**Per-line chat batching:** the wire streams every `assistant.delta` (§6.3 of [API.md](API.md)); the
Color E-Ink UI coalesces deltas and repaints only on a completed line, so the panel isn't thrashed by
per-token updates.

### 2. Hardware EPD refresh — optional, best-effort (`EInkRefreshController`)
A vendor-neutral interface with a **NO-OP default**, so nothing breaks off-target (including the
standard LCD build). A device-specific impl is chosen by `Build.MANUFACTURER`. Triggers a clean flash
on file/page switch, modal close, and stream completion, with a fast/dirty mode for streaming.

**Bigme reality (verified mid-2026):** Bigme exposes refresh via a proprietary **xRapid** system and
the on-device **E-Ink Center** (per-app modes: Default/Magazine/Comic/Video/Custom; underlying levels
HD256 / Regal / Normal / Extreme). There is **no documented public API** — unlike Onyx/Boox's
`com.onyx.android.sdk` `EpdController`, which is Boox-only and does nothing on Bigme. So:

- **Minimum (works today):** document that the user sets GitView's per-app refresh mode in the E-Ink
  Center. The app is fully usable on the Bigme with only the software layer.
- **Best-effort hook:** `BigmeEInkRefreshController` attempts a vendor broadcast as a *placeholder*
  and otherwise no-ops. Any real hook (system service, broadcast intent, or window/activity flag)
  must be found **empirically** on-device: decompile E-Ink Center, watch logs, check XDA Bigme
  threads. Replace the placeholder action/extras once confirmed.
- **Last resort (not a requirement):** sysfs (`/sys/kernel/debug/eink_debug`) is root-only.

Keep the interface vendor-neutral so an Onyx/Boox impl (its official SDK) or other e-ink devices can
be added later without touching the profile logic.

## Detection & override
`EinkDetection.autoDetect()` selects Color E-Ink when the manufacturer/brand/model matches a known
e-ink vendor (Bigme, Onyx, Boox, …) or the panel reports a very low refresh rate (~40–48 Hz, typical
of Kaleido 3). A **persisted user override always wins** (`DisplayProfileManager`). Both profiles are
first-class; neither is the default "real" one.

## Phase 8 (on-device tuning)
Determine and integrate Bigme's refresh hook (or finalize E-Ink Center guidance); tune clean-flash
cadence, batch interval, and the mono/Kaleido-3 palette on the actual panel; verify the controller
no-ops cleanly on non-Bigme devices.
