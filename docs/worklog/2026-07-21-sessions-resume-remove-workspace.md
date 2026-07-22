# Worklog — Session transcript (picker + resume) + remove workspace

**Date:** 2026-07-21 · **Branch:** `redesign/step1-tokens-theme`

## Goal
Two follow-ons to the browse/open-a-workspace work:
- **Session transcript.** Opening a repo should land on a **session picker / new-chat** screen (not
  auto-open the most-recent thread), and **resuming a session should restore its history** — which SDK
  `resume` doesn't do on its own.
- **Remove workspace.** Give opened workspaces a way **off** the repos list, without ever touching the
  folder on disk.

## Owner decisions
- **Picker-on-open, not auto-open-latest.** Auto-resuming the newest session is surprising on a shared
  repo (you continue someone else's / a stale thread and can spend budget) and offers no fresh start; the
  picker makes resume-vs-new explicit.
- **New `/messages` endpoint, not jsonl.** `resume` reconnects but **replays no past turns**, and per
  **ADR-011** the bridge never parses `~/.claude/projects/*.jsonl`. So history comes from the SDK's own
  `getSessionMessages()`, degrading to an empty transcript if that API is absent.
- **Remove = un-register only.** `DELETE /v1/workspaces/:id` drops the registration; it **never deletes
  files**, and **refuses config repos** (`403`).

See [DECISIONS.md](../DECISIONS.md) ADR-031 (sessions) + ADR-032 (remove-workspace).

## Built
- **Bridge — session transcript:**
  - `GET /v1/repos/:repo/sessions/:id/messages` (Bearer; `:id` = SDK session UUID) →
    `{ sessionId, messages: TranscriptMessage[] }`, chronological.
  - `TranscriptMessage` is a `role`-tagged union: `{role:"user",text}`, `{role:"assistant",text}`,
    `{role:"tool_use",id,name,input}`, `{role:"tool_result",id,name,ok,summary?,content?}`. The
    tool shapes **reuse the live-frame field names** (§6.2) — `id` (SDK `tool_use_id`), `name`, `ok`,
    truncated `summary?`/`content?` — so the app reuses its `ToolActivityCard` + correlation-by-`id`
    with no new parsing.
  - Backed by the SDK's `getSessionMessages()` — which reads the session **dir**, not a `cwd` (unlike
    `resume`/`listSessions`). Degrades to `{ sessionId, messages: [] }` if the SDK lacks it (never jsonl).
- **Bridge — remove workspace:**
  - `DELETE /v1/workspaces/:id` → `200 { ok: true }`; `403 forbidden` for a config repo; `404 not_found`
    for an unknown id. Removes the `.gitview/workspaces.json` entry, unserves, stops the fs watcher —
    **never deletes the folder/files**.
  - `RepoSummary` gains **`removable: boolean`** (config repos `false`, opened workspaces `true`, default
    `false`) so the app shows a remove action only where it's valid.
  - Needed a **`RepoWatcher` refactor from a single watcher → a Map-keyed-by-id**, so one workspace's
    watcher starts/stops independently.
- **App:**
  - Repo-open now shows the **session picker** (list from `GET …/sessions`: title / turns / `updatedAt`,
    plus **New chat**). Picking a session resumes it and **rehydrates the transcript** from
    `…/sessions/:id/messages` before streaming continues.
  - A **remove** affordance on `removable` repo entries → `DELETE /v1/workspaces/:id`, then refresh
    `/v1/repos`.
- **Docs** — `API.md` (read table + §5 transcript subsection with the role-union; write table + §4.2
  remove; `RepoSummary.removable` in §3.1), `DECISIONS.md` (ADR-031, ADR-032), this worklog.

## Wire
Both reuse existing field names so the app parses with **no new logic**:
- Transcript `tool_use`/`tool_result` = the same `{id,name,input}` / `{id,name,ok,summary?,content?}` as
  the WebSocket frames → same card + `id`-correlation path.
- `removable` is one added boolean on the existing `RepoSummary`; `DELETE /v1/workspaces/:id` mirrors the
  existing `{ ok: true }` write-success shape and the `forbidden`/`not_found` error codes.

## Verification (done)
- **Bridge:** `npm run typecheck` clean; transcript + remove tests green (role-union normalization,
  `getSessionMessages`-absent degradation to `messages:[]`, `DELETE` `200`/`403` config-repo/`404`
  unknown, `RepoWatcher` Map start/stop); `npm run build` OK.
- **Live local-SDK session** (bridge + real `claude`, throwaway repo): a Read+Edit thread was resumed —
  `…/messages` returned the chronological transcript (user / assistant prose / `tool_use` /
  `tool_result` with correlated `id` + `name` + `summary`), and the app rendered it with the existing
  `ToolActivityCard`s before new streaming appended.
- **On-device** (Android emulator, paired bridge): opening a repo shows the picker (New chat + resumable
  sessions with turns/`updatedAt`); resuming restores prior bubbles + tool cards; opened workspaces show a
  remove action that drops them from `/v1/repos` while the folder stays on disk; config repos show **no**
  remove action and a direct `DELETE` returns `403`.
- **App:** `assembleDebug` SUCCESS.
