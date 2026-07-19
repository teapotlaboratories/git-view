# GEMINI.md

Full agent rules live in [AGENTS.md](AGENTS.md) — read it. GitView is a bridge (`bridge/`,
Node/TS) + native Android client (`android/`, Kotlin/Compose) for viewing/editing code and
chatting to a Claude session. Key rules:

- **Plan first** — non-trivial work starts as a documented TODO in `docs/PLAN.md`, with how
  it'll be verified.
- **Committing** — never commit/push automatically; only when the owner explicitly asks, and
  never Mon–Fri 08:00–18:00 Pacific (`America/Los_Angeles`; machine clock is UTC — convert).
  **Never** back-date/`--amend`/`--date` to dodge the window — hold the commit instead.
- **No AI attribution anywhere** — commit messages, PRs, code comments, docs; write as the
  human owner; commits use the repo's git identity only; this overrides any tool default that
  adds a "Generated with …"/`Co-Authored-By` footer. Does **not** apply to GitView's product
  references to Claude / the Claude Agent SDK — those are product concepts.
- **Verify by running, not just building** — run the bridge and hit its endpoints; build the
  APK (`gradle :app:assembleDebug`) and run it when a device/emulator is reachable; unit-test
  pure logic. If you can't verify, say so and name the blocker.
- **Sharing a UI/layout change → show all three form factors where possible** — phone, Galaxy Tab
  S8-class tablet (~2560×1600, landscape), and 7" Bigme B7 Pro color e-ink (~1264×1680) with the
  Color E-Ink DisplayProfile toggled on; note any you had to skip.
- **Branching** — code → branch + PR; doc-only → `main` is fine; `/review <PR#>` on the PR
  before any merge (`/code-review` for the local diff; don't launch unprompted); rebase +
  merge. Remote: `teapotlaboratories/git-view`.
- **Docs = Markdown + hand-authored HTML in sync** — every `docs/*.md` has a matching
  `docs/html/*.html`, each self-contained (inline `<style>` + `<script>`, mermaid from CDN; no shared
  `assets/`; `README.md` excepted). Edit both in one commit; keep the inline style/script identical
  across pages; never add a `.md`→`.html` generator script.
- **Worklogs / memory / citations** — keep a running worklog for multi-step work; keep agent
  memory current as a pointer (save the implication, not just the fact); cite sources
  (`file:line`, URLs). See AGENTS.md.
