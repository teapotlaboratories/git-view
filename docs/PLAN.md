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

- **`release.sh`: don't read a failed existence check as "release absent" ✅ done (tooling)** — found while
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

- **KiCad viewer — schematic + PCB + 3D with cross-probing ✅ done, shipped in v0.1.15 (ADR-038, bridge + app)** —
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
  - **Net filter on real e-ink hardware ⬜ (app, follow-up).** The filter was driven on the B7 Pro AVD
    with the E-Ink profile on: it costs *less* screen there than on the phone (keyboard 39% vs 56%, 13
    chips visible vs 8) and stays legible, so no profile-specific affordance is warranted. What an
    emulator cannot test is the **refresh cost of typing on a real EPD** — it redraws instantly, so
    layout and legibility are verified and per-keystroke flash is not. Check on the physical panel; if it
    is bad, the fix is a profile-specific control, not a global one. See ADR-014 (no public Bigme SDK, EPD
    is not emulable).
  - **Schematic viewer: canvas draws over the chrome ✅ (app, owner-reported).** The Compose Canvas painted
    on top of the net-filter field and under the system navigation bar: a Canvas does **not** clip to its
    own Box, so a panned schematic drew over everything around it. Fixed with `clipToBounds()` plus
    `navigationBarsPadding()` on the pane, re-checked on all three form factors.
  - **Fit-to-view is dominated by stray annotation text ✅ (app, owner-reported as "writing at the bottom
    left").** The sheet bbox included every drawable, so a SPICE directive parked far from the circuit set
    the minimum and the circuit rendered small and off-centre — on `sallen_key` the text sits at x=109.2
    while the circuit starts at x=152.4. Fixed client-side with `circuitBounds()`: framing uses wires,
    pins and component bodies, and free-standing text is still drawn but no longer sets the frame. The
    text is genuinely part of the schematic — it is not junk, it is just not what you want to frame on.
    ⚠️ I misread this as a fit *bug* twice before measuring it; it was a framing choice, not a scale hack.
  - **Phase 3 — PCB view ✅ done (reader ✅ / endpoint ✅ / renderer ✅).** Nets are already explicit in a
    `.kicad_pcb`, so there is no solver to write — highlight is a filter. The hard part is **scale**, and it
    is a different problem from the schematic rather than a bigger one.
    - **Measured before designing anything.** The largest board (`jetson-agx-thor-baseboard`, 81 MB) holds
      **~357,000 primitives, ≈27 MB of JSON if shipped flat**. The largest *schematic* scene was 41 KB. A
      650× jump, and it decides the design.
    - **A scene is requested per layer.** 39 layers are declared on `vme-wren` and the mass is wildly
      lopsided — fab/courtyard/adhesive/paste hold **92%** of everything, while copper + silkscreen + board
      outline, the part you actually look at, is **7%**. Asking only for what is visible collapses the
      common case ~14× before any other trick.
    - **Zones ship KiCad's precomputed `filled_polygon`.** Re-deriving a fill means clearances, thermals and
      island removal — a solver the size of Phase 0, wrong invisibly. The file already has the answer.
      `zones=0` drops them, but **for clarity, not for bytes** — measured, fill is only 0–16% of a copper
      layer (`video` 0%, `vme-wren` 2.5%, `jetson` 12.4%). The saving lever is asking for fewer *layers*.
    - **The board takes its own primitive union**, not the schematic's. Tracks carry width and layer, vias
      and pads belong to *several* layers at once, and nets arrive as integers resolved through the file's
      own table. Forcing one shape would have made both worse. See ADR-038.
    - **Caps are by role, not one number ✅ (corrected).** The first cap was a flat 20,000, justified from a
      single board. A corpus survey killed it: `vme-wren`'s `F.Cu` is **20,887**, so *copper* was being
      silently shortened by 4% — the viewer-that-lies failure arriving through the mechanism meant to
      prevent it. Structural layers (copper, silkscreen, `Edge.Cuts`) now get a 100,000 backstop; annotation
      keeps 20,000. Truncation is reported either way, and says which kind it was.
    - **Reader ✅** — `bridge/src/kicad/board.ts`, **14 tests**, each checked by breaking the rule it
      protects. Parses once and serves per layer: on `vme-wren` (66 MB) parse 3.9 s, index 0.4 s, then
      `F.Cu` = 20,887 primitives / 2.4 MB in 0.27 s. Re-parsing per layer cost 6.5 s each before the split.
    - **Endpoint ✅** — `GET …/kicad/board?path=&ref=&layer=&zones=`: index without `layer`, one layer with
      it. Caches the *parsed tree*, so on `vme-wren` the index costs 6.2 s cold and each further layer
      **0.29–0.36 s**. Verified over HTTP, not just built. Found a 64 MB `MAX_BUFFER` wall in `gitBuffer`
      that made every committed ref fail on a 66 MB board — blobs now have their own 192 MB ceiling,
      checked before reading so an over-size file is a 413 naming it rather than a mystery buffer error.
    - **Renderer ✅** — `BoardView.kt`. Opens on the **index alone** and draws only `Edge.Cuts` (~2 KB,
      instant); every other layer is fetched when its chip is switched on. The chips carry their
      populations, so pulling 2.6 MB of `F.Cu` is an informed choice rather than a surprise. Tap a track or
      pad to select its net; highlight is accent on colour and **stroke weight** on e-ink, the same rule the
      schematic and diff viewers follow. Truncation is surfaced in the UI, not just in a field.
      Driven on `video.kicad_pcb`: outline → `F.Cu` (5,376) + `F.SilkS` (429) → tap selects `/CAS0-`.
      **Three form factors ✅:** e-ink 1264×1680 with the Color E-Ink profile (mono, selection by weight),
      phone 1080×2340 (F.Cu in its copper red over the white outline), Galaxy Tab S8 2560×1600 landscape
      (three panes, chips fit the narrow centre). 48.0 dp chips, `clickable`+`checked`, on all three.
      **Remaining ⬜:** component selection — needs footprint-level hit-testing the per-layer format does
      not carry yet.
    - **Cross-probe is nearly free** once both exist: schematic ⇄ board matching is on **refdes and net
      name**, the only identifiers both views share — which is why Phase 0 was built to produce real net
      names rather than synthetic ids.
  - **Phase 3b — schematic ⇄ board cross-probe ✅ (bridge + app).** Both halves now exist and both already
    publish `nets[]` and `components[].ref`, so nothing new has to be derived — the work is carrying a
    selection across a tab boundary.
    - **The bridge names the counterpart, the app does not guess it.** A `.kicad_sch` and its
      `.kicad_pcb` are paired by directory + basename, but *only the bridge can tell whether the sibling
      exists* at that ref. Guessing client-side means offering a "show on board" action that 404s on any
      project that names its files differently, which is worse than not offering it. So the scene and
      board responses each gain an optional `counterpart` path, resolved server-side, absent when there
      isn't one.
    - **The action only appears when there is something to show.** No counterpart, no button.
    - **Selection has to be seeded from outside the view.** Today both viewers own their selection in
      `remember(scene.path)`. Opening the board with a net pre-selected means an initial selection passed
      in, cleared once consumed so it does not re-apply on every recomposition.
    - **Refdes as well as net.** A component selected on the schematic should locate the same part on the
      board. Board-side component *hit-testing* is still absent (the per-layer format carries no footprint
      shape), but highlighting a known `ref` needs no hit-testing — every board primitive already carries
      one — so the schematic → board direction works now and board → schematic waits.
    - **Verify:** open `video.kicad_sch`, select a net that exists on both (`GND`), cross-probe to
      `video.kicad_pcb`, and confirm the same net is lit. Then the reverse. Then all three form factors —
      the tablet is where a second tab opening in the narrow centre pane will show first.
    - **Verify:** run the bridge and curl a real board, then all three form factors. A dense multi-layer
      board on the 1264×1680 mono panel is the legibility case that will actually bite.
  - **A KiCad tab's drawing is not maintained alongside its content ✅ (app, pre-existing).** One root
    cause, two symptoms, both found by reading the refresh paths after Phase 3b:
    - **`reloadConflict` strands the tab.** It rebuilds the `OpenFile` from the blob, dropping
      `scene`/`board`, and nothing re-fetches them. The render branch tests `scene != null` and the
      fallback tests `!sceneFailed`, so a `.kicad_sch` or `.kicad_pcb` sits on `EditorSkeleton` **forever**.
    - **`reloadChangedOpenFiles` goes stale instead.** It refreshes `content` with `copy(content = …)`, so
      the scene survives — and is never re-solved. The viewer keeps drawing the *old* schematic while the
      file on disk has changed. This is the worse of the two: it is silent, and it is the common case,
      because a viewer's tabs are normally **not** dirty, which is exactly the set this path refreshes.
    - Both are the same omission: a KiCad tab has derived state, and only its raw text is being kept
      current. Fix: re-trigger `loadScene` / `loadBoard` wherever a tab's content is replaced.
    - **Verify:** open a schematic, change the file on disk under the bridge, and watch the drawing follow
      rather than freeze — the staleness is invisible without doing exactly that.
  - **Three defects shipped in v0.1.14, found by opening one big board ✅ (app + bridge).** None came
    from a test or a review — they came from opening `vme-wren.kicad_pcb` (66 MB) on an emulator, which
    is the thing rule 6 asks for and the thing that had not been done for this feature. Fixed in
    `32f95e4` and the zoom change; **unreleased — this is what v0.1.15 is.**
    - **The app downloaded the board source it never shows.** Opening a KiCad tab fetched the blob as a
      string as well as the scene: a 157 MB allocation for a 66 MB file, and the process died before a
      trace was drawn. The source is only needed for the fallback editor, i.e. only when the drawing
      *fails*, so it is fetched only then.
    - **One text label could empty a whole layer.** The board reader emitted a text primitive's
      `size`, which collides with a field of a different type on another primitive in the same
      polymorphic list; `ignoreUnknownKeys` does not save a *known* key with the wrong shape, so the
      whole layer failed to deserialize. Renamed `fontSize`.
    - **Zoom was unbounded and anchored to the canvas origin.** `scale *= zoom` with `offset += pan`
      scales about the origin rather than the pinch centroid, so the board accelerated off-screen —
      one pinch left an empty canvas. The schematic viewer had always done this correctly; the board
      viewer was written without carrying it over.
    - **Follow-on:** two of the three were decisions living inside coroutines in `AppViewModel`, where
      no test could reach them. Both moved to `ui/kicad/KicadTabRules.kt` as pure functions
      (`isKicadPath`, `boardLayersToShow`) with nine tests, each pinned to a case that shipped wrong.
      A behaviour-preserving move: the bodies are the previous expressions verbatim.
    - **Verify:** open `vme-wren.kicad_pcb` on a device and pinch it — every one of the three is
      invisible on a small board, which is why a green suite missed all of them.
  - **Phase 4 — 3D ✅ done via Phase 4a (re-scoped after measuring; the original framing did not survive).** The plan said
    "gated on 5.7 GB of assets" and treated that as the only obstacle. Measuring the corpus first — 19
    boards, 3,616 model references, 392 unique — says otherwise.
    - **Model paths resolve through 13 different environment variables**, most machine- or project-specific:
      `${KICAD9_3DMODEL_DIR}` (1,324 refs), **`${ANT3DMDL}` (1,007)** — someone's private library, defined
      in *their* KiCad settings and shipped nowhere — `${KICAD6_3DMODEL_DIR}` (627), `${EASYEDA2KICAD}`
      (193), and more. The bridge cannot know these; any design must take a **configured variable →
      directory map** from the operator rather than guess.
    - **27% of unique models cannot be resolved at all** — but part of that was our own bug, found by
      asking *why* rather than re-quoting the survey. `kicad-embed://` (39 unique) is not unresolvable:
      KiCad 9 stores the model **inside the board**, base64 over zstd, and the resolver was treating it as
      a relative path, finding nothing, and reporting `missing`. On `vme-wren` that is **33 of 66** unique
      models — its coverage went from `present 1, missing 65` to `present 1, embedded 33, missing 32`.
      Counting is over payload entries of `(type model)`: 155 per-footprint declarations against 45
      payloads, of which 33 are models and **12 are PDF datasheets**, which a board embeds the same way.
      `${KISYS3DMOD}` (5) is likewise just the pre-v6 name for the official library — **fixed**: the six
      names the official library has had (`KISYS3DMOD`, `KICAD6`…`KICAD10_3DMODEL_DIR`) all resolve through
      whichever one the operator mapped, preferring the newest. An operator maps **one** variable, not six;
      `video.kicad_pcb` addresses three generations and resolves all 23 against a single mapping. The
      fallback is confined to that family — a private library is never substituted for the official one,
      which would return the right filename with the wrong geometry.
      private library), `${EASYEDA2KICAD}` (36, a converter's output directory), and 8 absolute paths into
      `C:/Users/…`. That part is real, and it is *concentrated*:

      | board | unique models | official lib | in repo | unresolvable |
      | --- | --- | --- | --- | --- |
      | `jetson-agx-thor-baseboard` | 67 | 0 | 1 | **66** |
      | `One-Air-Max` | 40 | 0 | 4 | **36** |
      | `vme-wren` | 66 | 33 | 33 | 0 |
      | `video` | 27 | 23 | 4 | 0 |
      | **all 19 boards** | **392** | 207 (53%) | 78 (20%) | **107 (27%)** |

      The two largest boards are almost entirely unresolvable. **A 3D view of `jetson` would show 1 part of
      67.** Shipping that silently is the viewer-that-lies failure again, in a more expensive costume.
    - **Reuse is the one number in our favour.** `vme-wren` has 1,480 references to **66** unique models —
      22×. Fetch and convert per *unique model*, never per placement.
    - **The format split kills the cheap toolchain — and the second measurement was worse than the first.**
      `.step` is **72%** of *references* (2,598) against `.wrl`'s 1,005; "footprints reference `.wrl`" was
      generalised from one board. `assimp` (in apt, reads WRL, writes glTF) **cannot read STEP** — CAD
      B-rep, needing OpenCascade/FreeCAD to tessellate.
      I then wrote "the official library is mostly `.wrl`", inferring it from those references rather than
      from the library. Checking the library itself, per directory, at both tags:

      | directory | 7.0.11 wrl/step | 10.0.5 wrl/step |
      | --- | --- | --- |
      | `Connector_PinHeader_2.54mm` | 49 / 50 | **0** / 99 |
      | `Resistor_SMD` | 40 / 40 | **0** / 40 |
      | `Capacitor_SMD` | 50 / 50 | **0** / 91 |
      | `Package_QFP` | 49 / 50 | **0** / 62 |

      **Upstream dropped WRL in v9**, and the evidence is the library's own `install()` rules rather than
      its directory listing: `"*.wrl"` and `"*.step"` are both installed at 6.0.11 / 7.0.11 / 8.0.8, and
      only `"*.step"` at 9.0.9 / 10.0.5. So the WRL path is not merely inconvenient — it
      only works against a library version upstream has abandoned. Anything meant to stay current must
      handle STEP, which means carrying a CAD kernel. Ubuntu's "three majors stale" `kicad-packages3d`
      (7.0.11) is simultaneously the *only* easy path and a dead end.
    - **The download is 424 MB, not 5.7 GB** — 5.7 GB is the *installed* size. Worth stating because the
      original framing treated the number as the obstacle, and the download is the part anyone waits for.
    - **The packaged library is three majors stale — and now measured, so it is usable anyway.** Ubuntu's
      `kicad-packages3d` is **7.0.11** while the corpus names `KICAD9`/`KICAD10` paths — the trap already
      documented for `kicad-cli`. "Whether v7 filenames satisfy v9/v10 references" was flagged here as
      unverified; comparing basenames per directory at 6.0.11 / 7.0.11 / 9.0.9 / 10.0.5 says **926 of 965
      v7 names (95%) still exist at v10** — 100% for `Resistor_SMD`, `Connector_PinHeader_2.54mm` and
      `Capacitor_THT`, 86% for `Package_QFP`, 85% for `Package_SO`. So a stale package still answers most
      references, and the ~5% renamed report `missing`, exactly as a genuinely absent file would.
    - **Only 24 model files actually exist in the corpus repos** (42 MB, largest a 24 MB STEP), so even the
      "free, in-repo" slice is ~6% of unique models rather than 20%.
    - **What is therefore deliverable, in order:**
      1. **Coverage reporting ✅.** `classifyModel` + `config.kicad.modelPaths` + `Board.models`, counting
         unique models (reuse is 22×). Reproduces the by-hand survey through the implementation and names
         the variable an operator would map — `ANT3DMDL` (66) on jetson, `EASYEDA2KICAD` (36) on
         One-Air-Max. No assets fetched. Originally: the board index already walks footprints; report
         per board how many parts have a model that *resolves*, and under which variable. Costs almost
         nothing, needs no assets, and is the honest precondition for the rest — it says up front whether a
         board can be shown at all.
      2. **Render the resolvable subset, stating what is missing.** Never a silent partial board.
      3. **STEP needs a CAD kernel, and it must not be in the bridge — measured, not judged.** WRL-only
         would ship a feature that works on the library nobody has and fails on the models repos actually
         contain, so STEP is not optional. Spiked with `occt-import-js` (OCCT compiled to WASM — the only
         realistic in-process option; `assimp` cannot read STEP, FreeCAD is an application rather than a
         library) against real geometry: 13 models from `kicad-packages3D` 9.0.9 and 12 vendor models out
         of the corpus repos.

         | | median | max |
         | --- | --- | --- |
         | official library (13) | **0.37 s** | 6.4 s (`TQFP-100`) |
         | in-repo vendor (12) | **2.7 s** | **101.7 s** (25 MB `hailo8_m.2`) |

         `vme-wren` end to end is **1.7 min** of CPU at those medians, 4.7 min at the means. Peak RSS is
         276 MB for a small part, 531 MB at 4 MB of input, and **1.7 GB** for the 25 MB one — the 750 MB
         board-retention problem again, with a worse constant and in the same process. The `.deb` goes
         **4.03 MB → ~11.6 MB** (7.6 MB of `.wasm`), paid by every operator including those who never open
         a board. `ReadStepFile` is synchronous, so a 6-second QFP would freeze chat and git with it; the
         shipped worker is a *browser* Web Worker, so a `worker_threads` wrapper is ours to write, and each
         worker carries its own WASM heap rather than sharing one.

         Output is the one number in our favour: **11 KB–1 MB per model, ~3.5 MB for a whole board**, and
         with the 22× reuse a converted model is worth caching forever, keyed by content hash — expensive
         exactly once per unique file, across every board and repo that names it.

         **Therefore: convert ahead of time, and keep the kernel out of the bridge.** The bridge only ever
         serves cached meshes, stays 4 MB, and keeps its memory profile. None of this is fatal to 3D; all
         of it is fatal to converting in the request path, which is what "carry a kernel" quietly meant.
         See `docs/worklog/2026-08-03-step-kernel-spike.md`.

  - **Phase 4a — the ahead-of-time model pipeline ✅ done (4a.1 + 4a.2 + 4a.3 all landed).**
      Conversion moves out of the request path entirely. Three parts, and the split is what keeps the
      bridge at 4 MB:
      1. **A content-addressed mesh cache**, shared code in `bridge/src/kicad/meshCache.ts`. Blobs are
         stored under the **sha-256 of the source model bytes** plus a format version, so a part used by
         ten boards across five repos converts once — reuse is 22× *within* a board and higher across a
         corpus.
      2. **A separate converter, `gitview-models`**, which is the only thing that carries OpenCascade.
         It is a CLI, and that alone removes the hardest problem the spike found: a CLI has no event loop
         to block, so synchronous `ReadStepFile` is fine and no `worker_threads` wrapper is needed. It
         reuses `board.ts` / `modelResolve.ts` rather than reimplementing resolution, extracts embedded
         models (base64 + zstd, via `fzstd` — Node 22.14 has no built-in zstd), and writes **glTF binary**
         so the app can use an existing renderer instead of one we write.
      3. **The bridge serves cached meshes and nothing else.** No kernel, no conversion, no new heavy
         dependency; `kicad.meshCache` points at the directory.

      **Availability is answered from a per-board manifest, not by hashing on the request path.** The
      converter writes one manifest per board mapping each raw reference to its mesh hash or a failure
      reason; the bridge reads that instead of stat-ing and hashing model files per request — a 25 MB STEP
      would be hashed on every index otherwise. It also gives embedded models somewhere to be named, since
      they have no host path at all.

      **Staged, because only the first two are bridge-side:**
      - **4a.1 ✅ done.** Cache layout + manifest + converter CLI (`tools/gitview-models`). Verified
        by running: `vme-wren` converted **33/33 embedded models**, every blob re-read and checked as
        valid glTF — 203,694 triangles in 7.3 MB; a re-run reported `converted 0, reused 33`; `video`
        converted **21 models that are all referenced as `.wrl`** against a STEP-only 9.0.9 library,
        proving the twin fallback through to geometry rather than only to resolution. Corrupted and
        truncated blobs are covered by unit tests. See `docs/worklog/2026-08-03-phase4a-pipeline.md`.
      - **4a.1a — the twin is a *preference*, not a fallback ✅ (PR #60, 2026-08-15).** The rule above was
        measured on a STEP-only v9 library, where "try the sibling when the named file is absent" is
        indistinguishable from "prefer the sibling". On a **v6–v8** library the two diverge and the
        fallback loses: the `.wrl` is present, resolves as named, counts as `present`, and then dies at
        conversion as `unsupported-format`. `video.kicad_pcb` against the v7 library — 175 references over
        27 unique models, all `.wrl` — went **24 resolved / 0 converted → 23 of 27 converted**, measured in
        both directions on the same machine. Three further defects came out of the review of that PR, each
        reproduced before it was fixed: the two STEP spellings were not twins of *each other* (a `.step`
        reference took a `.wrl` over the `.stp` beside it; 28 `.stp` references in the corpus); the
        extension was lowercased before the path was rebuilt, so an uppercase reference could never match
        its own file (**22 `.STEP` references**, all project-local, unresolvable on any Linux bridge); and
        probing the twin first let a symlinked-out `.step` mask an honest `.wrl` *and* report the board as
        escaping its mapped directory when it had not. `viaTwin` is consequently **no longer a v9+ signal**
        — on v6–v8 it now fires for nearly every official-library model, and it no longer counts a
        case-only match, which is the same part in the same format.
        Exercised through the app, not just the endpoint: on an emulator, long-pressing `J7` on
        `StickHub.kicad_pcb` fetched, parsed and **rendered** a model that resolved to nothing before —
        `CM5_MINIMA_3` went 20/32 → **22/32** ready and `StickHub` 10/12 → **11/12**, the difference being
        exactly the uppercase project-local models.
        See `docs/worklog/2026-08-15-kicad-project-viewer.md`.
      - **4a.2 ✅ done.** The board index reports mesh coverage from the manifest (never recomputed), and
        `GET …/kicad/model?path=&model=` serves the `.glb`. Verified against the running bridge: `video`
        reports **ready 21** (48,225 tris, 2.08 MB) and `vme-wren` **ready 33** (203,694 tris, 7.69 MB);
        fetching one returned **200 `model/gltf-binary`, 109,344 bytes, parsing as glTF with 2,498
        triangles**. `model` is client input used *only* as a manifest lookup — what becomes a path is the
        manifest's own key, and only after it is confirmed to be 64 hex characters. Traversal in either
        `model` or `path`, an unbuilt board, a `.wrl`, a deleted blob and a missing token were each
        exercised over HTTP and answer distinctly (401 for the last).
      - **4a.3 ✅ done.** The app's 3D view — long-press a part on the board, Filament core draws the
        cached `.glb`. Verified on all three form factors with the same part (`C39`): phone (POCO F3,
        `arm64-v8a`, real GPU, signed release build), tablet and Color E-Ink (both x86_64 under Mesa
        `llvmpipe`). Three things were only findable on a device: a `SurfaceView` in this tree never
        receives a surface (it draws into a `TextureView` instead), `Filament.init()` must precede every
        other engine call, and the camera distance has to come from the field of view and viewport aspect
        or a part that frames well on a tablet clips on a phone.

      **What this does not fix:** the 27% that names someone else's machine stays unresolvable, so a
      board like `jetson` still shows 1 part of 67. The pipeline makes the resolvable part *renderable*;
      it cannot invent geometry nobody published.
    - **Unchanged:** per-component instances, not a merged model (ADR-038), so a tap ray-casts to a refdes;
      merging is lossy and retrofitting tap-to-highlight would mean redoing the export.
      - **Changed:** 3D is **not** hidden under the Color E-Ink profile. The guess that it would be
        "close to pointless" there did not survive contact with the panel — it renders and reads fine.
        What it did need was a palette taken from the theme rather than two hardcoded constants: an
        unpainted part measured **2.4:1** against the viewport on e-ink and **3.5:1** on Standard dark,
        inside a UI running ~20:1. Now **7.7:1** and **6.1:1**.
    - **Verify:** coverage numbers against this corpus *before* any asset is downloaded or any renderer is
      written.
  ⚠️ **Prerequisite:** no KiCad files exist in any served repo. The corpus is the **KiCad 10.0.5 demos**
  (115 schematics, 19 boards) pulled from GitLab as a path-filtered archive of `demos/` at that tag — no
  KiCad install needed. Target is **KiCad 10**; Ubuntu's `kicad-demos` is 7.x and three majors stale.
  For *netlist* scoring the 7.x corpus is used anyway, because Ubuntu packages only `kicad-cli` 7 and the
  oracle has to be a KiCad that can open the files. The connectivity rules are not version-specific, and
  the KiCad 10 corpus still gets the position-based probe over all 115 sheets, so both are covered.
  A *dense* real board is still what will expose legibility on the 1264×1680 mono e-ink panel, which is
  the constraint likelier to bite than rendering.
  Verify: each phase on all three form factors; Phase 0 against a ground-truth netlist rather than by eye.


- **A bridge machine cannot serve 3D without hand-assembly ⬜ (packaging + bridge, ADR-038 follow-up)** —
  v0.1.15 ships the 3D viewer and a freshly installed bridge still cannot serve a single mesh. The bridge
  deployed here proves it: upgraded to 0.1.15, healthy, serving 2D — and `kicad.meshCache` is empty with
  `modelPaths` `{}`, so a long-press finds nothing with a mesh. **2D needs nothing at all**: the bridge
  parses `.kicad_sch`/`.kicad_pcb` itself, no KiCad install, no external binary, which is why the `.deb` is
  3.9 MB. 3D needs three things the package does not provide, and only two of them *can* be packaged.
  - **A. Config the package can set for you ✅ done (packaging; cheap, no size cost).** `postinst` creates
    `/var/lib/gitview-bridge/meshes` and points `kicad.meshCache` at it so the value is never empty by
    default; probes for the official library and maps it if found; `Suggests: kicad-packages3d` so apt
    hints at it; a commented example for the private variables; and the install summary says which of
    those happened. **One entry, not six** — the plan overstated this: `libVarFor` (`board.ts`) already
    aliases every official name onto whichever one is mapped, newest first, so six identical lines would
    be busywork that costs coverage the day one is missed. **Highest value per line changed:** 207 of 392 unique
    models in the corpus (**53%**) resolve to the official library, so this alone is the difference
    between "nothing renders" and "most parts render" on a machine that has it.
    Verified both ways. **Library absent** (on a second machine, which is the risky branch): no conffile
    prompt, config written, mesh cache created, bridge starts and serves. **Library present** (7.0.11,
    detected as `KICAD7_3DMODEL_DIR`): mapped, and measured against corpus boards —

    | board | library mapped | no library |
    | --- | --- | --- |
    | `video` | **24 present**, 0 unmapped | 1 present, 23 unmapped |
    | `vme-wren` | **29 present** + 33 embedded, 0 unmapped | 0 present + 33 embedded, 33 unmapped |

    `video` references three generations (`KICAD6`/`7`/`8_3DMODEL_DIR`) and all resolve through the single
    mapped entry, which is the aliasing working end to end.
    Two defects were caught before shipping, both recorded in the worklog: a bare `modelPaths:` with only
    comments under it parses as `null`, which the schema **rejects** — a fresh install without the library
    would not have started at all; and `postinst` edits the conffile the package ships, so documenting the
    block in that template made `dpkg` prompt interactively on every upgrade.
  - **B. Ship the converter ⬜ (packaging).** `tools/gitview-models` is 12 MB on disk, but 7.3 MB of that
    is the OCCT WASM and it xz-compresses to **2.2 MB** — the package goes 3.9 MB → ~6 MB. This does not
    breach "no CAD kernel in the bridge": that rule is about the serving *process*, and the bridge would
    still never load OCCT. `/usr/bin/gitview-bridgectl` already ships, so `gitview-bridgectl kicad
    convert <repo>` is the natural home rather than a second binary on `PATH`.
    Verify: on a fresh install, that subcommand populates a cache the *running* bridge then serves —
    exercised through the app on a device, not by checking that files appeared on disk.
  - **C. On-demand conversion ⬜ (bridge) — ADR written, see ADR-040 Decision 5.** With B shipped the
    bridge could spawn the converter when a board is opened, which is the only version of this that truly
    "just works". It is a real change to a deliberately ahead-of-time pipeline, so it needed an ADR before
    any code: what bounds the work (one board here has 1,480 references to 66 unique models), what the
    request that triggered it does meanwhile, and what stops two concurrent requests converting the same
    model twice. The cache is already content-addressed and writes atomically via `rename`, which is most
    of the concurrency answer already. **Now folded into the project-viewer work below**, because the case
    that most needs it — a model committed in the repo — is also the case that needs no operator at all.
  - **D. Say any of this in `docs/SETUP.md` ⬜ (docs).** It currently says nothing about KiCad, so the
    prerequisites are discoverable only by reading `bridge/src/config.ts`. Worth stating even before A–C
    land, including the part that is good news — 2D needs no setup whatsoever.
  **Cannot be packaged, at any effort:** the mesh cache *contents*, which are derived from the operator's
  own boards and libraries; and `modelPaths` for private variables (`${ANT3DMDL}` and friends), which only
  the operator knows. That is the same 27% measured above, and no amount of packaging moves it.
- **3D viewport contrast — investigated, no defect ✅ (2026-08-16).** Briefly recorded here as a bug and
  it was not one. An unpainted part measured **1.00:1** against the viewport, against ADR-038's 4.5:1
  floor — but the capture came from an emulator booted with `-gpu swiftshader_indirect`, which
  [`.ai/AGENTS.md`](../.ai/AGENTS.md#verifying-changes) already warns renders 3D as nothing. Re-measured
  under `-gpu host` on Xvfb (llvmpipe, OpenGL ES 3.0), on all three form factors:

  | | backdrop | part | contrast |
  | --- | --- | --- | --- |
  | phone | `(28,30,35)` | `(196,189,172)` | **8.91:1** |
  | tablet | `(28,30,35)` | `(196,189,172)` | **8.91:1** |
  | Color E-Ink | `(225,221,215)` | dark | **15.5:1** |

  `viewerPalette` is working, including the inversion to a dark part on the e-ink paper backdrop. The
  lesson is the one the rules already state and this still got wrong: *an emulator reproducing a bug is
  not an emulator artefact* — but an emulator configured against the documented requirement is not
  evidence of anything. Check the renderer before believing the pixels.

- **KiCad viewer opens files, but a KiCad design is a project ⬜ (bridge + app, ADR-040)** — owner-reported:
  "if the KiCad project has project-specific symbols, footprints, 3D models, there's no way to render it
  here." **Checked before planning, and only the third is true** — which is what makes this tractable.
  KiCad 6+ files are self-contained: the `interf_u` demo's project-local `${KIPRJMOD}/interf_u.kicad_sym`
  is fully embedded in the `.kicad_sch` (all 18 `lib_symbols` definitions are `interf_u:*`), and
  `StickHub.kicad_pcb` carries its 94 footprints as 1,417 inline primitives. Symbols and footprints already
  draw. **3D models do not, and that is the cheap case**: a `${KIPRJMOD}` model is committed in the repo —
  24 unique ones in the corpus, **24 of 24 present** — needing no operator mapping, no 5.7 GB library and
  no download, yet none can be shown because conversion is a CLI somebody has to log in and run.
  Flow today is file-shaped: `isKicadPath` matches `.kicad_sch`/`.kicad_pcb` only, each opens its own tab,
  3D is a long-press modal over one part. Flow decided in **ADR-040**: the `.kicad_pro` is the entry point,
  tabs are what the project actually has, and 3D is the assembled board.
  - **A. Bridge ⬜ — everything verifiable by curl before an app change exists.**
    - `GET /v1/repos/{repo}/kicad/project?path=…&ref=…` → what this project has *at this ref* (root sheet,
      board, sheet tree, coverage). Tabs must not be a fixed triple: of 36 corpus projects **17** have both
      halves, **18** are schematic-only and **1** is board-only, so a fixed `schematic|pcb|3D` shows a dead
      tab on more than half. Only the bridge knows what exists at a ref — the same reason `counterpart` is
      a bridge answer and not an app guess.
    - Carry the per-model `(offset)`/`(scale)`/`(rotate)` that `BoardComponent` currently drops. On
      `StickHub` **24 of 93** model blocks have a non-zero one; without them a quarter of the parts sit
      visibly wrong, and this is a prerequisite for B's 3D tab rather than a nicety.
    - Read `${KIPRJMOD}` and relative models as **git blobs at the requested ref** instead of from the
      working tree (`rest.ts` passes `projectDir: join(r.path, dirname(path))` today, with a comment
      conceding the compromise). Correct for history, needs no worktree, and is what makes on-demand
      conversion tractable. Library models under `${KICAD*_3DMODEL_DIR}` stay filesystem lookups.
    - On-demand conversion, bounded per ADR-040 Decision 5 — unique models only, existing size ceiling,
      answer the request with what is ready rather than blocking it.
    Verify: curl each case against a served corpus repo — schematic-only project, board-only project,
    multi-sheet hierarchy (13 of 36 corpus projects have more than one sheet), a path containing a space
    (the corpus has a directory literally named `sonde xilinx`), traversal in `path`, and a cold cache that
    warms. Conversion is verified through to a `.glb` that parses, never to a coverage count — resolution
    succeeding is not rendering succeeding, which is exactly how the 24-present/0-convertible bug hid.
  - **B. App ⬜ — the project shell.** Tabs driven by A's response; schematic tab gets a sheet **tree**
    rather than the current flat switcher (13 of 36 projects are multi-sheet, and the owner's are);
    direct `.kicad_sch`/`.kicad_pcb` opens show the source with a persistent "Open in KiCad viewer →"
    banner; cross-probe retargeted at the project view, or "show on board" drops the user into a text
    buffer. The **3D tab is the assembled board** — substrate from `Edge.Cuts`, instanced placements, tap a
    part to focus it, which is where the existing per-part viewer goes. Affordable because ADR-038 already
    exports per-component instances: `vme-wren` is 1,480 placements over **66** unique geometries, so it is
    66 buffers and 66 instanced draws, not 1,480 of anything.
    Verify: on all three form factors, per the standing rule, on the densest corpus board rather than a
    demo — and on a bridge with an empty mesh cache, because "3D tab on a cold bridge" is a state to design
    and not a blank panel. Remember the `AndroidView` trap: the renderer's identity must stay stable or the
    factory never re-runs and the viewport freezes on its last frame.
  ⚠️ **Depends on B of the item above** (ship the converter in the `.deb`) — on-demand conversion has
  nothing to spawn on a packaged bridge until that lands.
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

## Transport security — TLS on the bridge, pinned at pairing ⬜ *(ADR-039, backlog)*

**Wanted, deliberately not built yet.** Recorded so it is a tracked gap rather than an assumption nobody
revisits. Full reasoning in [DECISIONS.md → ADR-039](DECISIONS.md).

The short version: **the bridge has no TLS and cannot be given any** — `Fastify({ bodyLimit, logger:
false })`, no `https` option, nothing in the config schema — and the app ships a blanket
`android:usesCleartextTraffic="true"`. Every confidentiality claim rests on a tunnel, and **a VPN is not
a hard requirement for this project**. So in the common case the device bearer token crosses the network
in cleartext on every request, and that token is repo write, `git push`, Claude sessions, and a **PTY
shell on the host** (`terminal.enabled` defaults to `true`).

- **The design:** the bridge generates a self-signed certificate on first run beside `tokens.json`; its
  SHA-256 fingerprint travels over the pairing code, which is *already* an out-of-band channel; the app
  pins it per bridge exactly as it pins a token. TOFU with out-of-band verification — no CA, no public
  DNS, no rotation chore.
- **The obvious interim does not exist — checked, not assumed.** A `network_security_config.xml` is
  static XML compiled into the APK and matches `<domain>` entries, not CIDR ranges; the bridge address
  is entered by the *user at runtime* (`AppViewModel` builds `BridgeApi` from a stored `baseUrl`), so a
  shipped app cannot know what to permit. "Private ranges" would also be the wrong set: this project's
  tailnet addresses are in `100.64.0.0/10`, which is not RFC1918, and the LAN address is DHCP.
- **What is implementable instead:** show it. The app knows the scheme and host at runtime — a
  non-loopback `http://` connection is unencrypted, and the bridge list and pairing screen can say so.
  Fixes nothing cryptographically; stops the exposure being invisible.
- **Costs:** a cert-generation dependency in the bridge, an `X509TrustManager` in the app, a pairing
  payload change, and a re-pair-or-grandfather decision for already-paired devices.
- **Blocks a nearby decision:** response compression. gzip inside TLS with attacker-influenced request
  content is the CRIME/BREACH shape, so compression should be settled *with* TLS, not before it —
  relevant because meshes gzip to 9–20% and that is otherwise free money.
- **Verify:** pair a device against a TLS bridge and confirm it pins; confirm a *different* certificate
  on the same address is refused rather than silently accepted; confirm a pre-TLS device still works or
  is told to re-pair, whichever is chosen.


## Out of scope
Cloud multi-tenant service; running the agent or a full IDE on the phone; parsing internal Claude
transcript files; a Boox/Onyx hard dependency; treating either display profile as secondary.
