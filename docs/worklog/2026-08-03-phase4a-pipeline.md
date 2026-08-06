# Phase 4a — the ahead-of-time model pipeline

The spike said a CAD kernel cannot live in the request path. This is the shape that follows from that:
conversion happens in a separate tool, the bridge only reads what it left behind.

## What exists now

| | |
| --- | --- |
| `bridge/src/kicad/meshCache.ts` | cache layout, keys, manifests. **No kernel dependency** — it is the contract, not the converter. |
| `bridge/src/kicad/glb.ts` | glTF-binary writer and inspector, ~200 lines, no dependencies. |
| `tools/gitview-models/` | the converter. The **only** thing carrying OpenCascade. |
| `bridge/src/config.ts` | `kicad.meshCache` — a directory the bridge reads and never writes. |

**Blobs are keyed by content; manifests by board.** Those answer different questions. *"Have we converted
these bytes?"* is about content, because one part is referenced under several variable names, from
several boards, in several repos. *"What can this board show?"* is asked on every index request, and
answering it by hashing every referenced model would re-read a 25 MB STEP each time to produce an answer
that had not changed. A manifest also gives embedded models somewhere to be named — they have no host
path at all, so a path-keyed design could not describe them.

**The CLI removed the hardest problem for free.** The spike's worst finding was that `ReadStepFile` is
synchronous, so a 6-second QFP would freeze chat and git alongside it, and the shipped worker is a
*browser* Web Worker — meaning a `worker_threads` wrapper, each with its own ~370 MB WASM heap. In a CLI
none of that exists. No worker pool, no streaming, no cancellation. A build tool is allowed to take a
while.

## Verified by running it

**`vme-wren` — the embedded path, on real geometry.** 33 of its 66 models are carried in the file, so
this needs no library at all:

```
vme-wren.kicad_pcb: 66 unique models (1480 references), 33 carried in the file
  converted 33, reused 0, failed 1, unresolved 32, skipped 0
  33/66 models ready
```

Every one of the 33 blobs was then re-read and checked as glTF rather than trusted: **33 valid, 0
invalid, 203,694 triangles in 7.3 MB** — a whole board's geometry. The single failure is the one file
`present=1` referred to earlier: a placeholder in the fake library that the kernel correctly rejects.

**Re-run: `converted 0, reused 33`**, 14.6 s wall — parse, decode, hash, no conversion. That is the
property the cache exists for.

**`video` — the disk path, against the real library.** Fetched the 21 models it needs from
`kicad-packages3D` 9.0.9, which is STEP-only:

```
converted 21, reused 0, failed 1, unresolved 5
```

**All 21 were referenced as `.wrl`** and resolved through the twin fallback to `.step`. That rule was
previously proven only as far as *resolution*; it is now proven through to 48,225 triangles of actual
geometry. Without it this board converts nothing.

## Two things I got wrong, both caught before running

**The cache check was after the conversion, on the disk path.** The comment beside it said "hash the
bytes first and only convert on a miss" and the code did the opposite — `convertFile` ran, *then* the key
was computed and the cache consulted. Every cache hit would have paid full conversion cost while
reporting itself as reused. Found by re-reading my own loop before running it; both paths now read
bytes → hash → check → convert only on a miss.

**A reused entry recorded zero triangles and zero bytes.** The manifest's counts are what a client uses
to decide whether to fetch, so a board assembled from cache hits would have advertised itself as free to
load. Reused entries now re-read the blob and record its real numbers.

## A failure bucket that was lying

`video`'s project-local `.wrl` was recorded as `convert-failed`, which says *this file is broken, go look
at it*. It is not broken — we do not read WRL, and nothing an operator does to the file will change that.
The corpus has 18 such models, so it is a recurring outcome, not an edge case. Now its own
`unsupported-format`, and the board reports `failed 0, unsupported 1` where it used to claim a failure.

The same distinction the coverage work already draws between `missing` and `unmapped`: a state is worth
its own name exactly when it changes what someone would do about it.

## Not done yet

- **4a.3** — the app. Nothing here depends on it: a mesh cache and honest coverage are useful to any
  client.
- **WRL is still unread.** 18 project-local models in the corpus. `occt-import-js` cannot read it;
  `assimp` can. Worth deciding later, and cheap to add to the converter — it is the component that is
  allowed to carry dependencies.

## Phase 4a.2 — the bridge serves what the converter built

Two additions, both read-only: the board index reports mesh coverage, and
`GET /v1/repos/:repo/kicad/model?path=&model=` returns the `.glb`. The bridge still has no kernel and
never converts.

**Coverage on the index**, read from the manifest rather than recomputed — hashing every referenced
model per request would re-read a 25 MB STEP to answer a question whose answer had not changed:

| board | resolved | meshes |
| --- | --- | --- |
| `video` | present 22, viaTwin 21, missing 5 | **ready 21**, unsupported 1, unresolved 5 — 48,225 tris, 2.08 MB |
| `vme-wren` | present 1, embedded 33, missing 32 | **ready 33**, failed 1, unresolved 32 — 203,694 tris, 7.69 MB |

**A mesh over HTTP**, which is what 4a.2 existed to prove:

```
GET …/kicad/model?path=vme-wren/vme-wren.kicad_pcb&model=kicad-embed://5000751517.step
200  model/gltf-binary  109,344 bytes   → parses as glTF, 2,498 triangles
cache-control: public, max-age=31536000, immutable
```

Immutable is honest here rather than optimistic: the URL's content is addressed by the hash of the
source bytes, so it cannot change meaning. A different model is a different key.

### The confinement property, and where it actually lives

`model` is client input. It is used **only** as a lookup key against the manifest's `raw` field and never
as part of a path. What becomes a path is the *manifest's own* key, and only after it is confirmed to be
64 lowercase hex characters — because a manifest is a file on disk, and a hand-edited or corrupted one
containing `../../../../etc/passwd` would otherwise reach `join(cacheDir, …)`. The board path cannot
traverse either, for a different reason: manifests are named by a hash of repo id + path, so a traversal
simply hashes to a manifest that does not exist.

Exercised against the running bridge rather than argued:

| request | result |
| --- | --- |
| model this board never references | 404 *that model is not referenced by this board* |
| model known but a `.wrl` | 404 *no mesh for that model: unsupported-format* |
| board with no manifest | 404 *no meshes have been built for …* |
| `model=../../../../etc/passwd` | 404 *not referenced by this board* — never treated as a path |
| `path=../../../../etc/passwd` | 404 *no meshes have been built* |
| no token | **401** |
| blob deleted from under the manifest | 404 *named by the manifest but missing from the cache* |

That last one is deliberately a 404 rather than a 500: the bridge is fine, the cache is not, and the fix
is to re-run the converter.

Four mutations of the lookup, all caught: dropping the key validation, accepting any non-empty key,
matching references loosely with `includes` instead of `===`, and dropping the reason a model is not
ready. The loose-matching one matters most — matching by prefix would serve one model in place of
another, which is the exact failure this whole feature is meant to avoid.

## Phase 4a.3 — the app side, so far

**Renderer chosen with numbers, and the numbers were wrong once.** Filament core, on the owner's call.
The figure quoted at decision time — 3.4 MB, +16% APK — was the *compressed AAR*. What actually lands is
one `.so` per ABI, and the build ships four:

| ABI | size | |
| --- | --- | --- |
| arm64-v8a | 2.03 MB | real devices |
| armeabi-v7a | 1.67 MB | real devices |
| x86 | 2.23 MB | **emulator only** |
| x86_64 | 2.14 MB | **emulator only** |
| total | **8.07 MB** | → release would be ~29.4 MB, **+38%** |

`abiFilters("arm64-v8a", "armeabi-v7a")` on the **release** build type only drops 4.4 MB that no phone
can load, bringing it back to ~25 MB (+17%) — the number the decision was actually made on. Debug keeps
all four, because the emulator is x86_64 and it is the only thing this gets exercised on.

**Two 11 MB / 9.5 MB dependencies avoided.** `gltfio-android` (the glTF loader) is 11 MB to parse a
format we generate ourselves; `GlbReader.kt` does it instead. `filamat-android` (the runtime material
compiler) is 9.5 MB; `part.filamat` is compiled ahead of time with `matc` and committed at **41 KB** —
427 KB unfiltered, 132 KB with `-S`, 41 KB once the variants a part viewer can never reach (skinning,
shadow-receiver, VSM, SSR, fog, stereo) are dropped. The `.mat` source sits beside it with the exact
command, and `matc` is needed only to change it, never to build the app.

### The bug worth recording

Filament's `TANGENTS` vertex attribute is **not a normal**. It is a float4 quaternion encoding the whole
tangent frame, and the shader recovers the normal by rotating `+Z` with it. My first version bound the
mesh's float3 normals straight to it — which compiles, binds, draws, and lights the model *wrongly*.
That is the shape of bug that ships: the picture is not blank, so nothing looks broken.

`TangentFrames.kt` builds the quaternion properly, and its tests assert the operation the shader
performs — rotate `+Z` by the frame, get the original normal back — over all six box-face normals, 400
pseudo-random directions, and every vertex of a real bridge-produced mesh. The basis also picks its seed
axis by *least* alignment with the normal: a fixed seed yields a zero-length tangent exactly when the
normal is parallel to it, which is one whole face of a box rendering black rather than a rare edge case.

### Components had to learn which model is theirs

Coverage counts *unique* models, which answers "can this board be shown" but not "what does R12 look
like" — so a tap had nothing to open. `BoardComponent.models` now carries the placement's own
references, per placement rather than per `libId`, because two instances of the same library part can
override their models separately and keying on the library would show one part's geometry for the other.
Omitted entirely when empty, since most components have no model and the index is already the largest
response the bridge sends.

Measured on `vme-wren` over HTTP: **1,508 components, 1,480 carrying a model reference, and 164 of those
already have a mesh ready** — 33 unique models reused across 164 placements, which is the 22× reuse
figure showing up from the other direction.

### Not verified yet, and the reason matters

`PartRenderer` compiles and the pure logic around it is tested (app suite **101**, bridge **281**), but
**nothing has been run on a device**: there is no screen wired to it yet, so there is nothing to look at.
Compiling is not verifying, and for a renderer that is more than usually true — the tangent-frame bug
above would have passed a compile, passed a wire-format test, and produced a picture. The next step is a
screen and an emulator, not more code.

## 4a.3 on a device: what is verified, and what is not

Driven on an emulator (1264x1680, `-gpu swiftshader_indirect`). **Long-press a component → its 3D model
opens.** Every stage below the renderer is confirmed working on-device:

```
primitive: 264 verts, 212 tris      ← C38's geometry, parsed and uploaded
onResized 1264x1011                 ← viewport correct, not degenerate
frame 2 renderables=1 vp=1264x1011  ← rendering the right thing
drawn=91  refused=3028              ← 91 frames actually completed
```

Hit-test → `readyModels` filter → HTTP fetch → `GlbReader` → Filament engine → geometry upload →
swapchain → resize → frame loop. All of it works.

**What is NOT verified: the pixels reaching the screen.** After 91 completed frames the render area still
samples `f8f7ec` — the exact colour of the Compose surface behind it — in both `screencap` and
`screenrecord`. `setZOrderOnTop(true)` did not change that.

I could not resolve it on this machine, and the reason is worth stating rather than hiding: there is no
GPU available. `/dev/dri` does not exist and `DISPLAY` is unset, so the emulator runs on SwiftShader and
nothing else is offered. A `SurfaceView` layer failing to composite into a capture under a software
renderer is a well-known awkwardness, and it is indistinguishable from here from a genuine bug in the
z-ordering. **This needs a physical device or a GPU-backed emulator**, and until then the honest
statement is "renders, visibility unconfirmed" — not "works".

The `beginFrame` ratio is a red herring worth recording so nobody chases it: 91 drawn against 3,028
refused is Filament's frame skipper reacting to ~1-2 second software frame times, not an error.

### Four bugs found by running it, none of which a test could have caught

| bug | why the suite was blind to it |
| --- | --- |
| `TANGENTS` bound as float3 normals | compiles, binds, draws — merely lit wrongly |
| missing `Filament.init()` | the engine is entirely native; the JVM suite never reaches it |
| tolerance `6f/scale` on a point target | ~0.8 mm of board space — the unit test supplies its own tolerance |
| `hasMesh` answering at board level | **the test was green while the caller was wrong** |

The last is the one to remember. `nearestPart` had five passing tests, and every one of them handed it a
correct predicate — while production handed it a predicate that ignored its argument and answered "does
this board have *any* mesh". A passing test on a pure function says nothing about whether its caller
passes sane arguments. Fixed properly by having the bridge send `readyModels`, so the client filters by
reference instead of guessing from a count.

Also self-inflicted, and costing two cycles: the first round of diagnostics printed `$width` literally,
because `${'$'}` written through a Python heredoc emits a literal `$` in Kotlin. The one number I needed
— the viewport size — was the one the broken interpolation hid. And one run was read against a **stale
install**, which briefly looked like "the callbacks never fire"; checking the dex for the diagnostic
strings is what showed the build was fine and the install was not.

## Form factors, and a second defect the tablet exposed

Driven on all three, against the same bridge.

| | board viewer | 3D part viewer |
| --- | --- | --- |
| Phone — POCO F3 (Adreno 650), physical | works | **works** — C20 with coherent directional lighting |
| Tablet — 2560x1600 | works; three-pane (Explorer / board / Sessions), copper in colour | **long-press never fires** |
| E-ink — 1264x1680 | works; mono, high contrast — copper drawn black rather than coloured | not reachable, same cause |

The board viewer is good on all three. `F.Cu`'s 5,376 primitives render legibly everywhere, and the e-ink
profile visibly does its job: the same copper that is orange on the tablet is black on the mono panel.

### RETRACTED: "the long-press competes with the pan gesture"

**That diagnosis was wrong, and it is left here rather than deleted because being wrong five times on
one feature is the story.** Instrumenting `onLongPress` and `nearestPart` before changing any code
showed both working perfectly on the tablet:

```
onLongPress at screen 938,562 -> board 334.06,131.17 scale=3.190114
nearestPart tol=8.777116 components=189 -> (C39, ${KICAD6_3DMODEL_DIR}/…/R_1…)
```

The gesture fires, the hit-test finds C39, the viewer opens. What actually caused the earlier misses is
duller: **enabling `F.Cu` re-fits the view**, which changes the board's screen transform — and every
coordinate I was pressing had been computed from a screenshot taken *before* that. I was pressing
where components used to be. The tap coordinates are also pane-relative on a three-pane layout (my
1514,934 arrives as 938,562), which I had not accounted for either.

The instrumentation is the only reason this did not become a fifth wrong fix on top of a fourth wrong
theory. What follows is the original, incorrect write-up.

### Original (incorrect) analysis: the long-press competes with the pan gesture

`BoardView` registers two separate handlers:

```kotlin
.pointerInput(board) { detectTransformGestures { … } }          // pan / zoom
.pointerInput(board, layers, shown) { detectTapGestures(onLongPress = …) }
```

`detectTransformGestures` handles single-finger pan, so a press-and-hold is ambiguous — a zero-distance
pan and a long press are the same input, and which detector claims it is a race. On the phone it fired
on the third attempt; on the tablet it never fired at all, including at coordinates computed from the
board's own component positions (C39 at 333.2 mm → screen 1514,934, pressed for 2 s, and with explicit
`motionevent DOWN`/`UP`).

Input reaches the pane — tapping the `F.Cu` chip loads the layer, confirmed by the render area changing
colour — so this is gesture arbitration, not a dead pointer path.

**This invalidates an earlier diagnosis.** The phone's first two long-press misses were recorded as "no
component within tolerance", and the tolerance was widened from `6f/scale` to `28f/scale` on that basis.
The tolerance was genuinely too tight for a point target, so that change stands — but it was not why
those presses missed, and treating the subsequent success as confirmation was wrong. The real cause was
always the race.

The fix is to arbitrate both gestures inside one `pointerInput` rather than letting two compete for the
same events. Not yet done.

## SUPERSEDED: "the emulator cannot render the 3D view"

It can. The problem was **SwiftShader**, not the emulator. Running it on Mesa's `llvmpipe` instead
renders the part correctly — C39's resistor body, lit faces, shadowed side, proper skybox — on the same
APK that showed a blank cream rectangle minutes earlier.

```
# give Xvfb time to actually create its socket; check /tmp/.X11-unix/X99, not pgrep
( Xvfb :99 -screen 0 1920x1200x24 & ) ; sleep 6
DISPLAY=:99 emulator -avd tabS8 -gpu host        # NOT -no-window: the window goes to :99
```

The emulator then reports `Graphics Adapter … (llvmpipe (LLVM 20.1.2))` and
`OpenGL ES 3.0 (4.5 Core Profile Mesa 25.2.8)` instead of SwiftShader at feature level 1. Sampling the
render area: **`6c6d77`** (geometry) where SwiftShader gave **`f4f1ea`** (blank).

Two things had blocked this earlier and both were my own checks being wrong. `-gpu host` needs
`DISPLAY` set at launch — headless it dies with `DISPLAY: [(null)]` — and my "Xvfb produces no socket"
conclusion came from checking before it had started *and* from `pgrep -f "Xvfb :99"` matching its own
command line. That was the third self-matching `pgrep` of the session; `ps -eo pid,cmd | grep "[X]vfb"`
is the honest form.

**This matters for the loop, not just for tidiness.** An emulator install is seconds; a signed build for
the phone is minutes, because the phone runs a release-signed APK and every iteration has to go through
`tools/release.sh`. The 3D viewer is now testable in the fast loop.

### The earlier (wrong) conclusion, kept for the record

With the `TextureView` fix in place, the viewer **opens** on the tablet emulator (`C39` / `Close`
present, Filament initialises, backend feature level 1 under SwiftShader) and the render area is
**flat cream `f4f1ea`**, unchanged after a further 25 seconds. On the phone the identical view shows
the capacitor body at `93959b`.

The area *is* distinct from the app's dark background (`25262c`), so the `TextureView` composites —
this is not the surface bug returning. SwiftShader simply produces no geometry.

So for the 3D viewer specifically, **a physical device is required**, and the emulator is only good up
to "the viewer opened". Worth stating carefully, because the earlier claim that a device was needed was
made for a reason that turned out to be false — the blank `SurfaceView` was a real bug the emulator
reproduced faithfully, not a SwiftShader artefact. Right conclusion, wrong reasoning, and the two are
not the same thing.

The board viewer needs no device: it renders correctly on all three form factors.

## 2026-08-05 — the viewer palette, and re-shooting the three form factors

Re-captured all three form factors because the previous screenshots lived in `/tmp` and had been
cleaned. Two of three came back; the phone is PIN-locked and stayed blocked.

### Emulator: the blocker was a dialog, not the GPU

The tablet AVD would not boot — `qemu` alive, no adb port, nothing in the log after
`Showing crashdialog to get consent`. It was waiting on a **crash-consent dialog from an earlier
crash**, drawn on the virtual display where nothing could answer it. Removing `/tmp/android-argonite`
cleared it. `rm -f` on that path had silently failed because it is a directory; the `-rf` is the fix.

Second trap: on the headless tablet both `screencap` **and** a still `screenrecord` return the last
*composited* frame, which on an idle screen is whatever was there before. That produced a black frame
with the launcher dock, and the first reading of it — "GitView's window has no visible buffer" — was
wrong. Rendering stock Settings proved the pipeline was fine; nudging the UI *during* the recording
produced correct frames. The e-ink AVD's `screencap` behaves normally.

Third: `input swipe x y x y <ms>` does not cross the long-press threshold. `input motionevent DOWN`,
wait, `UP` does. Eight "failed" long-presses were that, not the picker. Confirmed by pulling the board
index from the bridge, mapping the 164 mesh-bearing parts to screen coordinates and pressing a real one.

### The palette, which was the actual defect

Measured off captures of one build: an unpainted part sat at **2.4:1** against the viewport on Color
E-Ink and **3.5:1** on Standard dark, inside a UI running **19.8:1** (text) and **21.0:1** (traces).

The first framing — "e-ink gets the dark theme's backdrop" — was wrong, and measuring both killed it.
The backdrops were `(85,93,103)` and `(88,94,106)`: the *same* colour, belonging to neither theme. The
tablet only scored better because TR2's face caught more light than C39's. So this was never an e-ink
bug; it was one constant that ignored the theme everywhere, and e-ink is where it showed because there
is no backlight to recover the difference.

`BoardView` never had the problem: it draws through Compose and keys off
`MaterialTheme.colorScheme.background.luminance()`. Filament draws outside Compose, so the theme has to
be carried across by hand — `viewerPalette` in `KicadTabRules.kt`, sampled in `PartViewer` and passed
into `PartRenderer`.

### Three attempts, two of them wrong — and only measurement caught it

**First attempt: solve for the floor.** Pick the part colour so it lands at exactly 4.5:1 against the
backdrop. Tests passed, e-ink went 2.4 → 7.8:1. It also **regressed the dark theme, 3.50 → 2.86:1**,
because solving *for* 4.5 pulled the dark theme's part albedo from 0.62 down to 0.315 — throwing away
separation it already had in order to hit a minimum. A floor is a thing to clear, not to land on.
Caught only by re-measuring the tablet, which the change was never "about".

**Second attempt: maximise instead.** Keep `PART_LIGHT = 0.62` verbatim so the dark theme cannot move,
and use a very dark part on light grounds. Tablet 6.09:1, e-ink **14.3:1** — and the e-ink render was a
black silhouette. The facet shading that makes the part read as a *solid* was gone, so the shape was
harder to see at the better ratio. Contrast is not the objective; legibility is, and contrast is its
floor.

**Third, and what shipped:** two fixed candidates (`PART_LIGHT` 0.62, `PART_DARK` 0.15), take whichever
separates further, and solve only in the narrow mid-grey band where neither clears the floor. Choosing
the *side* there by which candidate scores better is a fourth trap the sweep caught: against a 0.22
backdrop the light candidate wins on points but tops out at 3.9:1, while black reaches 5.4:1 — so the
side is chosen by which extreme reaches further. The floor is always attainable: `max(toWhite, toBlack)`
is minimised where they cross, at `bl = sqrt(0.0525) ≈ 0.229`, and there it is **4.58** — which is why
the floor is 4.5 and not a rounder, unreachable 5.

Measured on the final build, same part (C39), same board:

| | before | after |
|---|---|---|
| Standard dark (tablet) | 3.50:1 | **6.09:1** |
| Color E-Ink | 2.42:1 | **7.70:1** |

The unit tests bound **albedo** contrast only; lighting modulates what reaches the screen (the rendered
part is consistently darker than its albedo), so both figures above are measured off device captures
rather than claimed from the tests. 127 tests, 0 failed.
