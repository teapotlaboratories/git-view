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
