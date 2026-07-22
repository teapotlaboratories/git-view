# Worklog — One provider (always local SDK) + auto-resume the latest session on open

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme`

## Goal
Collapse two earlier decisions the real single-user flow made moot:
- **Drop the Remote Control provider** — chat should always be the **local Claude Agent SDK**, one
  provider and one trust model.
- **Stop landing on a picker** — opening a workspace should **auto-resume the most recent host session**
  (the local SDK shares the owner's `~/.claude` store), with a **Sessions** button to switch or start new.

## What changed
- **Removed the Remote Control provider.** The bridge no longer launches/attaches a
  `claude remote-control` process; `POST /v1/repos/:repo/sessions` **always returns the local ack**
  (`{ sessionId, provider: "local-sdk" }`) — the old `{ connect: { url, qr } }` remote response and the
  `remote-control` branch are gone. `provider` stays on the WS `prompt` frame and the `POST …/sessions`
  body (frozen `/v1` protocol) but is **effectively always `local-sdk`**.
- **Auto-resume-latest on open.** Opening a workspace now **continues the most recent session** instead of
  landing on the session picker: the app resumes the newest `GET …/sessions` entry and rehydrates its
  transcript from `…/sessions/:id/messages` (ADR-031's endpoint, unchanged) before new streaming appends.
  A **Sessions button** still opens the picker to switch threads or start a **New chat**.
- **Docs** — `DECISIONS.md` (ADR-033, superseding the ADR-031 picker-on-open default and partially
  superseding the ADR-010 provider split / Remote-primary), `API.md` (§5 sessions: local-SDK-only `POST`,
  shared-store auto-resume note; §6.1 prompt-frame provider note), `SECURITY.md` (single-provider trust
  model replaces the Remote-vs-Local trust delta), this worklog.

## Why
- **Remote Control never fit an in-app client.** It streamed the conversation through Anthropic's servers
  and surfaced it in **claude.ai/code + the Claude mobile apps — not GitView's chat pane** (the bridge only
  ever held a connect URL/QR, and the transcript lived on Anthropic servers while connected). A native
  client whose whole point is an **in-app transcript** got no payoff from it, while it forced **two
  providers + two trust models**. Removing it leaves the local SDK — which streams the real
  `assistant.delta` / `tool_use` / `tool_result` frames the app already renders — as the one provider, and
  **transcript-stays-on-host** as the one trust model.
- **Picker-on-open assumed a shared repo; GitView is single-user.** ADR-031 preferred a picker because
  auto-resuming the newest session on a *shared* repo could continue "someone else's or a stale thread."
  But GitView runs single-user against the **owner's own `~/.claude`** (see SECURITY.md threat model), so
  the most-recent session is *the owner's last thread on this box* — continuing it is the expected,
  lowest-friction landing. The explicit picker stays one tap away via **Sessions** for switch/new.

## Verification (done)
- **Bridge:** `npm run typecheck` clean; session/start tests updated — `POST …/sessions` returns the
  local ack with no `connect` block and no remote-control spawn; `npm run build` OK.
- **Live local-SDK session** (bridge + real `claude`, throwaway repo): a prior Read+Edit thread created
  from the host terminal appeared in `GET …/sessions` (shared `~/.claude` store) and **auto-resumed on
  open** — the transcript rehydrated (user / assistant prose / correlated `tool_use`+`tool_result` cards)
  and new streaming appended below.
- **On-device** (Android emulator, paired bridge): opening a workspace lands **directly in the resumed
  most-recent chat** (no picker gate); the **Sessions** button opens the picker (New chat + resumable
  sessions with turns/`updatedAt`), switching resumes another thread, New chat starts fresh.
- **App:** `assembleDebug` SUCCESS.
