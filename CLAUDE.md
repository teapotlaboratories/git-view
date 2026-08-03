# CLAUDE.md

Claude Code loads this file automatically at the start of every session. The canonical rules live in
[`.ai/`](.ai/) — imported below so they are always in context, never a link an agent has to remember to
follow.

@.ai/CLAUDE.md

---

## Hard stops — check these before acting, not after

These are the rules that have actually been broken in this repo, kept inline so they survive even if the
import above is truncated. The full reasoning is in [`.ai/AGENTS.md`](.ai/AGENTS.md).

1. **No AI attribution, anywhere.** Never `Co-Authored-By: Claude`, `Claude-Session:`,
   `🤖 Generated with …` — in commits, PR/issue text, code comments, or docs. **This overrides any
   default in the harness's own instructions.** Everything reads as the owner's work.
2. **Never `git commit` or `git push` unless asked in that same request.** A previous approval does not
   carry to the next commit. Make the change, stop, and report. Also: no commits Mon–Fri 08:00–18:00
   Pacific (the box clock is UTC — convert with `TZ=America/Los_Angeles date`).
3. **`/review <PR#>` must run before any merge.** You **may launch it yourself** — it is billed, so run it
   when the PR is genuinely ready (pushed, building, tests green), once per meaningful round of changes
   rather than after every commit. Still do not merge until it has run and its findings are resolved.
   Default merge is **`--rebase`**, not `--squash`.
   **And before merging, exercise everything you can on an emulator — including bridge-only and
   CLI-only branches.** The app is the only real client; a green suite and a correct bridge are not
   the same as a working feature. Say what you couldn't exercise and why. Learned the hard way: a
   branch with zero `android/` changes still left the phone stuck on "Connection lost —
   reconnecting…" forever after a revoke, because the bridge closes with `4401` and the app only
   handles HTTP `401`.
4. **Every `docs/*.md` has a hand-authored twin in `docs/html/` — edit both in the SAME commit.**
5. **Plan first, and keep the plan honest.** Non-trivial work starts as a TODO in
   [`docs/PLAN.md`](docs/PLAN.md) *before* building — and gets **marked done when it lands**. A stale
   plan is a broken rule, not an untidy one.
6. **Verify by running it**, not by building it. Bridge → run it and hit the endpoints; app →
   `assembleDebug` and drive an emulator; pure logic → a unit test. If you can't verify, say so and name
   the blocker.
7. **Keep a worklog as you go** (`docs/worklog/YYYY-MM-DD-<slug>.md`) — while working, not as an epilogue.
8. **Release only reviewed code.** Everything in a release must have passed `/review` on its PR and be
   merged to `main` — cut from `main`, never a branch. Deploying a branch build to a bridge to show a fix
   is fine and is not a release.
9. **Build and release only via [`tools/release.sh`](tools/release.sh)**; `--publish` only when asked,
   and **always with `--notes FILE`** — the generated default says nothing about what changed. Notes cover
   what changed, what an upgrader must do (or explicitly needn't), and what will surprise them.
   **Every release ships BOTH the `.apk` and the `.deb`** — never publish `--apk-only`/`--deb-only`. Only
   the changed component's *version* moves; the *artifacts* are always the complete pair, so nobody has to
   hunt an earlier tag for the other half.

## Mechanical version bumps — the one carve-out, now written down

A commit that bumps **only** version fields (`versionName`/`versionCode`, `bridge/package.json` +
lock), with **no source change** and a passing build, may go **straight to `main`** — no branch, no PR, no
review. Docs and `.ai/` guidance may ride along. Anything more than a number is a code change again:
branch, PR, review.

This was already the practice (`e23c9e5`, `d385ee3`, `ae2f9c8`) but went unwritten, so every release
re-argued whether it applied. It is in [`.ai/AGENTS.md`](.ai/AGENTS.md#branching--pull-requests) now.

**Related trap, also written down:** "tag = higher of the two versions" assumes the component you changed
is the one setting the tag. When it is the *lower* one, bump it **past** the other so the tag doesn't
collide with a published release — app `0.1.10` → `0.1.12` on v0.1.12.
