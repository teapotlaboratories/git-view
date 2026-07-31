# 2026-07-30 — KiCad Phase 1 (bridge half): the tagged scene endpoint

Continues [Phase 0](2026-07-30-kicad-phase0-solver.md), which derived nets and matched `kicad-cli` on
1722/1722. This turns a solved design into something the app can draw, and serves it over HTTP.

Two forks settled with the owner before writing anything, because both fix the wire format the app will
consume and both are expensive to change afterwards: the scene is **drawable *and* tagged** (symbol body
graphics and text, not just connectivity), and the work is sequenced **bridge first, then app**, so each
half is verifiable on its own.

## What landed

- `src/kicad/scene.ts` — solved design → tagged scene. Primitives: `wire`, `bus`, `poly`, `rect`,
  `circle`, `arc`, `text`, `pin`, `junction`, `nc`, each carrying `net`/`ref` where it has one.
- `src/kicad/service.ts` — on-demand parse, cache keyed by resolved oid + root path.
- `GET /v1/repos/{repo}/kicad/scene?path=…&ref=…&sheet=…` in `rest.ts`, reading sheets as **git blobs**.

Symbol graphics go through the same `placePoint` as the pins. That is not a detail: if they used different
transforms the sheet would still render, just wrong. Checked structurally across the corpus — **0 of 1585
components have a pin outside its own body**.

## Rendering it is what found the bugs

Every count looked healthy: primitive kinds all present, 96% of primitives tagged, sensible bboxes. So I
dumped a scene to SVG, rasterised it, and looked at it. Three defects, none of which a count would show.

**No reference designators or values.** The sheet drew beautifully — op-amp triangle, resistors,
capacitors, power symbols, correct topology — and had no `R1`, `C1` or `10k` anywhere on it. I emitted the
symbol's *body* text but never the instance's `Reference`/`Value` **properties**, which are the labels a
human reads. A schematic without refdes is not a schematic, and Phase 2's cross-probe depends on them.
Hidden properties (every power symbol hides both; `Footprint` is hidden almost always) must stay hidden or
the sheet fills with noise.

**Text anchors were missing.** `PWR_FLAG` beside a `VDD` symbol rendered as `PWR_FLAGDO` — two strings on
top of each other. KiCad anchors text with `(justify left bottom)`; without it the app cannot place a
single label correctly. 2001 `left bottom`, 855 `left`, 272 `right` in the corpus.

**`\n` was never unescaped.** SPICE directives and text boxes came out as one run-together line. The
s-expression reader deliberately passed unknown escapes through, on the theory that KiCad only escapes
`\"` and `\\` and that leaving the rest alone was safer for Windows paths in `(model …)` refs. Measured
across both corpora, 135 files: the only escapes that ever appear are `\\` (9383), `\"` (1053) and
**`\n` (497)**. The Windows-path worry never materialises; the `\n` bug affects 497 real strings.

## Then running it found three more

A green test suite and a correct-looking JSON blob are not a working endpoint, so: build a git repo of
KiCad demos, run the bridge, pair, curl.

| finding | before | after |
| --- | --- | --- |
| non-schematic file returned **HTTP 500 "internal"** | 500 + parser message | 400 `bad_request`, named file |
| malformed self-referencing sheet | **70 s** per request | 0.22 s |
| repeated placements re-read the same blob | 2000 `git show` spawns | 1 |

The 70-second one is the interesting one. Phase 0's placement cap stopped the *fan-out*, so the design
solved fine — but `getScene` then eagerly built a scene for **every** instance, which at the cap is 2000
renders inline. Eager building had looked like a free win (the solve is already paid for, so the sheet
switcher would be instant). ADR-038 actually says warm siblings *in the background*; doing it inside the
request is the difference between a fast response and a bridge nobody else can use. Now exactly one scene
is built per request and siblings are cached as they are asked for.

That left 30 s, all of it `git show` spawns: a self-referencing file was read 2000 times. `loadDesign` now
memoises reads per load — correct because a design is a snapshot at one ref — which also helps legitimate
designs (`complex_hierarchy` places one file twice). **70 s → 30 s → 0.22 s.**

## Verified by running

```
sallen_key (flat)            HTTP 200   12 KB   0.10 s
video (8-sheet hierarchy)    HTTP 200   41 KB   0.35 s
video, immutable ref, warm   HTTP 200           0.009 s      ← 58× over cold
child sheet by instance path HTTP 200           0.06 s
../../../../etc/passwd       HTTP 400   path_escape
Sheetfile escaping the repo  HTTP 200   problems: ["x" points outside the design; refused]
self-referencing sheet       HTTP 200   0.22 s, capped at 2000, reported
```

ETag + `Cache-Control: immutable` on an oid; `no-cache` on the working tree, which is never cached because
it can change between two requests with no ref to say so.

## Tests

10 new, on hand-authored fixtures. Each verified to fail when its rule is broken — and two did not, first
time round:

- The **bus-tagging** test put its bus in empty space, where `netAt` returns nothing either way, so
  "buses carry no net" held even with bus tagging switched on. Moved the bus onto a real net's node, which
  is the case that actually matters, and it now fails when buses are tagged.
- The **transform** test was never exercised by any of my breaks, so I added one that uses raw library
  coordinates instead of `placePoint`.

Suite **213 pass**; Phase 0 still **1722/1722** nets, 0 merges, 0 splits.

## Not done

The **app half** — Compose Canvas renderer, pinch/pan, sheet switcher. Phase 0 was exempt from the
emulator rule because nothing was app-reachable; that exemption ends the moment the renderer exists, and
this endpoint is what it will be driven against.

## App half — written and building, NOT verified on a device

`SchematicView.kt` (Compose Canvas, pinch/pan about the pinch centroid, fit-on-first-layout,
tap-to-select-net, sheet switcher), `KicadScene`/`ScenePrimitive` wire types, `BridgeApi.kicadScene()`,
and an `EditorArea` branch so a `.kicad_sch` tab draws instead of showing its s-expression. APK assembles
(29 MB). **That is not verification** — the emulator rule is explicit that a compile is not proof the
screen works, and this is exactly the branch that rule was written for.

Design notes worth keeping:

- `ScenePrimitive` is **one flexible shape, not a sealed hierarchy**, mirroring the reader's schema-less
  stance: an unknown `t` from a newer bridge decodes cleanly and simply is not drawn, rather than failing
  the whole response.
- A schematic tab that cannot build a scene **falls back to the source text**. An unparseable schematic is
  precisely when reading the raw s-expression is most useful, so that is the right failure, not an error
  screen.
- E-ink is not a downgrade path. Selection is carried by **stroke weight**, not hue, because dimming is
  invisible on a mono panel — the same weight-not-colour rule the diff viewer already follows.

### Verified on a phone emulator — and two findings of mine that were wrong

Ran it: booted a phone AVD headless, installed, paired, opened a `.kicad_sch`.

- **The schematic renders.** Sallen-Key with op-amp, `R1 1k`, `R2 1k`, `C1 100n`, `U1 AD8051`, power
  symbols, junctions, pins, multi-line SPICE directives.
- **Tap-to-select-net works and is electrically correct.** Tapping the op-amp output selected `lowpass`
  and highlighted the output wire, the feedback path down to C1, and the label; everything else dimmed.
  That is the tagged scene paying off — highlight is a style change, not an overlay.
- **The sheet switcher works** across the 8-sheet `video` hierarchy.

**One real defect, findable only by running it: sheet symbols were never drawn.** The solver only ever
wants a sub-sheet's *pins*, so nothing failed until a hierarchical root was rendered and its seven
sub-sheets appeared as rows of floating pin stubs with no boxes and no names. Now emits the box, the sheet
name, the filename and the pin labels.

### Two things I reported that turned out to be my own fault

Both are worth recording, because both were confidently wrong and would have sent someone hunting.

**"Pairing fails silently" — false.** `pair()` already sets `pairError` and keeps the dialog open on
failure. What actually happened: I read the Pair button's coordinates from a dump taken *before* typing
the code, and the IME shifts the dialog by 383 px (y=1456 → y=1073). My tap landed outside the dialog,
which fires `onDismissRequest` and closes it with no message — exactly the symptom I attributed to the
app. The same stale-coordinate mistake had already bitten me on the add-bridge form an hour earlier,
where I fixed it with `KEYCODE_TAB` and then did not carry the lesson across. Pairing works: the device
registered on the first correctly-aimed attempt.

**"Fit-to-view is broken" — also false.** Comparing the device render against the bridge's own SVG of the
same sheet, they match: the empty space is genuine whitespace in that schematic. I had already moved the
fit from the draw phase to the layout phase before checking. That change is still right — writing state
during draw is wrong in Compose and breaks on resize — but it fixed no defect, and I should not have
claimed one.

The lesson is the one this repo keeps teaching from the other direction: *verify the diagnosis, not just
the symptom*. A UI harness can manufacture a convincing bug report about code that is fine.

### Incidental findings

- `screenrecord` produces a 0-byte file on this headless emulator; `screencap` works and *does* track UI
  changes here, contrary to an earlier note. Verified by diffing captures across a real UI change rather
  than assuming either way.
- `adb shell input tap` against the add-bridge form hits the wrong field once the IME is up, because the
  layout shifts. Navigating with `KEYCODE_TAB` is reliable where fixed coordinates are not.
- First frame took **19.9 s** on this 4-core box (`Displayed … +19s899ms`), which is long enough to look
  like a hang and produce a screenshot of the splash instead of the app.

## All three form factors, verified

| form factor | result |
| --- | --- |
| **Phone** 1080×2340 | renders; tap-to-select-net highlights the correct electrical net; sheet switcher works across the 8-sheet `video` hierarchy |
| **Tablet** 2560×1600 landscape | two-pane layout holds (Explorer │ schematic │ Sessions); the sheet fits itself to the narrower centre pane rather than assuming full width |
| **Bigme B7 Pro** 1264×1680, **E-Ink profile ON** | high-contrast black-on-white, single ink, antialiasing off; every label legible |

**The e-ink design bet was worth making, and it holds.** On the colour profiles a selected net turns accent
and everything else dims. Dimming is close to invisible on a mono panel and there is no accent hue, so the
e-ink path carries selection by **stroke weight** instead — the same weight-not-hue rule the diff viewer
follows. On the panel the `lowpass` net (output wire, feedback path, label) reads noticeably heavier than
its surroundings at a glance, with no colour involved. Worth stating plainly because it was a guess until
it was looked at, and Phase 2's cross-probe will inherit the same mechanism.

Incidentally, the schematic looks *better* under the e-ink profile than the dark one — unsurprising in
hindsight, since schematics were designed for paper.

The profile does not auto-detect on a generic AVD; toggled by hand via **⋮ → "Switch to E-Ink display"**.

## Phase 1 status

Bridge ✅, app ✅ on all three form factors. Suite **213 pass**; Phase 0 still **1722/1722** nets, 0 merges,
0 splits. Nothing committed.
