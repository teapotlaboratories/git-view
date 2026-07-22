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
