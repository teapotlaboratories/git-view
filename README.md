# GitView

**A view-only, VS Code–like mobile code browser for your git repositories, wired to a Claude remote-control session — so you can flip between reading the code and chatting to Claude about it, from your phone.**

GitView has two parts:

| Component | What it is | Tech |
|---|---|---|
| **Bridge** (`bridge/`) | A small server you run on the machine where your git repos live. It serves the repo read-only over an API and drives / attaches to Claude sessions in that repo. | Node.js + TypeScript (Fastify + `ws`), Claude Agent SDK |
| **Android app** (`android/`) | A native, read-only code viewer + Claude chat. Browse the file tree, read files with syntax highlighting, view diffs — then switch to a chat tab talking to Claude operating on that same repo. | Kotlin + Jetpack Compose |

The phone talks to the bridge over your **Tailscale** tailnet (WireGuard) — nothing is exposed to the public internet. You can save **multiple connections** (different machines) and switch between **multiple repos** on each.

```
 ┌─────────────────────────┐        Tailscale (WireGuard, TLS)        ┌───────────────────────────────────┐
 │  Android app (Compose)  │  ◄───────────────────────────────────►  │  Bridge server (Node/TS)          │
 │  • File tree + viewer   │   REST (GET, read-only) + 1 WebSocket    │  • Hardened git wrapper (read-only)│
 │  • Diff / blame / log   │                                          │  • Claude Agent SDK session mgr    │
 │  • Claude chat tab      │                                          │  • Attach to existing sessions     │
 │  • Saved connections    │                                          │  • Pairing / bearer-token auth     │
 └─────────────────────────┘                                          └───────────────┬───────────────────┘
                                                                                       │
                                                                        repos + `~/.claude/projects/…`
```

## Why this shape

Every mature project in this space (`claudecodeui`, `claude-code-webui`, `paseo`, and Anthropic's own Claude Code on the web) uses a **thin mobile client + a server-side agent daemon**. Running the agent — or a full IDE like `code-server` — on the phone is heavy, insecure, and bad for battery. GitView keeps the phone thin: it renders files and streams a chat; all git and all Claude execution happen on the bridge.

## Status

🚧 **Design + scaffold stage.** This repository currently contains the full plan, architecture, protocol spec, and a starting skeleton for both components. See the docs below, then start at Phase 0 in the plan.

## Documentation

- **[docs/PLAN.md](docs/PLAN.md)** — phased roadmap, MVP cut line, milestones.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — components, data flow, the two Claude "session provider" modes.
- **[docs/API.md](docs/API.md)** — REST + WebSocket wire protocol.
- **[docs/SECURITY.md](docs/SECURITY.md)** — read-only guarantees, sandboxing the Claude session, auth model.
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — the key architectural decisions and why (incl. the choices you made).
- **[docs/SETUP.md](docs/SETUP.md)** — toolchain prerequisites and how to run each part.

## Quick start (once built)

```bash
# On the machine with your repos:
cd bridge
cp .env.example .env          # add ANTHROPIC_API_KEY, DEVICE_TOKEN_SECRET
cp config.example.yaml config.yaml   # list your repos
npm install && npm run dev

# Expose it privately over your tailnet:
tailscale serve --bg 8787

# Then open the Android app, add a connection to  https://<machine>.<tailnet>.ts.net , pair, and browse.
```

## License

See [LICENSE](LICENSE) (MIT placeholder — change to whatever you prefer; this is your project).
