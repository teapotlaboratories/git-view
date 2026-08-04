# STEP → mesh: measuring whether the bridge can carry a CAD kernel

Phase 4 step 3 said "STEP only if a CAD kernel is worth carrying" and left it as a judgement call. It
isn't one — it is four numbers, and they were cheap to get. Spiked with
[`occt-import-js`](https://www.npmjs.com/package/occt-import-js) 0.0.23, a WASM build of OpenCascade's
STEP reader, which is the only realistic *in-process* option for a Node bridge (`assimp` cannot read
STEP at all; FreeCAD is a Python application, not a library you embed).

Everything below is measured on this box against **real geometry** — 13 models pulled from the official
`kicad-packages3D` at tag 9.0.9, and 12 vendor models that ship inside the corpus repos. The fake
STEP-only library used for the resolver tests is placeholder text and is useless for this.

## Conversion time

Warm-up is real but small and one-off: the same capacitor five times runs `1530, 386, 272, 356, 241 ms`,
so the first call into the module costs ~1.2 s extra and every call after it is steady. All figures
below are steady-state except the vendor rows, which are one process per file (so each carries ~1 s of
warm-up — they are *understated* as a per-call cost, not overstated).

| slice | n | median | mean | max |
| --- | --- | --- | --- | --- |
| official library | 13 | **0.37 s** | 1.75 s | 6.4 s (`TQFP-100_14x14mm`) |
| in-repo vendor | 12 | **2.7 s** | 15.3 s | **101.7 s** (25 MB `hailo8_m.2`) |

The median hides the shape. An 0402 resistor is 128 ms; the parts a board is actually *full of* are not:

| model | in | time | triangles | out |
| --- | --- | --- | --- | --- |
| `R_0402_1005Metric` | 40 KB | 0.13 s | 276 | 11 KB |
| `SOIC-8_3.9x4.9mm` | 122 KB | 0.68 s | 1,314 | 52 KB |
| `PinHeader_2x20` | 1.2 MB | 3.3 s | 2,404 | 120 KB |
| `LQFP-64_10x10mm` | 847 KB | 4.8 s | 8,744 | 353 KB |
| `TQFP-100_14x14mm` | 1.3 MB | 6.4 s | 13,480 | 545 KB |
| `ESP32-C6-WROOM v3` | 4.2 MB | 19.0 s | 16,452 | 678 KB |
| `USB3stacked` | 4.4 MB | 21.1 s | 25,416 | 1.0 MB |
| `hailo8_m.2` | 25 MB | **101.7 s** | 357,009 | 11.2 MB |

Applied to `vme-wren` (33 official + 33 in-repo, from the coverage survey): **1.7 minutes** of CPU at the
medians, **4.7 minutes** at the means. One board.

## Memory

This is the number that decides it. Peak RSS for a **single** conversion:

| model size | peak RSS |
| --- | --- |
| 40–500 KB | 276–325 MB |
| 4 MB | 434–531 MB |
| 25 MB | **1,732 MB** |

1.7 GB to convert one part. The board cache was capped at 48 MB of source precisely because a 66 MB
board retained 750 MB; this is that problem again with a worse constant, and it would sit in the same
process.

## Output is the one number in our favour

Meshes are small — 11 KB to 1 MB for everything except the 25 MB outlier, and roughly **3.5 MB for a
whole board's unique models**. Combined with the 22× reuse already measured, a converted model is worth
caching essentially forever, keyed by content hash. Conversion is expensive exactly once per unique file,
across every board and every repo that references it.

## Packaging

`occt-import-js` is 12 MB installed, of which **7.6 MB is the `.wasm`**. The bridge `.deb` is currently
**4.03 MB** (v0.1.14, amd64). Carrying the kernel makes it ~11.6 MB — near enough **3×** the package,
paid by every operator including the ones who never open a board.

## It cannot run on the event loop, and the shipped worker does not help

`ReadStepFile` is synchronous. A 6-second QFP conversion inline would freeze chat, git, and every other
request for six seconds. The package does ship `occt-import-js-worker.js`, but it is a **browser** Web
Worker — `importScripts`, `onmessage`/`postMessage` — so a Node `worker_threads` wrapper is ours to
write. And each worker instantiates its own WASM heap, so the memory figures above multiply by the pool
size rather than amortising across it.

## What this means

Conversion is an **ahead-of-time** job. Nothing above is fatal to 3D; all of it is fatal to converting
in the request path, which is what "the bridge carries a CAD kernel" quietly meant.

So the recommendation is to **keep the kernel out of the bridge**. If 3D ships, models are converted
ahead of time into a content-hashed mesh cache, and the bridge only ever *serves* cached meshes — it
stays 4 MB, stays kernel-free, and keeps its memory profile. The coverage work already landed is the
right precondition either way: it is what says which models exist to convert, and which boards can be
shown at all.

The one thing not measured here is whether a v7-era model file satisfies a v9/v10 reference, which the
plan already flags as unverified and which matters before anyone downloads 424 MB.
