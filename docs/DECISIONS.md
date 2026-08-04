# Architecture Decision Records

Each ADR is tagged **[owner-mandate]** (a hard requirement from the owner), **[research-backed]**
(driven by the mid-2026 research pass — see the two research reports summarized in the repo history),
or **[design-choice]** (our own call). Research-backed ADRs cite whether the claim was VERIFIED.

---

### ADR-001 — Thin client + bridge topology · [owner-mandate]
A small bridge runs where the repos live; the handheld is a thin client. No git engine and no agent
run on the device. All git and agent execution stay on the bridge host.

### ADR-002 — Native Kotlin + Jetpack Compose client · [owner-mandate]
Single APK for both device classes. Editable code component with VS Code-grade highlighting.
See ADR-013 for the editor choice.

### ADR-003 — Node.js + TypeScript bridge, system `git` via execFile · [owner-mandate]
The Claude Agent SDK is first-class in TypeScript. Git is driven by `execFile`-ing the system `git`
with an argv array (never a shell string). A pure-JS fallback is reserved for gaps only.

### ADR-004 — Transport: cacheable REST + one WebSocket · [owner-mandate / design-choice]
`GET` for browse (ETag + immutable cache for historical refs), `PUT/POST/DELETE` for edits, and ONE
WebSocket for the live channel. Server→client frames carry a monotonic `eventId` with a ring buffer
for replay. Wire protocol frozen in [API.md](API.md).

### ADR-005 — Symmetric DisplayProfile (Standard | Color E-Ink) · [owner-mandate]
Neither profile is the "real" one. Auto-detect selects per device; a persisted user override always
wins. The Color E-Ink profile is not a theme swap — it changes theme, highlighting mode, animation,
scrolling, and chat batching. See [EINK.md](EINK.md).

### ADR-006 — Connectivity over Tailscale Serve · [owner-mandate]
The editor API is reachable only over a Tailscale tailnet fronted by Tailscale Serve (auto-TLS, zero
public exposure). Cloudflare Tunnel is documented as a fallback. A read/write bridge is never exposed
on a public URL. See [SECURITY.md](SECURITY.md).

---

### ADR-010 — Provider split; Remote Control primary · [research-backed: VERIFIED]
Chat runs behind two selectable providers: **Remote Control** (primary) and the **local Claude Agent
SDK** (fallback). Remote Control (research preview, shipped Feb 2026) was VERIFIED: connects
claude.ai/code + the Claude mobile apps to a local `claude` session; **outbound-HTTPS only, no
inbound ports**; **subscription auth only — API keys rejected** (we unset `ANTHROPIC_API_KEY` in the
child); transcript stored on Anthropic servers while connected; invoked as `claude remote-control`
with `--sandbox` (off by default) and `--spawn worktree`. Constraints: research preview, one
connection per session, times out after a network outage, ZDR orgs can't enable it.
*Correction vs. brief:* `--sandbox` and worktrees are opt-in flags we must pass explicitly.

### ADR-011 — Sessions via SDK APIs, not jsonl parsing · [research-backed: VERIFIED]
Session discovery/resume uses the SDK's own `listSessions()` / `resume` / `continue` / `forkSession`
/ `persistSession` / `sessionStore` (all VERIFIED). We never glob or parse `~/.claude/projects/*.jsonl`
— that format is internal/unstable and its location is `CLAUDE_CONFIG_DIR`-configurable. SDK sessions
are resumed from the repo's `cwd` (we always pass `cwd: repo.path`).

### ADR-012 — Permission profiles; `auto` default; confined via allowedTools · [research-backed: VERIFIED, with one correction]
`permissionMode` accepts `default | dontAsk | acceptEdits | bypassPermissions | plan | auto`
(VERIFIED — note `plan` exists in addition to the brief's list). Defaults: **`auto`** (model-classifier
approvals, no prompts) for the chat; `acceptEdits` conservative; `confined-agent` when Bash isn't
needed. Deny rules (`disallowedTools` scoped like `Bash(rm *)`) and `PreToolUse` hook denies apply
**even in `bypassPermissions`** (VERIFIED) — used as backstops. `bypassPermissions` requires
`allowDangerouslySkipPermissions: true`, must not run as root, and is re-asserted at launch.
**Correction (KILLED claim):** the design's `tools: []`-drops-built-ins mechanism did NOT survive
verification, so `confined-agent` is built from an **`allowedTools` whitelist + bare-name
`disallowedTools`** (which *does* remove a tool from context — VERIFIED) instead. Not-verified but
low-risk: bypass-cannot-run-as-root and not-restored-on-resume — we enforce both defensively anyway.

### ADR-012a — In-process MCP write surface · [research-backed: VERIFIED]
`createSdkMcpServer()` exposes the bridge's confined git/file ops as tools auto-namespaced
`mcp__gitview__<tool>` with Zod schemas (VERIFIED). The `confined-agent` profile routes all writes
through this audited surface, so Claude uses the same path as the app — no raw Bash/Write, no bypass.

### ADR-012b — Sandbox runtime around the local agent · [research-backed: VERIFIED]
`@anthropic-ai/sandbox-runtime` (Apache-2.0, v0.0.66, VERIFIED): bubblewrap on Linux, Seatbelt on
macOS, whole-process, no container; `denyRead` for secrets; default-deny egress allowlist proxy;
`failIfUnavailable` to refuse running unconfined. Treated as the **hard isolation boundary**;
classifier/deny-rules/egress-proxy are defense-in-depth, not the boundary.

### ADR-013 — Sora Editor (LGPL-2.1) for the editor · [research-backed: VERIFIED — license correction]
Sora Editor provides VS Code-grade highlighting via **TextMate + tree-sitter** (VERIFIED). Its
license is **LGPL-2.1** — VERIFIED, and a **correction to the brief's MIT/Apache assumption**. LGPL
is weak/library copyleft (non-GPL/non-AGPL): fine to depend on as an unmodified AAR (dynamic-link
terms), but we must (a) keep it a replaceable dependency and not fork-modify it into our tree, and
(b) ship the LGPL notice + a way to obtain/relink it. GitView's own code stays MIT. Requires Kotlin
≥ 2.2 (Sora 0.24.4 ships Kotlin 2.2 metadata) and core-library desugaring for TextMate below API 33.

### ADR-015 — Native Oniguruma required for real highlighting · [design-choice, verified on-device]
VS Code-grade highlighting uses Sora's TextMate module with real VS Code grammars
(`assets/textmate/grammars`, from shikijs/textmate-grammars-themes, MIT) + the Dark+ theme (Standard)
or the weight/underline mono theme (Color E-Ink). Sora's DEFAULT regex engine is pure-Java **Joni**,
which **cannot parse the look-behind patterns** in the TypeScript/Kotlin grammars — tokenization
throws `TMException: invalid pattern in look-behind` and the file renders uncolored. Fix: add the
`io.github.rosemoe:oniguruma-native` module (native `.so` for all ABIs incl. x86_64) and call
`Oniguruma().setUseNativeOniguruma(true)` at init. Verified on the emulator: `native oniguruma
available=true`, 0 look-behind errors, full color. Highlighting degrades to plain monospace if the
native lib or a grammar is missing (`SyntaxHighlighting.ready`). File-type icons + a dark editor
(gutter, current-line, tab width) round out the IDE feel.

### ADR-014 — E-ink hardware layer is optional, vendor-neutral, NO-OP by default · [research-backed: VERIFIED — no public Bigme SDK]
VERIFIED: the Bigme B7 Pro (7" Kaleido 3, MediaTek Dimensity 1080, Android 14) has **no public
developer e-ink SDK** and **no documented programmatic refresh API**; refresh is an end-user setting
via the on-device **E-Ink Center** (xRapid; per-app modes). Contrast: Onyx/Boox `com.onyx.android.sdk`
`EpdController` is real but Boox-only. Therefore the software e-ink adaptations are the reliable core;
`EInkRefreshController` is an optional layer that defaults to NO-OP and degrades to E-Ink Center
guidance. Any Bigme hook must be discovered empirically on-device. See [EINK.md](EINK.md).

---

### ADR-020 — Streaming event shapes · [research-backed: VERIFIED]
`system`/`init` carries `session_id`; `includePartialMessages: true` streams `content_block_start` /
`content_block_delta` / `content_block_stop`; the terminal `result` carries `total_cost_usd` (a
per-query client-side estimate — the app accumulates it across resumes) and `num_turns`;
`maxBudgetUsd` is a soft cap; exhaustion surfaces as `error_max_budget_usd` / `error_max_turns`. All
VERIFIED. Mapped to GitView's own normalized events in `sessionManager.pump()`.

### ADR-021 — Optional Anthropic deps · [design-choice]
`@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sandbox-runtime` are `optionalDependencies`: the
bridge builds and serves git without a Claude subscription/SDK; the Claude layer loads them via
dynamic import and degrades gracefully. Both are pre-1.0 / research-preview surfaces — pin versions
and re-verify option names on upgrade.

### ADR-022 — KSP1 for Room on the current toolchain · [design-choice]
Room's annotation processing hits a KSP2 bug (`unexpected jvm signature V`) with Kotlin 2.2.21 here;
`ksp.useKSP2=false` selects stable KSP1. Revisit when Room/KSP2 compatibility settles.

### ADR-023 — Design tokens + ProfileTheme (extended tokens alongside a derived M3 ColorScheme) · [design-choice]
The redesign palette (`docs/design/design_handoff_gitview_redesign/`) exceeds Material 3's ColorScheme
slots — a 4-level text ramp, two border weights, `add`/`remove`/`warning`/`info`, a 0–4 risk ramp, diff
tints. So the extended tokens live in an `@Immutable GitViewColors` (plus `Spacing`, `Motion`) provided
via `staticCompositionLocalOf`, ALONGSIDE a Material 3 `ColorScheme` — and BOTH are built from the same
`StandardPalette`/`EinkPalette` hex constants (`ui/theme/Color.kt`), so the two channels can't drift.
`GitViewTheme(profile)` maps every M3 role from those constants (so stock components and existing
screens re-skin with no edits) with `surfaceTint = Transparent` (flat; the depth/elevation token is
deferred to step 2). Typography + Shapes are profile-aware (bundled IBM Plex Sans + JetBrains Mono as
static per-weight faces; sizes in `sp` — a conscious deviation from the spec's "dp"; E-Ink body floor
16sp / low-contrast min weight 500; all five shape slots set, E-Ink uniform 6dp). `Motion` carries
ready-built enter/exit/spec (E-Ink `None`/`snap`) so call sites branch once; ripple is gated off on
E-Ink. A `GitViewTheme` accessor object mirrors `MaterialTheme.colorScheme`. Fonts are **bundled**, not
downloadable, because the e-ink targets are offline / no-GMS (downloadable fonts fall back to system
default there). Verified: `assembleDebug` + both profiles rendered in-palette on-device (`kancil_test`).
Follow-ups: a depth/elevation token (step 2), overscroll-off on E-Ink, and the Sora editor code-font swap.

### ADR-024 — Tool-event correlation + capped result preview on the wire · [design-choice]
Extends ADR-020 for the redesign's `ToolActivityCard`. The card must match each `tool_result` to its
`tool_use` and show a badge + expandable preview. SDK `tool_result` blocks carry `tool_use_id`, not a
name (and names repeat), so both `tool_use` and `tool_result` now carry that id as `id`; the bridge
correlates by id, fills `tool_result.name` from the matching `tool_use`, and computes `summary` (a
short badge descriptor, e.g. line/match count) + `content` (the result text **truncated** to ≈120
lines / 8 KB with a `… (truncated)` marker — the wire never carries whole files). `tool_use.input` is
forwarded raw so the client derives the target path and synthesizes the Edit/Write inline diff
(`old_string`→`new_string`) with no extra REST fetch. Verified against a live local-SDK session.

### ADR-025 — Interactive permission gate via SDK `canUseTool` · [design-choice]
The redesign's **Ask first** tier pauses a write for inline approval — new behavior (the old
`confined-agent` used `dontAsk`, no prompt; that wire-id slot is repurposed). For the interactive tiers
(Ask first, Auto-edit, Auto-run) the bridge supplies the SDK `canUseTool` callback: a tool needing
approval emits `permission_request` (`requestId, tool, input`) and the callback awaits the client's
`permission_response` (`allow, scope`) via a pending-request map, then returns allow/deny to the SDK.
`scope:"session"` auto-allows edits for the rest of the session (and the app upgrades its shown tier to
Auto-edit). Read-only tools never prompt; `HARD_DENY_RULES` + the `PreToolUse` backstop still apply
underneath. `session.init` now echoes `maxBudgetUsd` (config soft cap) for the `Turn $ · Session $ vs
budget` bar. Wire ids stay stable — the app maps the new names/risk/`was`. If the SDK requires
streaming-input mode for `canUseTool`, the prompt is passed as a single-message async iterable
(resolved by live verification).

### ADR-026 — Branch checkout + push write endpoints · [design-choice]
The redesign's v1 scope includes branch switching + push, so two audited REST write endpoints were
added. `POST /checkout` runs `git checkout [-b] <ref>` (validated name — no leading `-`, no
whitespace/glob metacharacters); it **mutates HEAD** (not working-tree-file scoped), and the fs watcher
then emits `repo.changed` so the app refreshes tree/tabs. `POST /push` runs `git push` using the
**host's configured git credentials** — the first endpoint that performs network egress. It's the same
minimal posture as the rest of the write surface: pairing-gated, audited, no credential management in
the bridge (auth is whatever the host's git already has). See docs/SECURITY.md.

### ADR-027 — Live git-state on the repos list + commit log · [design-choice]
The redesign's repo cards + history show live git-state the bridge didn't compute (the repos list was
static config; the log carried no stat). `RepoSummary` now carries `branch`/`ahead`/`behind`/`dirty`
computed per repo in `GET /repos` (in parallel; `ahead`/`behind` omitted when there's no upstream, via
`rev-list --left-right --count @{upstream}...HEAD`), and `CommitSummary` carries `files`/`additions`/
`deletions` parsed from `git log --shortstat`. `rev-list` was added to the read-subcommand allowlist.
Reachability + latency stay **client-side** (the app round-trip-times `GET /health` per bridge) — no
server work. Verified live.

### ADR-028 — E-Ink comfort is user settings, not profile-forced · [design-choice]
The handoff assumed a slow EPD, so the Color E-Ink profile would **force** pagination, no-motion, and a
calmed editor. The owner's actual device is a Bigme B7 Pro — an **80Hz** Kaleido panel that scrolls and
animates fine. So those three behaviors became **user [DisplaySettings], default OFF, opt-in**:
`paginate` (EinkPaginator — discrete full-page repaints instead of scroll), `editorCalm` (page footer +
no blinking caret / fling), `reduceMotion` (still animations/ripple/overscroll + per-line chat batching).
They persist in the `gitview_display` prefs and are toggled from ⋮ → "Display settings…". The E-Ink
**profile** still owns the always-on VISUALS — 56dp targets, weight/underline semantics, paper palette,
weight/italic (`eink-mono.json`) syntax — since those aren't a function of refresh rate. Consequence:
`GitViewTheme` now gates the motion token + ripple + overscroll on `reduceMotion` (not `profile.isEink`),
so a Standard user can calm the screen and an E-Ink user can keep smooth motion. Verified on bigmeB7:
the toggles persist and Paginate pages History (`1–6` → `6–12 of 20`) + the explorer tree.

### ADR-029 — Observable WS connection state + auto-reconnect + offline read-only · [design-choice]
Step 7 needed an offline/reconnect story, but `BridgeClient` exposed no connection state and a dropped
socket silently no-op'd sends. Now `BridgeClient` publishes a `ConnState` StateFlow
(CONNECTING/CONNECTED/RECONNECTING/DISCONNECTED) and `connect()` is a **long-lived auto-reconnecting**
flow (capped 1→15s backoff) rather than a one-shot — one drop flips the banner and re-dials until the
workspace is left. A **10s WS ping interval** is required to detect a dead peer at all (OkHttp doesn't
apply the read timeout to an open WebSocket's frame reads). The UI consequences: a "Connection lost —
reconnecting…" banner in the workspace; the editor goes **read-only while disconnected with the unsaved
buffer preserved** (`readOnly = ref != null || disconnected`); `sendPrompt` refuses into a dead socket.
Verified on-device: a real network drop shows the banner + read-only in ~3s and auto-reconnects when the
bridge returns. (Editor **save-conflict** — a `repo.changed` on a dirty open file → an inline
reload/overwrite/diff bar, buffer preserved — ships alongside; it's a UI/VM behavior, not a wire change.)

### ADR-030 — Browse host filesystem + open a folder as a workspace · [design-choice]
GitView could only ever open **pre-registered** `config.yaml` repos. This adds a "browse the host + open
a folder as a workspace" flow (bridge `/v1/fs/*` + `/v1/workspaces/open`, app folder browser). Three forks
were decided:
1. **Scope = roots-confined (not free filesystem access).** A new `workspaceRoots: string[]` in
   `config.yaml`; browse/`mkdir`/open are allowed **only within** those declared roots, gated by the
   **same `confine()`** containment as every other path (rejects absolute / `..` / symlink escape).
   An **empty list = feature off** — `/v1/fs/*` and `/v1/workspaces/*` then return `404` and
   `GET /v1/health` reports `features.workspaces = false`. Rationale: a valid token is already effectively
   code-exec on the box (see [SECURITY.md](SECURITY.md)), but unbounded filesystem browse is a needless
   widening; reusing `confine()` means no new escape surface, and off-by-default keeps the current posture
   for anyone who doesn't opt in.
2. **Non-git folder = prompt-to-git-init (bridge never auto-inits).** `POST /v1/workspaces/open` on a
   non-repo folder returns `{ needsInit: true, path }` and does nothing; git is initialized only when the
   caller passes `initGit: true`, which the app sends **only after the user confirms**. Rationale: silently
   `git init`-ing a directory the user merely browsed into is a surprising, hard-to-undo side effect —
   creating a repo is the user's decision, made explicitly.
3. **Persistence = bridge state file, not config rewrite.** Opened workspaces persist to
   `.gitview/workspaces.json` (mode `0600`), mirroring the existing `tokens.json` convention;
   **`config.yaml` is never rewritten** by the bridge. `GET /v1/repos` then returns config repos **merged
   with** persisted workspaces, deduped by `id` (config wins on collision). Rationale: config.yaml is the
   operator's hand-authored file — programmatic rewrites risk clobbering comments/ordering and blur the
   line between declared trust and runtime state; a separate `0600` state file matches how tokens are
   already handled.

**Wire choice:** open returns a **200 with a `needsInit` flag rather than a 409.** A non-repo folder isn't
an *error* — it's an expected fork in the open flow the app resolves by prompting — so it's a normal
success response the client branches on, reserving the error channel (and `409 conflict`, used by
`/v1/fs/mkdir` for an existing name) for genuine failures. All new routes sit **behind the existing Bearer
auth gate** (not added to the pairing/health exemption) and path-escape / bad-root-id / clobber reuse the
existing `pathEscape` / `notFound` / `conflict` helpers in `bridge/src/util/errors.ts`.

### ADR-031 — Session picker-on-open + resume-by-id (new `/messages` endpoint) · [design-choice]
Opening a repo lands on a **session picker / new-chat** screen, not straight into the most-recent session.
Auto-opening the latest session is surprising on a shared repo (you resume someone else's or your own stale
thread, possibly spending budget continuing it) and gives no way to start fresh; a picker (list from
`GET …/sessions`, plus a "new chat" action) makes resume-vs-new an explicit choice and shows each session's
title/turns/`updatedAt` up front.

Resuming needed a **new `GET /v1/repos/:repo/sessions/:id/messages` endpoint** because **SDK `resume`
reconnects the session but does not rehydrate past turns** — it replays no history, so a resumed chat would
open blank. We can't reconstruct that history from disk either: per **ADR-011** the bridge **deliberately
never parses `~/.claude/projects/*.jsonl`** (internal/unstable format). So the transcript comes from the
SDK's own `getSessionMessages()`, normalized into a `TranscriptMessage` role-tagged union
(`user`/`assistant`/`tool_use`/`tool_result`) whose `tool_use`/`tool_result` **reuse the live-frame field
names** (`id`/`name`/`ok`/`summary?`/`content?`) so the app rehydrates with its existing
`ToolActivityCard` + correlation-by-`id` logic — no new client parsing. If the SDK lacks
`getSessionMessages`, the bridge degrades to `{ sessionId, messages: [] }` (still never touching jsonl).
One SDK gotcha worth recording: unlike `resume`/`listSessions` which key off the repo `cwd`,
**`getSessionMessages()` reads from the session directory, not a `cwd`** — the bridge passes the session
dir, not `repo.path`. See [API.md](API.md) §5.

### ADR-032 — Remove-workspace = un-register only (never deletes files), refuses config repos · [design-choice]
Opened workspaces (ADR-030) accumulate in `.gitview/workspaces.json` with no way to remove them.
`DELETE /v1/workspaces/:id` drops one: it removes the `workspaces.json` entry, **unserves** the repo, and
**stops its fs watcher**. It **never deletes the folder or any files on disk** — only GitView's registration
is dropped (re-opening the folder via `POST /v1/workspaces/open` restores it). Rationale: the user *browsed*
into a real project directory; destroying its contents from a "remove from list" action would be a
catastrophic, surprising side effect — removal is about GitView's registry, not the filesystem, mirroring how
open never rewrites `config.yaml`. It **refuses config repos** (`config.yaml`-declared) with **`403
forbidden`** — those aren't runtime state the bridge owns; an unknown id is `404 not_found`. To let the app
show the affordance only where it's valid, `RepoSummary` gains **`removable:boolean`** (config repos `false`,
opened workspaces `true`, **default `false`**). Implementation needed a **`RepoWatcher` refactor from a
single watcher to a Map-keyed-by-id**, so one workspace's watcher can be started/stopped independently
without disturbing the others. Behind the existing Bearer auth gate; reuses the `forbidden` / `notFound`
helpers. See [API.md](API.md) §4.2.

### ADR-033 — One provider (local Claude Agent SDK) + auto-resume the latest host session on open · [design-choice]
Two collapses of earlier decisions:

1. **Dropped the Remote Control provider — chat is always the local Claude Agent SDK.** Remote Control
   (ADR-010, the "primary") streamed a `claude remote-control` session **through Anthropic's servers and
   the Claude app**: the transcript lived on Anthropic servers while connected, and — the disqualifier —
   GitView **could not render it in-app** (the conversation surfaced in claude.ai/code + the mobile apps,
   not our chat pane; the bridge only held a connect URL/QR). So it never fit a native client whose whole
   point is an in-app transcript, and carrying it forced **two providers + two trust models** for no
   in-app payoff. Removing it leaves **one provider** — the local SDK, which streams real
   `assistant.delta` / `tool_use` / `tool_result` frames the app already renders — and **one trust model**
   (transcript stays on the host). The WS `prompt` frame's `provider` and `POST …/sessions`' `provider`
   are now **effectively always `local-sdk`**; the field is kept on the wire (frozen `/v1` protocol) but
   the bridge no longer launches a remote-control process — `POST …/sessions` always returns the local ack.
   This **partially supersedes ADR-010** (the provider split + Remote-Control-primary): the split is gone;
   what survives is the local-SDK half and everything built on it (ADR-011/012/020/024/025).

2. **Opening a workspace auto-resumes the most recent host session** (with a Sessions button to switch or
   start fresh). Because the local SDK **shares the host's `~/.claude` session store**, the sessions the
   bridge lists are the *same* sessions the owner's terminal `claude` created — so opening a workspace now
   **continues the most recent one** rather than landing on a chooser. A **Sessions button** still opens the
   picker (list from `GET …/sessions`) to switch threads or start a **New chat**; resume still rehydrates
   history via `…/sessions/:id/messages` (ADR-031). This **supersedes the picker-on-open choice in ADR-031**:
   the picker-first rationale assumed a *shared repo* where auto-resuming "someone else's or a stale thread"
   was surprising — but GitView is single-user (see [SECURITY.md](SECURITY.md) threat model) against the
   owner's own `~/.claude`, so the most-recent session is *the owner's last thread on this box* and
   continuing it is the expected, lowest-friction behavior; the explicit picker stays one tap away for
   switch/new. ADR-031's `/messages` endpoint + resume-rehydration are unchanged — only the default landing
   screen flips from picker to auto-resumed chat.

**Update — reverted #2 to picker-on-open.** Auto-resume proved unsafe in practice: the owner runs a
`claude --continue --remote-control` screen **per project**, and `--continue` binds each to that project's
**most-recent** session — the exact session auto-resume also targets. Resuming it made GitView's local SDK
a **second writer** on a session Anthropic's servers were concurrently driving (claude.ai/code), so the
local `~/.claude/**.jsonl` diverged from the live server view (a "test" turn sent from GitView appeared
locally but never on claude.ai/code). Remote-control isn't a per-session flag we can detect cheaply, and
the *most-recent* session is precisely the one a live screen holds — so opening a workspace now shows the
**picker** again (session list + New chat). You consciously resume an *idle* session or start fresh — both
of which GitView solely owns — and it never silently writes into a live remote-control session. The Sessions
button and `/messages` resume-rehydration are unchanged; only the default landing flips back to the picker.

### ADR-034 — Terminal = a host PTY over the live channel, `script(1)`-spawned, MIT in-app renderer, on by default · [design-choice]
The owner asked for "SSH in addition to files and chat." Three forks were decided:

1. **A host shell, not a remote-SSH client.** The Terminal opens an interactive shell **on the bridge host**
   (where the repos already live) rather than dialing out to another machine over SSH. It reuses the existing
   authenticated `/v1/live` WebSocket — new frames `terminal.open/input/resize/close` up, `terminal.data/exit`
   down (see [API.md](API.md) §6) — so it needs no new port, auth path, or connection. `termId` is
   client-generated, so one socket can hold several shells.

2. **PTY via `script(1)`, no native module.** The shell is spawned as
   `script -qefc "$SHELL -i" /dev/null` — the same trick the Claude-login relay already uses to get a real
   TTY without `node-pty`. This keeps the bridge **pure-JS**, so the `.deb` stays small and
   `Architecture: all` (a `node-pty` optional-dep would force an arch-specific package — the same reasoning
   that kept the Claude CLI a host binary, ADR on the `.deb`). The cost: `script` owns the PTY master, so
   `terminal.resize` (`TIOCSWINSZ`) is a no-op — the window size is fixed at open. Accepted; a future
   optional `node-pty` build could add live resize if wanted.

3. **A self-written MIT terminal renderer, not a GPL terminal-view.** The app parses ANSI/VT itself
   (`ui/terminal/TerminalEmulator.kt` — a line-oriented cell model: SGR colors/bold, `\r \b \t`,
   erase-line/clear-screen, in-line cursor moves; OSC-title and unknown escapes swallowed) rather than
   embedding Termux's `TerminalView` (**GPLv3**, which would relicense the app). The trade is scope:
   **full-screen TUIs** (vim, htop, tmux) are **out of scope** — the renderer targets running commands and
   reading colored output, which covers the ask; input is line-mode with raw `^C`/`^D`/Tab.

**Security.** The terminal is **arbitrary code execution as the run-user**, outside the agent's sandbox and
permission tiers — it is fenced only at the edges (auth-gated, on/off via `terminal.enabled` default `true`,
audited, shells killed on disconnect). Its threat model is spelled out in [SECURITY.md](SECURITY.md) →
"Terminal — a host shell, as powerful as SSH." Treat enabling it as handing out SSH to the run-user.

### ADR-035 — Device auth: hashed, identified device store (Option B) · [design-choice]
**Decided: Option B**, after the owner asked *"ultimately we kill a process? why is that — can't we have a
database that manages key pairs per client?"* and then *"if I have multiple devices connected at the same
time, which one is better?"* The first question exposes **two concerns** the current design conflates; the
second is what settled the choice. Options A/C are recorded below as considered-and-deferred.

#### What exists today
- The pairing code is **in-process state only** — `AuthManager.pairingCode` (`bridge/src/auth/pairing.ts:18`),
  minted in the constructor, 10-minute TTL, re-minted on SIGHUP (`refreshPairingCode`) and again after every
  successful pair (one code → one token, so it can't be replayed). It is **never persisted and never returned
  over the network** — that comment at `pairing.ts:45` is load-bearing, see below.
- Bearer tokens are persisted to `tokens.json` (`{tokens: string[]}`, mode `0600`) as **bare opaque strings**
  — no id, no label, no timestamps. `verify()` compares the presented token against *every* stored token with
  **no early return** (`pairing.ts:71`) — deliberate, to keep timing flat.
- App side: `ConnectionStore.kt` keeps the token in **`EncryptedSharedPreferences`** (AES256-SIV keys /
  AES256-GCM values) under a Keystore-backed **`MasterKey`**, keyed by connection id. REST sends
  `Authorization: Bearer` (`BridgeApi.kt:127`); the WS sends `{"type":"auth","token":…}` as its first frame
  (or the `gitview.bearer.<token>` subprotocol).
- On this dev box `tokens.json` has accumulated **21** tokens — mostly dead emulator pairings, and
  indistinguishable from the real devices.

#### Concern 1 — why minting a code needs a signal
Nothing is killed: the unit declares `ExecReload=/bin/kill -HUP $MAINPID`, so `gitview-bridgectl pair` →
`systemctl reload` → *the same* SIGHUP. The process keeps running (verified: MainPID stable, `NRestarts=0`).

The signal exists **only because the code lives in RAM**, and the code lives in RAM on purpose:
`POST /v1/pair` is the **only auth-exempt write endpoint** — necessarily, since a pairing client has no token
yet. A "mint me a fresh code" endpoint could not be authenticated either, so anyone who could reach `:8787`
could mint a code and pair themselves — and via ADR-034's terminal that is arbitrary code execution as the
run-user. **Restricting the code to the local console/journal makes host access the authentication.**

That argument justifies *not putting the code on the network*. It does **not** require a signal:

> **Option A — file-backed pairing code.** `bridgectl` mints a code, writes it `0600`, and the bridge reads
> it on demand. No signal, no reload. Cost: one more credential at rest, plus a read-per-request or a
> cache-invalidation path. **Verdict: small win, not the real problem.** The signal is a symptom, not the bug.

#### Concern 2 — the token store (this is the real weakness)
Bare strings mean: **no identity** (which of the 21 is your phone?), **no granular revocation** (a lost phone
is only remediable by truncating the file, which de-authorizes *every* device), **no expiry or last-seen**,
**plaintext at rest** (reading `tokens.json` grants full read/write bridge access, terminal included — this
is exactly how the rimba API tests authenticated), and **O(n) verify** on every request and WS frame.

> **Option B — hashed, structured device store.** Replace the string array with
> `{id, label, createdAt, lastSeenAt, tokenHash}`. Store only a **hash** of the token, so a leaked file no
> longer grants access; look up by id for **O(1)** verify (the constant-time compare then runs once, against
> one hash); add `DELETE /v1/devices/:id` and a device list in the app. Fixes identity, revocation and
> at-rest exposure **without any client-side crypto**.
>
> *Wire change:* the token must carry its id — e.g. `<id>.<secret>` — so the bridge knows which record to
> hash against. **App impact:** none beyond storing the new token format; the existing `Bearer` header and
> WS auth frame are unchanged.

> **Option C — per-device keypairs (the owner's "key pairs per client").** The device generates an
> **asymmetric keypair**, sends only the public key at pair time, and signs each request; the bridge stores
> public keys only, so it holds **no secret at rest at all**.
>
> ⚠️ **This is not a reuse of what the app already does.** `ConnectionStore` uses a Keystore *MasterKey* to
> encrypt a symmetric secret — it does not generate a signing keypair. Option C means new
> `KeyPairGenerator` work (`PURPOSE_SIGN`, StrongBox where available), a signing scheme with **replay
> protection** (nonce/timestamp, and a per-frame or challenge-response story for the long-lived WS, which
> authenticates *once* at open), key rotation, and attestation questions. **Largest change; strongest result.**

#### Migration for the existing 21 tokens
Any option must not force a re-pair of the owner's real devices. **B** and **C** can both migrate
compatibly: keep verifying legacy bare strings from `tokens.json` as an unlabelled `legacy` device while new
pairings write the new record, then drop the legacy path once the owner confirms every device is re-paired.
The 21 tokens **cannot be pruned selectively today** — they carry no identity, so "delete the dead emulators"
is not expressible until B or C exists. That is itself an argument for B.

#### The deciding factor — several devices connected at once
On what multi-device actually needs (attribute an action to a device; revoke one without touching the
others) **B and C are equivalent** — both add identity. What separates them under concurrency is **cost per
request**: C verifies an **asymmetric signature** on every call (EC P-256 verify ≈ 50–100 µs) where B does a
`Map` lookup plus one hash compare (≈ 1 µs). That multiplies by device count × request rate — the rimba soak
alone issued **59 diff polls in 30 s from one client**. So under concurrent load C is not merely more
expensive to *build*, it is the **slower** option at runtime. (Today's design is worse than both: `verify()`
walks all 21 tokens on every request.)

**The sharper finding is that identity alone is not enough, and neither option fixes it for free.**
`Conn` (`ws/liveChannel.ts:31`) carries **no device identity**, and `conn.authed` is set **once** (line 98)
and never re-checked. With several devices connected that means:
- **Revocation would not reach a live socket.** A revoked device keeps streaming events and keeps its open
  shells; only its *next REST call* fails. Revocation would be eventual, not immediate.
- **The terminal cap is per-connection** (`MAX_TERMINALS_PER_CONN = 8`), so N devices ⇒ up to **8N** shells.
- **Audit cannot attribute anything** — `AuditEntry.actor` is `"app" | "claude"` (`util/audit.ts:11`), so
  every `terminal.open` from every device logs as the same anonymous `"app"`. Tolerable with one device;
  it defeats the point of the log with several.
- **No "connected now"** — `conns` is an anonymous `Set`.

**So B ships with device identity plumbed through the live channel, not just the token file:**
1. stamp `Conn` with `deviceId` at auth;
2. `DELETE /v1/devices/:id` closes that device's live sockets with **4401** — revocation is immediate;
3. widen the audit actor to carry the device, so entries attribute;
4. cap terminals **per device**, and report `connected` on `GET /v1/devices` from the live set.

#### Decision
**B, including the four items above. A and C deferred.** B clears every sharp edge that exists today —
revocation, identity, at-rest exposure — for bridge-side-only cost and zero crypto-design risk, and it is a
prerequisite for the device list C would also need.

**A** (file-backed pairing code) is deferred: it removes a signal that costs nothing today (`ExecReload` is
already `/bin/kill -HUP $MAINPID` — no restart; verified `NRestarts=0`, MainPID stable) at the price of
another credential at rest.

**C** is deferred, not rejected — revisit when there is a second user, or when the bridge runs somewhere
less trusted than the devices. Its value is bounded here for two reasons: the WS authenticates **once at
open**, so a realistic challenge-response design leaves the live channel exactly as trusted as it is today
(per-frame signing would mean a signature per `terminal.input` keystroke); and because ADR-034's terminal is
already RCE as the run-user, anyone who can *read* `tokens.json` on the host can equally just run commands.
**B's hashing therefore defends against the file leaving the host** — a backup, a synced dotfile, a bad
`chmod`, a copied disk image — which is the realistic threat, rather than against a local attacker.

**Hashing note:** the secret is 32 bytes from `randomBytes`, not a human password, so a plain **SHA-256** is
correct — there is nothing to brute-force, and a slow KDF (bcrypt/argon2) would only add latency to every
request. **Timing note:** the `Map` lookup makes *id* existence observable by timing. Accepted deliberately —
ids are not secrets — and the constant-time compare still guards the **secret**. This is a change from
today's flat-timing O(n) loop (`pairing.ts:71`), recorded here so it is not mistaken for a regression.

---

### ADR-036 — A control socket replaces signals + direct store edits for host administration · [design-choice]
**Decided and implemented.** Written up after the owner asked whether a unix socket could
replace `SIGHUP`. It can, and it subsumes four other pieces of awkwardness that arrived separately.

#### What host administration looks like today
`gitview-bridgectl` manages the bridge from the machine it runs on. It has no credential — deliberately
(ADR-035 stores only `sha256(secret)`, so there is no usable token on disk, and a CLI shipped in the same
package running as the run-user has no boundary to cross). So it does two things instead: it **reads and
writes `tokens.json` directly**, and it **signals the process** to make the running bridge notice.

That works, but every part of it has now cost something:

1. **A signal carries no payload.** `SIGHUP` is a doorbell, not a message, so the handler cannot tell why
   it rang and must do everything it might need to: mint a pairing code *and* re-read the store. Measured
   consequence — **`gitview-bridgectl revoke` invalidates an outstanding pairing code**, precisely when an
   operator is revoking a lost phone in order to re-pair a good one.
2. **There is no reply.** The CLI prints `Revoked <id>.` before the bridge has agreed. When a reload is
   refused, the device stays authorised; we patched that by *logging* on the bridge side, which helps only
   an operator who thinks to read the journal.
3. **Two writers share one file.** The CLI's read-modify-write races the bridge's coalesced `lastSeenAt`
   flush. `flock` narrows it; nothing removes it while both processes write.
4. **Ownership is the CLI's problem.** Writing under `sudo` left the store root-owned, the bridge (running
   as the install user) hit `EACCES`, and — before `reload()` was hardened — **one revoke wiped every
   device and all 21 legacy tokens on a live install.**
5. **`connected` is unknowable.** Live connection state exists only in the running process, so the CLI
   cannot show it; the column was dropped from `devices` for that reason.
6. **`pair` scrapes `journalctl`** for the code it just caused to be printed.

#### Proposal
The bridge listens on a **unix domain socket** and `bridgectl` sends it named commands
(`pair`, `devices`, `revoke <id>`, `reload`), receiving structured replies.

- **Path:** `/run/gitview-bridge/control.sock`, mode `0600`, via `RuntimeDirectory=gitview-bridge` in the
  unit. systemd creates it owned by `User=` and removes it on stop — no stale socket, and **no ownership
  guesswork, which is what caused (4)**. It cannot live under `/tmp`: the unit sets `PrivateTmp=true`, so
  the service's `/tmp` is a private namespace the CLI cannot see.
- **Authentication: none, unchanged.** Filesystem permissions are the gate, exactly as for `tokens.json`.
  This adds no credential and no new trust boundary — the same people who could already edit the store or
  signal the process are the ones who can connect.
- **The bridge becomes the single writer** of `tokens.json`. (3) and (4) stop being possible rather than
  being mitigated; `flock`, the staging file and the ownership handling in the CLI all delete.
- Commands are distinct, so (1) disappears: revoking stops rotating the pairing code.
- Replies carry results, so (2) and (5) and (6) resolve: the CLI reports what actually happened, can show
  `connected`, and receives the pairing code directly instead of grepping the log.

#### Cost, stated plainly
- **A stopped bridge has no socket.** Today `revoke` still works on a dead service because it edits the
  file. It must instead fail clearly ("bridge not running") rather than pretend. Editing the store by hand
  remains the documented break-glass path.
- A second surface to threat-model in [SECURITY.md](SECURITY.md) — narrow, but real: anything that can
  connect can mint a pairing code, which is host access, which was already sufficient.
- The unit gains `RuntimeDirectory`, so the `.deb` changes and existing installs pick it up on upgrade.

#### Alternative considered: a second signal
`SIGUSR1` for "reload only" fixes (1) alone, in a handful of lines, and leaves (2)–(6) untouched. Worth
taking only if the socket is judged too much surface for the problem.

#### Sequencing
ADR-035's CLI (PR #41) ships first and is already merged: it carries the fix for the wipe, which should
not sit on a branch. This ADR then **removes** its file-editing internals rather than adding to them.

---

### ADR-037 — Drop legacy bare-token auth entirely · [design-choice]
**Decided.** ADR-035 replaced bare opaque tokens with `<deviceId>.<secret>` and kept the old ones working
so upgrading forced nobody to re-pair. That compatibility was always meant to be temporary, and it is now
the most expensive thing in the auth path.

#### What it costs to keep
- **No identity.** Every pre-ADR-035 token collapses to one shared id, `legacy`. Six tokens on a bridge
  are one row, one audit attribution (`util/audit.ts:14`), and one WebSocket bucket
  (`ws/liveChannel.ts:146`) — so "which device did this?" is unanswerable for exactly the devices most
  likely to be stale.
- **No granular revocation.** You cannot revoke *one* legacy device. `revoke legacy` is all-or-nothing,
  which is why it needed a count to be honest about its blast radius at all.
- **Plaintext at rest.** Legacy tokens are stored as-is. The whole point of ADR-035 was that a readable
  store yields no usable credential; every legacy token still in a file undoes that for its own device.
- **An O(n) constant-time scan on every request** (`auth/pairing.ts:155`), alongside the O(1) map lookup
  that replaced it — the old cost never actually went away, it just got a faster sibling.
- **A synthetic row that leaks into everything above it.** The bridge invents a fake device so the API
  has something to return; the app then needs `legacy` special-cases in its wire model, its labels, its
  device list, its confirm dialog, and a rule that a legacy client cannot revoke its own bucket.

#### Change
Bare tokens are no longer accepted. `AuthManager` stops reading, verifying, listing and persisting them;
`LEGACY_DEVICE_ID` and the synthetic row go, and with them the app's `legacy` branches. Authentication
becomes one shape: split on `.`, look the id up, compare the secret in constant time.

#### Cost, stated plainly
**This de-authorises every device still on a pre-0.1.8 token — they must re-pair.** At the time of the
decision that is **6 devices on the quartz bridge** and none on argonite. Nothing recovers them; a
`tokens.json` restored from backup will be ignored just the same.

To make that legible rather than mysterious, the bridge **warns loudly at boot** when it finds bare tokens
in a store — naming the count and that those devices must re-pair — instead of silently starting with
fewer devices than the file appears to contain. That is the same failure the "unreadable store" warning
exists for: a phone that stops working while the log looks like a healthy boot.

The dead entries are dropped from the file on the next write. They are unusable, and writing them back
would keep implying they mean something.

#### Dependency: this cannot ship alone
De-authorising a device is precisely what makes the bridge close its live socket with **`4401`**
(`ws/liveChannel.ts:107` on failed auth, `:178` on revoke). The app handled only HTTP `401` and treated
`4401` as an ordinary drop, so it reconnected forever without ever saying it had been de-authorised.
Shipping ADR-037 on its own would push **all 6 quartz devices into that permanent reconnect loop at
once** — the bug's worst case, triggered deliberately. The `4401` fix therefore ships in the same change,
not as a follow-up.

#### Alternatives
- **Keep it indefinitely** — rejected: the costs above are permanent, and every new feature that touches
  identity pays the special-case tax again.
- **Migrate legacy tokens into device records** — impossible in the direction that matters: a device
  record needs `sha256(secret)` and an id the *client* also knows, and a legacy client holds a bare token
  it cannot re-derive. Migration would mint credentials the devices could not present.
- **A deprecation window** (warn for N releases, then remove) — better practice on a multi-tenant product;
  here the operator is the owner, the affected population is 6 devices they control, and re-pairing is one
  `gitview-bridgectl pair`. The warning-at-boot is the window.

---

### ADR-038 — KiCad viewer: the bridge parses to a tagged scene, the app renders it · [design-choice]
**Decided.** The owner wants what Altium's web viewer gives: schematic, PCB and 3D in one place, with
live cross-probing — tap a component and it highlights everywhere, pick a net and follow it across sheets
and layers. Scope is **x86 bridges**, targeting **KiCad 10** (10.0.5 at time of writing; sch format
`20250114`, pcb `20241229`).

> **Do not take the snap store as the current version.** It sat at 9.0.7 (Feb 2026) months after 10.0
> shipped, and reading it as authoritative is how this ADR first got written against the wrong target.
> KiCad's own GitLab tags are the source of truth.

#### What killed the obvious design
The obvious design shells out to `kicad-cli`, exports SVG, and shows the picture. It is wrong twice over.

A picture has no semantics: an SVG knows where the ink is, not that this rectangle is `R12` or that this
polyline is `+3V3`. Every render-and-display design dies at the first tap. And the data was there all
along — **KiCad 6+ files are self-contained.** Measured on the `kicad-demos` projects:

| in the file | evidence |
| --- | --- |
| symbol definitions | `lib_symbols` block embeds every symbol the sheet uses |
| footprints | 42 embedded inline, with pad geometry |
| nets, on the board | `(net N "name")` on **all 365** track segments and 378 pads |
| zone fills | 8 `filled_polygon` blocks — already computed, not something to re-solve |
| refdes, value, layers | present throughout |

So a KiCad binary buys nothing for 2D. Dropping it removes a ~1.7 GB runtime dependency from every bridge.

#### The one thing that is genuinely hard
**Schematic nets do not exist as data.** The board tags every drawable with its net; a schematic has 81
wires carrying *no* net at all. Nets must be derived: union-find over wire endpoints, joined at junctions
and pin coordinates, each group then named by label priority (local → hierarchical → global, else
auto-named). Two wires crossing **without** a junction are not connected, and getting that wrong silently
merges nets — a viewer that lies rather than one that breaks.

`kicad-cli sch export netlist` does not rescue this. It yields net→*pin* membership, not which wire
segments belong to a net, so highlighting wires needs the same walk regardless.

#### Change
The bridge parses each file **once**, caches by content hash, and serves a **tagged scene**: drawing
primitives each carrying the ids that matter.

```jsonc
{ "sheet": "pic_sockets",
  "primitives": [
    { "t":"wire", "pts":[[86.36,50.8],[91.44,50.8]], "net":"+3V3" },
    { "t":"pin",  "at":[91.44,50.8], "ref":"U1", "pin":"14", "net":"+3V3" }
  ],
  "components": [ { "ref":"U1", "value":"24C16", "bbox":[...] } ] }
```

The app draws those on a Compose Canvas. Interactivity then costs almost nothing: highlight is a style
change on matching `net`/`ref`, hit-testing is exact rather than an overlay approximation, and
cross-probing between schematic, board and 3D is matching on **reference designator and net name** — the
only identifiers those three views already share.

Sending SVG plus a bounding-box index would also "work", but net highlight would be weak: painting
rectangles over ink you cannot address.

#### The pin transform, settled by measurement
A symbol *instance* on a sheet lists its pins by number and uuid — **no coordinates**. Those live in
`lib_symbols` in the symbol's local frame and must be transformed by the instance placement. Get it wrong
and connectivity is garbage *silently*, because the drawing still renders correctly.

Measured rather than remembered, using `no_connect` markers as an oracle — KiCad places one exactly on an
unconnected pin, so a correct transform must land a pin there:

| transform | markers, KiCad 10 (19978 pins) | netlist, KiCad 7 (582 nets) |
| --- | --- | --- |
| **Y-flip, rotate(−r), mirror** | **91.8%** | **100%** |
| Y-flip, mirror, rotate(−r) | 90.6% | 95.4% |
| mirror ignored | 86.6% | — |
| Y-flip, rotate(+r), mirror | 85.0% | 78.2% |
| `(mirror x)` negates X, not Y | — | 80.6% |
| no Y-flip | 57.8% | — |

Library symbols are Y-up, sheets are Y-down; the rotation is negative. The 7.x corpus could not separate
the two rotation signs (most rotated parts there are two-pin and symmetric about their origin, so both
signs give the same *set* of positions) — the larger KiCad 10 corpus does, decisively. `(mirror x|y)` is
modelled and those instances are **included** (850 of them in the KiCad 10 demos).

**The marker oracle got the mirror order wrong, and this is the interesting part.** It ranked
mirror-before-rotation at 90.6% against the correct 91.8% — a 1.2-point gap that reads like noise. It is
not noise; it is a blind spot. Markers constrain *where* pins land, not *which* pin landed there, and
swapping pins 1 and 2 of a two-pin part moves no coordinates at all. The wrong order shipped briefly and
put every ESD diode on StickHub backwards — pin 2 on GND, pin 1 on the signal — while drawing a flawless
sheet. Only the netlist, which names the pin on each net, separates them: **100% against 95.4%**.

Both measurements are committed tools — `bridge/tools/kicad-probe.ts` and
`bridge/tools/kicad-netlist-oracle.ts` — because the earlier figures came from throwaway scripts and were
reproducible by nobody, including their author. The lesson generalises past KiCad: an oracle that cannot
distinguish two hypotheses will still rank them, and the ranking looks like an answer.

#### The solver, and the rules that were not guessable
`bridge/src/kicad/nets.ts` derives nets by union-find over coordinates; `design.ts` extends that across a
hierarchy. Together they match `kicad-cli`'s own netlist on **1722 of 1722 nets across all 19 demo
projects** — an exact partition match, **zero merges and zero splits**, covering flat sheets, buses and
hierarchy. Getting there meant discovering that most of the interesting rules are not the ones in the
tutorials:

| rule | why it is not obvious |
| --- | --- |
| A wire ending **mid-span of another does not connect** without a junction dot | It looks exactly like a T. `electric.kicad_sch` has one at (115.57, 20.32) and KiCad keeps the nets apart. Assuming otherwise merged two real nets. |
| …but a **pin** mid-span **does** connect, junction or not | The symmetric-looking rule is wrong: requiring a junction here split 59 of `carte_test`'s 100 nets. |
| **Power symbols name a net without being a node on it** | The netlist lists `GND` with the pins it reaches and no `#PWR0x` of its own. |
| A power symbol is `(power)` **plus a `power_in` pin** | Neither the `power:` library prefix nor a hidden pin works: sallen_key keeps GND in its own library, KiCad 10's `power:GND` pin is visible, and `PWR_FLAG` is flagged power but is `power_out` and must name nothing. |
| **Same-name labels join islands that share no wire**, and **hidden `power_in` pins connect by pin name** | A label is a connection, not an annotation. Without the second, the old 74xx convention leaves every supply pin as a one-pin net. |

Ranking merges above splits in the report was deliberate: a split only fails to highlight something, but a
merge silently shorts two nets, which is the viewer-that-lies failure this whole phase exists to avoid.

#### Hierarchy: three mechanisms, each the only one somewhere
A design is usually several files, and the joins between them are **not geometric**. Three mechanisms
appear in the demos, and implementing any two of them looks like it works until it meets the third:

| mechanism | the project that needs it | what it is |
| --- | --- | --- |
| sheet pin ↔ hierarchical label | `video`, `kit-dev-coldfire`, `pic_programmer` | a sheet symbol's pin binds **by name** to a `hierarchical_label` inside the child file |
| global labels + power symbols | `flat_hierarchy` (3 sheets, **zero** sheet pins) | names that reach every sheet regardless of nesting |
| per-instance references | `complex_hierarchy` | the same file placed twice — refdes come from an `instances` block keyed by the path `/rootUuid/sheetUuid` |

The third is not about nets at all, which is what makes it dangerous. `ampli_ht.kicad_sch` is placed twice
and the same potentiometer is `RV1` in one placement and `RV2` in the other; the `Reference` property
holds only one. Trusting it reports one refdes twice — two components silently collapsed into one, in a
netlist that otherwise reads perfectly.

**A sheet pin's identity on the parent is its geometry, not its name.** Binding it through the parent's
name scope shorted two sheets in `video` that each expose a pin called `BLUE` wired to different nets. The
name only selects *which of the child's labels* the pin feeds.

#### Buses: a bundle, not a net
Buses turned out to be entangled with hierarchy rather than separate from it. `kit-dev` passes a bus sheet
pin `AN[0..7]` into a child that refers to its members as plain local labels `AN0`…`AN7` and never
mentions the bus, so members must be expanded across the boundary. `video` goes further: its top sheet
runs one physical bus past five sheet symbols that each name it differently — `DQ[0..31]`, `DPC[0..31]`,
`PC_D[0..7]`, `DQ[0..15]` — and KiCad pairs member *i* of one with member *i* of the other, by index.

Two structural decisions follow, both load-bearing:

- **Bus geometry lives in its own union-find.** `(bus …)` is a distinct element from `(wire …)`, and it
  must never touch the signal solver: one accidental join between a bus node and a signal node collapses
  every member of that bus into a single net. There is a test that fails if bus segments are ever fed to
  the signal union-find.
- **Members alias scope-to-scope, never through the bus node.** Routing them through the shared node would
  merge the whole bus into one net — the same failure by another route.

#### Cost, stated plainly
- **2D rendering fidelity is a long tail.** Stroke fonts, arc primitives, pad shapes, soldermask
  clearance. A parser reaches useful quickly and pixel-faithful slowly. This is the real trade for
  dropping the binary, and unlike the dependency it is honest work rather than an invented cost.
- **3D remains external, and the variable name is version-dependent.** Footprints reference the model
  library through a substitution variable that differs by KiCad version — `${KISYS3DMOD}` in the KiCad 10
  demos, `${KICAD6_3DMODEL_DIR}` in the 7.x ones — so resolution must handle several, not one.
  *Mitigation worth checking at Phase 4:* KiCad 9+ supports **`embedded_files`**, and 2 boards in the
  KiCad 10 corpus already use it. A project that embeds its own models needs no asset library at all.
  On sizing: 43 model refs on a single demo board.
  The meshes ship as `kicad-packages3d` (`Architecture: all`, assets only, no binary) but that is **5.7 GB
  installed**, and WRL/STEP still needs converting to glTF for Android. 3D is therefore gated on the
  assets being present, and is the last phase for good reason.
- **E-ink.** A dense multi-layer board on a 1264×1680 mono panel is a legibility problem, not a rendering
  one; the 3D view there is close to pointless and should be hidden under the Color E-Ink profile.
- **No KiCad files exist in any served repo.** The corpus is the **KiCad 10.0.5 demos** — 115 schematics
  and 19 boards, fetched from GitLab with a path-filtered archive of the `demos/` tree at that tag, no
  KiCad install required. (Ubuntu's `kicad-demos` package is 7.x and three majors stale; useful only as a
  backwards-compatibility check.)

#### Parsing untrusted files
A `.kicad_sch` is repository content, so everything in it is attacker-controlled, and the design walker
follows *paths* out of it. Two limits are therefore part of the design rather than hardening added later:

- **Sub-sheet paths are confined to the root sheet's directory.** `Sheetfile` is joined onto a directory
  path, so `../../../../etc/passwd` otherwise resolves straight out of the repo — an arbitrary-file read
  through a schematic. `loadDesign` refuses it, *and* its `read` callback is documented as a security
  boundary the caller must confine too.
- **Placements are capped, not just nesting depth.** Bounding depth alone is a trap: a sheet holding two
  sheet symbols that each point back at itself branches twice per level, so 32 levels is 2^32 placements
  (measured at 200,000 placements in 43 seconds before the cap). Parsing runs on demand against user
  repositories, so that is a bridge-wide availability failure from one malformed file.

Both surface through `Design.problems` rather than an exception: a partial design is still worth serving,
but a viewer that silently drops sheets shows something wrong that looks complete.

#### A binary is still welcome as a test ORACLE
Not shipping `kicad-cli` does not mean never running it. Generating a ground-truth netlist to check the
connectivity solver against is exactly what it is good for — a **development-time** oracle, not a runtime
dependency. The distinction is worth keeping: what the bridge needs to run is not what the tests need to
prove it right.

This is now real rather than aspirational: `bridge/tools/kicad-netlist-oracle.ts` shells out to
`kicad-cli sch export netlist` and scores the solver against it. Two practical notes. Ubuntu packages only
**`kicad-cli` 7**, which cannot open KiCad 10 files, so netlist scoring runs on the 7.x corpus — acceptable
because the connectivity rules are not version-specific, and the KiCad 10 corpus still gets the
position-based probe across all 115 sheets. And because the oracle cannot run in CI (KiCad is not
installed there, and the demos are separately licensed), the rules it established are re-stated as 11
tests on **hand-authored** fixtures, each verified to fail when its rule is deliberately broken.

#### Alternatives
- **`kicad-cli` at runtime** — rejected above: ~1.7 GB per bridge for data already in the file.
- **Render in the app from raw s-expressions** — rejected: every device re-parses multi-MB files, and the
  parser exists in Kotlin where it is hardest to test. Parsing once on the bridge is the same work, cached.
- **A web view with an existing JS viewer** — rejected: drags a browser stack into a native app and has no
  story for the e-ink profile.
- **Pinning the reader to one file-format version** — rejected, and vindicated: the reader is deliberately
  schema-less (nested lists, callers pick fields), which is why moving the target from KiCad 7 to 10 cost
  nothing. KiCad 10 pretty-prints differently — `(symbol` and `(lib_id …)` land on separate lines — and a
  regex-based reader would have broken silently on exactly that.

#### Decided with the owner

**1. 3D keeps per-component instances addressable.** Not one merged model. Each part stays a named node
tagged with its reference designator, so a tap ray-casts to a node, reads `R12`, and cross-probes to the
schematic and board like every other view.

The reason it could not be deferred to Phase 4 despite being Phase 4 work: **merging is lossy**. Build the
export around a merged mesh and adding tap-to-highlight later is not an increment — it is redoing the
export, the WRL/STEP→glTF conversion, and possibly the app's renderer choice. Instances can always be
*displayed* as though merged; the reverse is not true. Cost is a larger asset and a renderer that supports
node picking (Filament/SceneView does).

Put plainly: cross-probing is the whole premise of this feature, and 3D is the view people show other
people. A part that does nothing when tapped is exactly where the promise would visibly break.

**2. Parsing happens on demand, not eagerly.** Parse on first open, cache by content hash. The rejected
alternative was hooking the repo watcher so a changed `.kicad_*` file is parsed immediately — warm cache,
instant opens, but CPU spent on files nobody opens, and on a repo like rimba a branch switch or submodule
update could kick off a storm of parses. That watcher has already caused one refresh-loop incident
(ADR-036 era); giving it expensive work to trigger is not a trade worth making for a first version.

**Sibling prefetch is the permitted middle**: after parsing the sheet that was asked for, quietly warm the
*other sheets of that same project*. You only pay for projects someone actually opened, and flipping
between sheets — the common interaction — stays instant.

#### The board scene is a separate shape from the schematic scene

Phase 3 reads `.kicad_pcb`. The obvious move — reuse the schematic's `Primitive` union — is wrong, and the
reasons are structural rather than cosmetic:

- **A track carries width and a layer.** A schematic wire carries neither; it is a logical connection that
  happens to be drawn. On a board the width *is* the object.
- **An element belongs to several layers at once.** A via spans two, a pad names three
  (`F.Cu F.Mask F.Paste`). Nothing in a schematic has that shape, and modelling it as a single `layer`
  field makes a via disappear from the side you are looking at while its tracks stay — which reads as a
  broken connection rather than a reader bug.
- **A net is an integer here, not a name.** Tracks write `(net 1)` and the name lives in a table at the top
  of the file; pads write `(net 1 "GND")` inline. Skip the lookup and the geometry still draws, it just
  belongs to no net — so cross-probe silently selects nothing.

Forcing one union onto both would have made the schematic carry fields it has no use for and the board
carry a lie about layers. They share `Pt` and nothing else.

**Zones ship KiCad's own precomputed `filled_polygon`.** Re-deriving a fill means clearances, thermal
reliefs and island removal — a solver comparable to Phase 0's, and wrong in ways nobody could see by
looking. The file already contains the answer.

`zones=0` drops the pours, and it is worth being exact about why, because I first wrote that fills were
"the bulk of a board" and the measurement says otherwise: fill is **0–16% of a copper layer's bytes**
(`video` 0%, `vme-wren` F.Cu 2.5% / B.Cu 7.3%, `jetson` F.Cu 12.4% / B.Cu 16.3%). So the switch exists so
a reader chasing a track is not looking through a pour — a *legibility* control, not a bandwidth one. The
lever that actually moves bytes is per-layer fetching.

**Scale forces per-layer requests.** The largest board holds ~357,000 primitives, ≈27 MB of JSON flat,
against 41 KB for the largest schematic scene. But the mass is lopsided: fab, courtyard, adhesive and paste
layers hold **92%** of it, while copper, silkscreen and the board outline — what a person actually looks at
— are **7%**. So the wire format is *index first, then one layer at a time*, and the common case collapses
about 14× before any other trick.

**The truncation cap is by role, and the first version of it was wrong.** A flat 20,000-primitive cap was
justified from a single board, where `User.9` carried 286,621 elements of annotation and `F.Cu` sat at
12,581. Surveying the corpus showed `vme-wren`'s `F.Cu` at **20,887** — so the cap was silently shortening
*copper* by 4%, on the one layer the feature exists to show. That is precisely the viewer-that-lies failure
the cap was introduced to prevent, arriving through the cap itself.

The rule is now: **structural layers are the drawing, everything else is annotation on top of it.**
Structural (copper by name or KiCad `signal` kind, `Edge.Cuts`, silkscreen) gets a 100,000 backstop — 5×
the worst measured, kept only against a hostile file. Annotation keeps 20,000. Truncation is reported
either way, and the message says which kind of loss it was, because "some annotation is missing" and "the
drawing is incomplete" are not the same sentence.

Worth naming the mistake plainly: the original cap generalised from **one** board. A number that looked
like ample headroom was actually 60% of the real worst case, and only a survey showed it.

### ADR-039 — Transport security: the bridge terminates TLS, pinned by fingerprint at pairing · [design-choice]
**Decided in principle, not built — backlogged.** Recorded now because the reasoning is settled and the
current state is a stated assumption that no longer holds.

**The assumption that broke.** Every confidentiality claim in this project rests on a tunnel.
`docs/SECURITY.md` presents Tailscale Serve as "the hardened setup"; the app ships
`android:usesCleartextTraffic="true"` — globally, for *every* host, not merely local ones — with a comment
saying production reaches the bridge over Tailscale's auto-TLS. The bridge itself has **no TLS code at
all**: `Fastify({ bodyLimit, logger: false })`, no `https` option, nothing in the config schema. A VPN is
**not** a hard requirement for this project, so the common case is a bridge with no transport security of
any kind.

**What that exposes.** The device bearer token travels in a header on every request. ADR-035 made tokens
hashed at rest and individually revocable, which is worth nothing against someone on the same network:
capture one request and you hold that device's access until it is revoked. That access is repo write and
`git push`, driving Claude sessions, and — since `terminal.enabled` defaults to `true` (ADR-034) — a
**PTY shell on the host**. Everything else the bridge serves is in the clear alongside it: file contents,
diffs, chat, and 3D meshes.

**The decision: self-signed TLS on the bridge, pinned through the pairing flow.** Not a public CA, and
not plain trust-on-first-use.
- The bridge generates a certificate and key on first run, stored beside `tokens.json` with the same
  `0600` control-directory treatment.
- **Pairing already is an out-of-band channel** — a code read off one screen and typed into another. The
  certificate's SHA-256 fingerprint rides along it at no extra effort for the user, which turns TOFU into
  TOFU *with* out-of-band verification.
- The app pins that fingerprint per bridge, exactly as it already stores a token per bridge. `BridgeApi`
  builds its client with two timeouts and nothing else, so there is a clean seam for a custom
  `X509TrustManager` and hostname verifier.
- No CA, no public DNS, no certificate rotation chore — the properties that make a tunnel attractive,
  without requiring one.

**Why not the alternatives.** A public CA needs a resolvable name and renewals on a box that may be
offline. Plain TOFU accepts whatever answers first, which is the attack we are defending against.
Application-layer encryption over plaintext HTTP means designing a handshake, and rolling that is a worse
risk than the one it removes. Mandating a tunnel is a legitimate answer, but it must then be *enforced in
code* rather than assumed in prose — and the owner's position is that a tunnel is optional.

**Costs, stated up front.** A certificate-generation dependency in the bridge; trust-manager code in the
app; a pairing payload change; and a migration story for devices paired before this exists — they keep
working over plaintext or they re-pair, and that is a decision for whoever ships it. Compression
interacts with this too: gzip inside a TLS session with attacker-influenced request content is the
CRIME/BREACH shape, so response compression should be decided alongside TLS rather than before it.

**The obvious interim does not exist, and it is worth writing down why.** The tempting cheap fix —
replace the blanket `usesCleartextTraffic="true"` with a `network_security_config.xml` permitting
cleartext only to loopback and private ranges — cannot be built. A network security config is **static
XML compiled into the APK**, and it matches `<domain>` entries (hostnames and IP literals), not CIDR
ranges. The bridge address is **entered by the user at runtime** (`AppViewModel` constructs `BridgeApi`
from a stored `baseUrl`), so the shipped app cannot know what to allow. The only static choices are what
we have today — permit all cleartext — or forbid it outright, which breaks every plaintext bridge and is
therefore just ADR-039 with no migration path.

"Private ranges" would not have been the right set anyway: this project's own tailnet addresses sit in
`100.64.0.0/10` (shared address space, **not** RFC1918), and the LAN address is DHCP and expected to
change.

**What *is* implementable as an interim: say so in the UI.** The app knows the scheme and host at
runtime, which is exactly what the static config lacks. A connection to an `http://` host that is not
loopback is unencrypted, and the app can show that — on the bridge list, and at pairing time, when the
user is about to hand over a credential. It fixes nothing cryptographically and is not a substitute for
ADR-039; it stops the exposure being invisible, which is the part that currently makes it a trap.

