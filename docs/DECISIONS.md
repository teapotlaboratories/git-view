# GitView — Architectural Decisions

Short ADR-style record of the choices that shape the project, and why. The first four were decided with the project owner; the rest follow from research (see the annotated prior-art and technical briefs that informed this repo).

## ADR-001 — Android app: native Kotlin + Jetpack Compose  *(owner decision)*
**Decision:** Build the client natively in Kotlin/Compose.
**Why:** Best performance on large files and long lines; access to mature read-only editor components (**Sora Editor**, TextMate/tree-sitter grammars = VS Code–grade highlighting). Trade-off accepted: Android-only for now; iOS would be a separate build (Flutter/KMP were the cross-platform alternatives if that changes).

## ADR-002 — Topology: bridge server on the dev machine  *(owner decision)*
**Decision:** A small server runs where the repos live; the phone is a thin client. It also **attaches to an existing Claude session on a directory** when one exists, with an **option to connect to a remote-control-enabled session**.
**Why:** Repos and secrets stay on your machine; the API key never reaches the phone. Matches every mature reference (`claudecodeui`, `claude-code-webui`, `paseo`, Claude Code on the web) which all use *thin client + server-side daemon*. The "attach to existing session" requirement maps to discovering `~/.claude/projects/<cwd>/*.jsonl` and resuming.

## ADR-003 — Remote connectivity: Tailscale (WireGuard)  *(owner decision)*
**Decision:** Reach the bridge over a Tailscale tailnet, fronted by Tailscale Serve.
**Why:** Zero public exposure, NAT traversal solved by WireGuard P2P (DERP fallback), auto-TLS in-tailnet, and a verifiable device identity for free. Cloudflare Tunnel / Funnel are documented fallbacks for when the phone can't join the tailnet.

## ADR-004 — "Multiple sessions" scope  *(owner decision)*
**Decision:** Support **multiple repos per machine**, **multiple machines**, and **saved connections** you switch between. (Multiple concurrent chats per repo comes along for free via session multiplexing.)
**Why:** These are the owner's stated needs. Repos are namespaced server-side (`/api/repos/:repo`); machines + saved connections are an app-side connection store with Keystore-held tokens.

## ADR-005 — Bridge language: Node.js + TypeScript
**Decision:** Implement the bridge in TS (Fastify + `ws`).
**Why:** The **Claude Agent SDK ships first-class in TS/Python**, bundling the Claude Code binary — in-process streaming, sessions, permission modes, and `PreToolUse` hooks with the exact controls our security model needs, no CLI-stdio reverse-engineering. One language for REST + WS + spawning `git`. (Python is an equally valid second choice; Go was rejected — no first-party Agent SDK.)

## ADR-006 — Git access: shell out to the `git` binary (isomorphic-git as fallback)
**Decision:** Drive repos by `execFile`-ing the system `git`, with `isomorphic-git` only where no `git` binary exists.
**Why:** Faithful blame porcelain, three diff modes (worktree/staged/commit), and `show` are all first-class in the CLI and only partially covered by pure-JS/Go ports. `libgit2` bindings add native-build cost for marginal benefit at single-developer scale.

## ADR-007 — Transport: REST (GET) for browse + one WebSocket for the live channel
**Decision:** Read-only browse over cacheable `GET` REST; chat + tool events + repo-change pushes over a single WebSocket.
**Why:** We genuinely need upstream (interrupts/steering) and server push in one pipe — WebSocket's sweet spot. gRPC-Web can't do bidirectional streaming in this context. **SSE + POST is an accepted simpler MVP fallback** (free reconnect via `Last-Event-ID`) and is documented in API.md.

## ADR-008 — Claude session: pluggable providers, read-only by default
**Decision:** One `SessionManager` with providers — (A) local Agent SDK [default], (B) attach-existing (a mode of A), (C) remote-control attach [Phase 5, feasibility-gated]. Default permission profile is read-only.
**Why:** Cleanly satisfies both "attach to the session on this directory" and "connect to a remote-control session" behind one app UI, without betting the product on the (not-fully-public) third-party remote-control surface. Read-only default because `allowedTools` alone does **not** constrain writes under a bypass mode — see SECURITY.md.

## ADR-009 — Don't run the agent or an IDE on the device
**Decision:** No on-device agent, no embedded `code-server`/VS Code.
**Why:** Prior art is unanimous — on-device (`openclaude-android`) is possible but pays heavy APK/battery/security costs; a full IDE on mobile is the wrong tool for read-only viewing. Render files with a lightweight native highlighter; keep execution on the bridge.

## ADR-010 — License hygiene for references
**Decision:** Study AGPL/GPL references (`claudecodeui` AGPL, `MGit`/`SGit` GPLv3) but build on MIT-friendly bases (`claude-code-webui`, the Agent SDK, `code-server` as architecture only).
**Why:** AGPL forks force open-sourcing a hosted service. Keep GitView's own license unencumbered.

---

### Items to verify before relying on them
- Exact Claude Agent SDK option/flag names and the read-only permission mode string (pin the SDK version).
- The programmatic third-party attach surface for `claude remote-control` (ADR-008 provider C) — WebView fallback if none is clean.
