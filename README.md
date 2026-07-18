# GitView

**A VS Code–like mobile code editor for your git repositories, wired to a Claude session with full tools — so you can browse, edit, and commit code AND chat to Claude that reads and writes the same repo, from your phone.**

GitView has two parts:

| Component | What it is | Tech |
|---|---|---|
| **Bridge** (`bridge/`) | A small server you run on the machine where your git repos live. It serves each repo over a read **and write** API and drives / attaches to full-tool Claude sessions in that repo. | Node.js + TypeScript (Fastify + `ws`), Claude Agent SDK |
| **Android app** (`android/`) | A native code editor + Claude chat. Browse the file tree, read and **edit** files with syntax highlighting, view diffs, stage/commit — then switch to a chat tab with Claude operating on that same repo. Ships an alternative **color e-ink** display profile (Kaleido 3). | Kotlin + Jetpack Compose |

The phone talks to the bridge over your **Tailscale** tailnet (WireGuard) — nothing is exposed to the public internet. You can save **multiple connections** (different machines) and switch between **multiple repos** on each.

> **Read/write, direct, no prompts.** The app edits files and Claude runs full tools (`Bash`/`Write`/`Edit`) with no approval gate. A valid token therefore means arbitrary writes + command execution on the bridge machine — which is why the bridge must stay private (Tailscale) and authenticated. See **[docs/SECURITY.md](docs/SECURITY.md)**.

```
 ┌─────────────────────────┐        Tailscale (WireGuard, TLS)        ┌───────────────────────────────────┐
 │  Android app (Compose)  │  ◄───────────────────────────────────►  │  Bridge server (Node/TS)          │
 │  • File tree + editor   │   REST (read + write) + 1 WebSocket      │  • git read plumbing (browse)     │
 │  • Diff / blame / log   │                                          │  • file write path (edit working  │
 │  • Edit · save · commit │                                          │    tree) + stage/commit/discard   │
 │  • Claude chat tab      │                                          │  • Claude Agent SDK (full tools)  │
 │  • Saved connections    │                                          │  • pairing / bearer-token auth    │
 └─────────────────────────┘                                          └───────────────┬───────────────────┘
                                                                                       │
                                                                        repos + `~/.claude/projects/…`
```

## Why this shape

Every mature project in this space (`claudecodeui`, `claude-code-webui`, `paseo`, and Anthropic's own Claude Code on the web) uses a **thin mobile client + a server-side agent daemon**. Running the agent — or a full IDE like `code-server` — on the phone is heavy, insecure, and bad for battery. GitView keeps the phone thin: it renders/edits files and streams a chat; all git and all Claude execution happen on the bridge.

## Status

🚧 **Design + scaffold stage.** This repository contains the full plan, architecture, protocol spec, and a starting skeleton for both components. See the docs below, then start at Phase 0 in the plan.

## Documentation

- **[docs/PLAN.md](docs/PLAN.md)** — phased roadmap, MVP cut line, milestones.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — components, data flow, the Claude "session provider" modes.
- **[docs/API.md](docs/API.md)** — REST (read + write) + WebSocket wire protocol.
- **[docs/SECURITY.md](docs/SECURITY.md)** — what read/write means and what actually protects you.
- **[docs/EINK.md](docs/EINK.md)** — the alternative color e-ink display profile (constraints, palette, refresh, streaming).
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — the key architectural decisions and why (incl. the choices you made).
- **[docs/SETUP.md](docs/SETUP.md)** — toolchain prerequisites and how to run each part.

## Quick start (once built)

```bash
# On the machine with your repos:
cd bridge
cp .env.example .env          # add ANTHROPIC_API_KEY, DEVICE_TOKEN_SECRET, BRIDGE_TOKEN
cp config.example.yaml config.yaml   # list ONLY repos you're OK letting an agent edit + run
npm install && npm run dev

# Expose it privately over your tailnet (never a public URL for a read-write bridge):
tailscale serve --bg 8787

# Then open the Android app, add a connection to  https://<machine>.<tailnet>.ts.net , pair, and start editing.
```

## License

See [LICENSE](LICENSE) (MIT placeholder — change to whatever you prefer; this is your project).
