# App: paired-device list + revoke (ADR-035, app half)

The bridge half of ADR-035 shipped device identity, `GET /v1/devices` and `DELETE /v1/devices/:id`, but
nothing in the app used them — the feature was reachable only by `curl`. This adds the UI and makes
devices arrive *named*.

## What shipped
- **Repos ⋮ → "Paired devices…"** — a dialog listing every device holding a token: label, `connected` /
  relative `lastSeenAt`, and **Revoke** behind a confirm. There is no Settings screen
  (`CONNECTIONS/REPOS/WORKSPACE`), so it hangs off the existing screen-scoped `OverflowMenu` pattern —
  the same way `onClaudeSettings` is workspace-only — rather than inventing a screen for one dialog.
- **Devices arrive named.** `POST /v1/pair` now carries `Build.MODEL` as `label`, so the list reads
  "Pixel 8" instead of the bridge's `"device"` default. Verified end-to-end: the emulator's pair wrote
  `label: "sdk_gphone64_x86_64"` into the bridge's store.
- **The app knows which row is itself** by parsing the id out of its own bearer token
  (`<id>.<secret>`) — no extra endpoint. That row is marked "this device" and its Revoke is
  **withheld**, because the bridge answers a self-revoke with 403. Better to not offer the action than
  to offer one that fails.
- **The legacy row is honest about its own limits.** A client still on a pre-ADR-035 token *is*
  `legacy`, so it cannot clear the legacy bucket. Instead of a dead button, that case explains itself:
  "This device still uses an older token, so it's part of the legacy group and can't clear it."
- Wire types default every field, so an **older bridge** (which returns none of them) still decodes.

## Two defects that only running it would have caught
- **The legacy label was truncated.** `maxLines = 1` + ellipsis cut "unknown legacy device(s) (21)" at
  exactly the useful part — the count. Now 2 lines.
- **"last seen 2026-07-26" instead of "just now".** `lastSeenAt` is stamped by the BRIDGE, so on a device
  whose clock trails it the timestamp parses as the *future* — and the shared `relativeTime` (built for
  commit dates, where a future stamp means a rewritten timestamp) falls back to printing the date. Added
  `lastSeenText`, which reports a small forward skew as "just now" and defers to `relativeTime`
  otherwise. Real-world condition, not an emulator artifact: any phone running slightly behind the
  bridge would have hit it.

Also of note: a `relativeTime` helper **already existed** (`Screens.kt`) and is better than the one I
started writing (handles skew, falls back to a date), so mine was deleted rather than kept alongside.

## Verification — all three form factors
Built `assembleDebug` and drove each emulator against the live dev-box bridge.

| | |
| --- | --- |
| **Phone** (`kancil_test`, 1080×2340 @440) | `2026-07-27-devices-phone.png` — self row marked "this device" with **no** Revoke; legacy row shows its count and "Revoke all". |
| **Tablet** (`tabS8`, 2560×1600 @320) | `2026-07-27-devices-tablet.png` — driven from a client holding a **legacy token**, so it sees *itself* as the legacy row: no Revoke, plus the explanatory note. It can still revoke the phone. |
| **Color E-Ink** (`bigmeB7`, 1264×1680 @320, E-Ink profile) | `2026-07-27-devices-eink.png` — renders **hue-free**: "Revoke" is black rather than red, and the repo list paginates ("1–4 of 4"). |

Beyond rendering:
- **Revoke works end-to-end from the app.** Paired a throwaway "Old Tablet", revoked it from the phone
  → row disappeared and the bridge store confirmed only the remaining device
  (`2026-07-27-devices-revoke-confirm.png` is the confirm step).
- **The legacy path needs no re-pair** — the tablet connected on a token from a previous session
  without prompting, which is the migration guarantee holding up on a real client.
- **Error state renders too:** the e-ink emulator's stale token produced an inline "missing or invalid
  token" + "No devices reported." in the dialog rather than a blank list.
- The owner's bridge was left **exactly as found**: both test devices revoked, 21 legacy tokens intact.

## Not done
- The owner's real phone (`M2012K11AG`) was connected over wireless ADB throughout and was
  **deliberately not touched** — no install, no pairing. The three form factors are emulators.
- Revoking the legacy bucket was never actually executed: the confirm dialog was opened for the
  screenshot and cancelled, since it would drop the owner's 21 live tokens.
