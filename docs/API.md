# GitView Wire Protocol (v1)

This document is the **single source of truth** for the transport between the Android app and the
bridge. The bridge's TypeScript types (`bridge/src/wire.ts`) and the app's Kotlin types
(`android/app/src/main/java/com/gitview/app/data/Wire.kt`) are hand-mirrored from it. Change this
file first, then both ends.

Status legend for claims that depend on the Claude Agent SDK: shapes marked **[SDK-verified]** were
confirmed against the mid-2026 docs (see [DECISIONS.md](DECISIONS.md), ADR-010/011). Shapes marked
**[bridge-normalized]** are GitView's own envelope and are stable regardless of SDK churn.

---

## 1. Transport overview

| Concern            | Mechanism                                                                 |
| ------------------ | ------------------------------------------------------------------------- |
| Browse (read)      | `GET` REST, cacheable with `ETag`                                          |
| Edit (write)       | `PUT` / `POST` / `DELETE` REST                                             |
| Live chat + push   | ONE WebSocket (`/v1/live`): prompt/interrupt up; streamed events down      |
| Auth               | Bearer token on every request; pairing endpoint exempt                    |
| Base path          | All endpoints are under `/v1`                                              |
| Content type       | `application/json` unless noted; blobs are base64 inside JSON              |

Reachability is expected to be Tailscale-only (see [SECURITY.md](SECURITY.md)); the protocol assumes
TLS is terminated by Tailscale Serve (or Cloudflare Tunnel) in front of the bridge.

---

## 2. Authentication

- **REST:** `Authorization: Bearer <token>` on every request except `POST /v1/pair` and
  `GET /v1/health`.
- **Pairing:** the bridge prints a short-lived pairing code to its console on start. The app posts
  it once to exchange for a long-lived bearer token, which it stores in the Android Keystore.
- **Token comparison is constant-time** on the bridge (never a plain `===`).
- **WebSocket auth is first-frame, never in the URL query string** (query strings leak to logs and
  proxies). The client opens the socket, then sends `{"type":"auth","token":"…"}` as the very first
  frame. The bridge validates before processing anything else; on failure it closes with code
  `4401`. A `Sec-WebSocket-Protocol: gitview.bearer.<token>` subprotocol is also accepted as an
  alternative for clients that cannot send a first frame before receiving.

Errors use HTTP status + a JSON body `{ "error": { "code": "...", "message": "..." } }`.

| code                | HTTP | meaning                                            |
| ------------------- | ---- | -------------------------------------------------- |
| `unauthorized`      | 401  | missing/invalid token                              |
| `forbidden`         | 403  | token valid but not allowed for this repo/action   |
| `not_found`         | 404  | repo/path/ref not found                            |
| `path_escape`       | 400  | path escaped the repo root (`..`, absolute, symlink)|
| `read_only`         | 409  | write attempted against a historical ref           |
| `too_large`         | 413  | body or file exceeded the configured cap           |
| `git_error`         | 422  | git refused (bad ref, merge conflict, …)           |
| `internal`          | 500  | unexpected                                         |

---

## 3. REST — read (cacheable)

All read endpoints accept an optional `ref` (branch, tag, or commit SHA). **Reads at any historical
ref are immutable and read-only**; the bridge sets a strong `ETag` (the resolved object id) and
`Cache-Control: private, max-age=31536000, immutable`. Reads of the working tree (`ref` omitted or
`ref=WORKTREE`) are volatile: `Cache-Control: no-cache` and a weak `ETag`.

| Method & path                                   | Purpose                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `GET /v1/health`                                | liveness; no auth                                   |
| `GET /v1/repos`                                 | list registered repos                               |
| `GET /v1/repos/:repo/refs`                      | branches, tags, HEAD                                |
| `GET /v1/repos/:repo/tree?ref=&path=`           | one directory level (lazy tree)                     |
| `GET /v1/repos/:repo/blob?ref=&path=`           | file contents (utf-8 or base64)                     |
| `GET /v1/repos/:repo/log?ref=&path=&limit=`     | commit log                                          |
| `GET /v1/repos/:repo/diff?kind=&ref=&path=`     | unified diff (`kind` = `worktree`\|`staged`\|`commit`)|
| `GET /v1/repos/:repo/blame?ref=&path=`          | line-by-line blame                                  |
| `GET /v1/repos/:repo/show?ref=`                 | commit metadata + diff                              |
| `GET /v1/repos/:repo/status`                    | working-tree status                                 |

### 3.1 Representative payloads

`GET /v1/repos` →
```json
{ "repos": [ { "id": "gitview", "name": "gitview", "defaultBranch": "main",
              "provider": "local-sdk", "profile": "auto",
              "branch": "main", "ahead": 2, "behind": 0, "dirty": 3 } ] }
```
Each repo carries **live working-tree state**: `branch` (current HEAD), `ahead`/`behind` vs its upstream
(**omitted when there is no upstream**), and `dirty` (count of modified/staged/untracked entries) — for
the `main · ↑2 · 3 dirty` status chips. `CommitSummary` (in `…/log`) likewise carries `files`,
`additions`, `deletions` (from `git log --shortstat`) for the `1 file · +7 −1` per-commit stat.

`GET /v1/repos/:repo/tree?path=src` →
```json
{ "ref": "main", "path": "src",
  "entries": [
    { "name": "index.ts", "path": "src/index.ts", "type": "blob", "size": 1115, "oid": "a1b2…" },
    { "name": "git",       "path": "src/git",      "type": "tree", "oid": "c3d4…" }
  ] }
```

`GET /v1/repos/:repo/blob?path=logo.png` — binary is read as a Buffer on the bridge and base64-ed,
never decoded as utf-8:
```json
{ "path": "logo.png", "ref": "main", "oid": "…", "size": 20841,
  "binary": true, "encoding": "base64", "content": "iVBORw0KGgo…" }
```
Text files return `"binary": false, "encoding": "utf-8", "content": "…"`.

---

## 4. REST — write (working tree only)

Writes act on the **working tree** and are rejected (`read_only`, 409) if a historical `ref` is
supplied. Every write is path-confined (realpath + containment re-check) and subject to
`writeSizeCapBytes` (413 `too_large`). Every write is appended to the audit log.

| Method & path                          | Body                                  | Purpose                 |
| -------------------------------------- | ------------------------------------- | ----------------------- |
| `PUT /v1/repos/:repo/file?path=`       | `{ encoding, content }`               | save existing file      |
| `POST /v1/repos/:repo/file`            | `{ path, encoding, content }`         | create file             |
| `DELETE /v1/repos/:repo/file?path=`    | —                                     | delete file             |
| `POST /v1/repos/:repo/rename`          | `{ from, to }`                        | rename/move             |
| `POST /v1/repos/:repo/stage`           | `{ paths: string[] }`                 | `git add`               |
| `POST /v1/repos/:repo/commit`          | `{ message, paths?: string[] }`       | commit staged (or paths)|
| `POST /v1/repos/:repo/discard`         | `{ paths: string[] }`                 | restore working tree    |
| `POST /v1/repos/:repo/checkout`        | `{ ref, create?: boolean }`           | switch/create branch    |
| `POST /v1/repos/:repo/push`            | `{ remote?, branch?, setUpstream? }`  | `git push`              |

`encoding` is `"utf-8"` or `"base64"`. Successful writes return `{ "ok": true, "oid"?: "…" }`
(`checkout` returns the new branch name as `oid`). Branch/remote names are validated (no leading `-`,
no whitespace/glob metacharacters). **`checkout` mutates HEAD** (not working-tree-file scoped) — the fs
watcher then emits `repo.changed` so the app refreshes. **`push` uses the HOST's git credentials and
performs network egress** (see [SECURITY.md](SECURITY.md)); default `git push` targets the current
branch's upstream. Both are audited.

---

## 5. REST — sessions

| Method & path                            | Purpose                                                 |
| ---------------------------------------- | ------------------------------------------------------- |
| `GET /v1/repos/:repo/sessions`           | enumerate resumable Claude sessions **[SDK-verified]**  |
| `POST /v1/repos/:repo/sessions`          | start/attach a session; returns id (+ URL/QR for remote)|

`GET …/sessions` is backed by the SDK's `listSessions()` — **never** by globbing
`~/.claude/projects/*.jsonl` (that format is internal/unstable; see ADR-011). Response:
```json
{ "sessions": [ { "id": "sess_…", "updatedAt": "2026-07-18T09:00:00Z", "title": "…", "turns": 12 } ] }
```

`POST …/sessions` body:
```json
{ "provider": "remote-control" | "local-sdk",
  "profile": "read-only" | "confined-agent" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions",
  "resume": "sess_… (optional)" }
```
For `remote-control` the bridge launches/attaches a `claude remote-control` process and returns:
```json
{ "sessionId": "sess_…", "provider": "remote-control",
  "connect": { "url": "https://claude.ai/code/…", "qr": "data:image/png;base64,…" } }
```
For `local-sdk` it returns `{ "sessionId": "sess_…", "provider": "local-sdk" }` and all streaming
happens over the WebSocket.

---

## 6. WebSocket — the live channel (`/v1/live`)

One socket per app instance. Carries all chat streaming and repo-change push. Every **server→client**
frame carries a **monotonic `eventId`** (per-connection, starting at 1) so a client that reconnects
can request replay from the last id it saw. The bridge keeps a ring buffer (default 512 events).

### 6.1 Client → server

```jsonc
{ "type": "auth",      "token": "…" }                       // MUST be first frame
{ "type": "subscribe", "repo": "gitview", "sessionId": "…?" }
{ "type": "prompt",    "repo": "gitview", "sessionId": "…?",
                       "provider": "local-sdk", "profile": "auto", "text": "…" }
{ "type": "interrupt", "sessionId": "…" }
{ "type": "replay",    "fromEventId": 128 }                  // resend events with id > 128
{ "type": "permission_response", "requestId": "…", "allow": true, "scope": "once" }  // answer a permission_request
```

### 6.2 Server → client

All frames: `{ "eventId": <n>, "type": "...", ... }`.

| type                       | fields                                        | source                          |
| -------------------------- | --------------------------------------------- | ------------------------------- |
| `ready`                    | —                                             | post-auth ack                   |
| `session.init`             | `sessionId, provider, resumed, model?, maxBudgetUsd?` | SDK `system`/`init` **[SDK-verified]** |
| `assistant.block_start`    | `sessionId, index, blockType`                 | `content_block_start` **[SDK-verified]** |
| `assistant.delta`          | `sessionId, text`                             | `content_block_delta` **[SDK-verified]** |
| `assistant.done`           | `sessionId`                                   | end of assistant message        |
| `tool_use`                 | `sessionId, id, name, input`                  | tool call (incl. Claude's writes)|
| `tool_result`              | `sessionId, id, name, ok, summary?, content?` | tool result                     |
| `permission_request`       | `sessionId, requestId, tool, input`           | `canUseTool` pause (interactive tiers) |
| `result`                   | `sessionId, subtype, costUsd?, turns?`        | terminal `result` **[SDK-verified]** |
| `repo.changed`             | `repo, paths`                                 | fs watcher (Phase 4)            |
| `error`                    | `code, message, sessionId?`                   | any failure                     |

`result.subtype` is one of `success`, `error_max_budget_usd`, `error_max_turns`, `error` — the SDK's
own subtypes. **`costUsd` is `total_cost_usd`: a client-side ESTIMATE, per-query not per-session** —
the app must **accumulate it across resumes** to show a running total. `maxBudgetUsd` (config) is a
**soft** cap compared against that same estimate.

**Tool events carry the SDK `tool_use_id` as `id`** on both `tool_use` and `tool_result`, so a client
matches a result to its call by `id` — robust even when tools run in parallel (matching by `name` is
not: SDK `tool_result` blocks carry no name, and names repeat). The bridge fills `tool_result.name`
from the correlated `tool_use`. `tool_use.input` is the tool's raw input object (e.g. Read's
`file_path`, Edit's `old_string`/`new_string`) — enough for the client to render a target path and an
inline edit diff without any extra fetch. `tool_result.summary` is a short one-line descriptor for the
collapsed badge (e.g. `"142 lines"`, `"12 matches"`); `tool_result.content` is the result text
**truncated** by the bridge (≈120 lines / 8 KB, with a trailing `… (truncated)` marker) for an
expanded preview — the wire never carries whole files. Both are omitted when empty (e.g. a bare `ok`).

**Interactive permission gate.** For the interactive tiers (Ask first, Auto-edit, Auto-run) the bridge
runs the SDK `canUseTool` callback: a tool needing approval **pauses** the turn and the bridge emits
`permission_request` (`requestId`, `tool`, `input` — enough to render the target path + edit diff). The
client answers with `permission_response` (`allow`, `scope`): `allow:false` denies the call; `allow:true`
with `scope:"once"` permits just this call; `scope:"session"` also stops prompting for edits for the rest
of the session (and the app upgrades its shown tier to Auto-edit). Read-only tools never prompt.
`session.init.maxBudgetUsd` echoes the bridge's soft budget cap so the client can show `Turn $ · Session
$ vs budget` (the turn/session split is derived from each `result.costUsd`).

### 6.3 Partial streaming & the e-ink profile

Per-token `assistant.delta` frames require the SDK's `includePartialMessages: true`
**[SDK-verified]**. The **Color E-Ink** DisplayProfile does **not** render every delta; the client
coalesces deltas and repaints **per completed line** (see [EINK.md](EINK.md)) to avoid thrashing the
panel. The wire is identical for both profiles — batching is a client-side rendering decision.

---

## 7. Versioning

The path prefix (`/v1`) is the protocol version. Breaking changes bump it. `GET /v1/health` returns
`{ "ok": true, "protocol": 1, "bridge": "0.1.0" }` so the app can detect a mismatch early.
