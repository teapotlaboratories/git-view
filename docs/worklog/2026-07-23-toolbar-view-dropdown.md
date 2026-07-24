# Workspace toolbar: Files/Chat as a right-side dropdown

Asked for: "make the view cleaner — move the Files/Chat selection to the same dropdown [style as] the
Git dropdown on the right."

## Change
- New `ViewMenu` in `ui/Screens.kt`, a compact `AssistChip` + `DropdownMenu` that mirrors `GitMenu`:
  the chip label is the current pane (`Files` / `Chat`), the menu offers both with a check on the active
  one. Selecting a pane calls the existing `vm.setActivePane`.
- Phone/E-Ink `WorkspaceToolbar` restructured: the centre `SingleChoiceSegmentedButtonRow` is gone; the
  branch chip (`main ▾`) moves up into the top bar's leading slot, and `ViewMenu` sits with `GitMenu` on
  the right of the second bar. Two bars are still used so nothing is pushed off a narrow phone.
- Removed the now-unused `FilesChatSegment` composable (dead code). `SegmentedButton` imports stay —
  still used by the Claude-agent auth selector.
- Tablet path unchanged: the ≥720dp split shows tree + editor + chat together, so it has no pane
  switcher and never showed the segment; `ViewMenu` is not added there.

## Verified on-device (all three form factors, sequentially)

- **Phone** (`kancil_test`, 1080×2340): top bar = `← · main ▾ · ⋮`; second bar = files-tree icon on the
  left, `Files ▾  Git ▾` on the right. Opening `Files ▾` shows Files (✓) / Chat; picking Chat switches
  the pane, the chip relabels to `Chat`, and the files-tree icon correctly disappears (Files-only).
  Screens: `2026-07-23-toolbar-phone-files.png`, `-viewmenu.png`, `-chat.png`.
- **Tablet** (`tabS8`, 2560×1600): unchanged — `main ▾` left, `Git ▾ · ⋮` right, all three panes shown,
  no View chip (`2026-07-23-toolbar-tablet.png`).
- **Bigme B7 e-ink** (`bigmeB7`, 1264×1680, E-Ink profile ON): the `Files ▾` / `Git ▾` chips read on the
  paper palette by border + weight (no hue); tree paginates below (`1–10 of 10`).
  `2026-07-23-toolbar-eink.png`.

---

## Revision: combined INTO the Git dropdown (owner follow-up)

Owner: "instead of a separate dropdown, combine it under the git dropdown."

So the standalone `ViewMenu` chip is gone; there is now a **single** `Git ▾` chip on the right whose
menu holds both concerns, with lightweight section labels:

```
View
  Files   ✓
  Chat
────────────
Git
  Working-tree diff
  Staged diff
  History…
────────────
  Commit…
  Push
```

- `GitMenu` gained optional `activePane` / `onSelectPane`. When present (phone/E-Ink) it renders the
  `View` section + a `Git` label above the actions; when absent (tablet split) it renders exactly the
  old git-only menu — no behavioural change there.
- New `MenuSectionLabel` — a muted, semibold, non-interactive heading (weight over hue, so it reads on
  the E-Ink paper palette).
- `ViewMenu` removed.

Verified on-device: **phone** (`2026-07-23-toolbar-combined-phone.png`) — opening `Git ▾` shows the
View section with Files checked; picking Chat switches the pane and moves the check to Chat on reopen.
**E-Ink** (`2026-07-23-toolbar-combined-eink.png`) — the same menu on the paper palette, section labels
legible. **Tablet** unchanged (git-only menu; the earlier `2026-07-23-toolbar-tablet.png` still holds).
The earlier separate-dropdown screenshots were removed to avoid confusion.
