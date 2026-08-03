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
