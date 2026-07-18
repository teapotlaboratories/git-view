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
- **Branching** — code → branch + PR; doc-only → `main` is fine; `/code-review` before any
  merge (agent can't launch it); rebase + merge. (No GitHub remote yet.)
- **Worklogs / memory / citations** — keep a running worklog for multi-step work; keep agent
  memory current as a pointer (save the implication, not just the fact); cite sources
  (`file:line`, URLs). See AGENTS.md.
