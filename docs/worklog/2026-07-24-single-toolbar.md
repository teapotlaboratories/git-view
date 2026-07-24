# Workspace: one top navigation bar (merge the two phone bars)

Asked for: combine the navigation bar with the row below it — one clean top bar.

## Change
The phone workspace had two stacked bars (top: back · branch · ⋮; below: files-tree · save · Git).
Unified `WorkspaceToolbar` (`ui/Screens.kt`) into a **single** `ScreenBar` for every form factor:
`back · branch · … · [files-tree] · [save] · Git · ⋮`. The tablet was already a single bar, so this
mainly collapses the phone/e-ink path. Phone-only bits stay conditional: the explorer-tree toggle shows
only in the phone Files pane (the tablet has a permanent tree panel), and the Git menu hosts the
Files/Chat *View* switch only on phone.

`BranchChip` now takes a `maxLabelWidth` and ellipsizes: **108dp on phone** (so a long branch name can't
crowd the action chips off the single row) and **220dp on tablet** (room to spare). The dropdown still
lists every branch in full.

## Verified on-device (all three form factors)
- **Phone** (`kancil_test`, 1080×2340): one bar; Files shows the tree toggle, Chat doesn't; everything
  fits with headroom. `2026-07-24-single-toolbar-phone-files.png`, `-phone-chat.png`.
- **Tablet** (`tabS8`, 2560×1600): one bar over the tree|editor|chat split, unchanged.
  `2026-07-24-single-toolbar-tablet.png`.
- **Bigme e-ink** (`bigmeB7`, 1264×1680, E-Ink profile ON): one bar on the paper palette (border/weight,
  no hue); tree paginates below. `2026-07-24-single-toolbar-eink.png`.

Not stress-tested with a genuinely long branch name on-device (served repo is on `main`); the width cap
+ ellipsis is standard and low-risk.
