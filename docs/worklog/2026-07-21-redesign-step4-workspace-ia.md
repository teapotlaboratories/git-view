# Worklog — Redesign step 4: Workspace IA (+ branch/commit/push)

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme` (steps 1–4 stack)

## Goal
Collapse Browse + Chat into one **Workspace** (redesign step 4): phone `SegmentedButton` (Files ⇄ Chat),
tablet tree + editor + chat with a **draggable, persisted divider**; Diff / History / Commit as overlays.
Owner chose the fuller scope, so also: **real branch switch + push** via new bridge endpoints.

## Owner decision
**IA + full git (bridge):** new `POST /checkout` + `POST /push` endpoints (+ wire + API docs + live
re-verify) and a real branch-picker chip, on top of the IA scaffold + History/Commit overlays.

## Scout findings
- Nav today: `Screen` = CONNECTIONS/REPOS/BROWSE/LOG/CHAT. Diff is already a full-screen overlay; History
  (LOG) + Chat are separate screens reached via chips.
- Bridge has `commit`/`stage`/`discard` + `refs` (branch list) but **no checkout/push**; the app's ref chip
  only does read-only historical views. So Commit overlay is Android-only; branch-checkout + push are new.
- Tablet two-pane (tree 320dp + editor, `maxWidth ≥ 720dp`) exists but has no chat pane / draggable divider.

## Status — done
- [x] Bridge: `gitWrite.ts` (`checkout`, `push` + `assertBranchName`), `gitService.ts` allowlist (+checkout/push),
      `rest.ts` routes, `wire.ts` (CheckoutBody/PushBody). Typecheck + `npm test` 39/39.
- [x] Docs: `API.md`(+html) endpoints; ADR-026 (+html); `SECURITY.md`(+html) push/checkout note.
- [x] Android wire: `Wire.kt`, `BridgeApi.kt` (`checkout`/`push`).
- [x] VM: `Screen` → CONNECTIONS/REPOS/WORKSPACE + `WorkspacePane`; `logOverlay`/`commitOpen`/`activePane`/
      `splitRatio`(persisted)/`branches`/`currentBranch`/`notice`; `checkout`/`push`/`commit`/`showHistory`.
- [x] `ui/workspace/DraggableSplit.kt`; Workspace UI in `Screens.kt` (WorkspaceScaffold, WorkspaceToolbar,
      BranchChip, FilesChatSegment, GitMenu, FilesPane, EditorColumn, ChatPane, HistoryOverlay, CommitOverlay).
- [x] `AppRoot` reworked; ChatScreen/LogScreen retired as embedded pane / overlay.

## Verification (done)
- Bridge typecheck; `npm test` 39/39; `assembleDebug` + `testDebugUnitTest` green.
- **Live REST** (bridge + testrepo + bare remote): `checkout -b feature-1` → `{ok,oid:"feature-1"}`, refs head
  moved to feature-1; `push {origin,feature-1,setUpstream}` → branch landed on the bare remote; `-evil`
  rejected (invalid name); audit log records both checkout + push.
- **On-device phone** (`kancil_test`, Standard): Workspace with back + explorer toggle + `feature-1` branch
  chip + Files ⇄ Chat segment + tree; branch loaded live from the bridge.
- **On-device tablet** (`tabS8`, 2560×1600 Standard): 3-pane draggable split — tree (280dp) + editor
  (server.js, highlighted) + chat pane (provider, Ask-first bar + RiskMeter, cost bar, composer), divider
  between editor and chat. Screenshots in the session scratchpad.

## E-Ink Workspace — verified + a real bug fixed
Rendered the Workspace under the E-Ink profile on-device (toggled via the overflow menu; set the
`gitview_display` override deterministically with `run-as`). This surfaced a **real bug**: the single
top bar was overcrowded on the phone (back + explorer-toggle + branch chip + Files/Chat segment), which
**pushed the Git menu AND the overflow ⋮ off-screen** — the git actions and even the profile toggle were
unreachable on the phone (both profiles). **Fix:** split the phone toolbar into two bars per the handoff —
top bar = Files/Chat segment + overflow; a slim **path/ref bar** = explorer toggle + branch chip + save +
Git menu. Tablet keeps one bar (wide enough). Rebuilt + re-verified on-device, on the **`bigmeB7` AVD at the true Bigme B7 Pro ratio — 1264×1680 @ 320dpi
= 632dp wide** (3:4 portrait), not the tall phone AVD used earlier (per AGENTS.md's e-ink form factor):
- **E-Ink Files pane:** paper theme, Files ⇄ Chat segment, `feature-1` branch chip, Git menu + overflow now
  reachable, tree. At 632dp the two-bar toolbar has ample room (uncrowded).
- **E-Ink Chat pane:** provider selector, "Ask first" permission bar with the **square RiskMeter** (`■□□□
  LOW · 1/4`), cost bar, composer — all in the E-Ink theme, correct proportions.

## Correction — E-Ink CAN have the split view (owner-flagged)
Initially I gated the split with `maxWidth >= 720.dp && !eink`, reasoning that a draggable divider is
continuous motion (bad on EPD). That conflated the **draggable divider** (motion) with the **split
layout** (static — perfectly fine on E-Ink; E-Ink is co-primary, not second-class). **Fix:** the split
now shows on any wide screen (`maxWidth >= 720.dp`, both profiles); on E-Ink the divider becomes a
**discrete tap-to-cycle** handle (presets 0.35/0.5/0.65, persisted) with a grip glyph, instead of the
Standard continuous drag — adjustable with no continuous-motion repaint. The Bigme B7 Pro *portrait* is
632dp (< 720) so it stays segment there (a 3-pane split is too cramped at 632dp anyway); the split
appears in **Bigme landscape (~840dp)** and on larger e-ink tablets. Verified on-device on `bigmeB7` in
landscape: tree + editor + chat with the discrete `⣿` divider, paper theme.

## Both Workspace dividers adjustable (owner-requested)
The tree ↔ editor divider was a fixed 280dp `VerticalDivider`; made it adjustable too. The wide layout
now **nests two `DraggableSplit`s** (tree | editor | chat), each with its own persisted ratio
(`treeRatio` default 0.22 clamped 0.12–0.4; `splitRatio` for editor:chat) in `gitview_workspace` prefs.
`DraggableSplit` gained `minRatio`/`maxRatio`/`einkPresets` params so the same component serves both
(Standard drag / E-Ink tap-cycle). Verified on-device (Bigme E-Ink landscape): both `⣿` grips present;
tapping the tree grip widens the tree (`treeRatio` 0.22 → 0.32, persisted).

## Follow-ups
- Branch-name validation returns **500/internal** (`invalid branch/remote name`) rather than a 400 — rejected
  correctly, but the status could be a cleaner `bad_request`. Minor.
- The `bigmeB7` AVD approximates the **resolution** only; the Kaleido-3 EPD panel (muted color, refresh
  cadence) can't be emulated — the on-panel `eink-mono.json` tuning stays a Phase-8 on-device item.

## Notes
- E-Ink split view: see the correction below — E-Ink DOES get the tree+editor+chat split on wide screens.
- Push uses the **host's git credentials** (network egress) — security-relevant; audited + noted in SECURITY.md.
- Split ratio persisted in SharedPreferences (like DisplayProfile override).
