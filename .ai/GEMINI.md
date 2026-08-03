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
- **Release only reviewed code** — everything in a release must have passed `/review` on its PR and be
  merged to `main`; cut from `main`, never a branch. Deploying a branch build to a bridge is not a release.
- **Every release ships BOTH the `.apk` and the `.deb`** — never `--apk-only`/`--deb-only` when
  publishing. Versions track what changed; artifacts are always the complete pair.
- **Release notes are mandatory** — always pass `--notes FILE` to `tools/release.sh`; the generated
  default only lists artifacts + verify steps. Say what changed, what an upgrader must do (or needn't),
  and what will surprise them. `--clobber` updates the notes on an existing release.
- **Build & release via `tools/release.sh`** — always build the `.deb` + signed `.apk` (and cut
  releases) with the script, never hand-run `gradlew assembleRelease` / the `.deb` `build.sh` /
  `gh release create`. Building locally is fine; `--publish` only when the owner explicitly asks.
- **Versioning** — bump only the component(s) that changed. App (`build.gradle.kts`) and bridge
  (`package.json`/lock) version independently and may diverge; don't bump an unchanged
  component. When they differ the release tag is `v<higher of the two>`. See AGENTS.md.
  When the changed component is the **lower** one, bump it past the other so the tag doesn't
  collide with a published release (app 0.1.10 → 0.1.12).
- **Branching** — code → branch + PR; doc-only → `main` is fine; **`/review <PR#>`** on the PR
  before any merge — the only review command here. You may launch it yourself; it is billed, so
  review once per meaningful round of changes, and don't merge until one has run. Rebase + merge.
  Remote: `teapotlaboratories/git-view`.
- **Mechanical version bumps may go straight to `main`** (no branch/PR/review) when the commit touches
  only version fields plus docs, has no source change, and still builds.
- **Before merging, exercise everything you can on an emulator — including bridge-only and
  CLI-only branches.** The app is the only real client, so a correct bridge is not a working
  feature. Name what you couldn't exercise, and why. A branch with zero `android/` changes
  already left the phone stuck on "reconnecting…" after a revoke: the bridge closes with
  `4401`, the app handles only HTTP `401`.
- **Docs = Markdown + hand-authored HTML in sync** — every `docs/*.md` has a matching
  `docs/html/*.html`, each self-contained (inline `<style>` + `<script>`, mermaid from CDN; no shared
  `assets/`; `README.md` excepted). Edit both in one commit; keep the inline style/script identical
  across pages; never add a `.md`→`.html` generator script.
- **Worklogs / memory / citations** — keep a running worklog for multi-step work; keep agent
  memory current as a pointer (save the implication, not just the fact); cite sources
  (`file:line`, URLs). See AGENTS.md.
