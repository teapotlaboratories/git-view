# Terminal / SSH — bridge foundation

Request: "in addition to files and chat, I want to be able to have SSH." Owner picked (AskUserQuestion):
**host terminal** (not remote-SSH), **on by default** (I kept it disableable), **full shell starting in
the open repo**.

## Bridge (this pass — done + verified)
- `config.terminal` = `{ enabled: true (default), shell? }`. Disable with `enabled: false`.
- Wire frames: client `terminal.open {termId, repo?, cols?, rows?}` / `terminal.input` / `terminal.resize`
  / `terminal.close`; server `terminal.data {termId, data}` / `terminal.exit {termId, code}`. termId is
  client-generated → one WS can hold several terminals.
- `terminal/ptyTerminal.ts`: spawns `script -qefc "$SHELL -i" /dev/null` (the same no-native-module PTY
  trick the login relay uses), cwd = the requested repo's dir (else run-user home), COLUMNS/LINES from the
  open frame. Pure JS → the `.deb` stays ~4MB / `Architecture: all`. **Limitation:** `script` owns the PTY
  master so we can't `TIOCSWINSZ` after spawn — no live resize (a `node-pty` optional-dep build could add
  it, at the cost of an arch-specific `.deb`).
- `LiveChannel`: per-connection `terminals` map; disconnect (close/error) SIGKILLs the process group so a
  closed app never orphans a shell. Gated by `terminal.enabled`; **audited** (`terminal.open`, actor app,
  repo, shell). `features.terminal` on `/v1/health` so the app can show/hide the view.

### Verified (live WS against a scratch bridge)
`terminal.open {repo:r}` → `pwd` shows the repo dir, `echo $((6*7))` → `GV-MARKER-42` (real shell),
`exit` → `terminal.exit code=0`; audit line written; `features.terminal=true`. Bridge suite: 111 pass
(added `terminal` to the openFlow Config fixture).

## Security note (⚠️)
A shell here is arbitrary code execution as the bridge's run-user — the same access that account has.
On by default per the owner; disable with `terminal.enabled: false` (routes/feature gone). Every open is
audited. SECURITY.md gets the full write-up when the app side lands (Markdown + HTML twin together).

## Next: app side (needs an owner decision)
`WorkspacePane.TERMINAL` + View-menu entry + a terminal-emulator view. Renderer fork: Termux
terminal-view (robust, TUIs work, **GPLv3** → app relicenses) vs a self-contained MIT Compose ANSI
renderer (basic shell fine; vim/htop limited).

## App side — done + verified on-device (phone)
- `WorkspacePane.TERMINAL` + a "Terminal" entry in the View menu (shown only when `features.terminal`).
- `ui/terminal/TerminalEmulator.kt`: a self-contained, **MIT** line-oriented ANSI/VT model (SGR colors +
  bold, `\r \b \t`, erase-line/clear-screen, in-line cursor moves, OSC-title ignored; unknown escapes
  swallowed). No terminal-emulator dependency → app stays MIT. Full-screen TUIs (vim/htop) out of scope.
- `ui/terminal/TerminalPane.kt`: colored scrollback (auto-tail, horizontal scroll) + a line-mode input
  (type → Run/Go sends `line\n`) + raw `^C` / `^D` / Tab chips. "New shell" after exit.
- Wire: `ServerEvent.TerminalData/Exit`, `BridgeClient.terminalOpen/input/resize/close`; VM
  `openTerminalIfNeeded` (on pane show) / `terminalInput` / `closeTerminal`, feeding the emulator.

**Verified (phone AVD → real host bridge, redeployed 0.1.7):** View → Terminal opens a shell in the
repo dir; `pwd` → `/home/argonite/Developments/git-view`; `ls` renders the repo files with **directory
colors** (ANSI SGR parsed). Screenshot `2026-07-24-terminal-app.png`. Bridge suite still 111 pass; app
builds clean.

## Still to do before release
- **SECURITY.md** (+ its HTML twin) write-up: terminal = full host shell as the run-user, on by default,
  disable with `terminal.enabled: false`, audited.
- On-device pass on **e-ink** (phone path, should match) — phone confirmed.
- Tablet has no pane switcher, so no terminal there yet (follow-up: surface it in the tablet split).
- Line-mode input: live tab-completion / arrow-history are limited (raw char-by-char would need a
  custom input connection). ^C/^D work.

## Three-form-factor verification (device screenshots)
Ran each AVD one at a time (per .ai/ "never boot all three at once") against the live 0.1.7 bridge
(`features.terminal:true`). Captured via screenrecord+ffmpeg (headless screencap is stale).

- **Phone** (kancil_test, 1080×2340, release 0.1.7) — `2026-07-24-terminal-phone.png` +
  `-phone-viewmenu.png`. The View chip **relabels to the active pane**: it reads "Files" on the
  explorer, and the combined menu lists **View: Files ✓ / Chat / Terminal** then the Git actions.
  Tapping Terminal opens a shell in the repo dir; the chip now reads **"Terminal"**; `ls` renders with
  ANSI directory colors.
- **E-Ink** (bigmeB7, 1264×1680, E-Ink DisplayProfile ON, debug 0.1.7 — release key won't install over
  the panel's existing debug build; same source) — `2026-07-24-terminal-eink.png`. Same flow in the
  high-contrast/hueless profile: chip relabels Files→Terminal, the View menu renders, and the terminal
  surface keeps its dark ANSI rendering (a code surface, like the editor/diff — intentionally not
  huelessed). `ls` shows colored dirs. (Had to re-pair: reinstall drops the token; minted a fresh code
  via `gitview-bridgectl pair` / SIGHUP.)
- **Tablet** (tabS8, 2560×1600 landscape, debug 0.1.7) — `2026-07-24-terminal-tablet.png`. The tablet
  uses the **two-pane split** (Explorer + editor + a permanent Chat/Sessions pane), so it has **no pane
  switcher**: the right chip stays **"Git"** and its menu is Git-only (no View section, no Terminal).
  **The terminal is phone/E-Ink only for now** — surfacing it in the tablet split is a tracked
  follow-up (PLAN.md). This is the honest "where possible" gap called out by the .ai/ screenshot rule.

## Iteration 2 — per-repo terminals + direct console input (owner-requested)
- **Per-repo shells.** `UiState.terminal/terminalId/terminalExited` → `terminals: Map<repoId, TermSession>`.
  `openTerminalIfNeeded`/`terminalInput`/`closeTerminal` act on the ACTIVE repo; `onEvent` routes
  terminal.data/exit by termId across the map; a socket drop marks every session exited. The pane's
  `LaunchedEffect` is keyed on `activeRepo` so switching repos attaches that repo's own shell.
- **Direct input.** Removed the line-edit `OutlinedTextField`/Run. Input now streams to the PTY key-by-key
  via an invisible anchor-and-reset `BasicTextField` (`ConsoleKeyInput`): typed chars (incl. `\n`) forward
  raw, deleting the zero-width anchor sends DEL. Tapping the console (or opening the pane) focuses it and
  shows the keyboard; a slim ^C/^D/Tab/Esc/↑↓← control row supplies un-typable keys. `imePadding()` +
  the existing `adjustResize` lift the console above the keyboard.
- **Verified on the phone (release 0.1.7 over the live bridge):** git-view shell (`pwd` → git-view dir) and
  `main` shell (`~/Developments/main`) are independent — switching repos switches shells and each keeps its
  own scrollback (a marker typed in `main` did NOT appear in git-view). Direct typing runs commands; backspace
  works (`pwdx`⌫→`pwd`); keyboard auto-shows and the console resizes above it. Screenshots
  `2026-07-24-terminal-direct-input.png`, `-per-repo-main.png`, `-per-repo-gitview.png`.

## Iteration 3 — pinch-to-zoom
- `TerminalPane` gains a pinch handler: a 2-finger-only `awaitEachGesture` that consumes ONLY multi-touch
  (via `calculateZoom()`), so single-finger scroll/tap/type are untouched. It scales the font (0.6–2.6×,
  base 13sp) applied to the scrollback `Text`.
- **Correction:** the first cut used a pane-local `rememberSaveable`, which does NOT persist — the pane
  fully unmounts on a pane/repo switch (bare `when(activePane)`, no SaveableStateHolder), so it reset to 1×.
  Fixed by hoisting the scale to the ViewModel. **Then made it per-repo** (owner request): the scale lives in
  `UiState.terminalFontScales: Map<repoId, Float>` (`setTerminalFontScale` writes the active repo's key,
  `activeTerminalFontScale` reads it), so each repo remembers its own zoom and it survives switches + rotation
  for the process lifetime (cross-launch would need DataStore; not done).

## Iteration 4 — tighten terminal line spacing (owner request)
- Terminal rows used Compose's default leading + platform font padding (~1.4× line height), leaving big gaps
  between lines. Fixed with a shared `TERM_TEXT_STYLE` (`includeFontPadding=false`, `LineHeightStyle` trim=Both,
  center) + `lineHeight = fontSize` on each row, so lines hug the glyphs like a real terminal.
- **Verified on the phone:** `ls` + `pwd` output now renders tightly packed (screenshot
  `2026-07-24-terminal-tight-spacing.png`); no input/scroll regression.
- **Verified:** compiles; on the phone, single-finger typing/scroll and command output still work (no
  regression from the added detector). The pinch gesture itself is NOT automated-tested — multi-touch can't
  be driven through adb on a headless emulator; needs a real finger to confirm the zoom feel/bounds.

## Iteration 5 — cross-bridge terminal leak (owner-reported) + git-op fixes
- **Bug:** switching bridges kept showing the previous bridge's terminal. Root cause: `openRepo` only
  dialed `connectLive()` when `live == null`, and `selectConnection` swapped the REST client but never tore
  down the old bridge's live channel — so `live` stayed on the old bridge, and the `terminals` map (keyed by
  repo id, which collides across bridges, e.g. "main") surfaced the stale session.
- **Fix:** `selectConnection` now, when the bridge actually changes, cancels `liveJob`, closes `live`
  (old shells die with the socket), nulls it (so `openRepo` reconnects to the new bridge), and clears
  `terminals` + `terminalFontScales` (both repo-id-keyed, connection-scoped).
- **Verified on-device:** two bridges (demo :8787 and n2 :8899) each serving a repo **id "main"** (different
  dirs). demo/main → shell in `~/Developments/main`; switch to n2/main → **fresh** shell in
  `~/Developments/second-main` (screenshot `2026-07-24-terminal-crossbridge-fixed.png`) — no carry-over.
- Also this cycle: git-op fixes — push auto-set-upstream, commit "Nothing to commit" (422), and a clear
  "commit or stash first" checkout message (owner picked the message-only option). Verified against a live
  bridge; both dev + quartz bridges redeployed with the updated `.deb`.

## Known follow-up (not a regression from this work)
- Direct terminal input occasionally doubled characters under very rapid injection during automated testing
  ("echo" → "eececho"). Not reproduced in normal human-paced typing (ls/pwd/commands worked); flagged to
  re-check on a real device / with a debounced diff in ConsoleKeyInput if it shows up.

## Iteration 6 — pinch zoom snapped back to 1× (owner-reported)
- **Bug:** pinch appeared to do nothing / reverted to the original size. Root cause: after hoisting the
  scale out of the pane, the pinch handler lived in `pointerInput(Unit)` and read the `fontScale` PARAMETER,
  which is captured once (stale at 1×) because a Unit-keyed block never restarts. So every event computed
  `1 × zoom` (zoom = the tiny per-event ratio from `calculateZoom()`) → the result hovered at ~1× → snap-back.
- **Fix:** accumulate locally within the gesture — `var scale = latestScale` at `awaitFirstDown` (seeded via
  `rememberUpdatedState(fontScale)` so it's the current value, not stale), then `scale = (scale*zoom)…;
  onFontScale(scale)` per event. The running scale no longer depends on recomposition timing or a stale capture.
- **Verification:** compiles. Could NOT drive the pinch on the headless emulator to confirm visually — the
  AVD exposes ~11 `virtio_input_multi_touch` devices and synthetic MT `sendevent` (even as root) didn't route
  to the app's window; `adb input` has no pinch. So the gesture itself is unverified on-device (tooling
  blocker), but the root cause + fix are the textbook stale-capture pattern. Needs a real-finger confirm.

## Iteration 7 — "no path on working tree" creating a branch on an empty repo (owner-reported)
- **Bug:** on a fresh repo with no commits (unborn branch), creating a branch errored with git's
  "ambiguous argument 'HEAD' … path not in the working tree". The `git checkout -b` actually SUCCEEDS;
  the failure was the bridge's post-check `git rev-parse --abbrev-ref HEAD`, which throws on an unborn HEAD.
- **Fix (bridge only, no app change):** `gitWrite.checkout` now reads the new HEAD via
  `symbolic-ref --short HEAD` (works on an unborn branch) → falls back to `rev-parse --short HEAD` for a
  detached checkout → then the requested ref. Also improved `gitService.repoState` the same way so an empty
  repo shows its real branch (e.g. "master"/"newbranch") instead of "HEAD".
- **Verified against a live bridge:** create-branch on an empty repo → `{"ok":true,"oid":"newbranch"}` (200,
  was 422); repo state branch = "newbranch". Bridge suite green; tsc clean.
- Rebuilt `.deb` and redeployed to BOTH the dev bridge and quartz (fix confirmed in the deployed code).

## Iteration 8 — working-tree diff empty for untracked-only changes (owner-reported)
- **Bug:** a repo whose only change was a NEW (untracked) file showed "1 dirty" but an EMPTY working-tree
  diff. Cause: the diff endpoint ran plain `git diff`, which by design ignores untracked files (only the
  dirty COUNT, from `git status`, includes them).
- **Fix (bridge only):** `gitService.diff` (worktree kind) now lists untracked files
  (`ls-files --others --exclude-standard`), briefly marks them intent-to-add (`git add -N`), runs `git diff`
  (so they render as new-file diffs alongside tracked edits), then `git reset -q -- <paths>` to undo —
  leaving the index exactly as it was. Allowlisted `ls-files` (read) + `reset` (write). Works on an empty
  (unborn) repo, where `restore --staged` can't (no HEAD).
- **Verified against a live bridge:** worktree diff of the `main` repo (only `?? test.md`) now returns the
  new-file diff; repo state restored to `?? test.md` afterward (index clean). tsc clean; suite 114 pass.
- Rebuilt `.deb`, redeployed to dev + quartz (fix confirmed in deployed code). Bridge-only — no new APK.

## Iteration 9 — working-tree diff kept refreshing (regression from iteration 8)
- **Bug:** the untracked-diff fix (iter 8) ran `git add -N` / `git reset` on the REAL `.git/index`. The repo
  watcher watches `.git/index` as a git-state signal → each diff mutated it → `repo.changed` broadcast →
  the app re-fetched the worktree diff → mutated again → infinite refresh loop.
- **Fix:** run the intent-to-add against a THROWAWAY copy of the index via `GIT_INDEX_FILE` (seeded from the
  real index, discarded after), so the real `.git/index` is never written. Added an optional `env` arg to the
  `git()` helper for this; dropped the temporary `reset` allowlist entry (no longer needed). Same diff output.
- **Verified against a live bridge:** the worktree diff still shows untracked files, and the real `.git/index`
  is byte-identical (mtime/size/inode) across repeated diff calls → the watcher stays silent → no loop.
  tsc clean; suite 114 pass. Rebuilt `.deb`, redeployed to dev + quartz. Bridge-only — no new APK.
