# 2026-08-03 — Phase 4 (3D): measuring before building, and the plan not surviving it

Phase 4 has sat in the plan as "gated on 5.7 GB of external assets" since it was written. Before touching a
renderer I measured the corpus, and the framing does not hold.

## What the corpus actually says

19 boards, **3,616 model references, 392 unique**.

**Model paths resolve through 13 different environment variables.** Not one, not two:

| variable | refs | what it is |
| --- | --- | --- |
| `${KICAD9_3DMODEL_DIR}` | 1,324 | the official library, v9 naming |
| **`${ANT3DMDL}`** | **1,007** | someone's private library — defined in *their* KiCad settings, shipped nowhere |
| `${KICAD6_3DMODEL_DIR}` | 627 | official, v6 naming |
| `${EASYEDA2KICAD}` | 193 | third-party converter output |
| `${KIPRJMOD}` | 49 | the project directory — the only one we can resolve for free |
| …8 more | | |

The bridge cannot know what these point at. Any design has to take a **configured variable → directory
map** from the operator; guessing is not available.

## 27% cannot be resolved at all, and it is concentrated

| board | unique models | official lib | in repo | unresolvable |
| --- | --- | --- | --- | --- |
| `jetson-agx-thor-baseboard` | 67 | 0 | 1 | **66** |
| `One-Air-Max` | 40 | 0 | 4 | **36** |
| `vme-wren` | 66 | 33 | 33 | 0 |
| `video` | 27 | 23 | 4 | 0 |
| **all 19** | **392** | 207 (53%) | 78 (20%) | **107 (27%)** |

The two largest, most interesting boards are almost entirely unresolvable. **A 3D view of `jetson` would
show one part out of 67.** Rendering that without saying so is the viewer-that-lies failure again, in a
more expensive costume — and it would be discovered only after downloading 5.7 GB.

## The cheap toolchain covers the assets we do not have

`.step` is **72%** of references (2,598) against `.wrl`'s 1,005. The plan said "footprints reference
`${KICAD*_3DMODEL_DIR}/….wrl`", generalised from one board.

That distinction decides the whole build:

- `assimp` is in apt, reads **WRL**, writes glTF. It **cannot read STEP** — that is CAD B-rep and needs
  OpenCascade/FreeCAD to tessellate.
- The official 5.7 GB library is mostly `.wrl`. Everything *outside* it is mostly `.step`.

So the easy path serves the library nobody has installed, and fails on the models repos actually carry.

Two smaller findings in the same direction:

- **Ubuntu's `kicad-packages3d` is 7.0.11** while the corpus names `KICAD9`/`KICAD10` paths — the same
  staleness already documented for `kicad-cli`. Whether v7 filenames satisfy v9/v10 references is
  *unverified*, and it has to be measured before anyone spends 5.7 GB finding out.
- **Only 24 in-repo model files actually exist on disk** (42 MB, largest a 24 MB STEP), so the "free" slice
  is ~6% of unique models, not the 20% the path counting suggests.

## What is in our favour

**Reuse is 22×.** `vme-wren` makes 1,480 references to 66 unique models. Fetch and convert per *unique
model*, never per placement — otherwise the work is 22 times larger than it needs to be.

## The re-scope

Coverage reporting first, and nothing else: the board index already walks footprints, so report per board
how many parts have a model that **resolves**, and under which variable. It needs no assets, costs almost
nothing, and answers up front the question everything else depends on — *can this board be shown at all?*

Then render the resolvable subset while saying what is missing. Then STEP, only if carrying a CAD kernel
earns its place.

Nothing has been downloaded and no renderer written, which is the point: an hour of measuring moved this
from "install 5.7 GB and start" to a first increment that ships value with no assets at all — and stopped a
version of Phase 4 that would have looked broken on the two boards most worth looking at.
