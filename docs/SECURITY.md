# GitView Security Model

GitView is **full read/write, low-friction**: the app edits/commits and Claude runs tools without a
per-action approval gate in normal use. That is a deliberate, powerful posture — **a valid bearer
token is effectively arbitrary code execution on the bridge host.** The protections below are what
make it acceptable for single-user, personal use.

## Threat model
- **In scope:** a lost/leaked token; a malicious or buggy client request trying to escape the repo;
  prompt-injection steering the agent; accidental exposure of the bridge to the public internet.
- **Out of scope:** a compromised bridge host OS; a malicious owner; multi-tenant isolation (this is
  single-user by design).

## Perimeter — keep it on a trusted network
The bridge binds **`0.0.0.0`** by default so a phone on your LAN/tailnet can reach it directly; every
request is still pairing-token gated. Because it is a **read/write** bridge, keep it behind a firewall
or VPN — the hardened setup is **Tailscale**: set `bind: 127.0.0.1` and front it with **Tailscale Serve**
(auto-TLS, reachable only from your tailnet, zero public exposure). **Never put a read/write bridge on a
public URL.** Cloudflare Tunnel (authenticated) is a documented fallback. See [SETUP.md](SETUP.md).

## Authentication
- Bearer token on **every** request except `POST /v1/pair` and `GET /v1/health` (the auth hook
  exempts exactly these — you can't obtain the first token otherwise).
- Pairing code → token exchange; the code is short-lived (~10 min), printed to the bridge console, and
  rotates after a successful pair. It is **never exposed over the network** — surfacing it requires host
  console/journal access, which is the root of trust for authorizing a new device. Send the bridge
  **SIGHUP** (`kill -HUP <pid>`, or `systemctl reload gitview-bridge`) to mint + print a fresh code at
  runtime without a restart; already-issued tokens are unaffected.
- Tokens are compared in **constant time** (`timingSafeEqual`), stored `0600` on the bridge, and in
  the **Android Keystore** (EncryptedSharedPreferences) on the device — never in the URL, never in
  Room, never in logs.
- **Tokens are per-device and hashed at rest** (ADR-035). A token is `<deviceId>.<secret>` and the
  bridge persists only `sha256(secret)`, so the state file **grants nothing if it leaves the host** —
  a backup, a synced dotfile, a bad `chmod`, a copied disk image. Note the bound: because the terminal
  is already RCE as the run-user, this does **not** defend against someone who can read the file
  *locally* (they could just run commands) — it defends against the file being carried off. A plain
  SHA-256 is correct here: the secret is 32 random bytes, not a human password, so there is nothing to
  brute-force and a slow KDF would only tax every request.
- **Revocation is per-device and immediate.** `DELETE /v1/devices/:id` drops the token *and* closes
  that device's live sockets with `4401`, killing its terminals — a WebSocket authenticates only once
  at connect, so without that a revoked device would keep streaming until it happened to disconnect.
  Revoking a device cannot be done from that same device (403), so a request can't sever itself.
- **Audit entries carry the acting device** (`device: "dv_…"`), so with several devices paired the log
  attributes each write and `terminal.open` to one of them rather than an anonymous `"app"`.
- **Legacy tokens** issued before ADR-035 keep working (no forced re-pair) but share one synthetic id,
  `legacy` — they carry no identity, so they can only be revoked **all at once**. Re-pair devices and
  revoke `legacy` to get individual control. Note a device **cannot revoke itself** (403), and a client
  still holding a legacy token *is* `legacy` — so clearing the legacy bucket must be done from a
  newly-paired device, not from a legacy one. That asymmetry is deliberate: it stops a client from
  severing the request it is making, and stops the last credential being dropped by accident.
- **Any paired device may revoke any other.** There is no ownership tier — pairing is the only
  privilege boundary, so a compromised device could revoke its peers (a denial of service, not an
  escalation: that device already has terminal RCE as the run-user). Treat "paired" as fully trusted,
  and revoke promptly if a device is lost. Every revoke is audited with the acting device.
- **Host administration runs over a unix socket, not the network** (ADR-036).
  `/run/gitview-bridge/control.sock`, mode `0600`, created by systemd's `RuntimeDirectory` owned by the
  run-user and removed on stop. **Filesystem permissions are its only gate — there is no token**, and that
  is deliberate: `gitview-bridgectl` ships in the same package and runs as the same user, so anyone who
  can open the socket could already edit the token store or signal the process. It adds no trust boundary,
  only a better channel across the existing one. Anything that can connect can mint a pairing code, which
  is host access, which was already sufficient to pair a device.
  It also makes the bridge the **single writer** of the token store: the CLI no longer edits
  `tokens.json`, so a write under `sudo` can no longer leave it unreadable by the bridge — the failure
  that once wiped every device on a live install.
- **WebSocket auth is first-frame or subprotocol, never the query string** (query strings leak to
  logs/proxies). Bad auth closes the socket with `4401`.

## Git & filesystem confinement
- **Path confinement on every read and write:** inputs are rejected if absolute or containing `..`;
  paths are `realpath`-resolved and re-checked for containment, so a symlink inside the repo pointing
  outside it cannot escape. Creates confine the nearest existing ancestor.
- **Subcommand allowlist:** git is only ever invoked with an allowlisted subcommand and an argv array
  (no shell). Refs are validated before use; `--` separates options from pathspecs.
- **Binary safety:** blobs are read as a `Buffer` (`encoding: "buffer"`) before base64 — images/
  binaries are never corrupted by a utf-8 round-trip.
- **Ignored/secret paths aren't served:** working-tree browse (`listTree`/`readBlob`) hides `.git` and
  `.gitview` (the token file + audit log) unconditionally and filters `.gitignore`-matched paths (via
  `git check-ignore`), so `node_modules`, build output, `config.yaml`, and secrets can't be read
  through the API.
- **Explicit caps:** an explicit request `bodyLimit` AND a per-file `writeSizeCap` (don't rely on the
  framework default). The body limit is raised to at least `writeSizeCap × 1.4` so base64 expansion
  can't reject a valid near-cap save before the write-size check runs.
- **No CORS:** the only client is the native app (bearer token in a header, not a browser), so no CORS
  is registered — nothing to reflect or widen.
- **Historical refs are read-only:** any write with a non–working-tree `ref` is rejected (409).
- **Branch checkout + push:** `checkout` mutates HEAD (branch/remote names validated — no leading `-`,
  no whitespace/glob metacharacters); `push` egresses to the network using the **host's git credentials**
  (the bridge holds none of its own). Both are pairing-gated and audited like every other write.

## Workspace roots / filesystem browse
The **"open a folder as a workspace"** feature lets a paired client with a valid token browse the host
filesystem, create directories, and register a folder as a workspace (and, on **explicit** confirmation,
`git init` it) — but **only within the operator-declared `workspaceRoots`**. This is a deliberate
widening of reach beyond the pre-registered repo set, so it is fenced the same way everything else is:
- **Off by default.** `workspaceRoots` is an empty list unless the operator sets it. While empty, the
  feature does not exist: `/v1/fs/*` and `/v1/workspaces/*` return `404`, and
  `GET /v1/health` reports `features.workspaces = false`. (This on/off boolean is the one browse-related
  field on the *unauthenticated* `/v1/health`, alongside the bridge version/protocol — reconnaissance-only,
  exposing no paths or data. It is a deliberate, accepted disclosure; keep the bridge fronted by Tailscale
  Serve / loopback regardless.)
- **Roots-confined, same containment.** Browse (`/v1/fs/list`), `mkdir`, and open are gated by the **same
  `confine()`** logic used for every read/write: inputs that are absolute, contain `..`, or resolve
  (via `realpath`) outside the declared root — including a symlink pointing out — are rejected
  (`path_escape`). A bad/unknown root id is `not_found`. Nothing outside a declared root is reachable.
  (The browser does **not** follow symlinks: a link inside a root is shown as a non-navigable file, so it
  can neither be traversed nor disclose the type/repo-ness of its out-of-root target.)
- **Revocation on narrowing/disable.** An opened workspace is persisted, but it is only *served* (and
  watched) while the feature is enabled **and** its path is still inside a currently-declared root.
  Emptying or narrowing `workspaceRoots` (then restarting) withdraws the full read/write/push surface for
  any folder that now falls outside — the served set never exceeds `workspaceRoots` ∪ the config repos.
  The record stays in `workspaces.json`, so re-widening a root restores it.
- **Never auto-init.** The bridge never runs `git init` on its own. A non-repo folder returns
  `needsInit: true`; git is only initialized when the caller passes `initGit: true`, which the app sends
  **only after the user confirms** the prompt.
- **Behind the auth gate + audited.** Every `/v1/fs/*` and `/v1/workspaces/*` route requires the Bearer
  token (they are **not** in the pairing/health exemption). `mkdir`, `git init`, and workspace
  registration are audited like any other write. Opened workspaces persist to `.gitview/workspaces.json`
  (mode `0600`, like `tokens.json`); `config.yaml` is never rewritten.

**Operator guidance:** declare **narrow** roots — e.g. `~/dev` or a single projects directory — and
**never the home directory or `/`.** A root is a grant of browse + create + open (and confirm-to-init)
across everything beneath it, to anyone holding a valid token; scope it as tightly as the work allows.

## Terminal — a host shell, as powerful as SSH
The **Terminal** view opens a real interactive shell (a PTY) on the bridge host and streams it to the
paired client. Understand what this is: **arbitrary command execution as the bridge's run-user, with none
of the agent's protections.** It is *not* fenced by `confine()`, the sandbox, the permission tiers, the
deny hook, or the egress proxy — those guard the *agent*; the terminal is a raw shell, so it can read and
write anything the run-user can, anywhere on the host, and reach the network. Treat granting it exactly
like handing out SSH to that account.

Because of that reach it is fenced at the edges instead:
- **On by default, one switch to disable.** `terminal.enabled` defaults to `true`. Set
  `terminal.enabled: false` (then restart) to turn it off entirely: `terminal.open` is refused
  (`forbidden`) and `GET /v1/health` reports `features.terminal = false`, so the app hides the view.
  (Like `features.workspaces`, this on/off boolean is reconnaissance-only on the unauthenticated
  `/v1/health` — it exposes no paths or data. Keep the bridge behind Tailscale Serve / loopback regardless.)
- **Behind the auth gate.** The shell rides the `/v1/live` WebSocket, which requires the first-frame
  Bearer token like every other live frame — an unpaired client cannot open one.
- **Starts in the workspace.** A terminal opens with its cwd set to the requested repo's directory (or the
  run-user's home when none is given). It is *not* confined there — the user can `cd` anywhere the account
  can — the cwd is a convenience, not a boundary.
- **Audited.** Each `terminal.open` is appended to the audit log (actor `app`, the repo, the shell).
- **No orphans.** Each connection's shells are tracked and **SIGKILL**ed (process group) when the socket
  closes or errors, so a closed app never leaves a shell running.

**Operator guidance:** the terminal is the single most powerful surface the bridge exposes — anyone with a
valid token gets a shell equal to the run-user. Run the bridge as a **tightly-scoped unprivileged user**
(the same advice as everywhere, but it matters most here), and if you don't want paired devices to have
host shell access, set `terminal.enabled: false`. The run-user's own confinement (its file permissions,
what it can `sudo`, its network reach) *is* the terminal's security boundary — there is no other.

## The agent — defense in depth, not one boundary
The default chat profile is **`ask-first`** (the interactive gate: every edit & command pauses for the
user's explicit OK before it runs). Layered protections, from hard to soft:

1. **Sandbox (the hard boundary):** the local-SDK agent runs inside `@anthropic-ai/sandbox-runtime`
   (bubblewrap/Seatbelt, whole-process). Set `failIfUnavailable: true`; `denyRead` `~/.ssh`, `~/.aws`
   and other secrets; use the default-deny egress allowlist proxy.
2. **PreToolUse deny hook:** runs before every permission step; a `deny` here applies **even in
   `bypassPermissions`**. Backstops destructive commands.
3. **Deny rules:** scoped `disallowedTools` (e.g. `Bash(rm -rf /*)`) are enforced in every mode
   including bypass.
4. **Permission profile / tier:** `read-only` / `ask-first` (`confined-agent` — interactive `canUseTool`
   gate: every edit & command prompts) / `auto-edit` (`acceptEdits` — edits auto, commands prompt) /
   `auto-run` (`auto` — classifier; edits + safe commands, destructive prompts) / `no-prompts` (`dontAsk`) /
   `unrestricted` (`bypassPermissions`). The interactive tiers pause a tool and await the app's decision;
   `read-only`/`no-prompts`/`unrestricted` don't prompt. (Wire ids in parens are unchanged.)
5. **Interactive gate (`ask-first` / `auto-edit` / `auto-run`):** the SDK `canUseTool` callback pauses a
   write/command and awaits the user (ADR-025); the `auto-run` tier also uses the model classifier for
   auto-allowed calls. Resists prompt injection and scope-escalation.

The classifier, deny-rules, and egress proxy are **defense-in-depth, not a hard isolation boundary —
the sandbox is.** `bypassPermissions` is isolated-use only: explicit opt-in, requires
`allowDangerouslySkipPermissions`, refuses to run as root, and is re-asserted at launch.

## Provider trust model
Chat runs on a **single provider — the local Claude Agent SDK** (the Remote Control provider, whose
transcript was stored on Anthropic servers while connected, was removed — see [DECISIONS.md](DECISIONS.md),
ADR-033). With only the local SDK, the **transcript stays on your machine** (the shared `~/.claude` session
store) and the agent runs on the host under the sandbox + permission layers above; there is no longer a
device-sync path that puts the conversation on Anthropic servers. One provider means one trust model.

## Accountability
Every **write** (REST or MCP) and every **agent tool call** is appended to an **audit log**
(`.gitview/audit.log`) as one JSON line: timestamp, actor (`app`|`claude`), repo, action, target, ok.

## Operating rules
- Run the bridge as an **unprivileged user** (never root).
- **Register only repos you'd hand an agent.**
- Optional dials (documented): approve-each-write, isolated per-session worktree (`--spawn worktree`),
  stricter sandbox egress, `confined-agent` instead of full-tool.
