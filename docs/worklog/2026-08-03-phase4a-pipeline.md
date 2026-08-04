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
