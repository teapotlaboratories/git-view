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
- **Rename / delete UI ✅:** long-press a file-tree row → context menu. *Rename* (files + dirs) opens
  a dialog; *Delete* (files only — the bridge's `remove` is non-recursive) confirms first. Both hit
  the existing `POST …/rename` / `DELETE …/file`, then update the tree and any open tabs in place
  (paths rewritten on rename, node + tabs dropped on delete). Hidden on a read-only historical ref.
  Rename **refuses to overwrite** an existing name — the bridge's `renamePath` rejects a colliding
  destination (`conflict`) so it can't silently clobber another file, and the app guards visible
  collisions client-side; the confirm dialogs dismiss on tap so a double-tap can't re-fire (all found
  by an adversarial self-review).
- **Remaining:** conflict handling (external change to a file open + dirty).

## Phase 3 — Chat (completes the MVP) ✅ core / 🧱 polish
Provider split, `auto` default + selectable profiles + sandbox runtime, SDK session APIs.
- Bridge: `claude/sessionManager.ts` (local SDK, `listSessions`/resume, event normalization),
  `claude/remoteControl.ts`, `claude/permissions.ts`, `claude/mcpServer.ts`, `claude/sandbox.ts`. ✅
- App: `ChatScreen`, `BridgeClient` (WS), provider/profile selectors, cost accumulation. ✅
- **SDK event mapping verified live ✅:** driven end-to-end against a real local-SDK session (the
  machine's authenticated `claude` CLI + the installed Agent SDK) — `session.init` → `tool_use`(Read)
  → `tool_result` → `assistant.delta` → `result` (cost/turns) all stream and normalize correctly. The
  live run caught + fixed two mapping bugs: a tool_use block's streaming `input_json_delta`/
  `partial_json` was leaking into the chat message text, and `session.init` re-fired on every system
  message (with `model=undefined`); now only `text_delta` becomes `assistant.delta` and `session.init`
  emits once. (Verified with `sandbox.enabled=false` on this box — the bwrap sandbox itself was not
  exercised, only the event stream.)
- **Remaining (🧱):** Remote Control QR rendering; markdown/image rendering in chat (currently minimal).
- **Explorer: create file / folder ✅** (shipped v0.1.6, PR #34) — **New file… / New folder…** in a
  folder's long-press menu (created inside it) + a header ＋ for the repo root. Folder =
  `createFile("<path>/.gitkeep", "")`; reuses `POST /v1/repos/{repo}/file` (no bridge change). Reloads
  the parent's children (auto-expands a collapsed parent) and opens a new file. See
  `docs/worklog/2026-07-24-explorer-create.md`.
  - **Follow-up 🧱 (review #34, minor):** creating at the **repo root** via the header ＋ full-replaces
    the tree (`reloadDir("")`), collapsing every expanded folder. Cosmetic — the folder-menu path is
    fine, and root *New file* is masked by the editor opening; only root *New folder* visibly collapses.
    Fix: splice the new depth-0 node into the flat list in sort order instead of replacing (see
    `AppViewModel.reloadDir`); re-verify on-device.

- **Workspace toolbar: Files/Chat as a right-side dropdown 🧱** — the phone workspace put a chunky
  `Files ⇄ Chat` segmented control in the centre of the top bar. Replace it with a compact `View`
  dropdown chip styled like the existing `Git` menu, grouped next to it on the right; move the branch
  chip up into the top bar so neither bar is crowded. Phone/E-Ink only — the tablet split shows both
  panes at once and has no switcher. Verify on the three form factors.

- **Reasoning-effort selector 🧱** — the agent's reasoning effort is not settable from the app; only the
  model is. The installed Agent SDK takes `effort?: EffortLevel` on the query `Options`
  (`'low'|'medium'|'high'|'xhigh'|'max'`, `sdk.d.ts:480,1425`), so this is a pass-through.
  Change: mirror the existing *model* override end-to-end — `claude.effort` in config.yaml as the reset
  target, an override in `ClaudeSettingsStore` (`claude-settings.json`), `effort`/`configEffort` on
  `GET/PUT /v1/claude/settings`, and `options.effort` in `sessionManager.start()`. The bridge validates
  against the 5 known levels (an unknown value must 400, never reach the SDK mid-session). App: an
  Effort dropdown directly under the Model dropdown in the Claude agent dialog, with a Default entry
  that clears the override. Not every model supports every level (`xhigh` is Opus 4.7 only; the SDK
  silently downgrades), so the UI hints at that rather than hard-blocking — the model field accepts
  custom ids, so the app cannot reliably know the target model's capabilities.
  Verify: bridge unit tests for the store round-trip + rejection of a bad level; live `curl` PUT/GET
  round-trip; app build + emulator run confirming the dropdown saves and survives reopening the dialog.

- **Transcript open-position + selectable text 🧱** — opening a chat lands on the *oldest* message
  instead of the newest, so every resume starts with a scroll to the bottom. Cause: `scrollToNewest()`
  takes its target from `layoutInfo.totalItemsCount`, which is `0` before the list is measured → it
  scrolls to index 0, and an unmeasured list reports `canScrollForward == false` so the settle loop
  breaks and never corrects (`ui/chat/ChatTranscript.kt`). Separately, `follow` is an unkeyed
  `rememberSaveable`, so a scrolled-up position leaks from one session into the next. Chat text is also
  not selectable, so there's no way to copy a reply or a code block.
  Change: derive the scroll target from `items.lastIndex`; key follow-state to the open session and
  re-pin to newest on open (auto-tail continues, and still yields the moment the user scrolls up); wrap
  the transcript in a `SelectionContainer`.
  Verify: run on an emulator — resume a session with a long transcript and confirm it opens at the
  newest message, that it keeps tailing while streaming, that scrolling up stops the auto-scroll and
  scrolling back down resumes it, and that message text / code blocks can be long-pressed and copied.

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

## Redesign — Standard + Color E-Ink (design handoff) 🧱
A visual + interaction redesign per `docs/design/design_handoff_gitview_redesign/` (its README is the
full spec). One component set, two first-class profiles. Build order from the handoff:
1. **Design tokens + ProfileTheme ✅** — both palettes as one hex source (`ui/theme/Color.kt`); an
   `@Immutable GitViewColors`/`Spacing`/`Motion` via CompositionLocals ALONGSIDE a derived M3
   `ColorScheme` mapping every role from the same constants (stock components + existing screens
   re-skin with no edits); bundled IBM Plex Sans + JetBrains Mono; profile-aware Typography (E-Ink body
   16sp / min-weight 500) + Shapes (5 slots, E-Ink 6dp); a motion gate (E-Ink `None`/`snap`, ripple
   off). `GitViewTheme(profile)` + `object GitViewTheme` accessor; `DiffView` moved onto the
   `add`/`remove` tokens. See [DECISIONS.md](DECISIONS.md) ADR-023. Verified: `assembleDebug` + both
   profiles re-skinned on-device (Connections). Depth/elevation token deferred to step 2 (surfaceTint
   neutralized now); overscroll-off + Sora code-font are follow-ups.
2. **Chat transcript ✅** — kind-tagged `LazyColumn` + `StreamingText` (per-line on E-Ink) +
   `ToolActivityCard` (name/path/badge, expand → shared `DiffRow` for Edit, result preview for Read) +
   markdown via compose-richtext, over the WebSocket. Wire extended (ADR-024: `tool_use_id` correlation
   + `tool_result` summary/capped content). Verified: bridge typecheck + a **live local-SDK** Read+Edit;
   `assembleDebug` + unit tests (`ChatModelsTest`); on-device on **both profiles** (E-Ink strikethrough/bold
   diff, Standard green/red tints).
3. **Permission model ✅** — renamed tiers (0–4 risk), a persistent `PermissionBar` + `RiskMeter`, a
   `ModalBottomSheet` tier picker (with `was:` + hold-to-confirm for Unrestricted), a `Turn $ · Session $
   vs budget` `CostBar`, and the centerpiece **live inline approval gate**: interactive tiers run the SDK
   `canUseTool` (ADR-025) — an edit pauses, emits `permission_request`, and the app's inline card answers
   `permission_response` (Allow once / for session → Auto-edit / Deny). Default → `ask-first`. Verified:
   bridge typecheck + tests (`permissions.test.ts`); **live SDK** — Ask-first edit paused, Allow applied,
   Deny blocked (file unchanged), reads auto-allowed; on-device (bar, sheet, inline diff card, cost bar).
4. **Workspace IA ✅** — Browse + Chat collapsed into one `WorkspaceScaffold`: narrow screens a Files ⇄ Chat
   `SegmentedButton`; wide screens (≥720dp, **both profiles**) show tree + editor + chat with **two persisted
   dividers** (tree↔editor + editor↔chat, nested `DraggableSplit`) — draggable on Standard, **discrete
   tap-to-cycle** on E-Ink (no continuous motion). Diff / History / Commit are overlays; `Screen` collapses to
   CONNECTIONS/REPOS/WORKSPACE. Owner-chose the fuller scope, so also **real branch switch + push**: new
   audited bridge endpoints `POST /checkout` + `POST /push` (ADR-026), a `main ▾` branch-picker chip
   (+ new branch), and a Commit overlay. Verified: bridge typecheck + tests; **live** checkout (HEAD
   moved) + push (branch landed on a bare remote) + name validation + audit; on-device **phone** (Standard
   + **E-Ink**) and **tablet** (3-pane draggable split). The E-Ink pass caught + fixed a real toolbar-
   crowding bug (Git menu + overflow pushed off-screen on the phone) via a **two-bar** layout: segment +
   overflow on top, branch chip + save + Git in a slim path/ref bar.
5. **Connections & Repos status** ✅ — reachability + latency poller, per-bridge provider, git-state
   chips (`branch · ↑n ↓n · n dirty`) + commit `+/−` stats. Extended the bridge (ADR-027); Room v1→v2.
6. **E-Ink profile pass** ✅ — `EinkPaginator`, 56dp targets, weight/underline semantics, calm editor.
   Reshaped per owner: the Bigme is **80Hz**, so pagination / reduced-motion / calm-editor are **opt-in
   user settings** (default off), not profile-forced (ADR-028); the profile keeps the always-on visuals.
7. **States polish** ✅ — loading skeletons, styled empty states, inline Retry on failed fetches, and a
   full **offline/reconnect** story: observable WS state + auto-reconnect + banner + editor read-only
   (buffer preserved), plus the editor **save-conflict** bar (reload/overwrite/diff) — ADR-029. Verified
   on-device (network drop → banner + read-only + auto-reconnect; external change → conflict bar).

**Redesign complete** — all 7 build-order steps done, stacked on `redesign/step1-tokens-theme` (uncommitted).

## Browse host filesystem + open a folder as a workspace 🧱
Beyond the pre-registered `config.yaml` repos: browse the host inside operator-declared **`workspaceRoots`**,
`mkdir`, and **open a folder as a workspace** (prompting to `git init` a non-repo folder). Roots-confined,
off by default. See [DECISIONS.md](DECISIONS.md) ADR-030.
- **Bridge:** `GET /v1/fs/roots`, `GET /v1/fs/list`, `POST /v1/fs/mkdir`, `POST /v1/workspaces/open` — all
  behind Bearer auth and the **same `confine()`** containment; `404` when `workspaceRoots` is empty
  (`GET /v1/health` gains `features.workspaces`). Opened workspaces persist to `.gitview/workspaces.json`
  (`0600`); `config.yaml` is never rewritten; `GET /v1/repos` merges config repos + workspaces (config wins
  on id collision). Three decided forks: roots-confined scope; prompt-to-git-init (never auto-init, open
  returns `{needsInit:true}` — a 200, not a 409); persist to the bridge state file. See [API.md](API.md).
- **App:** a folder browser (roots → dirs, new-folder action) gated on `features.workspaces`; open a folder,
  and on `needsInit` confirm-then-`git init`, landing it in the repos list.

## Testing — 🧱 cross-cutting *(review follow-up)*
Bridge unit tests cover the security-critical logic: `util/paths.ts` confinement (reject `..`,
absolute, and symlink escape; accept in-repo paths incl. an in-repo symlink); `git/gitService.ts`
(ref validation, working-tree browse hiding `.git`/`.gitview`/ignored paths, blocking listing inside
them, and binary-blob base64); `auth/pairing.ts` (pair/verify flow, wrong + expired code rejection,
one-shot code rotation, and token persistence at `0600`); and the write path — `git/fileService.ts`
(save/create/rename/remove, base64 round-trip, size cap, path confinement, audit) and
`git/gitWrite.ts` (stage/commit/discard, empty-message rejection, confinement, audit). 29 tests
(incl. merge → 2-way commit diff). Run locally with `npm test` (node:test via tsx).
**Android tests 🚧:** a JVM unit-test harness now exists (`app/src/test`, JUnit) — `DiffClassifierTest`
covers the hunk-aware diff line-classifier (`classifyDiff`, extracted to the Compose-free `DiffModel.kt`
so it tests on the JVM): header-lookalike content lines, no-newline markers, multi-file state reset,
combined-diff headers. Run `gradle :app:testDebugUnitTest`. **Remaining:** the wire-event mapping;
broader Android coverage.

## Out of scope
Cloud multi-tenant service; running the agent or a full IDE on the phone; parsing internal Claude
transcript files; a Boox/Onyx hard dependency; treating either display profile as secondary.
