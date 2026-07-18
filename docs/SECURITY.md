# GitView — Security Model

GitView is configured for **full read/write with direct writes and no approval prompts** (see
[DECISIONS.md](DECISIONS.md) ADR-011/012/013). This document is honest about what that means and
what actually protects you.

## 1. The posture, stated plainly

- The **app is an editor**: it can create, edit, rename, and delete files in a repo's working tree, and stage/commit via the bridge.
- The **Claude session runs full tools** — `Read`, `Write`, `Edit`, **`Bash`**, etc. — with **direct writes and no approval prompts**.

Therefore: **a valid bearer token grants arbitrary file writes and arbitrary command execution on the machine running the bridge.** Treat the token like an SSH private key. This is the deliberate trade-off you chose for convenience; the controls below are what keep it safe *enough*.

## 2. What actually protects you (the real boundary)

Because the "structurally read-only" guarantee is gone, security now rests on four things — keep all four:

1. **Network reachability — Tailscale, nothing public.** The bridge is reachable **only** from your tailnet (WireGuard), fronted by Tailscale Serve (auto-TLS). No ports are opened to the internet. **Do not** put a read-write bridge on a public URL (Funnel/Cloudflare/ngrok) without strong additional auth — a leaked/omitted token there = your machine is owned.
2. **Authentication on every request.** Phase 0 uses a shared `BRIDGE_TOKEN`; Phase 4 uses per-device paired bearer tokens (QR/short code → token in the Android Keystore), revocable server-side. Both REST and the WebSocket check it.
3. **Path confinement (`util/paths.ts`).** Every read *and every write* is resolved and confined to the repo root; `..` traversal and absolute escapes are rejected. This is now the single most important code-level guard — a write must never land outside the repo you configured.
4. **No shell injection.** All git runs via `execFile("git", [args])` (never a shell string); file writes use `fs` APIs with confined paths. User/agent input never becomes a shell command on the browse/edit path. (Claude's *own* `Bash` tool is a separate, intended capability — see §3.)

## 3. The Claude session is intended to be powerful

With `claude.profile: read-write`, the session is meant to run commands and modify files. That is the feature. The bridge does **not** try to sandbox it by default. Sensible operating discipline:

- **Only register repos you're comfortable an autonomous agent can modify and run code in** (`config.yaml`). Don't point the bridge at `~` or a repo full of secrets/production credentials.
- **Git is your undo.** Commit or branch before big agent runs; review diffs; `git reset`/`git restore` to roll back. The editor exposes stage/commit/discard for exactly this.
- Keep per-session **budget/turn caps** (`limits.session`) on to bound runaway loops.
- The bridge should run as **your unprivileged user**, not root.

## 4. Dials you can turn back toward safety (optional)

Nothing here is on by default now, but each is a small change if you want it later:

| Want | How |
|---|---|
| Lock a specific repo to inspect-only | `claude.profile: read-only` for it → deny-by-default mode + `allowedTools:[Read,Glob,Grep]` + a `PreToolUse` deny hook (code path already sketched in `sessionManager.ts`). |
| Confirm each write on the phone | Re-enable approval prompts: surface the SDK's permission requests as approve/deny (Plan, Phase 6). |
| Keep your working tree pristine | Run the agent in an isolated **git worktree/branch** and merge deliberately (Plan, Phase 6). |
| OS-level containment | Run the bridge in a container/sandbox with the repo mounted and network egress limited to the Anthropic API. |

## 5. Secrets handling (unchanged)

- `ANTHROPIC_API_KEY` and `DEVICE_TOKEN_SECRET` live only in the bridge's `.env` / an OS secret store — never sent to the phone, never logged.
- The phone holds only its device bearer token (in the Keystore), never the API key.
- **Audit log:** log every write (path, bytes, device id) and every Claude tool call. With no prompts, the log is your after-the-fact record of what changed.

## 6. Threat model — updated for read/write

| Threat | Mitigation |
|---|---|
| Write escapes the repo (`../../etc/…`, symlink) | `confine()` on every path; reject `..`/absolute; realpath symlinks if that risk applies |
| Shell/arg injection via git | `execFile` only (no shell), fixed subcommand allowlists (read + write), arg validation |
| Bridge reachable by an attacker | Tailscale only, no public exposure; bearer token + (Phase 4) Tailscale identity on every request |
| Stolen device token → RCE | short pairing TTL, revocable/rotatable tokens, Keystore storage, optional mTLS; **never expose read-write bridge publicly** |
| Agent runs destructive command | operate on repos you accept that risk for; commit/branch first; budget/turn caps; run as unprivileged user; optional worktree isolation |
| Accidental bad edit/delete from the app | git is the undo (discard/restore/reset); commit checkpoints |
| API key leaking to device | key stays on bridge; phone only sends prompts / receives streamed events |

> Bottom line: you traded the structural read-only guarantee for a full editor + autonomous agent. That's a fine trade **as long as the bridge stays private (Tailscale), authenticated (tokens), and pointed only at repos you're willing to hand to an agent.**
