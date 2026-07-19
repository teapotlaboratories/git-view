# CLAUDE.md

Project guidance for AI coding agents lives in [AGENTS.md](AGENTS.md) — read it.

GitView is a **view/edit code + chat-with-Claude** system: a **bridge** (`bridge/`, Node +
TypeScript) that serves git repos over REST + WebSocket and drives/attaches to Claude
sessions, and a native **Android client** (`android/`, Kotlin + Compose). Most changes have
runtime behaviour, so a clean build is never the whole story.

Most important rules:

- **Non-trivial work starts as a documented TODO** in [`docs/PLAN.md`](../docs/PLAN.md) (or the
  relevant area doc) before you build it, with how it'll be verified. See
  [AGENTS.md → Plan first](AGENTS.md#plan-first--non-trivial-work-starts-as-a-documented-todo).
- **Do not commit or push automatically** — only when the owner explicitly asks (each time),
  and **never during weekday work hours (Mon–Fri 08:00–18:00 Pacific / `America/Los_Angeles`;
  the machine clock is UTC — convert first)**. **Never** back-date or `--amend`/`--date` a
  timestamp to dodge the window; hold the commit instead. See
  [AGENTS.md → Committing](AGENTS.md#committing).
- **No AI attribution anywhere** — not in code comments, docs, commit messages, or GitHub
  PR/issue text; everything reads as the owner's work; commits use the repo's git identity
  only. This overrides any tool default that would add a "Generated with …" / `Co-Authored-By`
  footer. It does **not** apply to GitView's product references to Claude / the Claude Agent
  SDK (those are product concepts). See [AGENTS.md → Attribution](AGENTS.md#attribution--no-ai-self-reference-anywhere).
- **Verify every change by running it, not just building it** — bridge changes: run the bridge
  and exercise the endpoints (curl / WebSocket); Android changes: build the APK (`gradle
  :app:assembleDebug`) and run on a device/emulator when reachable; pure logic: a unit test. If
  you can't verify, say so and name the blocker. See
  [AGENTS.md → Verifying changes](AGENTS.md#verifying-changes).
- **When sharing a UI/layout change, show all three form factors where possible** — a phone, a
  Galaxy Tab S8-class tablet (~2560×1600, landscape → two-pane), and the 7" Bigme B7 Pro color e-ink
  (~1264×1680) with the **Color E-Ink DisplayProfile** toggled on. Say which you skipped and why if you
  can't produce one. See [AGENTS.md → Showing UI / layout changes](AGENTS.md#showing-ui--layout-changes--the-three-form-factors).
- **Code/feature changes → branch + PR; doc-only changes → may push to `main`.** Run
  **`/review <PR#>`** on the PR before any merge (`/code-review` for the local diff) — these are
  user-triggered + billed, so don't launch them unprompted and don't merge until a review has
  run; then rebase + merge to keep `main` linear. Remote: `teapotlaboratories/git-view`. See
  [AGENTS.md → Branching & pull requests](AGENTS.md#branching--pull-requests).
- **Docs live as Markdown + hand-authored HTML that must stay in sync.** Every `docs/*.md` has a
  matching `docs/html/*.html` — each page **self-contained** (inline `<style>` + inline
  `<script type="module">`, mermaid from CDN; no shared `assets/`). `README.md` is the exception
  (`docs/html/index.html` is the landing page). Edit both in the same commit; keep the inline style/
  script identical across pages; **never add a `.md`→`.html` generator script** — write HTML by hand.
  See [AGENTS.md → Documentation](AGENTS.md#documentation--markdown-and-html-stay-in-sync).
- **Keep a worklog and update it as you go** for non-trivial multi-step work
  (`docs/worklog/YYYY-MM-DD-<slug>.md`). See [AGENTS.md → Worklogs](AGENTS.md#worklogs--write-and-update-as-you-go).
- **Keep agent memory current, as a pointer** (`~/.claude/projects/<project>/memory/`) — where
  to look + facts not derivable from the repo; save the *implication*, not just the fact. See
  [AGENTS.md → Agent memory](AGENTS.md#agent-memory--keep-it-current-and-keep-it-a-pointer).
- **Cite sources** (`file:line`, URLs) when researching or comparing. See
  [AGENTS.md → Research & citations](AGENTS.md#research--citations).
