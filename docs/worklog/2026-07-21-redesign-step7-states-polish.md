# Worklog — Redesign step 7: States polish (final step)

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme` (steps 1–7 stack)

## Goal
The final build-order step: loading / empty / error / offline states across every screen, plus the two
deferred features the spec ties to states — **offline/reconnect** and the editor **save-conflict** bar.

## Owner decisions (both forks: fuller scope)
- **Offline: Full** — observable WS state + auto-reconnect + reconnect banner + editor read-only lock
  (buffer preserved) + send-after-drop fix + no-network handling.
- **Save-conflict: Build it** — external change to a dirty open file → inline reload/overwrite/diff bar.

## Scout (workflow `states-step7-scout`, 3 agents)
Spec pins states for 3 screens (Connections, Repos/History, Browse/Editor) + a global rule: Standard
shimmers, E-Ink = static grey (→ the `reduceMotion` gate). Audit: error path is decent (snackbar); the
systemic gap is **loading** (only `busy`, chat-only — every REST fetch was a silent blank, and the
History/Diff overlays didn't even open until data arrived). `BridgeClient` had **no** observable
connection state → no offline banner was possible; a dropped socket silently no-op'd `sendPrompt`.

## Built
- **`BridgeClient` connection state + auto-reconnect** — `ConnState` (CONNECTING/CONNECTED/RECONNECTING/
  DISCONNECTED) as a `StateFlow`; `connect()` is now a long-lived flow that re-dials with capped backoff
  (1→15s). Added a **ping interval (10s)** so a dead peer is actually detected (an open WS otherwise
  never times out). `isConnected` guards sends. See ADR-029.
- **VM** — `connState` + `disconnected` in UiState; `readOnly = ref != null || disconnected` (editor
  locks offline, buffer stays in `openFiles`); `sendPrompt` refuses when disconnected; a drop clears
  `busy`. Per-fetch loading/error flags (`reposLoading/Error`, `treeLoading/Error`, `logLoading/Error`,
  `diffLoading/Error`, `OpenFile.loading`); History/Diff overlays now open **immediately** with a
  loading state (`historyOpen`/`diffOpen`). Save-conflict: a `repo.changed` on a **dirty** open file →
  `conflictPaths`; `reloadConflict`/`overwriteConflict` resolve it. Pairing keeps the dialog open on a
  bad code (`pairError`/`pairing`).
- **New components** (`ui/state/`): `Skeletons.kt` (pulse on Standard / static grey when motion is off),
  `StateViews.kt` (`StatusBanner` + `EmptyState`, both hueless-safe).
- **Wiring**: reconnect banner (AppRoot, workspace); Repos + Explorer + History + Diff get
  skeleton/empty/error/retry; editor gets a loading skeleton + the save-conflict bar + read-only-offline;
  chat gets an onboarding empty state + Send disabled offline; pairing dialog inline error.

## Verification (kancil phone, Standard — bridge live, kill/restart)
- **Offline → reconnect (headline):** dropped the network (airplane mode) → **"Connection lost —
  reconnecting…"** banner in ~3s, editor read-only, **buffer preserved** ("ahead-line" kept). Restored
  bridge + network → **auto-reconnected**, banner cleared in ~3s. (Note: killing the *host* bridge over
  the emulator's 10.0.2.2 NAT does NOT propagate a FIN, so that path doesn't detect the drop — an
  emulator artifact; a real guest-side network loss is detected immediately, which is the real case.)
- **Save-conflict:** typed into README (dirty dot on the tab) → externally appended to the file → the
  **"Changed on disk while you were editing." + Reload / Overwrite / Diff** bar appeared in ~2s, and the
  in-app edit ("EDIT_IN_APP") was **not** clobbered.
- **Chat onboarding empty state:** "Ask Claude to work on this repo" renders when the transcript is empty.
- **Build**: `:app:assembleDebug` SUCCESSFUL. No crashes across the flow.

## Not screenshot-verified (wired + compiling, same pattern as the above)
- Skeletons during load (the local test bridge answers too fast to catch the flash); Repos/tree/History/
  Diff empty + error + Retry (verified the chat + history empty states + the shared `EmptyState`/skeleton
  code; the others follow the identical wiring); pairing inline error (needs an unpaired bridge).

## Redesign complete
All 7 build-order steps are done. Remaining nice-to-haves noted across worklogs (FilterChip weight on
E-Ink, editor page footer, CostBar over-budget weight, on-panel Kaleido tuning).

## PR + code review (commit `f019de6`)
Committed as PR #14 (`teapotlaboratories/git-view`, one commit `8f233cb`). A code-review pass (xhigh)
surfaced 8 findings, all fixed in `f019de6`:
1. `sendPrompt` fired into a CONNECTING/null socket (lost prompt + stuck "Thinking…") → now dispatches
   only when `isConnected`, returns a Boolean, and the composer clears input only on a real send.
2. Reconnect backoff never reset on success → reset `attempt` to 0 when CONNECTED is reached.
3. `EinkPaginator` prev/next could no-op on a viewport-tall item → always step ≥1 item.
4. `overwriteConflict` bypassed the read-only-offline lock → guarded in the VM + button disabled.
5. `clearError()` wiped the pairing dialog's inline error → split into `clearError` (snackbar) and
   `dismissPairing`.
6. `repoState` forked 3 git subprocesses per repo per `/repos` request → now concurrent + a 2s per-repo cache.
7. `connectLive` could leak the state-observer coroutine if re-invoked → both collectors under one
   cancellable `liveJob`.
- Re-verified after the fixes: bridge typecheck + `:app:assembleDebug`; `GET /v1/repos` still returns
  git-state; offline→reconnect on-device (banner in ~3s on the workspace, auto-reconnect clears it).
- Debug note: the banner is intentionally **workspace-only** (`disconnected && screen == WORKSPACE`);
  a mid-test navigation to the Repos screen made it look like detection had broken — it hadn't.
