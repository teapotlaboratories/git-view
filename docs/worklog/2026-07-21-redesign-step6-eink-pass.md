# Worklog — Redesign step 6: E-Ink profile pass

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme` (steps 1–6 stack)

## Goal
Step 6 of the handoff build order: the E-Ink pass — EinkPaginator, no-motion, weight/underline
semantics, 56dp targets. A cross-cutting audit-and-upgrade over existing components, not new screens.

## Owner decision (reshaped the step)
The Bigme B7 Pro is an **80Hz** panel that handles scroll + motion fine. So the three motion/scroll
"calming" behaviors become **user settings (default OFF, opt-in), not profile-forced**:
- **Paginate long lists** · **Calm editor** (page footer + caret-off) · **Reduce motion**.
Each must be **testable on the emulator**. The E-Ink *profile* still owns the always-on visuals (56dp
targets, weight/underline semantics, paper palette, weight/italic syntax). See ADR-028.

## Scout (workflow `eink-step6-scout`, 6 agents)
Already-correct (not redone): motion gate on the 7 app-authored animation sites; `spacing.touchTarget`
token (48/56dp); RiskMeter squares+label; DiffView add=bold/remove=strikethrough; chat per-line
batching; editor `eink-mono.json` weight/italic syntax. Gaps found → the work below.

## Built
- **Settings model** — `DisplaySettings(paginate, editorCalm, reduceMotion)` + `LocalDisplaySettings`;
  persisted in `DisplayProfileManager` (`gitview_display` prefs); `GitViewTheme.settings` accessor.
- **Motion now follows `reduceMotion`, not the profile** — `Theme.kt` gates the motion token + ripple +
  **overscroll** (new `LocalOverscrollConfiguration` null) on `reduceMotion`. Reclassified the per-site
  motion branches: chat per-line batching (`setDisplayEink`), DraggableSplit drag-vs-tap-cycle.
- **EinkPaginator** (`ui/eink/EinkPaginator.kt`) — pass-through `LazyColumn` when off; when on, disables
  free scroll and pages in discrete `scrollToItem` jumps via a `‹ prev · N–M of T · next ›` footer.
  Applied to chat, diff, history, repos, explorer. Overlays (History/Diff) got `systemBarsPadding()` so
  the bottom footer clears the nav bar.
- **Calm editor** — `editorCalm` → Sora `setCursorBlinkPeriod(0)` (kills the blinking caret, the worst
  EPD ghosting source); re-applied on `update` so the toggle takes effect live.
- **56dp targets** — threaded `spacing.touchTarget` through the 6 toolbar `IconButton`s (were 36dp),
  Files⇄Chat segment, explorer rows (34dp), tabs, ProviderToggle segments, PermissionBar.
- **Weight/underline semantics** — TabBar active tab now reads by **weight** (was an imperceptible bg
  fill on paper) + a proper hairline separator (the old accent spanned the whole bar); PermissionBar
  critical tier gets a border + bold label (the red wash vanishes on E-Ink); bigger tab close target.
- **Settings UI** — ⋮ → "Display settings…" opens a dialog: the 3 toggles + descriptions ("off by
  default — the panel is 80Hz").
- Fixed a self-inflicted bug: `fillMaxHeight()` on the tab close button inside a `LazyRow` (unbounded
  cross-axis) blew up the tab-bar height and pushed the editor tab to mid-screen → fixed to a 44dp box.

## Verification (bigmeB7, E-Ink, 632dp — one emulator at a time per the .ai rule)
- **Display settings dialog** — all 3 toggles render, default OFF, persist to `gitview_display`
  (`set_paginate=true` confirmed after toggling).
- **Paginate ON** — History (20 commits) shows discrete pages, no scroll; footer `1–6 of 20`; tapping
  next advanced to `6–12 of 20` (commits 13→8). Explorer tree also paginates (`1–6 of 6`).
- **56dp** — workspace toolbar (two-bar layout, not crowded) + taller tree rows render cleanly.
- **Editor** — opens without crash (Sora `setCursorBlinkPeriod`), renders content + line numbers,
  active tab **README.md** is bold (weight semantics), tab bar back at the top after the fix.
- **Build**: `:app:assembleDebug` SUCCESSFUL (only the benign D8 metadata warnings).

## Verification (kancil phone, Standard — re-verified once the box was quiet)
- **Display settings dialog** renders on the dark-violet theme; toggling Paginate + Reduce motion
  persists (`set_paginate=true`, `set_reduce_motion=true`, no `override_profile` → Standard).
- **Paginate ON** — History pages `1–7 of 20` → next → `7–14 of 20`; the footer clears the nav bar
  (the `systemBarsPadding` fix works on Standard too); `+1` stats stay green (hued).
- **56dp on the narrow phone** — the two-bar toolbar (back + Files/Chat segment + ⋮ on top; tree +
  feature-1 + Git below) fits without crowding; active tab **README.md** is bold at the top; editor
  renders. Confirms the 56dp bump doesn't reintroduce the step-4 crowding bug.

## Not screenshot-verified (temporal)
- **Reduce motion / Calm editor visual effect** — wired, persisted, open-without-crash confirmed on both
  profiles, but the effects (ripple/overscroll/animation stilling, caret-blink) are temporal and don't
  capture in a still. The `reduceMotion` gate + `setCursorBlinkPeriod` paths are exercised without crash.
- **Tablet form factor** — these step-6 surfaces (settings dialog, History, workspace toolbar) are
  width-capped and render as on the phone; the tablet-specific split was covered in step 4.

## Follow-ups (candidates, not done)
- FilterChip selected-state weight/check on E-Ink (ProviderSelector/ProfileSelector) — minor consistency.
- CostBar over-budget weight; markdown link underline on E-Ink.
- Editor page prev/next footer (only caret-off shipped for `editorCalm`; footer/fling on the native Sora
  view deferred — the 80Hz panel scrolls fine, so caret was the high-value part).
