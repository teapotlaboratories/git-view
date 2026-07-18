# GitView Build Plan

Phased delivery. **MVP = phases 0–3.** Each phase lists its goal, the key work, and how it maps to
what already exists in this scaffold. ✅ = scaffolded and building; 🧱 = stubbed/partial; ⬜ = not started.

## Phase 0 — Walking skeleton ✅
Bridge boots, serves `/v1/health`, pairs, and returns `/v1/repos`; app builds to an APK and lists a
saved connection. **Status:** bridge boots + pairs + reads verified end-to-end; APK assembles.

## Phase 1 — Read viewer ✅ (highlighting = 🧱)
Lazy file tree, blob view, refs/log/diff/blame/show/status; BOTH DisplayProfiles auto-selected per
device with the Color E-Ink software base.
- Bridge: `git/gitService.ts` (tree/blob/log/refs/diff/blame/show/status; working-tree lists
  untracked files; blobs as Buffer). ✅
- App: `FileTreeList`, `CodeEditorView` (Sora), `BrowseScreen`, DisplayProfile system. ✅
- **Remaining (🧱):** wire Sora TextMate grammar + tree-sitter and apply `eink-mono.json` on the
  e-ink profile; diff viewer UI; pagination scrolling on e-ink.

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

## Phase 4 — Multi-repo / machine / session + fs watcher ⬜
Multiple repos per machine, multiple machines, saved connections, multiple concurrent chats per repo;
repo-change push. Scaffolded hooks: `repos` list, `LiveChannel.broadcastRepoChanged`, per-connection
store. **Remaining:** an fs watcher (chokidar/`fs.watch`) emitting `repo.changed`; multi-session UI.

## Phase 5 — Tailscale + pairing ✅ pairing / ⬜ docs-only Tailscale
Pairing is implemented. Tailscale Serve is an operational step (see [SETUP.md](SETUP.md)); nothing to
build in the bridge beyond binding loopback.

## Phase 6 — Confined-MCP write surface + Remote Control polish ✅ core
`createSdkMcpServer` surface (`mcp__gitview__*`) and the `confined-agent` profile are implemented.
**Remaining:** Remote Control lifecycle polish (reconnect after outage, one-connection enforcement).

## Phase 7 — Hardening + audit log + optional safety dials ✅ audit / 🧱 dials
Audit log implemented. **Remaining:** surface the optional dials (approve-each-write, isolated
worktree, stricter egress) in config + app; rate limiting; token revocation UI.

## Phase 8 — E-ink on-device refresh tuning ⬜
On the actual Bigme B7 Pro: determine/integrate the refresh hook (or finalize E-Ink Center guidance),
tune clean-flash cadence, batch interval, and the Kaleido-3 palette; verify `EInkRefreshController`
no-ops cleanly on non-Bigme devices. See [EINK.md](EINK.md).

## Out of scope
Cloud multi-tenant service; running the agent or a full IDE on the phone; parsing internal Claude
transcript files; a Boox/Onyx hard dependency; treating either display profile as secondary.
