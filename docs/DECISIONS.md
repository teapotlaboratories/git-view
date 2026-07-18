# GitView — Architectural Decisions

Short ADR-style record of the choices that shape the project, and why. The first four were decided with the project owner; the rest follow from research (see the annotated prior-art and technical briefs that informed this repo).

## ADR-001 — Android app: native Kotlin + Jetpack Compose  *(owner decision)*
**Decision:** Build the client natively in Kotlin/Compose.
**Why:** Best performance on large files and long lines; access to a mature **editable** code component (**Sora Editor**, TextMate/tree-sitter grammars = VS Code–grade highlighting). Trade-off accepted: Android-only for now; iOS would be a separate build (Flutter/KMP were the cross-platform alternatives if that changes).

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

## ADR-007 — Transport: REST for browse + edit, one WebSocket for the live channel
**Decision:** Browse over cacheable `GET` REST plus edit over `PUT`/`POST`/`DELETE`; chat + tool events + repo-change pushes over a single WebSocket.
**Why:** We genuinely need upstream (interrupts/steering) and server push in one pipe — WebSocket's sweet spot. gRPC-Web can't do bidirectional streaming in this context. **SSE + POST is an accepted simpler MVP fallback** (free reconnect via `Last-Event-ID`) and is documented in API.md.

## ADR-008 — Claude session: pluggable providers
**Decision:** One `SessionManager` with providers — (A) local Agent SDK [default], (B) attach-existing (a mode of A), (C) remote-control attach [Phase 6, feasibility-gated].
**Why:** Cleanly satisfies both "attach to the session on this directory" and "connect to a remote-control session" behind one app UI, without betting the product on the (not-fully-public) third-party remote-control surface.
**Note:** the *default permission profile* is set by ADR-013 (full read/write, no prompts), superseding the earlier read-only default.

## ADR-009 — Don't run the agent or an IDE on the device
**Decision:** No on-device agent, no embedded `code-server`/VS Code.
**Why:** Prior art is unanimous — on-device (`openclaude-android`) is possible but pays heavy APK/battery/security costs; a full IDE on mobile is the wrong tool for read-only viewing. Render files with a lightweight native highlighter; keep execution on the bridge.

## ADR-010 — License hygiene for references
**Decision:** Study AGPL/GPL references (`claudecodeui` AGPL, `MGit`/`SGit` GPLv3) but build on MIT-friendly bases (`claude-code-webui`, the Agent SDK, `code-server` as architecture only).
**Why:** AGPL forks force open-sourcing a hosted service. Keep GitView's own license unencumbered.

## ADR-011 — Full read/write, not view-only  *(owner decision — supersedes the view-only premise)*
**Decision:** GitView is a read **and write** tool: the app can create/edit/rename/delete files and stage/commit, and Claude runs full tools. The original "view only" framing is dropped.
**Why:** The owner changed direction to want editing + an autonomous agent, not just review. Reads at a `ref` stay read-only (history is immutable); writes act on the working tree.
**Consequence:** the "structurally read-only" guarantee is gone; safety now rests on path confinement + auth + a private network. See SECURITY.md.

## ADR-012 — In-app editing via a working-tree write API  *(owner decision)*
**Decision:** The bridge exposes a small write surface — `PUT /blob` (save), `POST /file` (create), `DELETE /file`, `POST /rename`, and `stage`/`commit`/`discard` — operating on the working tree. The Android app uses Sora Editor in editable mode. `util/paths.ts#confine()` guards every path.
**Why:** "Edit in the app" needs a real write path, not just a Claude proxy. Keeping it a thin, explicit, confined REST surface (separate `fileService`/`gitWrite` modules) makes the write capability easy to audit.

## ADR-013 — Direct writes, no approval prompts  *(owner decision)*
**Decision:** Writes hit the working tree immediately and the Claude session runs `permissionMode: "bypassPermissions"` (verify the exact name) — no approve/deny step. Worktree isolation and approval prompts are **off by default**, available as opt-in dials (Plan, Phase 7). Per-repo `claude.profile: read-only` re-locks a repo.
**Why:** The owner chose maximum convenience. Git (commit/branch/restore) is the undo. This is safe *provided* the bridge stays private (Tailscale) and authenticated — a valid token = code execution on the machine.

## ADR-014 — Color e-ink alternative view via a `DisplayProfile`  *(owner requirement)*
**Decision:** Ship a second display profile tuned for color e-ink (Kaleido 3), selectable everywhere and auto-offered on e-ink devices. Model it as one immutable `DisplayProfile` (Standard / Color E-Ink) provided through a `CompositionLocal`, controlling: Material theme, animations, ripple/overscroll, scroll vs pagination, the Sora `EditorColorScheme` + TextMate theme, streaming-batch interval, and Onyx refresh strategy.
**Why:** E-ink isn't a theme swap — Kaleido is ~300 PPI mono but only ~150 PPI muted color, ghosts on motion, and can't sustain per-token streaming repaint. So: **highlight by weight/italic/underline (mostly black), not pastel hues** (`eink-mono` TextMate theme); **kill animations, paginate**; **batch streamed chat per line**; drive **Onyx `EpdController` refresh via reflection** (no SDK hard-link; no-ops off-Boox) with full-flash on the right triggers. Auto-detect (Build heuristics) only pre-selects — a persisted user override always wins. Full rationale in [EINK.md](EINK.md).
**Scope:** in-app base rides in Plan Phases 1 & 3; on-device refresh integration is Phase 8.

---

### Items to verify before relying on them
- Exact Claude Agent SDK option/flag names and the **full-access** permission mode string (`bypassPermissions`) — pin the SDK version.
- The programmatic third-party attach surface for `claude remote-control` (ADR-008 provider C) — WebView fallback if none is clean.
- Onyx `EpdController`/`UpdateMode` API surface, Compose `Indication`/overscroll APIs, and Sora theme APIs — all version-sensitive; verify against pinned versions on a real Kaleido 3 device ([EINK.md](EINK.md) §8).
