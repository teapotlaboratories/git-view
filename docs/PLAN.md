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

- **Terminal / SSH — host shell in the workspace 🧱 (bridge ✅ / app ✅ / docs ⬜)** — a third workspace view
  beside Files & Chat: an interactive PTY shell on the bridge host, cwd = the open repo. Owner decisions:
  host terminal (not remote-SSH), **on by default** (disableable via `terminal.enabled: false`), full
  shell in the repo dir. ⚠️ arbitrary code execution as the bridge run-user — audited (`terminal.open`),
  documented in SECURITY.md when it lands.
  - **Bridge ✅** (uncommitted): `config.terminal`, WS frames `terminal.open/input/resize/close` +
    `terminal.data/exit`, `terminal/ptyTerminal.ts` (the `script -qefc "$SHELL -i" /dev/null` PTY — pure
    JS, keeps the .deb small + `all`), per-connection PTY map killed on disconnect, `features.terminal`
    on `/v1/health`. Verified E2E (open → run → exit, cwd=repo, audited). Limitation: no live resize
    (`script` owns the master); node-pty optional-dep could add it later.
  - **App ✅** (uncommitted): `WorkspacePane.TERMINAL` + View-menu entry (gated on `features.terminal`);
    self-contained **MIT** `TerminalEmulator` (line-oriented ANSI/VT, SGR colors) + `TerminalPane`
    (line-mode input, ^C/^D). Verified on the phone (pwd/ls in the repo dir, colored output). Full-screen
    TUIs out of scope (the MIT-renderer trade). **Docs ✅:** the threat model is written up in
    [SECURITY.md](SECURITY.md) → "Terminal — a host shell, as powerful as SSH". **Remaining 🧱:** e-ink
    pass; the tablet still has no pane switcher, so Terminal is unreachable there (follow-up).

- **Reasoning-effort selector ✅** (shipped in `5378a0a`) — an Effort dropdown sits under Model in the
  Claude agent dialog with a "Default" entry that clears the override; the bridge carries
  `effort`/`configEffort` on `GET/PUT /v1/claude/settings` and validates against the 5 known levels.
  As originally specced: the agent's reasoning effort was not settable from the app; only the
  model was. The installed Agent SDK takes `effort?: EffortLevel` on the query `Options`
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

- **`release.sh`: don't read a failed existence check as "release absent" ⬜ (tooling)** — found while
  backfilling v0.1.12. The publish step chose between *edit* and *create* with
  `gh release view "$TAG" >/dev/null 2>&1`, which throws the error away and treats **any** non-zero exit as
  "does not exist". A transient API failure therefore sent a `--clobber` run down the create path, which
  died with "a release with the same tag name already exists". Confusing — and only harmless by luck: the
  same slip against a *missing* release would create one nobody asked for, from whatever sat in `dist/`.
  Change: capture the output and distinguish three outcomes — exit 0 = exists (edit); non-zero **and**
  stderr matches `release not found` = genuinely absent (create); anything else = unknown, so `die` with
  gh's exit code and message rather than guessing.
  Verify: exercised against all three cases with a stub `gh` that fails the way a network blip does — the
  old code takes the create path on a transient failure, the new one stops. Plus `bash -n` and one real
  `--deb-only` build.
  ⚠️ **Written but only in a local `git stash`** (`git stash list`) — a stash is not a durable home for
  work, so either land it or redo it from this description; it is ~15 lines around one helper function.

- **KiCad viewer — schematic + PCB + 3D with cross-probing ⬜ (ADR-038, bridge + app, MULTI-PHASE)** —
  owner-requested, Altium-web-viewer shaped: one place for schematic, board and 3D, where tapping a part
  highlights it everywhere and a net can be followed across sheets and layers. **A programme, not a PR** —
  staged so each phase stands alone and the risky part is settled first. x86 bridges only.
  Architecture in **ADR-038** (decided): parsing runs **on demand** at first open — never eagerly off the
  watcher, which on a repo like rimba could turn one branch switch into a storm of parses — with sibling
  sheets of the same project warmed in the background so flipping between them stays instant.
  The bridge parses each file **once**, caches by content hash, and serves a
  *tagged scene* — drawing primitives each carrying `net` / `ref`. The app draws them on a Compose Canvas,
  so highlight is a style change and hit-testing is exact. **No KiCad binary**: KiCad 6+ files are
  self-contained (symbols embedded, 42 footprints inline, nets on all 365 track segments, zone fills
  precomputed), so a ~1.7 GB runtime dependency buys nothing for 2D.
  - **Phase 0 — the connectivity solver ✅.** The only real unknown, and it came out clean:
    **1722 of 1722 nets match `kicad-cli`'s own netlist exactly** across all 19 demo projects — an exact
    partition match, **zero merges and zero splits**, covering flat sheets, buses and hierarchy.
    Built as `bridge/src/kicad/{sexpr,transform,schematic,nets,design}.ts`, scored by
    `bridge/tools/kicad-netlist-oracle.ts` (a **development-time oracle; `kicad-cli` is never a runtime
    dependency** — it is not even installed on a bridge), and pinned by 20 tests on hand-authored
    fixtures, each verified to fail when its rule is deliberately broken.
    Nine rules were measured rather than assumed, and five were implemented backwards first:
    **mirror applies after rotation** (the marker probe could not see this — swapping a two-pin part's
    pins moves no coordinates — and it reversed every ESD diode on StickHub); **a wire ending mid-span of
    another does not connect without a junction dot**, though a *pin* mid-span does; **power symbols name
    a net without being a node on it**, and their name comes from the **pin**, not `Value` (one supply
    spells it `+3,3V` while its pin says `+3.3V`); **same-name labels join islands that share no wire**;
    **hidden `power_in` pins connect by pin name**; **a sheet pin's identity on the parent is its
    geometry**, not its name (binding by name shorted two sheets that both exposed a pin called `BLUE`);
    **references come from the `instances` block keyed by sheet path**, not the `Reference` property — a
    file placed twice has different refdes per placement; and **buses pair their members by index** where
    two differently-named buses meet, with bus geometry kept in a **separate** union-find so a bundle can
    never collapse into a single net.
  - **Phase 0 follow-ups ⬜ (from the PR #47 review, none blocking).** (a) `aliasBusMembers` is
    O(anchors × bus segments) per sheet — unmeasured on a large real design; the bounding-box reject that
    took the contact scan 1149 ms → 213 ms applies directly. (b) A sheet placed many times is re-parsed
    per placement, so Phase 1's content-hash cache belongs **under** `loadDesign`'s `read`, not above
    `loadDesign`. (c) `readSheet`'s injectable `place` is production surface existing only for the
    transform sweep — kept deliberately (that sweep caught the mirror-order bug) but worth revisiting if
    it ever grows a second caller.
  - **Phase 1 — schematic view ✅ (bridge ✅ / app ✅ — verified on all three form factors).** Bridge endpoint serving the cached tagged scene;
    app renders it on a Compose Canvas with pinch/pan and a sheet switcher. Sequenced **bridge first, then
    app**, because each half is then verifiable on its own — the endpoint by running the bridge and
    curling it, the renderer on an emulator.
    - **The scene is drawable *and* tagged, decided up front.** It carries symbol body graphics
      (`rectangle` ×1514, `polyline` ×4941, `circle` ×515, `arc` ×297, `bezier` ×312, `text` ×863 in the
      KiCad 10 corpus) and sheet-level drawables (`text`, `text_box`, `polyline`, `rectangle`) *as well as*
      the connectivity primitives, with every drawable carrying its `net`/`ref` where it has one. The
      alternative — connectivity-only — reaches a running endpoint sooner but renders boxes and lines
      rather than a readable schematic, and would change the wire format again once the app exists. Bézier
      may be flattened to a polyline; the app should not need a curve rasteriser.
    - **Endpoint:** `GET /v1/repos/{repo}/kicad/scene?path=…&ref=…`, parsed **on demand at first open**
      (never eagerly off the watcher — on a repo like rimba that would turn one branch switch into a storm
      of parses), cached by **content hash**, with sibling sheets of the same project warmed in the
      background so flipping between them stays instant.
    - ⚠️ **This is where `loadDesign` first meets untrusted input.** The placement cap and the `Sheetfile`
      path confinement added in review are the load-bearing bits; the endpoint must pass a **confined**
      `read` rather than a raw filesystem reader, and `Design.problems` must surface to the client instead
      of being dropped. Phase 0's own caveat, now due.
    - **Bridge ✅** — `src/kicad/scene.ts` (tagged scene), `src/kicad/service.ts` (on-demand parse, cache
      by resolved oid + root path), `GET /v1/repos/{repo}/kicad/scene` reading sheets as git blobs.
      Verified by running the bridge and curling it: flat sheet 0.10 s, 8-sheet hierarchy 0.35 s, warm
      cache 0.009 s (58×), traversal refused with `400 path_escape`, an escaping `Sheetfile` reported in
      `problems`, a malformed self-referencing sheet answered in 0.22 s rather than hanging.
      Rendering a scene to a picture caught three defects no count would show — missing refdes/value
      properties, missing text anchors, and `\n` never unescaped by the reader (497 real occurrences).
      Running it caught three more — HTTP 500 where 400 belonged, a 70-second request from building every
      sheet inline, and 2000 `git show` spawns from re-reading one file. See
      [the worklog](worklog/2026-07-30-kicad-phase1-scene.md).
    - **App ✅ — verified on phone, tablet and e-ink.** `SchematicView.kt` (Compose Canvas, pinch/pan,
      tap-to-select-net, sheet switcher), scene wire types, `BridgeApi.kicadScene()`, and an `EditorArea`
      branch that draws a `.kicad_sch` instead of its source. **Verified on a phone emulator**: the
      Sallen-Key sheet renders with refdes/values/power symbols; tapping the op-amp output selects
      `lowpass` and highlights the output wire, the feedback path and the label while everything else
      dims; the 8-sheet `video` hierarchy switches sheets from the switcher chip row.
      One defect found only by running it: **sheet symbols were never drawn** — the solver only wants
      their pins, so `video`'s root rendered as floating pin stubs with no boxes. Now emits the box,
      sheet name, filename and pin labels.
    - **Verified on all three form factors:** phone 1080×2340 (renders, net selection, sheet switcher);
      tablet 2560×1600 landscape (two-pane holds, sheet fits the centre pane); Bigme B7 Pro 1264×1680 with
      the **E-Ink profile ON** (high-contrast mono, and selection carried by **stroke weight** rather than
      hue reads clearly on the panel — the design bet that had never been looked at until now).
  - **Phase 2 — cross-probe on the schematic ✅.** Half of this already shipped in Phase 1: tapping a wire
    selects its net and highlights every primitive carrying it. What is left is the *component* side and a
    way to pick a net without hunting for a wire to tap.
    - **Tap a part → select it.** Hit-test the component's own primitives (body graphics and pins already
      carry `ref`), highlight everything with that `ref`, and show a detail card: refdes, value, `lib_id`,
      pin count. The scene already carries `components[]` with `ref`/`value`/`libId`, so no new endpoint.
    - **A net picker ✅.** `scene.nets` is already sorted and complete. A chip row alone is only usable on a
      small sheet — `buspci` has 162 nets, `graphic` 156, `muxdata` 116 — so a filter field appears above
      it once a sheet passes 12 nets, keeping a 7-net sheet (and e-ink) free of a text box it does not
      need. Shipping the bare row first and calling it done would have left the plan asserting a
      searchable list that did not exist.
    - **One selection model, not two.** Component and net selection must be mutually exclusive and share
      one highlight path, or the draw loop grows a second, subtly different notion of "selected" — the
      kind of divergence that ends with the two disagreeing about what is dimmed.
    - **Verified ✅ on all three form factors.** Phone (component card `R1 1k · sallen_key_schlib:R ·
      2 pins`, net chips, toggle); tablet (all 7 chips fit the centre pane — the narrowest place the new
      row lands, re-driven rather than assumed); e-ink (R1's outline draws markedly heavier than its
      neighbours, unambiguous with no hue). Two bugs found only by running it: the net chip selected but
      never deselected (`active` captured in a `pointerInput` closure that restarts only on key change),
      and body graphics did not honour selection at all — invisible in Phase 1, because only nets were
      selectable and nets own no bodies. See
      [the worklog](worklog/2026-07-31-kicad-phase2-crossprobe.md).
  - **Phase 3 — PCB view ⬜.** Per-layer primitives with layer toggles; nets are already explicit here, so
    highlight is a filter. Schematic ⇄ board cross-probe keyed on refdes and net name.
  - **Phase 4 — 3D ⬜.** The one part still needing external assets: footprints reference
    `${KICAD*_3DMODEL_DIR}/….wrl` (43 refs on one demo board). `kicad-packages3d` is assets-only but
    **5.7 GB installed**, and WRL/STEP needs converting to glTF for Android. Gated on the assets being
    present; hidden under the Color E-Ink profile, where it is close to pointless.
    **Per-component instances, not a merged model** (ADR-038) — each part stays an addressable node so a
    tap ray-casts to its refdes. Decided up front precisely because merging is lossy: retrofitting
    tap-to-highlight later would mean redoing the export and conversion, not extending them.
  ⚠️ **Prerequisite:** no KiCad files exist in any served repo. The corpus is the **KiCad 10.0.5 demos**
  (115 schematics, 19 boards) pulled from GitLab as a path-filtered archive of `demos/` at that tag — no
  KiCad install needed. Target is **KiCad 10**; Ubuntu's `kicad-demos` is 7.x and three majors stale.
  For *netlist* scoring the 7.x corpus is used anyway, because Ubuntu packages only `kicad-cli` 7 and the
  oracle has to be a KiCad that can open the files. The connectivity rules are not version-specific, and
  the KiCad 10 corpus still gets the position-based probe over all 115 sheets, so both are covered.
  A *dense* real board is still what will expose legibility on the 1264×1680 mono e-ink panel, which is
  the constraint likelier to bite than rendering.
  Verify: each phase on all three form factors; Phase 0 against a ground-truth netlist rather than by eye.

- **Watcher exhausts the machine's inotify budget ✅ (bridge, shipped v0.1.13)** — found by accident: 7 watcher tests
  began failing with `got []`, which was `chokidar.watch()` throwing **`ENOSPC: System limit for number of
  file watchers reached`** before it could observe anything. The holder was the bridge itself —
  **119,573 of the system's 119,664 watches**.
  **Not a lifecycle leak.** `watch()` is already idempotent per repo id and `unwatch()` releases properly;
  the first diagnosis (3.2 watches per *directory*) used the wrong denominator. Chokidar 4 watches every
  **path**, files included:

  | | |
  | --- | --- |
  | files + dirs in the 4 watched repos | **180,210** |
  | watches held | 119,573 *(capped by the kernel, not by choice)* |
  | directories alone | 25,014 |
  | directories excluding `.git`/`node_modules`/`build`/`.gradle` | **10,908** |

  So it is scope, not leakage — it walked 180k paths and stopped only when the kernel refused more.
  One ESP32 workspace (`pico-e32`, 144,525 paths) exhausts the budget on its own.
  ⚠️ Blast radius is the machine: once the budget is gone *any* program needing a watcher fails — editors,
  build tools — and the bridge's own notifications then degrade silently rather than erroring.
  Change: stop descending into what is already unreportable. `ignored` currently screens only `.git`-ish
  noise, while `node_modules`, `build/` and `.gradle` are filtered out of *reports* at flush time by the
  gitignore check — after chokidar has watched every file inside them. Moving that decision to watch time
  is a ~16× reduction (180,210 → ~10,908) and costs nothing, because the content was never reportable.
  Consider also whether files need individual watches at all when directory events would do.
  Done in **v0.1.13**: swapped to `@parcel/watcher` (directory-level, as VS Code uses), with watch-time
  ignores taken from `git ls-files --others --ignored --exclude-standard --directory` rather than guessed.
  argonite **119,573 → 8,461** watches; quartz holds 14,005 for a 237k-path repo that alone would have
  wanted twice the kernel limit. Two tests guard it — one asserts the count from `/proc/self/fdinfo`, one
  covers an `unwatch()` racing the initial walk (a real orphan bug that review caught). The count test
  *passed against broken code* until its fixture was rebuilt with 120 ignored subdirectories, since files
  cost no watches either way.
  Consequence: the `.deb` is no longer `Architecture: all` — it ships per-arch, cross-built with
  `npm pack` because `npm install` refuses a foreign-platform package.

- **Pull-to-refresh the bridge list ⬜ (app)** — owner-requested. The Connections screen polls every saved
  bridge's `/health` on a 15s timer while visible (`startReachabilityPolling` → `pingAll`), and an offline
  card offers a per-bridge **Retry** (`retryReachability`). What is missing is the gesture people reach for
  first: swipe down to re-check everything now. Today you either wait out the timer or tap Retry on each
  card in turn, and there is no feedback that a check is in flight.
  Change: wrap the bridge list in a pull-to-refresh (Material 3 `PullToRefreshBox`) whose refresh calls the
  existing `pingAll`, with the spinner tied to the probes actually completing rather than a fixed delay.
  Note it needs `androidx.compose.material3` at a version that has `PullToRefreshBox`; check the catalog
  before assuming. The list is now a `LazyColumn` containing the Add-a-bridge form as its last item, so the
  gesture must not fire while that form is open and scrolled to the top.
  Verify: on an emulator with one reachable and one dead bridge — swipe down, confirm both statuses
  re-probe (latency changes on the live one, the dead one stays offline) and the indicator clears when the
  probes finish, not before; confirm the per-card Retry and the 15s poll still work; and check the gesture
  on all three form factors, including that it does not fight the form's own scrolling.

- **Add-a-bridge form hidden by the soft keyboard ✅ (app)** — owner-reported. With bridges already in the
  list the form sits below the fold, and focusing Name or Base URL put the whole card behind the keyboard:
  you typed into a field you could not see, with Save unreachable. Two causes, both needed fixing.
  The window is `adjustResize`, but `enableEdgeToEdge()` means the system no longer insets us, so Compose
  has to consume the IME inset itself (`imePadding()` — the chat and terminal panes already did; the
  Connections screen was missed). And the form was a *sibling* below a `LazyColumn`, so it only ever got
  the height the list left over — with the keyboard up that was nothing, and nothing could scroll it back.
  Change: `imePadding()` on the content box (not the whole screen, so the top bar stays put), and move the
  form to be the **last item of the list** so it scrolls like any other row; opening it scrolls it into view.
  Verified on all three form factors with a real soft keyboard and a populated list, before and after.

- **Drop legacy bare-token auth ✅ (ADR-037, decided + implemented)** — ADR-035 kept pre-0.1.8 bare tokens working
  so upgrading forced no re-pair. Keeping them costs: no identity (all collapse to one shared `legacy` id,
  so audit and the WS bucket cannot tell them apart), no granular revocation, **plaintext at rest**, an
  O(n) constant-time scan on every request beside the O(1) lookup that replaced it, and a synthetic device
  row whose special-cases reach into the app's wire model, labels, list, and confirm dialog.
  Change: stop reading, verifying, listing and persisting bare tokens; delete `LEGACY_DEVICE_ID`, the
  synthetic row, and the app's `legacy` branches. Auth becomes one shape.
  ⚠️ Cost: **de-authorises every device still on a pre-0.1.8 token — they must re-pair.** 6 on quartz, 0 on
  argonite at decision time. The bridge warns loudly at boot when it finds bare tokens, naming the count,
  so devices don't stop working against a log that looks healthy.
  Verified: bridge unit tests that a bare token is refused, that a store containing them still loads and
  warns, and that the warning names the count; a live bridge refusing a real pre-0.1.8 token (401) while a
  new one works (200); and the full round trip on all three form factors — devices dialog with no legacy
  row, de-authorisation while connected, and recovery, including re-entering a workspace afterwards to
  prove the live channel comes back. The app's `4401` handling is pinned by a MockWebServer test that
  fails against the old code, since that path is silent when wrong.

- **Control socket for host administration ✅ (ADR-036, decided + implemented)** — `bridgectl` used to
  manage the bridge by *editing `tokens.json` directly* and *signalling the process*, because it deliberately
  holds no credential. Six costs had accumulated: a signal carries no payload, so **`revoke` invalidates an
  outstanding pairing code**; there is no reply, so the CLI prints "Revoked" before the bridge agrees; two
  writers share one file; writing under `sudo` left the store root-owned and **wiped a live install**;
  `connected` is unknowable from the CLI; and `pair` scrapes `journalctl`.
  Change: the bridge listens on `/run/gitview-bridge/control.sock` (mode 0600, via
  `RuntimeDirectory=`) and the CLI sends named commands with structured replies. Authentication stays
  **none** — filesystem permissions are the gate, as for the token store. The bridge becomes the **single
  writer**, so `flock`, the staging file and the CLI's ownership handling all delete.
  ⚠️ Cost: a stopped bridge has no socket, so `revoke` must fail clearly instead of falling back to
  editing the file; hand-editing stays the documented break-glass path. Not under `/tmp` — the unit sets
  `PrivateTmp=true`.
  Verified: unit tests for the command protocol and for refusing when the socket is absent; live on the dev
  bridge — a revoke leaves a freshly minted pairing code usable, `devices` shows `connected`, and `pair`
  returns the code without touching the journal. Two further bugs came out of review and are covered by
  tests that fail against the old code: a second bridge could **steal a live socket** (the staleness probe
  bound a different path, so it always concluded "stale"), and the socket-reachability check ran
  **unprivileged**, so on a stock install — where the runtime directory is `0700` owned by the service
  user — every command reported "bridge is not running" while it was running fine.

- **App: a revoked device hangs on "reconnecting…" instead of re-pairing ✅ (app)** — found on an
  emulator while verifying ADR-036, on a branch with **zero** `android/` changes. Revoking a *connected*
  device works on the bridge side — `gitview-bridgectl` reports `1 connection(s) closed` and the socket
  really is closed — but the app shows **"Connection lost — reconnecting…" forever**. It never says the
  device was revoked and never offers to re-pair; cached screens keep rendering, so it looks online.
  Cause: the bridge closes a revoked device's WebSocket with **`4401`** (`bridge/src/ws/liveChannel.ts:178`)
  and the app re-prompts pairing only on **HTTP `401`** (`AppViewModel.kt:415`) — `4401` is handled
  nowhere in the app, so the close is indistinguishable from a network blip and the reconnect loop runs
  forever.
  Change: treat a `4401` close as terminal, not retryable — drop the stored token and surface the pairing
  prompt, exactly as the HTTP-`401` path already does. Distinguish it from a real disconnect in the banner
  ("access revoked — pair again") so the state is legible.
  Verified on an emulator (phone, Tab-S8-class, Bigme B7 under the Color E-Ink profile): revoking a
  connected device raises "Access revoked — pair again to reconnect." plus the pairing prompt immediately,
  while an *ordinary* drop (stop/start the bridge) still shows "Connection lost — reconnecting…", recovers
  silently and keeps the token — the regression that mattered more than the fix.
  **Shipped with ADR-037**, not separately: de-authorising a device is exactly what closes its socket with
  `4401`, so removing legacy auth without this fix would drop 6 quartz devices into the permanent
  reconnect loop at once.

- **`gitview-bridgectl devices` / `revoke` ✅ (bridge + CLI)** — *shipped in v0.1.8; the mechanism below was
  then replaced wholesale by ADR-036 above — the CLI no longer touches `tokens.json` and no longer signals,
  so the `SIGHUP`-reload design and its ⚠️ race are historical. Kept for the reasoning that still holds.*
  Devices could only be listed and revoked
  from the app or by hand with curl. Managing them from the HOST — revoking a lost phone when you have no
  working paired client — is not possible. Add `devices` (list: label, last seen, connected) and
  `revoke <id>` (`legacy` drops the whole pre-ADR-035 bucket).
  **No authentication.** The CLI ships in the same `.deb`, runs as root/the run-user, and already does
  `systemctl restart` and `journalctl`; making it prove itself to a service on the same box whose state
  file it can read and write anyway is theatre. It reads `tokens.json` directly and edits it to revoke.
  The one real constraint: `AuthManager.load()` runs once at boot and the store lives in memory, so an
  external edit would not take effect until restart. **SIGHUP** (already handled, for pairing codes) will
  also **reload the store and disconnect any device that vanished**, giving the CLI the same immediate
  revocation the API has.
  ⚠️ Known race: the coalesced `lastSeenAt` flush writes the in-memory store every ~10s, so a flush landing
  between the CLI's write and the signal could resurrect a revoked device. The CLI signals immediately
  after writing, shrinking the window to milliseconds; documented rather than claimed to be zero.
  Verify: bridge unit tests for reload-on-signal + disconnect-on-vanish; then on a live bridge — list
  matches the API, revoke drops the device and closes its socket, and `legacy` clears the bucket.

- **Watcher: submodule-aware ignore filtering 🧱 (bridge)** — owner-reported: rimba's diff view refreshes
  **every second on quartz** while behaving on the dev box. Measured, not guessed — idle produces **0**
  `repo.changed`, but *each worktree-diff request* emits 1–2 events for exactly
  `vendor/esp-idf/.git/index.lock`: serving the diff makes git take a lock inside the submodule, the
  watcher reports it, the app re-fetches the diff, and round it goes. Not architecture and not the git
  version — the dev box only looks healthy because its submodule indexes are freshly cloned.
  Investigating it surfaced a **second, worse defect**: `git check-ignore` **refuses any path inside a
  submodule** (`fatal: Pathspec … is in submodule`, exit 128), and `dropIgnored` fails open on error — so a
  single submodule path anywhere in a batch **silently disables gitignore filtering for that whole batch**.
  That means the #36 diff-flicker fix does not actually hold on rimba, the repo it was written for.
  Change: drop `.git/**/*.lock` (transient locks are never a state signal), then **partition the batch by
  owning repo** and run `check-ignore` inside each one (`git -C <submodule> check-ignore …`), caching the
  submodule prefix list per repo. This also makes a submodule's *own* `.gitignore` apply for the first
  time — today esp-idf's build output cannot be filtered even in principle.
  **Submodule file changes must keep firing** — only git-internal noise is dropped.
  Verify: unit tests for lock-dropping, per-submodule partitioning and the fail-open path; then on **both**
  bridges — confirm the diff-poll loop is gone on quartz, that a real edit inside a submodule still
  reports, and that ignored churn inside a submodule is now filtered.

- **Device auth: per-device, hashed, revocable tokens 🧱 (bridge ✅ / app ⬜)** — `tokens.json` held bare
  opaque strings (21 had accumulated), so there was **no identity** (which token is which phone?), **no
  granular revocation** (a lost device meant truncating the file and de-authorizing everything),
  **plaintext at rest**, and an **O(n)** constant-time scan per request. Decided in **ADR-035** after
  weighing a file-backed pairing code (A) and per-device signing keypairs (C); **Option B** won on the
  multi-device question — B and C both add identity, but C verifies an asymmetric signature per request
  (≈50–100 µs vs ≈1 µs), so under concurrent load C is the *slower* option as well as the larger build.
  Change: tokens become `<deviceId>.<secret>` with only `sha256(secret)` stored; lookup by id (O(1)) +
  one constant-time compare. Because identity must reach the **live channel** and not stop at the token
  file: stamp `Conn` with the device, make `DELETE /v1/devices/:id` close that device's sockets with
  `4401` (a WS authenticates once at connect, so revocation would otherwise be eventual), move the
  terminal cap per-**device**, and attribute audit entries. Legacy bare tokens keep working (one
  synthetic `legacy` entry) so upgrading forces no re-pair.
  Verify: bridge unit tests for token shape, secret-never-stored, tampered secret / unknown id,
  selective revoke, legacy co-existence + wholesale revoke, persistence at `0600`; plus a live E2E on a
  scratch bridge proving a device revoked **mid-connection** has its WebSocket closed with `4401` while
  a second device keeps working, and that the audit names both.
  - **Bridge ✅** — merged (`/review`ed; tsc clean, suite 134, live E2E) and **deployed to the dev-box
    bridge**, verified against the owner's 21 legacy tokens (still authenticate; no re-pair).
  - **App ✅** — merged (`/review`ed) in **#39**: **Repos ⋮ → "Paired devices…"** lists each device with
    its label, `connected` / relative `lastSeenAt`, and a **Revoke** behind a confirm; the synthetic
    `legacy` row revokes the whole bucket. It hangs off the existing screen-scoped `OverflowMenu`
    pattern rather than a new screen (there is no Settings screen). Pairing sends `Build.MODEL` as
    `label`, so devices arrive named instead of `"device"`.
    The two bridge behaviours are respected up front: the app finds its own row by parsing the id from
    its bearer token and **withholds that row's Revoke** (the bridge 403s a self-revoke), and a client
    on a legacy token explains that it cannot clear its own bucket instead of showing a dead button.
    Verified on **all three form factors** (phone, Tab-S8-class tablet, Bigme B7 e-ink under the Color
    E-Ink profile — hue-free), with revoke exercised end-to-end and the legacy path confirmed to need
    no re-pair. `/review` caught a real bug: device ids are **per bridge**, and the list + "which row
    is me" were not being cleared on a bridge switch — fixed and re-verified against two live bridges.
    See `docs/worklog/2026-07-27-app-device-list.md`.
  - **Not deployed / not released:** the app half is on `main` only — using the device list needs a
    fresh APK (`tools/release.sh --apk-only`). The bridge is deployed but still reports `0.1.7`, and
    quartz was never updated. Both components changed this cycle, so a release bumps **both** → `v0.1.8`.

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
