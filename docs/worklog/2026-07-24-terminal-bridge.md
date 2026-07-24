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
