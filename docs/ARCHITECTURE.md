# GitView — Architecture

## 1. The big picture

Two capabilities over one bridge, with a thin phone: a **direct edit path** and a **full-tool Claude session**. Both act on the same repo working tree.

```
        ANDROID APP (Kotlin/Compose)                      DEV MACHINE
 ┌───────────────────────────────────┐          ┌──────────────────────────────────────────────┐
 │ Connection store (Keystore)        │          │  BRIDGE (Node.js / TypeScript, Fastify + ws)  │
 │  ├ saved bridges (multi-machine)   │          │                                              │
 │  └ per-conn: token, lastRepo, sess │  Tailscale (WireGuard, TLS via Serve)                    │
 │                                    │◄────────►│  ┌────────────────────────────────────────┐  │
 │ Browse/Edit tab                    │   REST   │  │ Auth: pairing code → bearer token      │  │
 │  ├ file tree (lazy, virtualized)   │  (read + │  └────────────────────────────────────────┘  │
 │  ├ code EDITOR (Sora, editable)    │   write) │  ┌──────────── READ ─────────────────────┐  │
 │  ├ save · create · rename · delete │          │  │ gitService  (read plumbing)            │──┼─► repos/
 │  ├ diff / blame / log              │          │  │  ls-tree · cat-file · diff · blame ·    │  │  (working
 │  └ stage · commit · discard        │          │  │  log · show · for-each-ref             │  │   tree +
 │                                    │          │  ├──────────── WRITE ────────────────────┤  │   history)
 │ Chat tab                           │   1 × WS │  │ fileService (edit working tree)        │──┼─►
 │  ├ streamed assistant markdown     │◄────────►│  │  save · create · remove · rename       │  │
 │  ├ tool-use chips (incl. writes)   │   (chat  │  │ gitWrite   (stage · commit · discard)  │  │
 │  ├ interrupt / stop                │  + events)│ └────────────────────────────────────────┘  │
 │  └ session switcher (multi-chat)   │          │  ┌──────────── FULL-TOOL AGENT ──────────┐  │
 │                                    │          │  │ Claude session manager                 │  │
 └───────────────────────────────────┘          │  │  ├ Agent SDK query() (cwd = repo)      │──┼─► ~/.claude/
                                                 │  │  ├ Read/Write/Edit/Bash, NO prompts    │  │  projects/…
                                                 │  │  ├ discover + attach existing sessions │  │
                                                 │  │  └ (opt) remote-control attach / WebView│  │
                                                 │  └────────────────────────────────────────┘  │
                                                 └──────────────────────────────────────────────┘
```

**Two paths, one repo:**

1. **Direct edit path** — the app's own file operations (`PUT /blob`, `POST /file`, `DELETE`, `rename`, `stage/commit/discard`). It writes to the **working tree** (files on disk at the current checkout). Historical refs remain read-only — you can't write into a past commit.
2. **Claude session** — a full-tool agent (`Read`/`Write`/`Edit`/`Bash`) running with `cwd` = the repo and **no approval prompts**. It reads and modifies the same working tree.

They're kept as separate modules (clear write surface, easy to audit), but they are **not** separate trust levels anymore: both can change your repo. The boundary is now **path confinement + auth + a private network**, not a read-only guarantee. See [SECURITY.md](SECURITY.md).

The phone stays thin: it renders/edits files and streams a chat. No git engine and no agent run on the device.

## 2. Components

### 2.1 Bridge (`bridge/`)

Node.js + TypeScript. Chosen because the **Claude Agent SDK ships first-class in TS/Python** (bundling the Claude Code binary), giving in-process streaming, sessions, and permission modes. One language covers REST + WebSocket + spawning `git` + `fs` writes.

| Module | Responsibility |
|---|---|
| `src/config.ts` | Load `config.yaml` (repo registry, limits, `claude.profile`) + `.env` (secrets). |
| `src/util/paths.ts` | `confine()` — resolve + confine every path to the repo root. **The key write-safety guard.** |
| `src/git/gitService.ts` | Read plumbing: tree, blob (at any ref), log, refs, diff, blame. |
| `src/git/fileService.ts` | Write path: save / create / remove / rename in the working tree; read the working-tree version. |
| `src/git/gitWrite.ts` | Git write ops for the editor: stage / commit / discard. |
| `src/http/rest.ts` | Fastify routes — `GET` (browse) + `PUT`/`POST`/`DELETE` (edit). |
| `src/claude/sessionManager.ts` | Create/attach/resume Claude sessions via the Agent SDK; full-tool profile (or per-repo read-only). |
| `src/ws/liveChannel.ts` | The single WebSocket: prompt in, streamed tokens + tool events out, interrupts, repo-change pushes. |
| `src/auth/pairing.ts` | Pairing code / QR → bearer token issuance + verification middleware. |

### 2.2 Android app (`android/`)

Native Kotlin + Jetpack Compose. Best performance on large files and access to the **Sora Editor** (read *and* edit, TextMate/tree-sitter grammars). Layers:

- **UI (Compose):** `ConnectionsScreen`, `RepoListScreen`, `TreeScreen`, **`FileEditor`** (editable), `DiffViewer`, `LogScreen`, `ChatScreen`, with a `Browse/Edit ⇄ Chat` switch.
- **Data:** `BridgeApiClient` (Retrofit/OkHttp REST, read + write) + `LiveChannel` (OkHttp WebSocket). A `ConnectionStore` (Room + Keystore).
- **Rendering/editing:** Sora Editor (editable, grammars); a Markdown renderer; Coil for images.

### 2.3 The wire

- **REST** — `GET` for browse (tree, blob, working, diff, blame, log, refs) + `PUT`/`POST`/`DELETE` for edit (save, create, delete, rename, stage, commit, discard). Reads at a ref cache by object SHA; working-tree reads/writes are live.
- **One WebSocket** — bidirectional chat (send prompt / interrupt, receive streamed tokens + tool events, **including the writes Claude makes**) and server-push `repo_changed` notifications so the editor stays in sync.

Full message shapes: **[API.md](API.md)**.

## 3. The Claude side — pluggable "session providers"

Your requirement had two parts: *attach to a session already running on a directory*, and *optionally connect to a remote-control-enabled session*. GitView models this as **session providers** behind one interface.

- **Provider A — Local Agent SDK (default).** Runs Claude in-process, `cwd` = repo, **full tools, no prompts**. New chats and resumes.
- **Provider B — Attach to existing session (a mode of A).** Claude Code stores each session as `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The bridge lists these per repo and resumes the chosen one — so "there's already a session on this directory → attach to it" works: newest session for that cwd is offered first.
- **Provider C — Remote-control attach (Phase 6, feasibility-gated).** For `claude remote-control` sessions; WebView fallback to `claude.ai/code` if no clean programmatic surface.

> The app never sees an API key and never gets a raw shell of its own. It sends chat text + edit requests and receives streamed tokens + structured tool events. All credentials and all execution stay on the bridge.

## 4. Data flow — three representative requests

**Open a file for editing:**
```
tap file → GET /api/repos/app/working?path=src/App.kt   (working-tree version)
        → fileService.readWorking: confine path, read from disk
        → { path, size, encoding, content }
        → Sora Editor opens it editable with the .kt grammar
```

**Save an edit:**
```
⌘S → PUT /api/repos/app/blob  { path:"src/App.kt", content:"…", encoding:"utf-8" }
   → fileService.save: confine path → mkdir -p → fs.writeFile (working tree)
   → { path, size, savedAt }         then optionally:
POST /api/repos/app/commit { message:"tweak", paths:["src/App.kt"] }  → gitWrite.commit
```

**Ask Claude (may edit the repo):**
```
type prompt → WS ⇒ {type:"prompt", repoId, sessionId?, text}
           → sessionManager: resume sessionId (or attach newest, or new)
             query({ prompt, options:{ cwd: repo, includePartialMessages:true,
                     permissionMode:"bypassPermissions" }})   // full tools, no prompts
           → stream: {assistant.delta} … {tool_use name:"Edit", input:{…}} {tool_result}
                     {result, sessionId, costUsd}
           → app: append markdown, show tool chips; on Edit/Write, refresh the tree/open buffer
             (driven by repo_changed events — Phase 4)
```

## 5. Multi-{repo,machine,session}

- **Repos:** `config.yaml` lists N repos; every route is `/api/repos/:repo/…`. In-app repo picker. Register **only** repos you accept an agent editing/running code in.
- **Machines:** app connection store — saved bridges addressed by Tailscale MagicDNS name, tokens in Keystore. A connection switcher.
- **Sessions:** WS multiplexes by `{repoId, sessionId}`; several concurrent chats per repo; per-session budget/turn caps + idle reaping.

## 6. Deployment

The bridge runs where the repos live — a dev box, home server, or cloud VM — as a long-lived service (systemd/launchd), fronted by `tailscale serve`, running as an **unprivileged user**. The phone runs the Tailscale app and GitView. No ports are opened to the public internet. See [SETUP.md](SETUP.md).

## 7. Explicitly out of scope (for now)

- A cloud multi-tenant service (single-user / personal-tailnet assumptions bake in simpler auth).
- Running the agent or an IDE on-device (rejected: heavy, insecure, bad battery — see [DECISIONS.md](DECISIONS.md)).
- Default sandboxing/approval of the Claude session — intentionally off (ADR-013); available as opt-in dials in Phase 7.
