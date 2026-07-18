# GitView — Setup & Toolchain

This machine was checked during scaffolding. Here's what's present and what you'll need.

## Detected on this machine
- ✅ `git` 2.43
- ✅ `python3` 3.12, `java` (OpenJDK) 21
- ❌ `node` / `npm` — **required for the bridge**
- ❌ `kotlin`, Android SDK, `adb` — **required to build the app**
- ❌ `flutter` — not needed (native path chosen)

## Bridge prerequisites
- **Node.js ≥ 20** and npm (or pnpm). Install via [nvm](https://github.com/nvm-sh/nvm): `nvm install 20`.
- **Claude Agent SDK** — added as a dependency in `bridge/package.json` (`@anthropic-ai/claude-agent-sdk`). Pin the version and confirm option names against the current docs.
- **Claude auth** — an `ANTHROPIC_API_KEY` (bridge-held), or a Claude subscription if you use remote-control/OAuth paths later.
- **Tailscale** on the bridge machine and the phone (Phase 4).

### Run the bridge (once implemented)
```bash
cd bridge
cp .env.example .env            # ANTHROPIC_API_KEY, DEVICE_TOKEN_SECRET, BRIDGE_TOKEN
cp config.example.yaml config.yaml   # list your repos + absolute paths
npm install
npm run dev                     # http://localhost:8787
```

### Expose over Tailscale (Phase 4)
```bash
tailscale up                    # once
tailscale serve --bg 8787       # serves https://<machine>.<tailnet>.ts.net → :8787
tailscale serve status
```

## Android app prerequisites
- **Android Studio** (latest) with the Android SDK (API 34+), JDK 17+.
- Kotlin + Jetpack Compose (managed by Gradle; versions in `android/gradle/libs.versions.toml`).
- Key libraries: Sora Editor (`io.github.Rosemoe.sora-editor`), Retrofit + OkHttp (REST + WebSocket), Room (connection store), Coil (images), a Markdown renderer, `androidx.security` (Keystore-backed prefs).

### Build the app (once scaffolded in Android Studio)
```bash
# Open android/ in Android Studio, let it sync Gradle, then:
cd android
./gradlew assembleDebug        # after generating the Gradle wrapper in Android Studio
adb install app/build/outputs/apk/debug/app-debug.apk
```
> The `android/` folder here defines the intended module layout, dependency catalog, and key source stubs. Generate the Gradle wrapper (`gradle wrapper`) from Android Studio on first open; it's git-ignored.

## Development order
Follow [PLAN.md](PLAN.md): Phase 0 (LAN browse) → Phase 1 (viewer) → Phase 2 (chat) is the MVP. Add Tailscale (Phase 4) once the LAN loop works end to end.
