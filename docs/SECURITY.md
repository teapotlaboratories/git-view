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

## Perimeter — Tailscale only
The editor API is reachable **only over a Tailscale tailnet** fronted by **Tailscale Serve** (auto-TLS,
zero public exposure). The bridge binds `127.0.0.1` and is published to the tailnet by Serve.
**Never put a read/write bridge on a public URL.** Cloudflare Tunnel (authenticated) is a documented
fallback. See [SETUP.md](SETUP.md).

## Authentication
- Bearer token on **every** request except `POST /v1/pair` and `GET /v1/health` (the auth hook
  exempts exactly these — you can't obtain the first token otherwise).
- Pairing code → token exchange; the code is short-lived, printed to the bridge console, and rotates
  after a successful pair.
- Tokens are compared in **constant time** (`timingSafeEqual`), stored `0600` on the bridge, and in
  the **Android Keystore** (EncryptedSharedPreferences) on the device — never in the URL, never in
  Room, never in logs.
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
- **Explicit caps:** an explicit request `bodyLimit` AND a per-file `writeSizeCap` (don't rely on the
  framework default, which both DoS-caps and silently breaks large saves).
- **Historical refs are read-only:** any write with a non–working-tree `ref` is rejected (409).

## The agent — defense in depth, not one boundary
The default chat profile is **`auto`** (no prompts; a model classifier approves/denies each call).
Layered protections, from hard to soft:

1. **Sandbox (the hard boundary):** the local-SDK agent runs inside `@anthropic-ai/sandbox-runtime`
   (bubblewrap/Seatbelt, whole-process). Set `failIfUnavailable: true`; `denyRead` `~/.ssh`, `~/.aws`
   and other secrets; use the default-deny egress allowlist proxy.
2. **PreToolUse deny hook:** runs before every permission step; a `deny` here applies **even in
   `bypassPermissions`**. Backstops destructive commands.
3. **Deny rules:** scoped `disallowedTools` (e.g. `Bash(rm -rf /*)`) are enforced in every mode
   including bypass.
4. **Permission profile:** `read-only` / `confined-agent` (writes only via the audited MCP surface) /
   `acceptEdits` / `auto` (classifier) / `dontAsk` / `bypassPermissions`.
5. **Classifier (`auto`):** per-action model approval — resists prompt injection and scope-escalation.

The classifier, deny-rules, and egress proxy are **defense-in-depth, not a hard isolation boundary —
the sandbox is.** `bypassPermissions` is isolated-use only: explicit opt-in, requires
`allowDangerouslySkipPermissions`, refuses to run as root, and is re-asserted at launch.

## Provider trust delta
- **Remote Control:** authenticates with your **claude.ai subscription** (API keys rejected); while
  connected, the **transcript is stored on Anthropic servers** to sync devices/reconnect. Code and
  filesystem stay local; the connection is outbound-HTTPS only. ZDR orgs cannot enable it.
- **Local SDK:** API-key path; transcript stays on your machine. Choose this when transcripts must
  never leave the host.

## Accountability
Every **write** (REST or MCP) and every **agent tool call** is appended to an **audit log**
(`.gitview/audit.log`) as one JSON line: timestamp, actor (`app`|`claude`), repo, action, target, ok.

## Operating rules
- Run the bridge as an **unprivileged user** (never root).
- **Register only repos you'd hand an agent.**
- Optional dials (documented): approve-each-write, isolated per-session worktree (`--spawn worktree`),
  stricter sandbox egress, `confined-agent` instead of full-tool.
