# Worklog — Redesign step 1: design tokens + ProfileTheme

**Date:** 2026-07-20 · **Branch:** `redesign/step1-tokens-theme`

## Goal
Build the token/theme foundation for the GitView redesign (design handoff at
`docs/design/design_handoff_gitview_redesign/`) — step 1 of the handoff's build order. Both
co-primary profiles (Standard dark violet / Color E-Ink paper) share one token set. **No screens**
this step.

## Owner decisions (confirmed before coding)
1. **Re-skin now** — derive the M3 `ColorScheme` from the spec tokens and map every role, so existing
   screens adopt the new palette immediately. Gate = a two-profile preview of the stock components.
2. **Bundle static font weights** — IBM Plex Sans 400/500/600/700 + JetBrains Mono 400 in `res/font`
   (downloadable Google Fonts silently fall back to system default on no-GMS / air-gapped e-ink).
3. **Type in sp + M3 leading** — all 7 sizes in `sp` (Display = 62sp); a conscious deviation from the
   spec's literal "dp" so text respects system font scaling.
4. **Defer depth, neutralize now** — `surfaceTint = Transparent` on both profiles + a hairline stroke
   slot in `Spacing`; the full depth/shadow token waits for step 2 (no cards exist yet).

## What landed
- Fonts: `android/app/src/main/res/font/{ibm_plex_sans_regular,medium,semibold,bold,jetbrains_mono_regular}.ttf`
  (static faces from upstream IBM/plex + JetBrains/JetBrainsMono; TTF magic verified). OFL-1.1 texts in
  `assets/licenses/`.
- `ui/theme/Color.kt` — `StandardPalette` / `EinkPalette`, the single source of hex.
- `ui/theme/GitViewColors.kt` — `@Immutable GitViewColors` + `LocalGitViewColors` (static, concrete
  default); E-Ink semantics resolve to ink with `hueless=true`.
- `ui/theme/Type.kt` — bundled families + `profileTypography(profile)` (E-Ink body 16sp / min-weight 500).
- `ui/theme/Shape.kt` — `profileShapes(profile)` (all 5 slots) + `SendPillShape`.
- `ui/theme/Spacing.kt` — 4dp scale + touch targets (48/56) + hairline stroke (1 / 1.5dp).
- `ui/theme/Motion.kt` — `@Immutable Motion` carrying ready-built enter/exit/spec (E-Ink = None/snap).
- `ui/theme/Theme.kt` — rewritten: `fun GitViewTheme(profile)` builds both derived schemes (all ~30
  roles, `surfaceTint = Transparent`) + provides every local; `object GitViewTheme` accessor.
- `ui/theme/ThemePreview.kt` — two-profile gallery (the merge gate).
- `ui/Components.kt` — `DiffView` migrated off the hardcoded `0xFF3FB950`/`0xFFF85149` to
  `GitViewTheme.colors.add`/`.remove` (+ tints); on-screen diff hue now matches spec `#4ED08A`/`#F0736A`.

## Verification
- [x] `gradle :app:assembleDebug` clean (28 MB APK; all 5 fonts + both OFL texts packaged). D8 printed a
      non-fatal desugaring stack trace but dexing completed. `:app:testDebugUnitTest` green.
- [x] On-device (`kancil_test`, API 34): Connections re-skinned in-palette on BOTH profiles — TopAppBar,
      Card, Button, OutlinedTextField, DropdownMenu (no baseline-purple leak); IBM Plex Sans + JetBrains
      Mono render; Standard `#7F7BF5` button (dark on-primary) ↔ E-Ink `#4A4780` accent (white on-accent),
      `#14161B` ↔ `#FCFCFA` canvas. Screenshots in the session scratchpad.
- [ ] Six-component gallery `ThemePreview.kt` (adds SegmentedButton / FilterChip / ModalBottomSheet /
      Snackbar) — eyeball in the Android Studio @Preview pane; not renderable headlessly here.

## Notes / follow-ups
- Overscroll-off on E-Ink (`LocalOverscrollConfiguration = null`) deferred to when scrollable screens
  are built — the exact API on this Compose BOM needs verifying on-device first.
- Wiring JetBrains Mono into the Sora editor typeface is a step-2 "restyle chrome" item.
- Step-3 note: `PermissionProfile.DEFAULT` is still `AUTO`; the redesign default is `ask-first`.
