# GitView Bridge

The server that runs on the machine where your repos live. It:

1. Serves each configured repo **read-only** over a REST API (`src/http/rest.ts` → `src/git/gitService.ts`).
2. Drives / attaches to **Claude sessions** in a repo's directory (`src/claude/sessionManager.ts`) and streams them over a **WebSocket** (`src/ws/liveChannel.ts`).
3. Authenticates the phone (`src/auth/pairing.ts`).

## Run
```bash
cp .env.example .env
cp config.example.yaml config.yaml
npm install
npm run dev            # http://127.0.0.1:8787
```

Then expose it privately: `tailscale serve --bg 8787`.

## Layout
```
src/
  index.ts               entry: wires config → fastify (REST) + ws (live channel)
  config.ts              loads config.yaml + .env, validates with zod
  git/gitService.ts      the ONLY module that touches repos — hardened, read-only git wrapper
  http/rest.ts           GET-only browse routes (tree/blob/diff/blame/log/show/refs/status)
  claude/sessionManager.ts  Agent SDK sessions: create/attach/resume, read-only profile
  ws/liveChannel.ts      one WebSocket: prompt in, streamed tokens + tool events out
  auth/pairing.ts        pairing code → bearer token; auth middleware
  util/errors.ts         typed error helpers
```

## Status
Scaffold. Each module has a clear interface and TODOs. Implement in the order of `docs/PLAN.md`
(Phase 0 = health + repos + tree + blob; Phase 2 = Claude sessions).

> ⚠️ Verify the exact `@anthropic-ai/claude-agent-sdk` option names and the read-only permission
> mode string against the current docs before trusting the safety profile. See `docs/SECURITY.md`.
