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
