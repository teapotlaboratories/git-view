# GitView Android app

Native Kotlin + Jetpack Compose. A VS Code–like code **editor** plus a Claude chat tab,
talking to a GitView **bridge** over REST (browse + edit) and a WebSocket (chat).

> **Scaffold.** This folder defines the intended module layout, the dependency catalog, and key
> source stubs. Open it in **Android Studio**, let it sync, and generate the Gradle wrapper
> (`gradle wrapper`, git-ignored) on first open. Then build in the order of `docs/PLAN.md`.

## Screens (Compose)
| Screen | Phase | Purpose |
|---|---|---|
| `ConnectionsScreen` | 0/4 | Saved bridges (multi-machine); add/pair; pick one. |
| `RepoListScreen` | 0 | Repos served by the selected bridge. |
| `TreeScreen` | 0/1 | Lazy, virtualized file tree; create/rename/delete; file-type icons. |
| `FileEditor` | 1/2 | **Editable** Sora Editor with syntax highlighting; save, undo/redo, dirty state. |
| `DiffViewer` | 1 | Unified + side-by-side diffs; blame overlay; stage/discard hunks. |
| `LogScreen` | 1 | Commit log + commit detail; commit from the working tree. |
| `ChatScreen` | 3 | Streamed Claude chat (full tools); tool-use chips incl. edits; interrupt; session switcher. |

On a phone, `Browse/Edit ⇄ Chat` is a bottom tab; on a tablet it's a two-pane split. When Claude
edits a file, the open buffer/tree refresh (driven by `repo_changed` events, Phase 4).

## Suggested package layout
```
com.gitview.app
├─ MainActivity.kt            single activity; hosts the Compose nav graph
├─ ui/
│  ├─ connections/  repos/  tree/  file/  diff/  log/  chat/    (Compose screens + view models)
│  └─ theme/
│     ├─ DisplayProfile.kt    Standard vs Color-E-Ink profile + LocalDisplayProfile + EInk detect  ✅ stub
│     └─ (Material 3 theme, standard + e-ink color schemes)
├─ data/
│  ├─ BridgeApi.kt            Retrofit interface (REST browse + edit)
│  ├─ LiveChannel.kt          OkHttp WebSocket client (chat + events; e-ink batches per profile)
│  ├─ ConnectionStore.kt      Room + Keystore-backed saved connections
│  └─ model/                  DTOs mirroring docs/API.md
├─ render/
│  ├─ CodeEditor.kt           Sora Editor wrapper (editable; swaps EditorColorScheme per profile)
│  ├─ EInkRefreshController.kt  reflection-guarded Onyx EPD refresh (no SDK hard-link)  ✅ stub
│  └─ Markdown.kt, Images.kt  markdown preview, Coil images
└─ (assets) app/src/main/assets/textmate/eink-mono.json   e-ink TextMate theme  ✅
```

## Key dependencies (see `gradle/libs.versions.toml`)
- **Compose** (BOM) + Material 3 + Navigation Compose
- **Sora Editor** `io.github.Rosemoe.sora-editor` — editable code view with TextMate/tree-sitter grammars (VS Code–grade highlighting)
- **Retrofit** + **OkHttp** (+ `logging-interceptor`) — REST (read + write) and the WebSocket
- **kotlinx.serialization** — JSON DTOs
- **Room** — local connection metadata
- **androidx.security:security-crypto** — Keystore-backed `EncryptedSharedPreferences` for bearer tokens
- **Coil** — image files
- A Markdown renderer (e.g. `compose-markdown`) — `.md` preview

## Connecting
1. Add a connection: the bridge's base URL — LAN `http://<host>:8787` (Phase 0) or Tailscale `https://<machine>.<tailnet>.ts.net` (Phase 5).
2. Auth: Phase 0 uses a shared `BRIDGE_TOKEN`; Phase 5 pairs via QR/short code → token in the Keystore.
3. Browse/edit a repo; open the Chat tab to have Claude read and modify that same repo.

## Editing model
- The editor opens the **working-tree** version (`GET /working`) and saves back with `PUT /blob`.
- Historical refs (`GET /blob?ref=…`) are read-only — you view them but can't write into a past commit.
- Git actions (`stage`/`commit`/`discard`) act on the working tree. Git is your undo.

## Color e-ink alternative view
An alternative display profile for color e-ink panels (E Ink Kaleido 3 — Boox Note Air5 C / Tab X C, Bigme, PocketBook Color Note). Full design contract in [../docs/EINK.md](../docs/EINK.md). In the app:
- `ui/theme/DisplayProfile.kt` — the `Standard` vs `ColorEInk` profile, `LocalDisplayProfile`, and `EInk` device detection (heuristic; user override always wins). ✅ scaffolded.
- `render/EInkRefreshController.kt` — reflection-guarded Onyx `EpdController` refresh (REGAL default, GC full-flash on triggers, clean-flash every N). Compiles and no-ops off-Boox. ✅ scaffolded.
- `assets/textmate/eink-mono.json` — near-monochrome syntax theme encoding token type via **bold/italic/underline** (glyphs stay black at 300 PPI; color is 150 PPI and muted). ✅ scaffolded.
- Still to wire: MotionDurationScale=0 / `NoIndication` / overscroll-off at the theme root, snap/pagination scroll, and per-line streaming batching in `LiveChannel` keyed on `profile.streamBatchIntervalMs`.

## Notes
- Versions in `libs.versions.toml` are a reasonable starting point — bump to current stable in Android Studio. Compose ripple/overscroll APIs and Sora theme APIs are version-sensitive (see EINK.md §8).
- E-ink targets are Android 12+ (current `minSdk` 26 still runs everywhere; e-ink devices are simply newer).
- `applicationId` is `com.gitview.app` (change to your own before release).
