# GitView

**A VS Code–like native mobile code editor for your own git repositories, plus a chat tab where a
full-tool Claude session reads and writes the same repo — browse, edit, and commit from your phone,
then hand the repo to Claude.** Single-user / personal use.

It serves two co-primary device classes from one Android APK: a standard LCD phone/tablet, and a
**Bigme B7 Pro color e-ink tablet** — each a first-class experience, neither a bolt-on.

```
Android app (thin client)  ──HTTPS REST + one WebSocket, over Tailscale──▶  Bridge (Node.js + TS)
  Compose · Sora editor                                                      git read/write
  DisplayProfile (Standard | E-Ink)                                          Claude session manager
  Keystore tokens                                                            audited MCP write surface
```

**No git engine and no agent run on the device.** A small **bridge** runs where your repos live; the
handheld browses/edits/commits through it and drives a Claude session that executes on that host.

## Why
Driving a Claude agent on your own machine from your phone is now largely solved by first-party
Anthropic features (**Remote Control**) and the **Claude Agent SDK** — so GitView adopts those and
invests in its genuine differentiators: a **native editor** and a **first-class color e-ink**
experience alongside a first-class standard one.

## Repository layout
| Path        | What                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| `bridge/`   | Node.js + TypeScript server: git read/write, Claude session manager, transport |
| `android/`  | Kotlin + Jetpack Compose app: editor, browse/diff/log, chat, DisplayProfile  |
| `docs/`     | Architecture, plan, protocol, security, decisions, e-ink, setup              |

## Docs
- [ARCHITECTURE](docs/ARCHITECTURE.md) — components and request lifecycles
- [PLAN](docs/PLAN.md) — phased build plan (MVP = phases 0–3)
- [API](docs/API.md) — the frozen wire protocol (source of truth for both ends)
- [SECURITY](docs/SECURITY.md) — the full-read/write, low-friction security model
- [DECISIONS](docs/DECISIONS.md) — ADRs (owner-mandate / research-backed / design-choice)
- [EINK](docs/EINK.md) — the Color E-Ink profile and Bigme refresh strategy
- [SETUP](docs/SETUP.md) — run the bridge, expose over Tailscale, build & pair the app

## Quick start
```bash
# Bridge
cd bridge && npm install && cp config.example.yaml config.yaml   # edit repo path(s)
npm run dev                                                        # prints a pairing code

# App
cd ../android && ./gradlew :app:assembleDebug                     # local.properties -> your SDK
```
Then expose the bridge with `tailscale serve --https=443 http://127.0.0.1:8787` and pair the app to
the resulting `https://…ts.net` URL. Full walkthrough in [SETUP](docs/SETUP.md).

## Status
Compiling scaffold covering MVP phases 0–3: the bridge boots, pairs, and serves git read/write
(verified end-to-end); the app assembles to a debug APK. Highlighting grammar wiring, diff UI, and
on-device e-ink refresh tuning are the marked next steps — see [PLAN](docs/PLAN.md).

## Research provenance
The design was validated against the mid-2026 Claude ecosystem and target hardware via two
adversarially-verified research passes. Two findings corrected the brief and are reflected in the
code: **Sora Editor is LGPL-2.1** (not MIT/Apache — ADR-013) and the **confined-agent profile is
built from `allowedTools`/`disallowedTools`** rather than the unverified `tools:[]` mechanism
(ADR-012). See [DECISIONS](docs/DECISIONS.md).

## License
MIT (see [LICENSE](LICENSE)). GitView depends on the LGPL-2.1 Sora Editor as an unmodified library;
your use of GitView's own code remains under MIT. See ADR-013.
