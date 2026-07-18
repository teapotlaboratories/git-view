# GitView Android App

Native Kotlin + Jetpack Compose thin client. Browse/edit/commit a repo served by the bridge, and
chat to a full-tool Claude session over one WebSocket. One APK serves both device classes via the
symmetric **DisplayProfile** (Standard | Color E-Ink).

## Build
```bash
# local.properties must point at your SDK: sdk.dir=/path/to/Android/Sdk
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Toolchain: JDK 17–21, Android SDK platform 34 / build-tools 34, Gradle 8.9 (wrapper), **Kotlin 2.2.21**
(required by Sora Editor 0.24.4's Kotlin 2.2 metadata — see `../docs/DECISIONS.md` ADR-013/ADR-022).

## Layout
```
app/src/main/java/com/gitview/app/
  MainActivity.kt         single activity; detects DisplayProfile, hosts Compose
  AppViewModel.kt         UI state; owns BridgeApi + BridgeClient
  data/
    Wire.kt               protocol types, mirrored from ../docs/API.md
    BridgeApi.kt          REST (OkHttp), suspend calls
    BridgeClient.kt       one WebSocket; first-frame auth; parsed ServerEvents
    ConnectionStore.kt    Room (metadata) + Keystore/EncryptedSharedPreferences (tokens)
  ui/
    Screens.kt            connections / repos / browse+editor / chat
    Components.kt          Sora CodeEditorView, file tree, chat list, selectors
    theme/DisplayProfile.kt  Standard | Color E-Ink, auto-detect + persisted override
    theme/Theme.kt         Material theme per profile; ripple disabled on e-ink
  render/
    EInkRefreshController.kt  vendor-neutral; NO-OP default; best-effort Bigme impl
  assets/textmate/eink-mono.json   weight/italic/underline theme for the e-ink profile
```

## Notes
- **Sora Editor is LGPL-2.1** — used as an unmodified AAR dependency; GitView's own code stays MIT.
  Keep it a replaceable dependency and ship the LGPL notice. See `../docs/DECISIONS.md` ADR-013.
- **DisplayProfile** auto-selects Color E-Ink on Bigme/e-ink hardware; the top-bar toggle sets a
  persisted override that always wins.
- The chat cost shown accumulates `total_cost_usd` across resumes (it's a per-query estimate).
- Highlighting grammar loading and the diff viewer are the marked Phase-1 follow-ups.
