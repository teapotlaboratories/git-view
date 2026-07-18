# GitView — Architecture

## 1. The big picture

Two trust domains, one bridge, a thin phone.

```
        ANDROID APP (Kotlin/Compose)                      DEV MACHINE
 ┌───────────────────────────────────┐          ┌──────────────────────────────────────────────┐
 │ Connection store (Keystore)        │          │  BRIDGE (Node.js / TypeScript, Fastify + ws)  │
 │  ├ saved bridges (multi-machine)   │          │                                              │
 │  └ per-conn: token, lastRepo, sess │  Tailscale (WireGuard, TLS via Serve)                    │
 │                                    │◄────────►│  ┌────────────────────────────────────────┐  │
 │ Browse tab                         │   REST   │  │ Auth: pairing code → bearer token      │  │
 │  ├ file tree (lazy, virtualized)   │  (GET)   │  └────────────────────────────────────────┘  │
 │  ├ code viewer (Sora, read-only)   │          │  ┌───────────────── READ-ONLY ───────────┐  │
 │  ├ diff / blame / log              │          │  │ Git service  (hardened `git` wrapper)  │──┼─► repos/
 │  └ md preview / images / binary    │          │  │  ls-tree · cat-file · diff · blame ·    │  │
 │                                    │          │  │  log · show · for-each-ref  (GET only) │  │
 │ Chat tab                           │   1 × WS │  └────────────────────────────────────────┘  │
 │  ├ streamed assistant markdown     │◄────────►│  ┌───────────── SANDBOXED ────────────────┐  │
 │  ├ tool-use event chips            │   (chat  │  │ Claude session manager                 │  │
 │  ├ interrupt / stop                │  + events)│ │  ├ Agent SDK query() (cwd = repo)      │──┼─► ~/.claude/
 │  └ session switcher (multi-chat)   │          │  │  ├ discover + attach existing sessions │  │  projects/…
 │                                    │          │  │  ├ read-only permission profile + hook │  │
 └───────────────────────────────────┘          │  │  └ (opt) remote-control attach / WebView│  │
                                                 │  └────────────────────────────────────────┘  │
                                                 └──────────────────────────────────────────────┘
```

**Two domains that never merge:**

1. **Browse path** — structurally read-only. Only read-only git plumbing, only `GET` routes, path-confined to the repo root. It *cannot* mutate the repo because there is no write code on this path.
2. **Claude session** — a separate, sandboxed domain. Chatting "about" a repo is different from browsing it; Claude's tools can write unless locked down, so this path gets its own permission profile, deny-hook, and OS sandbox (see [SECURITY.md](SECURITY.md)).

The phone is deliberately thin: it renders trees/files and streams a chat. No git, no agent, no IDE runs on the device.

## 2. Components

### 2.1 Bridge (`bridge/`)

Node.js + TypeScript. Chosen because the **Claude Agent SDK ships first-class in TS/Python** (bundling the Claude Code binary), giving in-process streaming, sessions, permission modes, and `PreToolUse` hooks — no CLI-stdio reverse-engineering. One language covers REST + WebSocket + spawning short-lived `git` children.

Modules:

| Module | Responsibility |
|---|---|
| `src/config.ts` | Load `config.yaml` (repo registry, limits) + `.env` (secrets). |
| `src/git/gitService.ts` | The **only** thing that touches repos. `execFile("git", args)` with a subcommand allowlist, arg validation, path confinement, and SHA-keyed caching. |
| `src/http/rest.ts` | Fastify routes — all `GET`, all read-only (tree, blob, diff, blame, log, show, refs, status). |
| `src/claude/sessionManager.ts` | Create/attach/resume Claude sessions via the Agent SDK; enforce the read-only profile; track sessions per repo. |
| `src/ws/liveChannel.ts` | The single WebSocket: prompt in, streamed tokens + tool events out, interrupts, repo-change pushes. Multiplexed by `{repoId, sessionId}`. |
| `src/auth/pairing.ts` | Pairing code / QR → bearer token issuance + verification middleware. |

### 2.2 Android app (`android/`)

Native Kotlin + Jetpack Compose. Chosen for best performance on large files and access to mature read-only editor components (Sora Editor). Key layers:

- **UI (Compose):** `ConnectionsScreen`, `RepoListScreen`, `TreeScreen`, `FileViewer`, `DiffViewer`, `ChatScreen`, with a `Browse ⇄ Chat` switch (tabs on phone, two-pane on tablet).
- **Data:** `BridgeApiClient` (Retrofit/OkHttp for REST) + `LiveChannel` (OkHttp WebSocket). A `ConnectionStore` (Room + Keystore) holds saved bridges.
- **Rendering:** Sora Editor (read-only, TextMate/tree-sitter grammars); a Markdown renderer; Coil for images.

### 2.3 The wire

- **REST (GET only)** for everything cacheable and request/response: tree, blob, diff, blame, log, show, refs, status. Git objects are immutable, so responses are cached by object SHA.
- **One WebSocket** for the live channel: bidirectional chat (send prompt / interrupt, receive streamed tokens + tool events) and server-push `repo-changed` notifications. Chosen over SSE+POST because we genuinely need the upstream (interrupts, steering) and push in a single pipe; SSE+POST remains an acceptable simpler fallback and is noted in [API.md](API.md).

Full message shapes: **[API.md](API.md)**.

## 3. The Claude side — pluggable "session providers"

Your requirement had two parts: *attach to a session already running on a directory*, and *optionally connect to a remote-control-enabled session*. GitView models this as **session providers** behind one interface, so the app UI is identical regardless of source.

```
                        ┌────────────────────────────────────────┐
   app: "chat in repo X"│           SessionManager                │
   ──────────────────►  │   pick provider per session/config      │
                        └───────┬───────────────┬─────────────────┘
                                │               │
             ┌──────────────────▼───┐   ┌───────▼───────────────────────────────┐
             │ (A) LOCAL AGENT SDK    │   │ (C) REMOTE-CONTROL ATTACH  (Phase 5)  │
             │  default & recommended │   │  official `claude remote-control`     │
             │  • query(), cwd = repo │   │  session; if no clean 3rd-party API,  │
             │  • includePartialMsgs  │   │  fall back to embedding claude.ai/code│
             │  • read-only profile   │   │  in an authenticated WebView          │
             └──────────┬─────────────┘   └───────────────────────────────────────┘
                        │
             ┌──────────▼─────────────────────────────┐
             │ (B) ATTACH-EXISTING (a mode of A)       │
             │  scan ~/.claude/projects/<cwd>/*.jsonl  │
             │  list sessions; resume most recent      │
             │  (resume:<id> / --continue)             │
             └─────────────────────────────────────────┘
```

- **Provider A — Local Agent SDK (default).** The bridge runs Claude in-process with `cwd` set to the repo. Full control over streaming, permissions, and hooks. This is the recommended path for both new chats and resuming.
- **Provider B — Attach to existing session.** Not a separate engine — it's Provider A pointed at an already-existing session. Claude Code stores each session as `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The bridge lists these per repo and resumes the chosen one, so "there's already a session running on this directory → just attach to it" works: newest session id for that cwd is offered first.
- **Provider C — Remote-control attach (Phase 5, feasibility-gated).** For sessions started with `claude remote-control`. The clean programmatic third-party surface is **not confirmed public** as of design time; the pragmatic fallback is an authenticated `WebView` on `claude.ai/code`. Treated as an alternative, not the backbone.

> Design rule: the app never sees an API key and never gets a raw shell. It sends chat text and receives streamed tokens + structured tool events. All credentials and all execution stay on the bridge.

## 4. Data flow — two representative requests

**Open a file (Browse):**
```
tap file → GET /api/repos/app/blob?ref=main&path=src/App.kt
        → gitService: validate ref+path, confine to repo root,
          execFile("git", ["-C", repo, "cat-file", "-p", "main:src/App.kt"])
        → { path, size, encoding, content, sha } (cached by blob SHA)
        → Sora Editor renders read-only with the grammar for .kt
```

**Ask Claude (Chat):**
```
type prompt → WS ⇒ {type:"prompt", repoId, sessionId?, text}
           → sessionManager: resume sessionId (or attach newest for cwd, or new)
             query({ prompt, options:{ cwd: repo, includePartialMessages:true,
                     permissionMode:<deny-by-default>, allowedTools:[Read,Glob,Grep],
                     disallowedTools:[...], hooks:{PreToolUse: denyWrites} }})
           → stream: {type:"assistant.delta", text} … {type:"tool_use", name, input}
                     {type:"result", sessionId, costUsd}
           → app: append markdown, render tool chips, remember sessionId
```

## 5. Multi-{repo,machine,session}

- **Repos:** `config.yaml` lists N repos; every route is `/api/repos/:repo/…`. In-app repo picker.
- **Machines:** app connection store — a saved list of bridges, each addressed by its Tailscale MagicDNS name, tokens in Keystore. A connection switcher.
- **Sessions:** WS multiplexes by `{repoId, sessionId}`; per repo you can hold several concurrent chats; a session list lets you resume any. Per-session budget/turn caps + idle reaping on the bridge.

## 6. Deployment

The bridge runs where the repos live — a dev box, home server, or cloud VM — as a long-lived service (systemd/launchd), fronted by `tailscale serve`. The phone runs the Tailscale app and the GitView app. No ports are opened to the public internet. See [SETUP.md](SETUP.md).

## 7. Explicitly out of scope (for now)

- Writing to repos from the browse path (structurally impossible by design).
- Running the agent or an IDE on-device (rejected: heavy, insecure, bad battery — see prior-art lesson in [DECISIONS.md](DECISIONS.md)).
- A cloud multi-tenant service (single-user / personal-tailnet assumptions bake in simpler auth).
