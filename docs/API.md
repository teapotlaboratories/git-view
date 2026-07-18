# GitView — Wire Protocol

This is the authoritative contract between the Android app and the bridge. Keep app + bridge types in sync with it.

- **Base URL:** `https://<machine>.<tailnet>.ts.net` (Tailscale Serve) or `http://<host>:8787` on LAN.
- **Auth:** every request carries `Authorization: Bearer <token>`. Phase 0 uses a static token; Phase 4 uses paired per-device bearer tokens.
- **Content type:** JSON unless noted.

## 1. REST — browse (`GET`) + edit (`PUT`/`POST`/`DELETE`)

Reads at a `ref` come from committed objects (immutable). **Writes act on the working tree** (files on disk at the current checkout) and are direct — no approval step. Every path is confined to the repo root; see [SECURITY.md](SECURITY.md).

**Browse (read):**

| Method & path | Purpose | Git / fs |
|---|---|---|
| `GET /api/health` | Liveness + bridge version | — |
| `GET /api/repos` | List configured repos | config |
| `GET /api/repos/:repo/refs` | Branches + tags | `for-each-ref` |
| `GET /api/repos/:repo/tree?ref=&path=` | Directory listing at ref/path | `ls-tree` |
| `GET /api/repos/:repo/blob?ref=&path=` | Committed file content (any ref) | `cat-file -p` |
| `GET /api/repos/:repo/working?path=` | **Working-tree** file content (what the editor opens) | `fs.readFile` |
| `GET /api/repos/:repo/blame?ref=&path=` | Line → commit map | `blame --porcelain` |
| `GET /api/repos/:repo/log?ref=&path=&limit=&cursor=` | Commit log (paginated) | `log` |
| `GET /api/repos/:repo/commits/:sha` | Commit metadata + file diffs | `show` |
| `GET /api/repos/:repo/diff?base=&head=` | Commit-to-commit diff | `diff base..head` |
| `GET /api/repos/:repo/diff?staged=1` | Index vs HEAD | `diff --cached` |
| `GET /api/repos/:repo/diff?worktree=1` | Working tree vs HEAD | `diff` |
| `GET /api/repos/:repo/status` | Porcelain status summary | `status --porcelain=v2` |
| `GET /api/repos/:repo/sessions` | List Claude sessions for this repo | scans `~/.claude/projects/<cwd>` |

**Edit (write — working tree, direct):**

| Method & path | Body / query | Effect | Git / fs |
|---|---|---|---|
| `PUT /api/repos/:repo/blob` | `{ path, content, encoding? }` | Save (overwrite/create) a file | `fs.writeFile` |
| `POST /api/repos/:repo/file` | `{ path, content?, encoding? }` | Create a new file (fails if exists) | `fs.writeFile` |
| `DELETE /api/repos/:repo/file?path=` | — | Delete a file/dir | `fs.rm` |
| `POST /api/repos/:repo/rename` | `{ from, to }` | Rename / move within the repo | `fs.rename` |
| `POST /api/repos/:repo/stage` | `{ paths: [] }` | Stage paths | `git add` |
| `POST /api/repos/:repo/commit` | `{ message, paths? }` | Commit (stages `paths` first if given) | `git commit` |
| `POST /api/repos/:repo/discard` | `{ paths: [] }` | Discard working-tree changes | `git restore` |

### Representative responses

```jsonc
// GET /api/repos
{ "repos": [ { "id": "app", "name": "my-app", "defaultRef": "main" } ] }

// GET /api/repos/app/tree?ref=main&path=src
{ "ref": "main", "path": "src",
  "entries": [
    { "name": "App.kt", "path": "src/App.kt", "type": "blob", "size": 4213, "sha": "a1b2…" },
    { "name": "ui",     "path": "src/ui",     "type": "tree", "sha": "c3d4…" }
  ] }

// GET /api/repos/app/blob?ref=main&path=src/App.kt
{ "path": "src/App.kt", "ref": "main", "sha": "a1b2…",
  "size": 4213, "encoding": "utf-8", "binary": false,
  "content": "package com.example…", "truncated": false }

// GET /api/repos/app/diff?worktree=1
{ "base": "HEAD", "head": "WORKTREE",
  "files": [
    { "path": "src/App.kt", "status": "modified", "additions": 12, "deletions": 3,
      "unified": "@@ -1,4 +1,7 @@ …",
      "hunks": [ { "oldStart": 1, "oldLines": 4, "newStart": 1, "newLines": 7,
                   "lines": [ { "kind": "context|add|del", "text": "…" } ] } ] } ] }

// GET /api/repos/app/sessions
{ "sessions": [
    { "id": "9f3c…", "updatedAt": "2026-07-18T02:11:00Z", "title": "auth refactor", "messages": 42 } ] }

// PUT /api/repos/app/blob   body: { "path": "src/App.kt", "content": "package …", "encoding": "utf-8" }
{ "path": "src/App.kt", "size": 4310, "savedAt": "2026-07-18T02:20:00Z" }

// POST /api/repos/app/commit   body: { "message": "tweak", "paths": ["src/App.kt"] }
{ "committed": true, "output": "[main a1b2c3d] tweak\n 1 file changed, 3 insertions(+)" }

// GET /api/repos/app/blame?ref=main&path=src/App.kt
{ "ref": "main", "path": "src/App.kt",
  "lines": [ { "line": 1, "sha": "a1b2…", "author": "Ada", "content": "package com.example" } ] }

// GET /api/repos/app/status
{ "branch": "main",
  "entries": [ { "code": ".M", "path": "src/App.kt" }, { "code": "??", "path": "notes.txt" } ] }

// GET /api/repos/app/commits/<sha>
{ "sha": "a1b2…", "author": "Ada", "email": "ada@x.dev", "date": "2026-07-18T02:11:00Z",
  "subject": "tweak", "body": "", "files": [ { "path": "src/App.kt", "status": "modified",
  "additions": 3, "deletions": 0, "binary": false, "hunks": [ /* … */ ] } ] }
```

### Conventions
- `ref` defaults to the repo's `defaultRef`. Accepts branch, tag, or SHA.
- Blobs over a configurable size return `truncated: true` (+ a byte range API for on-demand paging); binaries return `binary: true` with no `content`.
- `log` paginates with an opaque `cursor`.
- Responses cache by object SHA (immutable) with strong `ETag`s.

## 2. WebSocket — live channel

One socket per connection: `wss://<host>/ws?token=<bearer>`. All frames are JSON with a `type`. Multiplexed across repos/sessions by the `repoId` / `sessionId` fields.

### Client → server

```jsonc
{ "type": "prompt", "repoId": "app", "sessionId": "9f3c…"?, "text": "Where is auth handled?" }
{ "type": "interrupt", "sessionId": "9f3c…" }
{ "type": "attach", "repoId": "app", "sessionId": "9f3c…" }   // resume a discovered session
{ "type": "new_session", "repoId": "app" }                     // start a fresh chat
{ "type": "subscribe_changes", "repoId": "app" }               // ask for repo-changed pushes
{ "type": "ack", "lastEventId": 12841 }                        // for replay after reconnect
```

### Server → client

```jsonc
{ "type": "session.started", "sessionId": "9f3c…", "repoId": "app", "resumed": true }
{ "type": "assistant.delta", "sessionId": "9f3c…", "eventId": 12842, "text": "Auth lives in " }
{ "type": "tool_use", "sessionId": "9f3c…", "eventId": 12843,
  "name": "Read", "input": { "file_path": "src/auth/Session.kt" } }
{ "type": "tool_result", "sessionId": "9f3c…", "eventId": 12844, "name": "Read", "ok": true }
{ "type": "assistant.done", "sessionId": "9f3c…", "eventId": 12845 }
{ "type": "result", "sessionId": "9f3c…", "costUsd": 0.0042, "turns": 3 }
{ "type": "repo_changed", "repoId": "app", "reason": "refs|worktree" }
{ "type": "error", "sessionId": "9f3c…"?, "code": "…", "message": "…" }
```

### Reconnection & replay
- Every server event carries a monotonic `eventId`. The bridge keeps a small ring buffer per session.
- On reconnect the client sends `{ "type": "ack", "lastEventId": N }`; the bridge replays anything after `N`.
- Heartbeats via WS ping/pong; exponential backoff with jitter on the client.
- On resume, the Claude session is resumed by id — the conversation is **not** restarted.

> **Simpler MVP alternative:** SSE (`GET /stream/:sessionId`, server→client) + `POST /prompt` (client→server). You get free auto-reconnect via `Last-Event-ID`, at the cost of two channels. Either is acceptable; the WebSocket is the target design.

## 3. Auth handshake (Phase 4)

```jsonc
// Bridge shows a QR/pairing code out-of-band (terminal). App posts it:
POST /api/pair   { "pairingCode": "GV-4821-QST" }
→ 200            { "token": "<long-lived bearer>", "deviceId": "…", "bridgeName": "devbox" }
// Token is stored in the Android Keystore and sent as Bearer on every request thereafter.
```

## 4. Error model

`{ "type"/"error" , "code", "message" }` with HTTP status for REST. Codes: `unauthorized`, `not_found`, `bad_ref`, `path_denied`, `too_large`, `rate_limited`, `session_denied`, `internal`.
