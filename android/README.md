# GitView Android app

Native Kotlin + Jetpack Compose. A read-only, VS Code–like code browser plus a Claude chat tab,
talking to a GitView **bridge** over REST (browse) and a WebSocket (chat).

> **Scaffold.** This folder defines the intended module layout, the dependency catalog, and key
> source stubs. Open it in **Android Studio**, let it sync, and generate the Gradle wrapper
> (`gradle wrapper`, git-ignored) on first open. Then build in the order of `docs/PLAN.md`.

## Screens (Compose)
| Screen | Phase | Purpose |
|---|---|---|
| `ConnectionsScreen` | 0/3 | Saved bridges (multi-machine); add/pair; pick one. |
| `RepoListScreen` | 0 | Repos served by the selected bridge. |
| `TreeScreen` | 0/1 | Lazy, virtualized file tree; breadcrumb; file-type icons. |
| `FileViewer` | 1 | Read-only Sora Editor with syntax highlighting; long-line scroll. |
| `DiffViewer` | 1 | Unified + side-by-side diffs; blame overlay. |
| `LogScreen` | 1 | Commit log + commit detail. |
| `ChatScreen` | 2 | Streamed Claude chat; tool-use chips; interrupt; session switcher. |

On a phone, `Browse ⇄ Chat` is a bottom tab; on a tablet it's a two-pane split.

## Suggested package layout
```
com.gitview.app
├─ MainActivity.kt            single activity; hosts the Compose nav graph
├─ ui/
│  ├─ connections/  repos/  tree/  file/  diff/  log/  chat/    (Compose screens + view models)
│  └─ theme/                                                    (Material 3 theme)
├─ data/
│  ├─ BridgeApiClient.kt      Retrofit interface (REST browse)
│  ├─ LiveChannel.kt          OkHttp WebSocket client (chat + events)
│  ├─ ConnectionStore.kt      Room + Keystore-backed saved connections
│  └─ model/                  DTOs mirroring docs/API.md
└─ render/
   ├─ CodeView.kt             Sora Editor wrapper (read-only)
   └─ Markdown.kt, Images.kt  markdown preview, Coil images
```

## Key dependencies (see `gradle/libs.versions.toml`)
- **Compose** (BOM) + Material 3 + Navigation Compose
- **Sora Editor** `io.github.Rosemoe.sora-editor` — read-only code view with TextMate/tree-sitter grammars (VS Code–grade highlighting)
- **Retrofit** + **OkHttp** (+ `logging-interceptor`) — REST and the WebSocket
- **kotlinx.serialization** — JSON DTOs
- **Room** — local connection metadata
- **androidx.security:security-crypto** — Keystore-backed `EncryptedSharedPreferences` for bearer tokens
- **Coil** — image files
- A Markdown renderer (e.g. `compose-markdown`) — `.md` preview

## Connecting
1. Add a connection: the bridge's base URL — LAN `http://<host>:8787` (Phase 0) or Tailscale `https://<machine>.<tailnet>.ts.net` (Phase 4).
2. Auth: Phase 0 uses a shared `BRIDGE_TOKEN`; Phase 4 pairs via QR/short code → token in the Keystore.
3. Browse a repo; open the Chat tab to talk to Claude operating on that repo (attaching to an existing session if one exists).

## Notes
- Versions in `libs.versions.toml` are a reasonable starting point — bump to current stable in Android Studio.
- `applicationId` is `com.gitview.app` (change to your own before release).
