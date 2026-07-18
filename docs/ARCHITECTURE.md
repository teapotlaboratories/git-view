# GitView Architecture

GitView is a VS Code–like **native** Android code editor for your own git repositories, plus a chat
tab where a full-tool Claude session reads and writes the **same** repo. Single-user / personal use.
It serves two co-primary device classes from one APK: a standard LCD phone/tablet, and a Bigme B7
Pro color e-ink tablet.

## Topology (owner mandate)

```
┌─────────────────────────────┐         Tailscale tailnet (WireGuard)         ┌──────────────────────────┐
│   Android app (thin client) │  ── HTTPS REST (browse/edit) ───────────────▶ │  Bridge (Node.js + TS)   │
│                             │  ── one WebSocket (chat + repo push) ───────▶ │  runs where repos live   │
│  • Compose UI               │        Tailscale Serve (auto-TLS)             │                          │
│  • Sora editor              │                                               │  • git read/write        │
│  • DisplayProfile           │                                               │  • Claude session mgr    │
│  • Keystore token store     │ ◀── streamed assistant tokens / tool events ─ │  • audited MCP surface   │
└─────────────────────────────┘                                               └───────────┬──────────────┘
                                                                                          │
                                              ┌───────────────────────────────────────────┴───────────────┐
                                              │ Provider split:                                            │
                                              │  • Remote Control  → `claude remote-control` (outbound-only)│
                                              │  • Local SDK       → @anthropic-ai/claude-agent-sdk         │
                                              │    inside @anthropic-ai/sandbox-runtime                    │
                                              └────────────────────────────────────────────────────────────┘
```

**No git engine and no agent run on the device.** The handheld browses, edits, and commits through
the bridge, and drives a Claude session that executes *on the machine where the repos are*.

## Components

### Bridge (`bridge/`, Node.js + TypeScript, ESM)
- **git read plumbing** (`git/gitService.ts`): tree, blob-at-ref, log, refs, diff, blame, show,
  status. `execFile` with a fixed subcommand allowlist; refs validated; blobs read as `Buffer`;
  working-tree browsing reads the filesystem so untracked files appear.
- **working-tree write API** (`git/fileService.ts`, `git/gitWrite.ts`): save/create/delete/rename;
  stage/commit/discard. Path-confined (realpath symlink check) and write-size-capped.
- **session manager** (`claude/`): the provider split (Remote Control | local SDK) and the
  permission profiles; session discovery/resume via SDK APIs; the in-process MCP write surface.
- **transport** (`http/rest.ts`, `ws/liveChannel.ts`): cacheable REST + one WebSocket with a
  monotonic `eventId` ring buffer for replay.
- **auth** (`auth/pairing.ts`): pairing code → bearer token; constant-time verification.

The wire contract is frozen in [API.md](API.md) and mirrored in `bridge/src/wire.ts` and the app's
`Wire.kt`.

### Android app (`android/`, Kotlin + Jetpack Compose)
- **connection store** (`data/ConnectionStore.kt`): saved bridges in Room; tokens in the Keystore
  (EncryptedSharedPreferences).
- **REST + live clients** (`data/BridgeApi.kt`, `data/BridgeClient.kt`): OkHttp; the WebSocket
  authenticates on the first frame (never a token in the URL).
- **screens** (`ui/`): connections, repo list, lazy file tree, editor (Sora), diff, commit log, and
  a chat pane with a Browse/Edit ⇄ Chat switch and a permission-profile selector.
- **DisplayProfile** (`ui/theme/`): symmetric Standard | Color E-Ink, auto-detected with a persisted
  override that always wins.
- **e-ink refresh** (`render/EInkRefreshController.kt`): vendor-neutral interface, NO-OP default, a
  best-effort Bigme impl chosen by `Build.MANUFACTURER`.

## Request lifecycles

**Browse a file at a historical ref:** `GET /v1/repos/:repo/blob?ref=<sha>&path=…` → git resolves
the object id → response carries a strong `ETag` + `immutable` cache. The app renders it read-only.

**Edit + commit:** the app `PUT`s the file (working tree only), then `POST /stage` + `/commit`. Each
write is path-confined, size-capped, and appended to the audit log.

**Chat:** the app opens the WebSocket, authenticates, and sends `prompt`. For the local-SDK provider
the bridge runs `query()` with the selected profile's options and streams normalized events
(`session.init` → `assistant.delta` … → `result`) back down. For Remote Control the bridge launches
`claude remote-control` and returns a connect URL the app opens in the Claude app.

## Trust boundaries
See [SECURITY.md](SECURITY.md). In short: the tailnet is the perimeter; the bridge authenticates
every request; path confinement + the subcommand allowlist bound the git surface; the sandbox is the
hard isolation boundary for the agent; classifier/deny-rules/egress-proxy are defense-in-depth.
