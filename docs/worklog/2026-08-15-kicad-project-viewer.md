# 2026-08-15 — KiCad viewer overhaul: the project as the unit, and where 3D comes from

Owner's report: *"if the KiCad project has project-specific symbols, footprints, 3D models, there's no way
to render it here."* Plus a flow change — open the project file, get schematic / PCB / 3D as tabs.

This is the planning pass. Output is ADR-040 and its `docs/PLAN.md` entry — **both written but landing
separately**, so they are not in the repo at this commit — plus one fix landed on its own PR (#60), which
is what this worklog ships alongside.

## The premise, checked before planning anything

Two thirds of it is already false, and finding that out is what turned a library-management project into
a small one. KiCad 6+ files are self-contained:

| claim | measured |
| --- | --- |
| project-local symbols cannot render | **false** — `interf_u` declares `${KIPRJMOD}/interf_u.kicad_sym` in `sym-lib-table`, and all 18 `lib_symbols` definitions in its `.kicad_sch` are `interf_u:*`. `scene.ts:356` draws from that block. |
| project-local footprints cannot render | **false** — `StickHub.kicad_pcb` has 94 footprints with 1,417 inline `fp_line`/`fp_poly` primitives. No `.pretty` is read. |
| project-local 3D models cannot render | **true**, and it is the cheapest case of the three |

24 unique `${KIPRJMOD}` model files in the KiCad 10 corpus, **24 of 24 present in the repo itself** — no
operator mapping, no 5.7 GB library, no download — and not one of them can be shown, because conversion is
an ahead-of-time CLI somebody has to log in and run.

## Two of my own numbers were wrong, both from not measuring

**Project composition.** I first reported "13 have a board, 25 schematic-only, 3 with neither". Wrong: the
counting loop word-split on a demo directory literally named `sonde xilinx`. Correct, with `-print0`:
**36 projects — 17 both, 18 schematic-only, 1 board-only, 0 empty.** The conclusion survived and got
stronger (half have no board, so fixed tabs are wrong either way), but the figures were fiction for one
exchange. The space in that path is itself worth keeping: it is reachable from repository content.

**Renderer sizing.** I told the owner that 1,508 placements needs a different renderer than 90. Placement
count is not the governing number:

| board | placements | referencing a model | unique geometries |
| --- | --- | --- | --- |
| `vme-wren` | 1,508 | 1,480 | **66** |
| `jetson` | 1,125 | 1,006 | **67** |
| `video` | 189 | 175 | **27** |

Memory follows unique geometries (66 — nothing); draw submission follows instances, which is what GPU
instancing is for. Whole-board 3D is materially cheaper than I implied, *because* ADR-038 already exports
per-component instances — a decision made for cross-probing that pays off somewhere unrelated.

## The resolver fix, landed separately (PR #60)

Found uncommitted in the working tree, on a branch with zero commits versus `main` — fragile place for a
measured fix to live. Landed on its own so the overhaul does not carry it.

Resolution preferred the extension the board names. Only STEP converts, so a `.wrl` resolved happily,
counted as `present`, and died at conversion as `unsupported-format`. Re-measured **both directions** on
this box rather than trusting the note — `video.kicad_pcb`, KiCad 7 library, 27 unique models, 175
references, all named `.wrl`:

```
before   converted 0,  unsupported 24   ->   0/27 ready
after    converted 23, unsupported 1    ->  23/27 ready
```

Taken through to converted `.glb`s, not to a coverage count — a coverage count is precisely what lied here.
Bridge suite 283 pass / 0 fail. One stray indentation from the original edit cleaned up.

## Decisions (ADR-040 — note ADR-039 was already taken by transport security/TLS)

1. The `.kicad_pro` is what the viewer opens. Basename pairing holds across all 36 corpus projects.
2. Tabs are what the project *has*, answered by the bridge — same reasoning as `counterpart`.
3. Direct `.kicad_sch`/`.kicad_pcb` opens show source with a banner into the viewer. Consequence:
   cross-probe must be retargeted at the project view or "show on board" lands in a text buffer.
4. `${KIPRJMOD}` and relative models read as **git blobs at the requested ref**, not from the working tree.
5. Conversion on demand, bounded (unique models only; content-addressed cache + atomic `rename` already
   answers most of the concurrency question). This is PLAN item C, and it reverses ADR-038's deliberate
   ahead-of-time choice, which is why it needed the ADR.
6. Whole-board 3D reuses the per-component instances. **Prerequisite:** the bridge must carry the per-model
   `(offset)`/`(scale)`/`(rotate)` it currently drops — 24 of 93 model blocks on `StickHub` have a non-zero
   one, so omitting them misplaces a quarter of the parts.

## Owner's answers that shaped it

Direct open → source with a banner (not text-only, not auto-redirect). 3D → project-local models first.
Densest board is over 1,500 placements. Projects are hierarchical multi-sheet, with project-local 3D
models *and* project-local symbol/footprint libraries, *and* stock-library parts — so coverage has to
distinguish "not converted yet" from "unmapped variable" rather than reporting one number.

## Not done here

No code beyond the resolver fix. Round A (bridge) and Round B (app) are TODOs in `docs/PLAN.md` with their
verification named.

## End-to-end on an emulator (the part a bridge-only branch still owes)

Bridge run from the branch on `:8899` serving a git repo of KiCad 10 demo projects; debug APK on
`kancil_test`; paired; opened `StickHub.kicad_pcb`; long-pressed **J7**, one of seven connectors using
`${KIPRJMOD}/3dmodels/JST_SH_SM04B-SRSS-TB.STEP` — a model that resolved to nothing before this branch.
It fetched, parsed and **rendered**, and orbits under drag. The endpoint returned `200
model/gltf-binary`, valid glTF 2.0, 140 triangles; the index reports `ready 11 / viaTwin 7`.

What the second round of fixes bought, measured rather than assumed:

| board | before | after |
| --- | --- | --- |
| `CM5_MINIMA_3` | 20/32 ready | **22/32** |
| `StickHub` | 10/12 ready | **11/12** |

Exactly the three uppercase project-local models, nothing lost.

### A capture trap, and then a real bug underneath it

The first frame of every part is a **blown-out flat field** — it looks exactly like a viewer that failed
to load. It is not: rotating reveals the geometry, and the diff across a rotation goes from 7 distinct
colours to 207. Two capture paths (`screencap` and screenrecord+ffmpeg) agreed on the flat frame, so the
staleness rule was not the explanation this time — the renderer really does open on a washed-out
close-up.

Underneath it is a genuine defect, written up as a plan item in the held batch: the viewport backdrop is
**near-white (250,246,238)**
inside a dark app **(24,27,33)**, and an unpainted part measures **1.00:1** against it. ADR-038 set that
floor at 4.5:1 and shipped 7.7 and 6.1. It reproduces on a stock-library part (`C18`) as well as a
project-local one, and this branch changes no `android/` code — pre-existing on `main`.

The uncomfortable part: **the `viewerPalette` unit tests still pass.** They assert the function's
arithmetic, and what is wrong is the value handed to it. A rule pinned in isolation cannot notice that
its input came from the wrong place — the same shape as "resolution succeeding is not rendering
succeeding", one layer up.
