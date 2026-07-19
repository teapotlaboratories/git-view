# GitView Build Plan

Phased delivery. **MVP = phases 0–3.** Each phase lists its goal, the key work, and how it maps to
what already exists in this scaffold. ✅ = scaffolded and building; 🧱 = stubbed/partial; ⬜ = not started.

## Phase 0 — Walking skeleton ✅
Bridge boots, serves `/v1/health`, pairs, and returns `/v1/repos`; app builds to an APK and lists a
saved connection. **Status:** bridge boots + pairs + reads verified end-to-end; APK assembles.

## Phase 1 — Read viewer ✅ (highlighting ✅)
Lazy file tree, blob view, refs/log/diff/blame/show/status; BOTH DisplayProfiles auto-selected per
device with the Color E-Ink software base.
- Bridge: `git/gitService.ts` (tree/blob/log/refs/diff/blame/show/status; working-tree lists
  untracked files; blobs as Buffer). ✅
- App: `FileTreeList` (file-type icons), `CodeEditorView` (Sora), `BrowseScreen`, DisplayProfile. ✅
- **Syntax highlighting ✅:** real VS Code TextMate grammars (23 langs) + Dark+ theme (Standard) /
  mono theme (e-ink) via `SyntaxHighlighting`, native Oniguruma engine (ADR-015). Verified on-device.
- **Diff viewer ✅:** `DiffView` renders the unified diff with accented hunk headers, dim file
  headers, and synchronized horizontal scroll; reachable from the browse toolbar ("Diff" — the open
  file, else the whole working tree) as a full-screen overlay. Verified on-device. **E-ink-adapted:**
  under the Color E-Ink profile it drops the green/red hue and conveys add/remove by weight (added =
  bold) + strikethrough (removed), keeping the +/- gutter symbol (`LocalDisplayProfile`-gated); the
  Standard profile keeps the green/red tints.
- Open-file tabs ✅ (shipped in the redesign).
- **Commit log + diff variants ✅:** a `LOG` (History) screen lists recent commits (existing `GET
  …/log` → `CommitSummary[]`: short SHA, subject, author, relative date); tapping a commit opens its
  diff (`diff?kind=commit&ref=<oid>`, merge-safe first-parent) in the same `DiffOverlay`. The browse
  toolbar's **Diff** chip is a menu — *Working tree* / *Staged* (`kind=worktree|staged`) / *History…*
  (opens the log) — so all three `DiffKind`s are reachable. Android-only (bridge endpoints already
  exist). Verified on-device: listed commits, opened a merge commit's diff (renders 2-way) and a
  staged diff, on both the Standard and Color E-Ink profiles.
- **Remaining (🧱):** pagination scrolling on e-ink; wire `eink-mono.json` visual tuning on the actual
  panel (Phase 8).

## Phase 2 — Write path ✅
Save/create/delete/rename; stage/commit/discard — with the correctness/security requirements.
- Bridge: `git/fileService.ts`, `git/gitWrite.ts` — path confinement (realpath), write-size cap,
  historical-ref = read-only, audit log. ✅
- App: editor Save, commit action. ✅
- **Remaining:** rename/delete UI affordances; conflict handling.

## Phase 3 — Chat (completes the MVP) ✅ core / 🧱 polish
Provider split, `auto` default + selectable profiles + sandbox runtime, SDK session APIs.
- Bridge: `claude/sessionManager.ts` (local SDK, `listSessions`/resume, event normalization),
  `claude/remoteControl.ts`, `claude/permissions.ts`, `claude/mcpServer.ts`, `claude/sandbox.ts`. ✅
- App: `ChatScreen`, `BridgeClient` (WS), provider/profile selectors, cost accumulation. ✅
- **Remaining (🧱):** verify SDK event mapping against a live session; Remote Control QR rendering;
  markdown/image rendering in chat (currently minimal).

## Phase 4 — Multi-repo / machine / session + fs watcher ✅ live push / ⬜ multi-session UI
Multiple repos per machine, multiple machines, saved connections, multiple concurrent chats per repo;
repo-change push. Scaffolded hooks: `repos` list, `LiveChannel.broadcastRepoChanged`, per-connection
store.
- **Live repo-change push ✅:** `git/repoWatcher.ts` (chokidar) watches each registered repo's working
  tree, ignoring `.git` noise (surfacing only `HEAD`/`index`/`refs` for branch/commit/stage changes),
  `.gitview`, and `node_modules`; coalesces bursts via `awaitWriteFinish` + a debounce and calls
  `LiveChannel.broadcastRepoChanged(repo, paths)` → the `repo.changed` WS event. The app connects the
  live channel on repo open (not just chat) and, on a `repo.changed` for the active repo, refreshes
  the file tree (preserving expanded folders), the open diff overlay, the History screen, and re-reads
  any **non-dirty** open file that changed — never clobbering unsaved edits. Watcher unit-tested;
  verified on-device (edit a file / commit externally → the app updates live). *Follow-up:* a
  "changed on disk" affordance for a **dirty** open file (currently that tab is left untouched).
- **Remaining:** multi-session UI.

## Phase 5 — Tailscale + pairing ✅ pairing / ⬜ docs-only Tailscale
Pairing is implemented. Tailscale Serve is an operational step (see [SETUP.md](SETUP.md)); nothing to
build in the bridge beyond binding loopback.

## Phase 6 — Confined-MCP write surface + Remote Control polish ✅ core
`createSdkMcpServer` surface (`mcp__gitview__*`) and the `confined-agent` profile are implemented.
**Remaining:** Remote Control lifecycle polish (reconnect after outage, one-connection enforcement).

## Phase 7 — Hardening + audit log + optional safety dials ✅ audit / 🧱 dials
Audit log implemented. **Remaining:**
- Surface the optional dials (approve-each-write, isolated worktree, stricter egress) in config + app;
  rate limiting; token revocation UI.
- ✅ **Drop CORS** *(review follow-up)*. `@fastify/cors` removed entirely — the only client is the
  native app (bearer token in a header, not a browser), so CORS was dead weight and surface.
- ✅ **Exclude ignored paths from the working-tree browse** *(review follow-up)*. `listTree`/`readBlob`
  now hide `.git`/`.gitview` unconditionally and filter `.gitignore`-matched paths via `git
  check-ignore`, so `node_modules`, `dist`, `config.yaml`, and the token file + audit log are no longer
  served. Verified: `GET …/tree` omits them and `GET …/blob?path=…/.gitview/tokens.json` → `not_found`.
- ✅ **Reconcile body limit vs. write cap** *(review follow-up)*. The bridge now raises the effective
  body limit to `max(bodyLimitBytes, ceil(writeSizeCapBytes × 1.4))`, so a near-cap binary save isn't
  rejected before the write-size check. Verified: a 7.9 MiB file saves; a 9 MiB one is rejected.

## Phase 8 — E-ink on-device refresh tuning ⬜
On the actual Bigme B7 Pro: determine/integrate the refresh hook (or finalize E-Ink Center guidance),
tune clean-flash cadence, batch interval, and the Kaleido-3 palette; verify `EInkRefreshController`
no-ops cleanly on non-Bigme devices. See [EINK.md](EINK.md).

## Testing — 🧱 cross-cutting *(review follow-up)*
Bridge unit tests cover the security-critical logic: `util/paths.ts` confinement (reject `..`,
absolute, and symlink escape; accept in-repo paths incl. an in-repo symlink); `git/gitService.ts`
(ref validation, working-tree browse hiding `.git`/`.gitview`/ignored paths, blocking listing inside
them, and binary-blob base64); `auth/pairing.ts` (pair/verify flow, wrong + expired code rejection,
one-shot code rotation, and token persistence at `0600`); and the write path — `git/fileService.ts`
(save/create/rename/remove, base64 round-trip, size cap, path confinement, audit) and
`git/gitWrite.ts` (stage/commit/discard, empty-message rejection, confinement, audit). 29 tests
(incl. merge → 2-way commit diff). Run with `npm test` (node:test via tsx); wired into
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
**Android tests 🚧:** a JVM unit-test harness now exists (`app/src/test`, JUnit) — `DiffClassifierTest`
covers the hunk-aware diff line-classifier (`classifyDiff`, extracted to the Compose-free `DiffModel.kt`
so it tests on the JVM): header-lookalike content lines, no-newline markers, multi-file state reset,
combined-diff headers. Run `gradle :app:testDebugUnitTest`. **Remaining:** the wire-event mapping;
broader Android coverage; wire the Android tests into CI.

## Out of scope
Cloud multi-tenant service; running the agent or a full IDE on the phone; parsing internal Claude
transcript files; a Boox/Onyx hard dependency; treating either display profile as secondary.
