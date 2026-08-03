# 2026-08-03 — A KiCad tab's drawing was not kept current with its file

Filed during Phase 3b as a one-line backlog item about `reloadConflict`. Reading the refresh paths
properly turned up a second, worse instance of the same omission.

## One root cause, two symptoms

A `.kicad_sch` / `.kicad_pcb` tab carries **derived** state — the solved scene, or the board index. Two
paths refreshed a tab's raw text and left that derived state alone.

**`reloadConflict` stranded the tab.** It rebuilds the `OpenFile` from the blob, which drops
`scene`/`board`. The render branch tests `scene != null`; the fallback tests `!sceneFailed`. Both false, so
the tab sits on `EditorSkeleton` **forever**. Visible, at least.

**`reloadChangedOpenFiles` went stale instead.** It refreshes with `copy(content = …)`, so the scene
*survives* — and is never re-solved. The viewer keeps drawing the previous solve while the file on disk has
moved on, and says nothing.

The second is the worse one and the one I nearly missed. It is silent, and it is the **common** case: that
path refreshes files that are **not dirty**, which is the normal state of every tab in a viewer. Someone
editing a board in KiCad with GitView open beside it would watch a drawing that had quietly stopped being
true. That is the viewer-that-lies failure this whole feature has been guarding against, arriving through
the refresh machinery rather than the reader.

## The fix

One helper, `refreshKicad(path)`, called wherever a tab's content is replaced. It does nothing for
non-KiCad files, so the call sites do not have to care.

## Verified by making a file change under a live viewer

The staleness is invisible without doing exactly that, so the net count in the filter label is the
observable: it comes from the solve, not from the text.

Opened `video/modul.kicad_sch` (43 nets), then appended a labelled wire to the file on disk — no
interaction with the app at all.

| build | file gains a net while the tab is open | result |
| --- | --- | --- |
| **pre-fix** | 44 → **44** | stale |
| **fixed** | 45 → **46** | follows |

Both runs on the same emulator, minutes apart, with the only difference being whether `refreshKicad` is
called. The new net (`ZZTESTNET`) also appears in the picker on the fixed build, so the solve really is
re-run rather than the count being patched.

The test schematic was restored afterwards; `~/kicad-board-repo` is back to its committed state.

## Not covered by a test, and why

This is `AppViewModel` logic, and there is no ViewModel test harness in the project — all ten app test
files are pure-function. Building one for this would be a larger change than the fix. Verified on a device
in both directions instead, which is the discrimination a test would have given.

## Review of the fix — it worked on the half that had no cache

The schematic verification passed and I nearly stopped there. Reviewing the diff found that the board half
was still broken, and broken in a *worse* way than before the change.

`loadBoard` refreshes `board`, `boardFailed` and `shownLayers` — but not `boardLayers`, the cached
per-layer geometry. And `loadBoardLayer` returns early when a layer is already held. So on a live board
change: the index re-fetched, the chip counts updated, and the drawing kept the pre-change geometry. The UI
**advertised** freshness it did not have, which is worse than the silent staleness it replaced.

A scene has no equivalent second-level cache, which is exactly why the schematic test passed. I proved the
fix on the half that could not fail.

Measured on the same emulator, opening the board with `F.Cu` on and appending 60 thick tracks to the file:

| build | chip (from the index) | drawing (changed pixels) |
| --- | --- | --- |
| **without the invalidation** | 5456 → **5516** ✓ | **552** — the chip text and nothing else. Stale. |
| **with it** | 5516 → **5576** ✓ | **9,160** — the new copper appears |

Two more things the review caught:

- **Layer selection was being reset on refresh.** `loadBoard` recomputed `shownLayers` from scratch, so a
  file change dropped someone from F.Cu + B.Cu back to the bare outline for a reason unrelated to what they
  were doing. A re-solve now keeps what they chose, intersected with the layers that still have content.
- **`refreshKicad` was the third copy of the extension test.** `openPath` already did exactly the same two
  lines. The helper replaces them rather than sitting beside them.

The test board was restored afterwards.
