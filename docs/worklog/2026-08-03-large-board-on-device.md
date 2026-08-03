# 2026-08-03 — The PCB viewer had never been opened on a large board

Asked directly whether the PCB view had been tested on the emulator, the honest answer was: yes,
thoroughly — on `video.kicad_pcb`, 5.5 MB. **`vme-wren`, 66 MB, had only ever been exercised through
curl.** That is the board the entire per-layer design exists for, and the app had never rendered it.

Opening it found **two bugs, both shipped in v0.1.14**.

## 1. Opening a large board OOM'd the app

```
OutOfMemoryError "Failed to allocate a 157099432 byte allocation with 25149440 free bytes"
```

`openPath` fetched the **blob** — the whole 66 MB source — before `loadBoard` fetched the index. ~157 MB as
a Java String. The board index request never fired: it lives in the blob fetch's `onSuccess`.

The bitter part is that **the app never displays that text**. For a `.kicad_pcb` the render branch is
`isBoard && board != null → BoardView` and the fallback is `EditorSkeleton`. The source is only wanted if
the drawing cannot be built. So the per-layer design — a 239 KB index, geometry on demand — was being
thrown away by the download in front of it.

Fixed: a KiCad file no longer fetches its source on open; it goes straight to the drawing, and the source
is fetched **only if that fails**, which is exactly when reading the raw s-expression is useful.
`reloadChangedOpenFiles` had to learn the same thing or it would reintroduce the download on every file
change. `loading` is now cleared by the scene/board load, because the blob fetch used to do it.

| | before | after |
| --- | --- | --- |
| open `vme-wren.kicad_pcb` | 186 s, then OOM, tab dropped | **9 s**, index landed, `F.Cu 20887` |

## 2. Three text labels silently killed a 20,887-primitive layer

With the board finally open, enabling `F.Cu` drew **nothing** — for 105 s. The chip stayed lit. No error.

The bridge served it fine (200, 6.1 s, 2.6 MB, 20,887 primitives). The app was throwing, and
`loadBoardLayer` swallowed it with `runCatching { … }.getOrNull()`.

The cause is a wire-format flaw I introduced in Phase 3: **one key with two types.**

```ts
| { t: "pad";  … size: Pt     … }   // [w, h] — an array
| { t: "text"; … size: number … }   // font size — a scalar
```

The app models `size: List<Double>?`. A strict decoder cannot be both, so **one** text primitive threw a
`SerializationException` and took the whole layer with it.

`video.kicad_pcb`'s `F.Cu` contains **0** text primitives. `vme-wren`'s contains **3**. That is the entire
difference between "works" and "silently draws nothing", and it is why the small board proved nothing.

Fixed by giving text its own `fontSize`. The schema-less stance was always about unknown *kinds* degrading
gracefully; it was never a licence to overload a field name.

And `loadBoardLayer` no longer swallows failures. A layer that fails must say so — swallowing made a failed
fetch indistinguishable from a layer with nothing on it, which is precisely how this hid.

## Verified

`vme-wren.kicad_pcb`, 66 MB, on the phone: index in **9 s**, `F.Cu` (20,887 primitives / 2.6 MB) rendered
in **~17 s**, ink 6,472 → **286,184** pixels, TOTAL PSS 152 MB, **0 OOMs**. Dense copper, BGA fanout, DDR
banks and the VME edge fingers all visible.

Breaking the field rename fails the new test; reverting the source-fetch skip reproduces the OOM.

## The lesson, again

Every device test of the board viewer used the 5.5 MB board, and I described that as having driven the PCB
view on all three form factors — true, and not the same as having tested it. The size that motivated the
design was the size never tried. This is the third time on this feature that generalising from one sample
has hidden a defect; the difference is that this one reached a release.
