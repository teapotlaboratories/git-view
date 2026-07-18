# GitView Bridge

Node.js + TypeScript server that runs where your repos live. It serves a git repo (read + working-tree
write) over a small REST + WebSocket API and drives/attaches Claude sessions for the GitView Android
app. The handheld is a thin client; **no git engine and no agent run on the device**.

## Quick start

```bash
cd bridge
npm install
cp config.example.yaml config.yaml   # edit: set your repo path(s)
npm run dev                            # or: npm run build && npm start
```

On start the bridge prints a **pairing code**. Enter it once in the app to receive a bearer token.

## Scripts

| script            | purpose                                  |
| ----------------- | ---------------------------------------- |
| `npm run dev`     | watch-mode dev server (tsx)              |
| `npm run build`   | compile to `dist/`                       |
| `npm start`       | run the compiled server                  |
| `npm run typecheck` | `tsc --noEmit`                         |
| `npm test`        | node:test unit tests                     |

## Layout

```
src/
  index.ts            entry — wires config + REST + WS
  config.ts           YAML config (Zod-validated), repo resolution
  wire.ts             protocol types, mirrored from ../docs/API.md
  auth/pairing.ts     pairing code -> bearer token; constant-time verify
  git/
    gitService.ts     read plumbing (execFile allowlist, ref validation, Buffer blobs)
    gitWrite.ts       stage / commit / discard
    fileService.ts    save / create / delete / rename (confined + size-capped)
  claude/
    permissions.ts    profile -> SDK options (auto default; confined via allowedTools, not tools:[])
    mcpServer.ts       in-process MCP write surface (mcp__gitview__*)
    sandbox.ts        @anthropic-ai/sandbox-runtime wiring
    remoteControl.ts  `claude remote-control` process manager (primary provider)
    sessionManager.ts local-SDK provider; listSessions/resume; event normalization
  http/rest.ts        Fastify routes + auth hook + caching + error mapping
  ws/liveChannel.ts   one WebSocket; first-frame auth; eventId ring buffer
  util/               errors, path confinement, audit log
```

## Optional dependencies

`@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sandbox-runtime` are **optional** — the bridge
builds and serves git without them; the Claude chat features degrade gracefully if absent. Pin their
versions and re-verify option names against current docs on upgrade (see `../docs/DECISIONS.md`).

## Security

Full read/write, low-friction — so **only expose it over Tailscale** and register only repos you'd
hand an agent. See `../docs/SECURITY.md`.
