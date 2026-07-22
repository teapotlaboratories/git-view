# Worklog — Redesign step 3: permission model

**Date:** 2026-07-20 · **Branch:** `redesign/step1-tokens-theme` (steps 1–3 stack)

## Goal
Make the permission system readable + trustworthy (redesign step 3): rename the 6 tiers with a 0–4
risk signal, a persistent permission bar + `RiskMeter` + `ModalBottomSheet` tier picker, a `Turn $ ·
Session $ vs budget` cost bar, and — the centerpiece — a **live inline approval gate**: under
"Ask first" an edit pauses for Allow once / Allow for session / Deny.

## Owner decisions (confirmed)
1. **Full gate (bridge + wire)** — new `permission_request`/`permission_response` frames; the SDK
   `canUseTool` callback pauses the agent and awaits the app; "Allow for session" upgrades tier → Auto-edit.
2. **Budget from the bridge** — `maxBudgetUsd` added to `session.init`; turn/session split derived app-side.

## Key scout findings
- Today `confined-agent` = `permissionMode: dontAsk` (MCP-only writes, NO prompt). The redesign
  repurposes that wire-id slot to "Ask first" = `permissionMode: default` + `canUseTool` prompting.
- The query wires `hooks.PreToolUse` (deny backstop) but no `canUseTool`. Adding it is the gate mechanism.
- **Risk:** the SDK may require streaming-input mode (AsyncIterable prompt) for `canUseTool`. Wire with the
  string prompt first; if it doesn't fire, switch to a single-message async generator. Verify live.
- Wire ids kept stable; the app maps new names/`was`/risk/description. `PermissionProfile.DEFAULT` → `CONFINED_AGENT`.

## Status — all done
- [x] Contract: `docs/API.md`(+html) — `permission_request`, `permission_response`, `session.init.maxBudgetUsd`.
- [x] ADR-025 (+html) — interactive gate via `canUseTool`.
- [x] Bridge: `wire.ts`, `permissions.ts` (`isInteractive` + `permissionDecision` policy), `sessionManager.ts` (canUseTool + pending map + `resolvePermission`), `ws/liveChannel.ts` (route response).
- [x] Android wire: `Wire.kt` (PermissionRequest, session.init budget, default → CONFINED_AGENT), `BridgeClient.kt`.
- [x] `ui/permission/`: PermissionModel, RiskMeter, PermissionBar, PermissionSheet, InlineApprovalCard, CostBar.
- [x] `ChatModels.PendingPermission`; `AppViewModel` (pending state, `resolvePermission`, tier upgrade, turn/session cost, budget); `ChatScreen`/`ChatTranscript`.

## Verification (done)
- Bridge **typecheck** clean; **`npm test`** 39/39 (incl. new `permissions.test.ts` — the tier policy).
- **`assembleDebug`** clean; **`testDebugUnitTest`** green.
- **Live local-SDK gate** (real Opus, throwaway repo, profile `confined-agent`):
  - Read → auto-allowed (no `permission_request`).
  - Edit → **paused**; `permission_request{requestId, tool, input}` emitted. `canUseTool` fired with the
    plain string prompt — **no streaming-input mode needed**.
  - `permission_response{allow:true, once}` → Edit applied. `allow:false` → `tool_result ok=false "denied
    by user"` and **`server.js` unchanged** (write blocked).
- **On-device (kancil_test)**: `PermissionBar` ("Ask first" + RiskMeter), `ModalBottomSheet` (6 tiers, risk
  meters escalate gray→green→amber→orange, descriptions, `was:`), the inline **Allow Edit?** card with the
  synthesized diff + Deny / Allow for session / Allow once, and the `CostBar` (`Turn · Session / $5.00` from
  the bridge). Allow once → edit applied → file changed. Screenshots in the session scratchpad.

## Security note (surfaced for review)
"Ask first" now uses **built-in tools** (Edit/Write/Bash) gated by `canUseTool` + `HARD_DENY_RULES` +
the `PreToolUse` backstop — the interactive per-write approval is the control. Agent writes under
ask-first therefore no longer route through the audited MCP surface (which uses whole-content saves and
gives poor diffs); the MCP server stays mounted for `confined-agent` as an extra path. **Follow-up:** an
"audited + prompted" mode if MCP-logged agent writes are wanted. `SECURITY.md` may want a note.
