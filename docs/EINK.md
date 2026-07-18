# GitView — Color E-Ink Alternative View

**Requirement:** GitView ships a second display profile tuned for **color e-ink** panels (E Ink Kaleido 3 class), selectable alongside the standard view. On e-ink devices it's offered automatically; on any device it can be turned on/off manually.

This is not just a dark/light theme — e-ink has hard physical constraints that change *rendering, color, motion, and how streamed chat is drawn*. This doc is the design contract; the app implements it via a `DisplayProfile` (see §3).

---

## 1. Why e-ink needs its own view

Color e-ink (Kaleido 3 = a printed RGB color-filter array over a monochrome Carta panel) imposes:

- **Resolution split:** ~**300 PPI in black-and-white but only ~150 PPI in color.** Black text/UI is sharp; anything *tinted* renders at half resolution and looks soft. → **Keep code glyphs black; treat color as a scarce accent.**
- **Muted gamut:** light passes the color filter twice on a reflective (non-emissive) substrate, so saturated colors are impossible — everything reads pale/pastel. → **A normal RGB syntax theme washes out. Don't port one.**
- **Low white/contrast + ghosting:** the filter dulls the white state; partial refreshes leave faint remnants, worst on high-contrast transitions (exactly a scrolling colored code buffer). → **High contrast only; own the refresh loop.**
- **Slow refresh, no cheap motion:** every animation frame is a separate slow refresh that smears. → **Kill animation; paginate; batch redraws.**

## 2. Target devices (full-Android, sideload/Play-capable)

| Device | Screen | Android | Notes |
|---|---|---|---|
| **BOOX Note Air5 C** | 10.3" Kaleido 3 | 15 | Primary test target |
| **BOOX Tab X C** | 13.3" Kaleido 3 | 13 | Best for editing (more columns) |
| BOOX Go Color 7 (Gen II) | 7" Kaleido 3 | 13 | Reading-size; cramped for editing |
| Bigme B-series (B6/B7) | 6–7" Kaleido 3 | 14 | Secondary |
| PocketBook Color Note | 10.3" Kaleido 3 | 12 + Play | Valid target |
| ~~PocketBook InkPad Color 3~~ | — | Linux | **Excluded** (no Android) |

Target **min SDK ~31 (Android 12)**. Onyx Boox is the primary target and the only one with a usable refresh SDK (§6).

## 3. The `DisplayProfile` abstraction

One immutable profile, provided via a `staticCompositionLocalOf`, drives every difference. Any composable and the editor host read it — no prop-drilling.

| Concern | `Standard` | `ColorEInk` |
|---|---|---|
| Material color scheme | full color | high-contrast, near-mono, white bg |
| Animations (MotionDurationScale / snap specs) | on | **off** |
| Ripple / `Indication` | ripple | none |
| Overscroll glow/stretch | default | disabled |
| Scroll | smooth fling | **snap / paginate** |
| Streaming flush interval | ~16–50 ms | **~300 ms** |
| Editor color scheme + TextMate theme | color | `eink-mono` |
| Refresh strategy (Boox) | n/a | REGAL default + GC clean-flash every N; DU only for cursor |

- **Selection:** default = `if (EInk.isLikelyEInk) ColorEInk else Standard`, but a **persisted user setting always wins**. Auto-detect only pre-selects.
- **Detection:** no standard Android e-ink flag exists → heuristic on `Build.MANUFACTURER`/`MODEL` (ONYX, Bigme, PocketBook, Kobo, reMarkable, Boyue, Dasung, Amazon Kindle…) plus a reflection probe for the Onyx framework class. See `android/.../ui/theme/DisplayProfile.kt`.

## 4. Syntax highlighting that survives a muted gamut

**Hybrid: grayscale + typographic encoding is the base; ≤3 dark hues are optional reinforcement.** Encode token *type* with **weight / italic / underline** (all black, full 300 PPI) rather than hue; add at most a couple of *dark* (not pastel) hues, always paired with a style cue so meaning survives if color washes out or the device is monochrome. Ship a **monochrome-only** toggle.

Base scheme (delivered as a TextMate theme, `assets/textmate/eink-mono.json`):

| Token | Style |
|---|---|
| Keyword (`if`, `return`, `def`) | **Bold** black |
| Type / class | **Bold** + underline |
| Function / method | *Italic* black |
| String | Regular, dark green `#006400` (optional) or very light gray box |
| Number / constant | Regular + underline |
| Comment | *Italic*, darkest gray that still clears 4.5:1 |
| Operator / punctuation / identifier | Regular black (unmarked default) |
| Decorator / annotation | ***Bold italic*** |
| Error / diagnostic | Bold + wavy underline (shape, not red) |

Optional dark accents if color is wanted: keyword dark blue `#00008B`, string dark green `#006400`, constant dark purple `#6A006A`. **Avoid** yellow/light-green/cyan (vanish on dull white) and adjacent hues (red vs orange become indistinguishable). Keep string/comment backgrounds flat light-gray boxes — never gradients.

## 5. Motion & refresh (the "kill everything" rules)

- **No animations, ripples, transitions, gradients, shadows, inertial scroll.** In Compose: inject a zero `MotionDurationScale` at the composition scope (makes all implicit animations instant), provide `NoIndication`, disable overscroll (`LocalOverscrollFactory`/`LocalOverscrollConfiguration` per BOM), set `NavHost` transitions to `None`, prefer `scrollToItem`/paging over `animateScrollToItem`, static text cursor.
- **Paginate, don't smooth-scroll** — a page jump is one clean refresh; momentum scroll is a storm of partial refreshes that smear.
- **Own the refresh strategy** (Boox, §6): fast partial (DU/REGAL) for typing/cursor; **force a full GC ("flash to black") refresh** on file/page switch, closing a modal, after **N partial updates** (accumulated ghosting), and on stream completion. Expose a manual "refresh screen" control.

## 6. Onyx EPD integration (reflection-guarded)

Boox is the only target with app-controllable refresh. Use the current SDK's `EpdController` (`onyxsdk-device`; namespace/enum are **version-sensitive — verify against your AAR**):

```kotlin
// UpdateMode (current SDK): None, DU, GU, GU_FAST, GC, GC4, REGAL, REGAL_D, ANIMATION*, ...
EpdController.setViewDefaultUpdateMode(view, UpdateMode.REGAL) // reading/editing default
EpdController.invalidate(view, UpdateMode.GC)                  // one clean full flash
```

- Newer **Qualcomm/Snapdragon** Boox (Note Air5 C, Tab X C) route refresh through a reflection-based path (waveform constants: Normal=255, REGAL=5, A2=1, X=4, GC16=2, REAGL=6) and need `preventSystemRefresh`-style calls around `onResume`/`onPause`. KOReader's EPD controller is the reference implementation.
- **Wrap every EpdController call in reflection-safe try/catch and no-op off-Boox**, so the same APK runs on phones. Implemented as `render/EInkRefreshController.kt` — a thin, SDK-free reflection wrapper gated by `EInk.isBoox`.

## 7. Streaming Claude chat on e-ink

Token-by-token repaint = constant flicker + heavy ghosting; e-ink can't do 30–60 updates/s. Instead:

1. **Buffer tokens, flush on a timer** (`profile.streamBatchIntervalMs`, ~300 ms on e-ink) via `snapshotFlow`/`Channel` + `sample()` — not per token.
2. **Flush on line/clause boundaries**, append-only into the growing message's box, using a fast waveform while streaming.
3. **Render plaintext while streaming; apply markdown + syntax highlighting only on completion** (code should be highlighted once it's syntactically complete anyway), then do **one full/REGAL refresh of the message block** — the "commit" frame.
4. Offer a **"smooth vs clean" toggle**: fast per-line streaming vs fully chunked per-message render (zero flicker). Clean is a sensible default for the code-heavy case.

## 8. Verify before shipping (version-sensitive)

- Onyx `UpdateMode` membership + `EpdController` package path (legacy mirror vs current `onyxsdk-device` AAR); Qualcomm vs MSTAR/RK code paths — **test on a real current-gen Kaleido 3 device.**
- Compose APIs: `Indication`/`ripple()` (1.7+) vs deprecated `rememberRipple`; `LocalOverscrollFactory` (1.8+) vs `LocalOverscrollConfiguration`. Pick per the pinned Compose BOM.
- Sora `EditorColorScheme` color-IDs and `TextMateColorScheme.create()` signature shift across releases; set themes on the **main thread**; color-scheme instances are shared unless you pass a fresh one.
- The e-ink device allowlist needs maintenance as new brands/models appear.

> Sources behind this doc: E Ink Kaleido 3 specs; BOOX ghosting guidance; Onyx `OnyxAndroidDemo` / `public-wiki` + `onyxsdk-device` (Maven); KOReader `android-luajit-launcher` #250; Android Indication/Ripple + MotionDurationScale + overscroll docs; Sora Editor color-scheme/TextMate docs.
