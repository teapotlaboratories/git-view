# GitView — Build Plan

This is the phased roadmap. Each phase is shippable on its own and adds one coherent slice of value. **Phases 0–2 are the MVP** (browse a repo + chat with Claude about it, on your LAN). Phases 3–6 add multi-connection, secure remote access, and hardening.

> Legend: 🟢 core / must-have · 🟡 important · ⚪ optional / later

---

## Phase 0 — Foundations & walking skeleton

**Goal:** From your phone on the same Wi-Fi, list repos and open a file as plain text.

- 🟢 Repo scaffold, docs, CI lint (this repository).
- 🟢 **Bridge:** Fastify server with `GET /api/health`, `GET /api/repos`, `GET /api/repos/:repo/tree`, `GET /api/repos/:repo/blob`.
  - Hardened git wrapper: `execFile("git", [...])` only, subcommand allowlist (`ls-tree`, `cat-file`, `rev-parse`, `for-each-ref`), path confinement to repo root.
  - Repo registry loaded from `config.yaml`.
- 🟢 **Android:** single-activity Compose app. A "Connection" screen (host + port), a repo list, a file-tree screen, and a plain-text file view.
- 🟢 **Transport:** plain HTTP on LAN; a static shared token in a header (real auth arrives in Phase 4).
- 🟡 Wire protocol frozen in [API.md](API.md) and shared as a typed contract.

**Done when:** phone → bridge → `git ls-tree` renders a browsable tree and a tapped file shows its contents.

---

## Phase 1 — VS Code–like read-only viewer

**Goal:** Reading code on the phone feels like VS Code (view-only).

- 🟢 **Syntax highlighting** for many languages. Primary: **Sora Editor** (`io.github.Rosemoe.sora-editor`) in read-only mode with TextMate grammars (the same grammars VS Code uses) or its tree-sitter path. Fallback: highlight.js/Shiki in a `WebView` for exotic languages.
- 🟢 **File-tree UX:** lazy/virtualized expandable tree, per-extension icons, breadcrumb path, collapse/expand, "reveal in tree" from search.
- 🟢 **Large files & long lines:** line virtualization, horizontal scroll, soft-wrap toggle, a size guard that streams/paginates very large blobs.
- 🟢 **Git surfaces (read-only):**
  - Branch/tag switcher (`for-each-ref`), commit **log** with pagination (`log`), commit detail (`show`).
  - **Diff viewer** — unified and side-by-side, intra-line highlighting — for working-tree, staged, and commit-to-commit (`diff`, `diff --cached`, `diff base..head`).
  - **Blame** overlay (`blame --porcelain`) → line → commit/author.
- 🟡 **Rich file types:** Markdown preview, image rendering, graceful binary handling ("N MB binary — download / hex peek").
- ⚪ Minimap, symbol outline (via tree-sitter), in-file find.

**Done when:** you can navigate branches, read highlighted code, and inspect a commit's diff comfortably on a phone.

---

## Phase 2 — Claude chat (local Agent SDK session)  ← completes the MVP

**Goal:** Switch to a chat tab and talk to Claude operating on the repo you're viewing.

- 🟢 **Bridge — Claude session manager** using the **Claude Agent SDK (TypeScript)**:
  - `query()` streaming with `includePartialMessages: true`, `cwd` = the repo path.
  - **Read-only safety profile** by default: `permissionMode` that denies-by-default, `allowedTools: ["Read","Glob","Grep"]`, `disallowedTools` for write/exec tools, plus a **`PreToolUse` deny hook** as the hard backstop. (See [SECURITY.md](SECURITY.md).)
- 🟢 **Attach to existing sessions** (your explicit requirement): discover sessions for a repo from `~/.claude/projects/<encoded-cwd>/*.jsonl`; list them; resume the most recent (`resume: <id>` / `--continue`) instead of always starting fresh.
- 🟢 **Live channel:** one **WebSocket** carrying: `prompt` up; streamed assistant text + `tool_use`/`tool_result` events down; `interrupt` up.
- 🟢 **Android:** a Chat pane and a Browse/Chat switch (tabs on phone, split on tablet). Render assistant markdown; show tool-use events as collapsible chips ("Read src/App.kt", "Grep 'TODO'"); a stop button.
- 🟡 Deep links: tapping a file path in a Claude message opens it in the Browse tab, and "Ask Claude about this file/selection" from Browse pre-fills the chat.

**Done when:** you can highlight-read code and, in the same app, ask Claude questions it answers by reading that repo — attaching to a session already running there if one exists.

---

## Phase 3 — Multiple repos, sessions, and machines

**Goal:** Your three "multiple sessions" needs: many repos per machine, many machines, saved connections.

- 🟢 **Multiple repos per bridge:** repo registry already namespaces every route as `/api/repos/:repo/…`. Add a repo picker in-app.
- 🟢 **Multiple machines:** app-side **connection store** — a saved list of bridges `{label, endpoint, token, lastRepo, lastSessionId}`. A connection switcher, like a workspace picker. Secrets in the Android **Keystore / EncryptedSharedPreferences**; non-secret metadata in a local Room DB.
- 🟢 **Multiple concurrent Claude sessions:** the WS multiplexes by `{connectionId, repoId, sessionId}`; a session list + "new chat" per repo; per-session budget/turn caps.
- 🟡 **Repo-change push:** an fs watcher on `.git/` + working tree emits `repo-changed` events over the WS so the phone invalidates trees/diffs live.
- ⚪ On-LAN auto-discovery via mDNS/DNS-SD (`_gitview._tcp`) to pre-fill connections.

**Done when:** you can hop between home box, work laptop, and a cloud VM, each with several repos and several live chats, from a saved list.

---

## Phase 4 — Secure remote access (Tailscale) + pairing

**Goal:** Use it from anywhere, safely, with nothing exposed publicly.

- 🟢 **Tailscale** as the transport. Bridge sits behind **Tailscale Serve** (auto-TLS inside the tailnet, zero public exposure). Connections use the machine's **MagicDNS** name.
- 🟢 **Pairing flow:** bridge shows a QR / short pairing code → phone exchanges it for a long-lived **bearer token** stored in the Keystore. Every REST/WS request carries the token.
- 🟡 **Defense in depth:** on the Serve path, also verify the Tailscale identity header (`tailscale whois`). Optional **mTLS** client cert pinned in the app.
- ⚪ Cloudflare Tunnel / Tailscale Funnel fallback for cases where the phone can't join the tailnet (adds its own auth; documented, not default).

**Done when:** the same experience works over cellular with no port-forwarding and no public endpoint.

---

## Phase 5 — Remote-control attach mode  *(verify feasibility against current docs)*

**Goal:** Your alternative path — connect to an official `claude remote-control`-enabled session.

- 🟡 Attach to a session started with `claude remote-control` / `/remote-control`.
- ⚠️ **Open question to verify:** the *programmatic* third-party attach surface for remote-control isn't fully public. Two fallbacks if a clean API isn't available:
  1. Prefer the **local Agent-SDK provider** (Phase 2) for full control — it already gives "attach to the session on this directory."
  2. For genuine remote-control sessions, embed **`claude.ai/code`** in an authenticated `WebView` as an escape hatch.
- 🟡 Document constraints (OAuth/subscription vs API key, server-side transcript residency, ZDR incompatibility).

**Done when:** you can either resume a local session or, where supported, hand off to a remote-control session — with the limits documented.

---

## Phase 6 — Edit mode, hardening, and polish

- 🟡 **Optional edit mode:** a per-session toggle that raises Claude's permissions, runs it in an isolated **git worktree**, and surfaces the SDK's permission requests as **mobile approve/deny prompts**. Off by default — GitView is view-first.
- 🟢 **Resilience:** monotonic event ids + a server ring buffer for replay; exponential backoff reconnection; resume the Claude session by id rather than restarting.
- 🟢 **Ops:** run the bridge as a service (systemd / launchd); structured audit log of every tool call; per-session cost/turn limits; idle-session reaping.
- 🟡 Offline caching of recently viewed trees/files (Room).
- 🟢 Tests: git-wrapper arg-injection tests, protocol contract tests, a Compose UI smoke test; Android release build + signing.

---

## MVP cut line

```
Phase 0  ─┐
Phase 1  ─┤  ► MVP: browse a repo like VS Code + chat with Claude about it, over LAN
Phase 2  ─┘
Phase 3     ► daily-driver: multi-repo / multi-machine / saved connections
Phase 4     ► anywhere: Tailscale + pairing
Phase 5/6   ► remote-control attach, edit mode, hardening
```

## Cross-cutting tracks (run alongside)

- **Protocol-first:** keep [API.md](API.md) authoritative; generate/mirror types on both ends.
- **Security-first:** the browse path is structurally read-only; the Claude session is separately sandboxed. Never merge the two trust domains. See [SECURITY.md](SECURITY.md).
- **Verify SDK/CLI specifics:** pin the Claude Agent SDK version and confirm exact option/flag names against the current docs before relying on them (some were synthesized during design — noted inline in the code).
