# GitView Setup

## Prerequisites
- **Bridge host:** Node.js ≥ 20, system `git`, and (for chat) a Claude subscription (Remote Control)
  or an `ANTHROPIC_API_KEY` (local SDK). Tailscale installed.
- **Build host (app):** JDK 17–21, Android SDK (platform 34 / build-tools 34), Gradle via the wrapper.
- **Device:** Android 8.0+ (API 26). Bigme B7 Pro (Android 14) is a first-class target.

## 1. Run the bridge
```bash
cd bridge
npm install
cp config.example.yaml config.yaml     # set your repo path(s)
npm run dev                              # dev; or: npm run build && npm start
```
On start it prints a **pairing code**. Keep the terminal visible for the next step.

Optional chat dependencies (already listed as optional):
```bash
npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/sandbox-runtime
```
- **Local SDK provider:** `export ANTHROPIC_API_KEY=sk-ant-…`
- **Remote Control provider:** leave `ANTHROPIC_API_KEY` UNSET and sign in with your claude.ai
  subscription (`claude` CLI). Remote Control rejects API keys.

## 2. Expose it over Tailscale (do NOT use a public URL)
```bash
tailscale up                 # once, to join your tailnet
tailscale serve --https=443 http://127.0.0.1:8787
tailscale serve status       # note the https://<host>.<tailnet>.ts.net URL
```
This gives auto-TLS and zero public exposure. The app will use that `https://…ts.net` URL as the
connection Base URL.

**Cloudflare Tunnel fallback** (documented alternative): `cloudflared tunnel --url http://127.0.0.1:8787`
behind Cloudflare Access. Never expose a read/write bridge unauthenticated. See [SECURITY.md](SECURITY.md).

## 3. Build & install the app
```bash
cd android
# local.properties must point at your SDK (sdk.dir=/path/to/Android/Sdk)
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 4. Pair
1. In the app: **Add a bridge** → name it, set the Base URL to your `https://…ts.net` (or
   `http://<tailscale-ip>:8787` for plain dev).
2. Tap **Connect** → enter the **pairing code** from the bridge console.
3. The token is stored in the Android Keystore; you won't re-pair unless you clear it or restart the
   bridge (which rotates the code).

## 5. Use it
- **Browse/Edit:** pick a repo → navigate the tree → open a file → edit → **Save** → commit. Switch
  to a historical ref to inspect read-only.
- **Chat:** tap **Chat →**, choose a provider (Remote / Local SDK) and a permission profile (defaults
  to `auto`), and prompt. Claude reads and writes the same repo; tool calls stream into the pane.

## DisplayProfile
Auto-detected per device (Standard on LCD, Color E-Ink on Bigme/e-ink hardware). Override with the
**Standard/E-Ink** toggle in the top bar; the override persists and always wins. On the Bigme, set
GitView's per-app refresh mode in the **E-Ink Center** for best results (see [EINK.md](EINK.md)).

## Troubleshooting
- **401 on every request:** token missing/expired — re-pair (restart the bridge to get a fresh code).
- **`path_escape`:** the path left the repo root (symlink or `..`) — expected and safe.
- **Chat says SDK unavailable:** install the optional `@anthropic-ai/*` packages (step 1).
- **Remote Control won't start:** ensure `ANTHROPIC_API_KEY` is unset and you're signed into claude.ai;
  it needs outbound HTTPS on :443.
