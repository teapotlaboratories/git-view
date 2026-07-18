# GitView — Security Model

Two independent trust domains. Keep them separate — this is the core of the design.

## 1. Browse path is *structurally* read-only

Not "read-only by policy" — read-only because there is no write code on the path.

- **Only `GET` routes.** No POST/PUT/DELETE/PATCH touches a repo.
- **Only read-only git plumbing** through one wrapper: `ls-tree`, `cat-file`, `blame`, `diff`, `log`, `show`, `for-each-ref`, `status`, `rev-parse`.
- **The wrapper (`gitService.ts`) enforces:**
  - `execFile("git", [args])` — **never** `exec`/a shell string. No shell = no shell injection.
  - **Subcommand allowlist** — anything not in the read-only set is rejected before spawn.
  - **Arg validation** — refs must match a safe pattern; every flag is from a known set; no arbitrary flags pass through.
  - **Path confinement** — requested paths are resolved and must stay within the repo root; `..` and symlink escapes are rejected.
  - Optionally run against a **read-only bind-mount** of the repo for a belt-and-suspenders guarantee.

## 2. The Claude session is a *separate*, sandboxed domain

Chatting *about* a repo is not the same as browsing it. Claude's tools can write unless you lock them down, so this path gets its own controls. **Default profile is read-only.**

> ⚠️ **Critical, verified during design:** `allowedTools` alone does **not** make a session read-only under a bypass/"trust everything" permission mode — an allow-list with a permissive mode still approves write/exec tools. Read-only must be enforced by *mode + deny rules + a hook*, not by the allow-list alone.

Lock-down recipe (Agent SDK, TypeScript — **pin the SDK version and confirm exact option names against current docs**):

```ts
query({
  prompt,
  options: {
    cwd: repoPath,
    includePartialMessages: true,
    permissionMode: /* deny-by-default mode */,      // unlisted tools are DENIED, never auto-approved
    allowedTools: ["Read", "Glob", "Grep"],          // read-only surface
    disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
    hooks: { PreToolUse: denyAnyWrite },             // hard backstop: hooks run FIRST, deny holds even in bypass
    maxTurns: 20,
    maxBudgetUsd: 5,
  }
})
```

Layers, outermost first:
1. **`PreToolUse` hook** — runs before every tool call; a hook-deny holds regardless of mode. The only gate that catches *every* call. This is the guaranteed backstop for read-only.
2. **Deny-by-default permission mode** — an unlisted tool falls through to *deny*, not approve.
3. **`disallowedTools`** — remove write/exec tools from the model's context entirely.
4. **`allowedTools`** — the small read-only surface.
5. **OS sandbox (Phase 6):** run the session as an unprivileged user, repo mounted read-only, network egress restricted to the Anthropic API. Permissions pick tools; the sandbox restricts the filesystem/network underneath. Subagents inherit the parent's restrictive mode and cannot escalate.

**The phone never gets a raw shell** and **never sees an API key.** It sends chat text and receives streamed tokens + structured tool events. All execution and all secrets stay on the bridge.

### Optional edit mode (Phase 6)
A per-session opt-in that raises permissions runs Claude in an **isolated git worktree** (not your working tree) and surfaces each permission request as a **mobile approve/deny prompt**. Off by default.

## 3. Transport & device auth

- **Tailscale (WireGuard)** is the default transport: identity-based mesh, **zero public exposure**, auto-TLS via Tailscale Serve. The bridge is reachable only from your tailnet.
- **App bearer token regardless of transport** (defense in depth): first connection uses a short-lived **pairing code / QR**; the phone exchanges it for a long-lived bearer token held in the **Android Keystore**. Every REST/WS call carries it.
- **On the Serve path**, additionally verify the Tailscale identity header (`tailscale whois`).
- **Public-ingress fallbacks** (Tailscale Funnel / Cloudflare Tunnel) strip or replace identity, so they require the app token **plus** the tunnel's own policy (service tokens / mTLS). Never rely on a tunnel alone. Optional pinned **mTLS** client cert for the highest assurance.

## 4. Secrets handling

- `ANTHROPIC_API_KEY` and `DEVICE_TOKEN_SECRET` live in the bridge's `.env` / an OS secret store — **never** sent to the phone, never logged.
- Tokens: short pairing codes expire fast; device bearer tokens are revocable server-side and rotate on app reinstall.
- Audit log: every Claude tool call and every browse request is logged with repo, session, and device id.

## 5. Threat-model quick table

| Threat | Mitigation |
|---|---|
| Repo write via browse API | No write routes; read-only plumbing only; path confinement |
| Claude edits/deletes files unexpectedly | deny-by-default mode + `disallowedTools` + `PreToolUse` deny hook + OS sandbox; edit mode is opt-in + worktree-isolated |
| Shell/arg injection into git | `execFile` (no shell), subcommand allowlist, arg + ref validation |
| Path traversal / symlink escape | resolve + confine to repo root; reject `..`/symlink escapes |
| Public exposure of the bridge | Tailscale, no open ports; token + identity even so |
| API key leaking to device | key stays on bridge; phone only gets streamed tokens |
| Stolen device token | short pairing TTL, revocable/rotatable tokens, Keystore storage, optional mTLS |
| Lost connection mid-chat | event-id replay + resume-by-id; no restart, no duplicate work |
