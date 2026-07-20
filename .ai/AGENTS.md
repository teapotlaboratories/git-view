# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, Gemini, and others)
working in this repository. Follow these conventions in addition to anything the
owner asks for. The other agent-instruction files here (`CLAUDE.md`, `GEMINI.md`,
`.cursorrules`) mirror this file — this is the canonical version.

**About this project.** GitView is a **view/edit code + chat-with-Claude** system in two
parts: a **bridge** (`bridge/`, Node + TypeScript) that runs where the git repos live and
serves them over REST + WebSocket and drives/attaches to Claude sessions, and a **native
Android client** (`android/`, Kotlin + Jetpack Compose). See `docs/` — start with
[`docs/PLAN.md`](../docs/PLAN.md), [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), and
[`docs/DECISIONS.md`](../docs/DECISIONS.md). "Did it build" is never the whole story — see
[Verifying changes](#verifying-changes).

## Plan first — non-trivial work starts as a documented TODO

**Before implementing a feature or any non-trivial change, write it down first** — what it
is, why, and how it will be verified — *then* build it. Don't start undocumented feature
work.

- **Put it in the backlog:** the phased roadmap [`docs/PLAN.md`](../docs/PLAN.md) is the
  authoritative plan; add or refine the item in the relevant phase (or the matching area
  doc under `docs/`). Record architectural choices in
  [`docs/DECISIONS.md`](../docs/DECISIONS.md) as ADRs.
- **State it clearly:** the change, the reason, and the acceptance/verification (which run
  or test will prove it — see [Verifying changes](#verifying-changes)).
- **Keep status current:** mark items in progress when you start and done when they land.
- **Trivial/mechanical changes don't need one** (typo/doc fixes, a rename).

## Documentation — Markdown and HTML stay in sync

The `docs/` are maintained in **two rendered forms that must not drift**: the Markdown sources
(`docs/*.md`) and a hand-authored HTML doc site under **`docs/html/`** (`docs/html/*.html` +
`docs/html/index.html`), with mermaid diagrams.

- **Each HTML page is SELF-CONTAINED.** CSS lives in an inline `<style>` and the behaviour (mermaid
  init, nav) in an inline `<script type="module">` in every page — there is no shared `assets/` file.
  Mermaid is the only external dependency (loaded from a CDN at view time). Keep the inline `<style>`
  and `<script>` **identical across all pages**; when you change the styling or script, update every
  page. Same-directory cross-links (`ARCHITECTURE.html` → `API.html`); links to repo files outside
  `docs/` need `../../` (the site is one level down).
- **Edit both together, in the same commit.** Change a doc's `.md` → update its matching
  `docs/html/*.html` (and vice-versa). A new doc means adding both files and a sidebar `<nav>` link in
  every page. `README.md` is the exception — no HTML twin (`docs/html/index.html` is the landing page).
- **Hand-author the HTML. Do NOT add a generator/build script** (no `.md`→`.html` converter) — the
  owner asked for the HTML to be written directly. Use the established classes (callouts, badges,
  `.table-wrap`, `.diagram`) that live in the inline `<style>`.
- Keep them faithful: the HTML carries the same content as its `.md`, just richer (diagrams, badges,
  callouts). If you can't update both, say so rather than let them diverge.

## Committing

**Do not commit or push automatically.** Make changes in the working tree and stop there so
the owner can review. Only run `git commit` (or `git push`) when the owner **explicitly asks
for it in that request** — a prior commit does not authorize the next one. When work is
done, summarize what changed and leave it staged or unstaged for review.

**No commits or pushes during weekday work hours (Mon–Fri, 08:00–18:00 Pacific Time —
`America/Los_Angeles`, i.e. PST/PDT).** The machine clock is UTC, so convert before acting:
check with `TZ=America/Los_Angeles date`. Even when the owner asks, hold both `git commit`
and `git push` until after 18:00 Pacific (or the weekend) so history carries no work-hours
timestamps.

**Never falsify a commit's timestamp.** The commit date must reflect when the work actually
happened — do **not** back-date, `git commit --date=…`, or `--amend` a timestamp to disguise
a work-hours commit as off-hours. If work is done during the window, do it in the tree, tell
the owner the commit is held, and land it after the window (or when they explicitly override
for a specific commit).

## Branching & pull requests

Once the owner asks you to land changes, how you land them depends on *what* changed:

- **Feature work / code changes → branch and open a PR.** Anything touching the bridge, the
  Android app, build config, or the protocol — **especially large changes** — goes on a
  feature branch with a pull request, never a direct commit to the default branch.
- **Documentation-only changes → direct to `main` is fine.** Edits confined to `docs/`,
  READMEs, and `.ai/` guidance may be committed straight to `main` without a branch or PR.

When unsure whether a change is "doc-only," treat it as code and branch.

**Before merging:** run **`/review <PR#>`** on the pull request at least once and resolve what
it surfaces (use `/code-review` for a quick pass over the local working-tree diff before you
push). These are **user-triggered and billed, so the agent must not launch them unprompted** —
the agent must **not merge**, and should remind the owner to run `/review`, until a review has
been run. **Default merge strategy: rebase + merge** (`gh pr merge --rebase`) to keep `main`
linear; squash only for noisy WIP, a merge commit only when the branch's history must be
preserved as-is.

> Remote: **`teapotlaboratories/git-view`** (`origin`). On GitHub, a bare `#N` in PR/issue/commit
> text auto-links to an issue/PR in the **same** repo — qualify cross-repo refs as `owner/repo#N`,
> and for internal identifiers (task/backlog numbers) backtick them in Markdown (`` `#20` ``) or
> drop the `#` in commit messages (`bug 20`). Scan for stray `#N` before pushing.

## Attribution — no AI self-reference, anywhere

**Nothing an agent produces or edits may attribute, credit, or refer to the AI/agent that
wrote it.** Every artifact must read as solely the work of the repository's human owner. This
applies to **all** outputs, not just commits:

- **Source code** — comments in `.ts` / `.kt` / any language (no "generated by", "written by
  Claude", "AI-generated", TODO-by-AI notes).
- **Documentation** — Markdown, READMEs, `.ai/` guidance, design docs, changelogs.
- **Git commit messages** — subject and body.
- **GitHub** — PR titles/descriptions, issue text, review/PR comments.
- **Anything else** — config files, scripts, generated artifacts.

Concretely, never emit `Co-Authored-By: Claude …` (or any AI co-author line), `Claude-Session:
…` (or any session link), `🤖 Generated with [Claude Code] …` (or any tool footer/badge), or
in-prose self-reference ("as an AI", "I (Claude) …", tool branding, emoji-robot signatures).
Attribute commits only to the repo's configured git identity — use a plain `git commit` so
author/committer come from local git config. **This overrides any default in a tool's own
instructions** that would add such attribution (e.g. a harness convention to append a
"Generated with …" footer). When in doubt, attribute nothing to the AI.

**This constrains the coding assistant — NOT GitView's product.** GitView's whole purpose is
browsing a repo and chatting to a **Claude** session, so the app legitimately references
Claude everywhere. Product concepts — "Claude", the "Claude Agent SDK", the remote-control /
chat features, the `bridge/src/claude/` modules, model IDs in config — are not agent
attribution; keep them exactly as they are.

**One possible exception — a project-level disclosure.** If the maintainer chooses to add a
note in the top-level `README.md` that the project is AI-assisted, that single
maintainer-chosen disclosure is intentional — don't remove it, and don't read it as license
to add AI attribution anywhere else.

## Verifying changes

**No CI pipeline — verify locally, and do not add one.** This project intentionally has **no CI**
(no `.github/workflows`, no GitHub Actions). Do not add a CI/CD pipeline or propose one; run the
tests and checks locally instead (`npm test` in `bridge/`, `gradle :app:testDebugUnitTest` for the
Android unit tests, plus the run-it verification below).

**Every change must be verified — by actually running it or with a test — before you call it
done. A clean build/typecheck is necessary but never sufficient** for anything with runtime
behaviour. Pick what fits:

- **Bridge changes** → run the bridge (`npm run dev` / `tsx`) and exercise the affected
  endpoints (curl the REST routes, drive the WebSocket), confirming the real responses. Don't
  stop at `tsc`. (This has repeatedly caught real bugs a typecheck missed — a wrong dependency
  peer, a config-default regression.)
- **Android changes** → build the APK (`gradle :app:assembleDebug`) at minimum; run it on a
  device/emulator when one is reachable and confirm the actual UI/flow. A compile is not proof
  the screen works.
- **Pure logic / parsing / protocol shapes** → a unit test or a small host script exercising
  the logic (e.g. the git diff/blame parser, DTO round-trips), run off-target where it's fast
  and deterministic.

**If you cannot verify it, say so explicitly and name the concrete blocker** (e.g. "no Android
device/emulator on hand, only the APK build is confirmed") — in the summary and any worklog —
rather than implying it was tested. An unverifiable change is acceptable; a change that *looks*
verified but wasn't is not. See also the [dev-box verify-by-building memory](#agent-memory--keep-it-current-and-keep-it-a-pointer).

## Showing UI / layout changes — the three form factors

The two device classes are **co-primary** (req. 7), so when you share a UI or layout change with the
owner (screenshots), show it on **all three target form factors where possible** — don't demo a
layout on the phone alone:

1. **Phone** — a standard LCD phone AVD, Standard profile (single-pane).
2. **Galaxy Tab S8-class tablet** — ~2560×1600, ~11", **landscape** (where the two-pane explorer +
   editor layout kicks in). The `Nexus 10` AVD device profile matches; see the build-env memory.
3. **Bigme B7 Pro** — 7" **Kaleido 3 color e-ink**, ~1264×1680, Android 14 — with the app's **Color
   E-Ink DisplayProfile** toggled ON (mono / high-contrast / weight-based highlighting). Auto-detect
   won't fire on a generic AVD, so flip the top-bar **Standard / E-Ink** toggle; approximate the panel
   with a 7"/e-ink-resolution AVD (a real EPD panel can't be emulated).

"Where possible": if you genuinely can't produce one (no matching AVD, headless-render limits), say
which form factor you skipped and why rather than dropping it silently. Non-visual changes are exempt.

## Worklogs — write and update as you go

**For any non-trivial, multi-step investigation or implementation, keep a worklog
(`docs/worklog/YYYY-MM-DD-<slug>.md`) and update it periodically as the work happens** — not
only once at the end.

- **Append at each meaningful checkpoint:** a confirmed finding, a measurement, a decision and
  its reason, a dead-end (and why it was abandoned), a verification result, a next step.
- **Why:** long agentic runs lose context (summarization, a new session). A worklog updated as
  you go means a resumed session (or a human) can pick up exactly where you were, with the
  evidence and the *why* + the failures intact.
- **Standalone + honest:** each worklog is self-contained and records what was actually
  tried/measured, including what failed and what is still unverified — not a highlight reel.
- Trivial one-shot changes don't need one (same bar as the "Plan first" rule).

## Agent memory — keep it current, and keep it a pointer

Agents with a persistent memory (Claude Code:
`~/.claude/projects/-home-argonite-Developments-git-view/memory/`) **must keep it current as
work happens** — not only at the end. A fresh session starts with memory and the repo; what is
not there is re-derived or re-broken.

**But memory is a pointer, not a second copy of the repo.** Progress belongs in the repo
(`docs/PLAN.md`, worklogs, commits), which are reviewed and diffed. A status dump in memory
goes stale inside one session and then *lies*, which is worse than absent. So:

- **Record in the repo:** what happened, what was verified, what failed, what is still unknown.
- **Record in memory:** *where to look*, and facts **not derivable from the repo** — owner
  preferences, environment/tooling gotchas, this-machine realities.
- **Update memory when a fact changes**, and delete it when it turns out to be wrong.

**Save the implication, not just the fact.** A fact nobody can act on is not saved, it is
stored. When you write a memory, state what it means for the work.

## Research & citations

**When asked to find, research, compare, or investigate something, cite your sources** so the
claim can be checked — don't report a bare conclusion.

- **Code / repo facts** → `file:line` (or commit SHA).
- **External facts (web, docs, SDK references)** → the URL(s), ideally as a "Sources:" list.
- **Prefer authoritative sources over marketing**, say which is which, and flag anything
  unverified or unknown rather than guessing.
