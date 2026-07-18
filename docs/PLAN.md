# GitView — Build Plan

This is the phased roadmap. Each phase is shippable on its own and adds one coherent slice of value. **Phases 0–3 are the MVP** (browse + edit a repo, and chat with a full-tool Claude about it, over your LAN). Phases 4–7 add multi-connection, secure remote access, and hardening.

> Legend: 🟢 core / must-have · 🟡 important · ⚪ optional / later

---

## Phase 0 — Foundations & walking skeleton

**Goal:** From your phone on the same Wi-Fi, list repos and open a file.

- 🟢 Repo scaffold, docs, CI lint (this repository).
- 🟢 **Bridge:** Fastify server with `GET /api/health`, `GET /api/repos`, `GET /api/repos/:repo/tree`, `GET /api/repos/:repo/blob`, `GET /api/repos/:repo/working`.
  - Hardened git wrapper (read): `execFile("git", [...])`, subcommand allowlist, path confinement (`util/paths.ts`).
- 🟢 **Android:** single-activity Compose app. A "Connection" screen, a repo list, a file-tree screen, a file view.
- 🟢 **Transport:** plain HTTP on LAN; a static `BRIDGE_TOKEN` header (real auth arrives in Phase 5).
- 🟡 Wire protocol frozen in [API.md](API.md).

**Done when:** phone → bridge → renders a browsable tree and a tapped file's contents.

---

## Phase 1 — VS Code–like viewer (read)

**Goal:** Reading code on the phone feels like VS Code.

- 🟢 **Syntax highlighting** for many languages via **Sora Editor** (`io.github.Rosemoe.sora-editor`) with TextMate grammars (VS Code's grammars) / tree-sitter. `WebView` highlighter fallback for exotic languages.
- 🟢 **File-tree UX:** lazy/virtualized expandable tree, per-extension icons, breadcrumb, collapse/expand.
- 🟢 **Large files & long lines:** line virtualization, horizontal scroll, soft-wrap toggle, size guard.
- 🟢 **Git surfaces:** branch/tag switcher, commit **log** + detail (`show`), **diff viewer** (unified + side-by-side, intra-line) for working-tree/staged/commit, **blame** overlay.
- 🟡 Markdown preview, image rendering, graceful binary handling.
- 🟢 **Color e-ink alternative view (base):** a `DisplayProfile` (Standard vs Color E-Ink) provided via `CompositionLocal` — high-contrast near-mono Material theme, the `eink-mono` Sora/TextMate scheme (token types via weight/italic/underline, not pastel hues), animations/ripple/overscroll off, snap/pagination, device auto-detect + manual override. See [EINK.md](EINK.md).

**Done when:** you can navigate branches, read highlighted code (in either display profile), and inspect diffs comfortably.

---

## Phase 2 — Editing (the write path)  🆕

**Goal:** Actually edit, save, and commit from the app — a real editor, not a viewer.

- 🟢 **Bridge write API** (working tree, direct — see [API.md](API.md)):
  - `PUT /blob` save · `POST /file` create · `DELETE /file` · `POST /rename`.
  - `POST /stage` · `POST /commit` · `POST /discard` (git write ops).
  - All confined to the repo root (`util/paths.ts`); `execFile`/`fs` only, no shell.
- 🟢 **Android editor:** Sora Editor in **editable** mode — edit buffer, dirty state, **save** (⌘S), undo/redo, create/rename/delete in the tree.
- 🟢 **Editing model:** the editor works on the **working tree** (current checkout). Historical refs stay read-only (you can't write into a past commit).
- 🟢 **Git actions in-app:** view working-tree diff, stage/unstage, commit with a message, discard changes.
- 🟡 Conflict/staleness handling: detect if a file changed on disk (e.g. by Claude) since you opened it; offer reload/merge.
- 🟡 Auto-save option; commit templates.

**Done when:** you can edit a file, save it to the working tree, see the diff, and commit — all from the phone.

---

## Phase 3 — Claude chat with full tools  ← completes the MVP

**Goal:** Switch to a chat tab and let Claude read *and modify* the repo you're editing.

- 🟢 **Bridge — Claude session manager** using the **Claude Agent SDK (TypeScript)**:
  - `query()` streaming (`includePartialMessages: true`), `cwd` = the repo.
  - **Full-tool profile, direct, no prompts** (`permissionMode: "bypassPermissions"` — verify name): `Read`/`Write`/`Edit`/`Bash` run without asking. (`claude.profile: read-only` per repo re-locks; see [SECURITY.md](SECURITY.md).)
- 🟢 **Attach to existing sessions:** discover sessions for a repo from `~/.claude/projects/<encoded-cwd>/*.jsonl`; list them; resume the most recent (`resume: <id>`) instead of always starting fresh.
- 🟢 **Live channel:** one **WebSocket** — `prompt` up; streamed assistant text + `tool_use`/`tool_result` (incl. writes) down; `interrupt` up.
- 🟢 **Android:** Chat pane + a Browse/Chat switch (tabs on phone, split on tablet). Render assistant markdown; show tool-use events (incl. edits Claude makes) as chips; a stop button.
- 🟢 **Reflect Claude's writes in the editor:** when Claude edits a file, the app refreshes the tree/open buffer (fed by the `repo_changed` events from Phase 4's watcher, or a poll until then).
- 🟢 **E-ink-friendly streaming:** honor `profile.streamBatchIntervalMs` — buffer tokens and flush per line (~300 ms on e-ink) instead of per token; render plaintext while streaming and apply markdown/highlighting on completion. See [EINK.md](EINK.md) §7.
- 🟡 "Ask Claude about this file/selection" from the editor; tap a path in a Claude message to open it.

**Done when:** you can edit code yourself *and* have Claude edit/run it, in one app, over your LAN.

---

## Phase 4 — Multiple repos, sessions, and machines

**Goal:** Many repos per machine, many machines, saved connections.

- 🟢 **Multiple repos per bridge:** already namespaced `/api/repos/:repo/…`; add an in-app repo picker.
- 🟢 **Multiple machines:** app-side **connection store** — saved bridges `{label, endpoint, token, lastRepo, lastSessionId}`. A connection switcher. Secrets in the Android **Keystore**; metadata in Room.
- 🟢 **Multiple concurrent Claude sessions:** WS multiplexes by `{connectionId, repoId, sessionId}`; a session list + "new chat" per repo; per-session budget/turn caps.
- 🟢 **Repo-change push:** an fs watcher on `.git/` + working tree emits `repo_changed` so the phone live-refreshes trees/diffs/open buffers (this is how the app stays in sync with Claude's edits and its own).
- ⚪ On-LAN auto-discovery via mDNS/DNS-SD (`_gitview._tcp`).

**Done when:** you hop between machines, each with several repos and live chats, from a saved list.

---

## Phase 5 — Secure remote access (Tailscale) + pairing

**Goal:** Use it from anywhere, safely — and this matters *more* now that the bridge can write and run code.

- 🟢 **Tailscale** transport; bridge behind **Tailscale Serve** (auto-TLS, **zero public exposure**). Connections use the machine's **MagicDNS** name.
- 🟢 **Pairing flow:** bridge shows a QR / short code → phone exchanges it for a long-lived **bearer token** in the Keystore; every REST/WS request carries it; revocable server-side.
- 🟡 Defense in depth: verify the Tailscale identity header on the Serve path; optional pinned **mTLS**.
- ⛔ **Do not** put a read-write bridge on a public URL (Funnel/Cloudflare/ngrok) without strong extra auth — a leaked token there = machine compromise. See [SECURITY.md](SECURITY.md).

**Done when:** the full editor + agent works over cellular with no port-forwarding and no public endpoint.

---

## Phase 6 — Remote-control attach mode  *(verify feasibility against current docs)*

**Goal:** The alternative Claude path — attach to an official `claude remote-control`-enabled session.

- 🟡 Attach to a session started with `claude remote-control` / `/remote-control`.
- ⚠️ The programmatic third-party attach surface isn't fully public; fallbacks: prefer the **local Agent-SDK provider** (Phase 3), or embed **`claude.ai/code`** in an authenticated `WebView`.
- 🟡 Document constraints (OAuth/subscription vs API key, server-side transcript residency).

---

## Phase 7 — Hardening, resilience, and optional safety dials

- 🟢 **Resilience:** monotonic event ids + a server ring buffer for replay; exponential-backoff reconnection; resume the Claude session by id (no restart).
- 🟢 **Ops:** run the bridge as a service (systemd/launchd); **audit log** of every write and every tool call (your record of what changed, since there are no prompts); per-session cost/turn limits; idle-session reaping; run as an unprivileged user.
- ⚪ **Optional safety dials** (off by default, per your choice — flip on if you want them):
  - Per-repo `read-only` profile (deny-by-default mode + `allowedTools:[Read,Glob,Grep]` + `PreToolUse` hook).
  - Approve-each-write prompts on the phone.
  - Isolated git worktree/branch for agent edits, merged deliberately.
  - OS sandbox/container with limited network egress.
- 🟢 Tests: path-confinement + write-op tests, protocol contract tests, a Compose UI smoke test; Android release build + signing.

---

## Phase 8 — Color e-ink: device refresh integration & tuning

**Goal:** Make the e-ink profile *great* on real hardware, beyond the in-app theme from Phase 1.

- 🟢 **Onyx EPD refresh control:** `EInkRefreshController` (reflection-guarded, no SDK hard-link) — REGAL default waveform for editing, forced **GC full-flash** on file/page switch, modal close, and stream completion, plus a clean-flash every N partials. No-ops off-Boox.
- 🟡 **Qualcomm-generation path:** the reflection/waveform route + `preventSystemRefresh` lifecycle hooks for Snapdragon Boox (Note Air5 C, Tab X C); KOReader's EPD controller as reference.
- 🟡 **Per-device QA:** test on Boox Note Air5 C / Tab X C (and a Bigme); tune batch interval, clean-flash cadence, and the mono palette on-panel.
- 🟡 **Settings:** "smooth vs clean" streaming toggle, monochrome-only toggle, manual "refresh screen" control, and the persisted display-profile override.
- ⚠️ Verify Onyx `UpdateMode`/`EpdController` names, Compose `Indication`/overscroll APIs, and Sora theme APIs against pinned versions — see [EINK.md](EINK.md) §8.

**Done when:** on a color Boox, reading/editing/chatting are crisp with controlled ghosting and no flicker storms.

---

## MVP cut line

```
Phase 0  ─┐
Phase 1  ─┤  ► MVP: browse + edit a repo like VS Code, and chat with a full-tool Claude, over LAN
Phase 2  ─┤
Phase 3  ─┘
Phase 4     ► daily-driver: multi-repo / multi-machine / saved connections + live sync
Phase 5     ► anywhere: Tailscale + pairing (the security boundary for a read-write bridge)
Phase 6/7   ► remote-control attach, hardening, optional safety dials
Phase 8     ► color e-ink: on-device refresh integration & tuning
```

> The **color e-ink alternative view** spans phases: its in-app base (theme, mono highlighting, no-animation, pagination, batched streaming) rides along in Phases 1 & 3; the hardware refresh integration is Phase 8. See [EINK.md](EINK.md).

## Cross-cutting tracks (run alongside)

- **Protocol-first:** keep [API.md](API.md) authoritative; mirror types on both ends.
- **Confine + authenticate:** with read/write + no prompts, the security model is path confinement + auth + a private (Tailscale) network — not a structural read-only guarantee. See [SECURITY.md](SECURITY.md).
- **Verify SDK/CLI specifics:** pin the Claude Agent SDK version and confirm the exact option/permission-mode names before relying on them (some were synthesized during design — noted inline in the code).
