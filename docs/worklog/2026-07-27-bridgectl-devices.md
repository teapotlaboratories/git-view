# `gitview-bridgectl devices` / `revoke`

Devices could only be listed and revoked from the app, or by hand with curl and a token. Managing them
from the **host** — revoking a lost phone when you have no working paired client — was not possible.

## The design question, and why my first answer was wrong
I started by asking how the CLI should *authenticate* to `/v1/devices`, and offered two options: pair the
CLI as a device, or add a local admin-token path to the bridge. The owner pushed back — "why does the CLI
need to authenticate to the bridge? the CLI itself is the bridge (or part of it), correct?" — and that is
right. `gitview-bridgectl` ships in the same `.deb`, runs as root or the run-user, and already drives
`systemctl restart` and `journalctl`. Making it prove itself to a service on the same box, running as the
same user, whose state file it can read and write anyway, is theatre: there is no boundary to cross.

It also would not have worked for long. Since ADR-035 the store keeps only **sha256 hashes**, so there is
no usable token on disk once the legacy plaintext ones are revoked — which is exactly what this feature
encourages. A "read `tokens[0]`" implementation works today and breaks the moment the feature is used
properly.

**So the CLI reads and edits `tokens.json` directly.** The only real constraint was that
`AuthManager.load()` runs once at boot and the store lives in memory, so an external edit would not take
effect until a restart.

## What shipped
- **`devices`** — reads the store directly and prints id / name / last-seen. No API call, no token.
- **`revoke <id>`** — edits the store, then `systemctl reload` (SIGHUP). `legacy` drops the whole
  pre-ADR-035 bucket.
- **Bridge: SIGHUP now also reloads the token store** and disconnects any device that vanished, so an
  out-of-band revoke is immediate — the same behaviour `DELETE /v1/devices/:id` already had.

## A test that proved nothing, again
`reload()` was documented as dropping a pending `lastSeenAt` flush "so it cannot resurrect a revoked
device", with a test to match. Removing the guard left the suite green: once `reload()` replaces the maps,
a late flush writes POST-reload state and cannot resurrect anything. **The comment claimed more than the
code did.**

The real window is on the other side of the signal — a flush landing between the CLI's write and the
signal writes the pre-edit list straight back — and `reload()` cannot close it. The comment now says so,
and the test was replaced with one that **pins the actual behaviour**: it asserts the device *does* come
back in that ordering. If someone later makes the flush merge rather than overwrite, that test will fail
and should be updated.

That is the third hollow test this session; each was caught only by deliberately running it against
broken code, never by reading it.

## Verification
- Suite **144 pass**. Four new tests for reload (vanished-device reporting, legacy bucket, no-op when
  unchanged, and the race above).
- **End-to-end against the live systemd bridge**: paired a throwaway, held an authenticated WebSocket,
  ran `gitview-bridgectl revoke <id>` → **socket closed with 4401**, token rejected **401 without a
  restart**, device gone from the list, and the owner's real device (`SM-S931B`) untouched.
