# 2026-08-03 — KiCad Phase 3b: schematic ⇄ board cross-probe

ADR-038 has called this "nearly free once both halves exist" since Phase 0. It mostly was — both sides
already publish `nets[]` and `components[].ref`, so nothing new had to be derived. The work was carrying a
selection across a tab boundary, and the two things that only showed up by running it.

## The bridge names the counterpart; the app does not guess it

A `.kicad_sch` and its `.kicad_pcb` pair by directory + basename. That is trivial to compute client-side,
and computing it client-side is wrong: only the bridge can tell whether the sibling actually **exists at
that ref**. An app that guessed would offer a "show on board" button that 404s on any project whose files
are not named in step — an action that lies about what it can do.

So both responses gained an optional `counterpart`, resolved server-side, absent when there is none. The
action is rendered only when it is present, so "no counterpart" and "no button" are the same state.

`blobExists` answers it without reading the file — one `rev-parse` instead of pulling up to 128 MB to
learn one bit. It inherits `readBlob`'s confinement and its silence about hidden and ignored paths: a
caller must not be able to turn an existence probe into a way to find `.gitview/tokens.json`. Both of those
are tested, and both tests fail when the corresponding guard is removed.

## Selection is a seed, not a binding

Both viewers own their selection internally (`remember(scene.path)`). Cross-probe needs to *start* them
somewhere, which is a different thing from controlling them: a binding would mean the user could never
deselect the net without leaving the tab, and every recomposition would drag it back.

So `pendingNet` is consumed once and cleared. The subtle part was elsewhere — `openFile` replaced the
placeholder `OpenFile` wholesale when the blob arrived, which silently dropped the seed. Cross-probe would
have opened the right tab with nothing selected. It is carried across explicitly now.

`openFile(node: TreeNode)` also had to become `openPath(path)`: cross-probe has a path from the bridge and
no tree node, because the counterpart is usually a file the user never touched in the explorer.

## What running it changed

**The first working version showed a blank rectangle.** Cross-probe opened the board with `Net: GND`
selected and the outline drawn — and nothing highlighted, because a board opens with only `Edge.Cuts` on.
That default is right when someone opens a board cold: copper is megabytes and nobody has said what they
want yet. It is wrong when they arrive by cross-probe, because *they have said*: they asked to see one
specific net on this board.

Now a seeded net turns copper on with it. The action does what its label claims instead of technically
working and visibly doing nothing.

**Driven end to end on the phone**, both directions:

| step | result |
| --- | --- |
| `video.kicad_sch`, filter `GND`, select | `Net: GND`, and `on board →` appears |
| tap `on board →` | `video.kicad_pcb` opens as a second tab, `Net: GND` already selected, F.Cu/B.Cu/In2.Cu on |
| the drawing | GND is amber against dimmed copper — and the whole inner plane is amber, because on this board `In2.Cu` **is** a ground plane |
| tap `on schematic →` | back to `video.kicad_sch`, `Net: GND` still selected |

## An hour lost to a harness, not a bug

Mid-verification the endpoint started returning empty bodies for exactly the two cases that should have had
a counterpart, while the negative cases behaved. That looked like a serialisation bug in the new field.

It was not. The scratchpad under `/tmp` had been cleaned underneath the running bridge, taking its config
and token store with it; `http=000` was connection-refused, not an empty 200. I had reported it as an open
bug before checking the status code.

Two lessons, one of them already written down and ignored: **anything that has to survive belongs outside
`/tmp`** — the corpus taught this once already — and **read the status code before theorising about the
body**. The test bridge now lives in `~/.gitview-test`.

## Left alone deliberately

- **Board → schematic works for nets only.** A component would need the board to hit-test footprints,
  which the per-layer format cannot do. Offering it half-working would be the viewer-that-lies problem.
- **`reloadConflict` drops a KiCad tab's rendered scene** and never re-fetches it, so a conflict reload on
  a `.kicad_sch` leaves the tab on a permanent skeleton. Pre-existing, unrelated to this change, and filed
  rather than fixed here — expanding a feature branch to cover it is how scope creeps.
- **Inner planes make a cross-probed board visually heavy.** Correct (the plane really is on that net) but
  worth revisiting; `zones=0` exists and may be the right lever.

## Review of PR #52 — three findings, one of them a per-frame cost

**`BoardView` keyed seven `remember`/`LaunchedEffect` calls on the whole `KicadBoard`.** It is a data
class, so every key comparison is *structural* — on `video.kicad_pcb` that walks 1,508 components, 1,800
nets and 39 layers, seven times per recomposition, and recomposition runs per frame during a pinch. The
schematic viewer has always keyed on `scene.path`, a String, for exactly this reason; the board viewer
never got the same treatment and this PR added another one to the pile.

Now keyed on the file path, with the two that genuinely depend on content narrowed to what they use —
`board.bbox` for the fit effect, `board.layers` for the chip list.

**`crossProbe` duplicated `openPath` and briefly pointed `activePath` at a tab that did not exist.** When
the counterpart was not already open, its `openFiles.map` matched nothing and `activePath` named a path
with no `OpenFile` until `openPath` added one — the render fell through to the "Pick a file" empty state
for that gap. And when the tab *was* open, `openPath` already did the same focus-and-reseed. The whole
function reduces to `openPath(counterpart, pendingNet = net)`, which is what it is now.

**The pairing rule was untested.** `blobExists` had tests including its security properties, but the
`.kicad_sch` ⇄ `.kicad_pcb` rule lived inline in the route. Extracted as `counterpartPath` and tested,
including the tempting near-miss: a `.kicad_pro` sits beside both halves and shares their basename, and
must pair with nothing. Breaking the rule to pair everything fails that test.

Re-driven both directions on the phone after the changes. Suite **245 bridge + 77 app**.
