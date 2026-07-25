# Device auth — per-device, hashed, revocable tokens (ADR-035, Option B)

**Bridge-only.** No app change is required: the token stays an opaque string to the client, and the
existing `Authorization: Bearer` / WS auth-frame paths are unchanged.

## Why
The owner asked why minting a pairing code has to signal the process, and whether "a database that
manages key pairs per client" would be better — then, decisively: *"if I have multiple devices connected
at the same time, which one is better?"*

Two separate concerns were tangled together:
- **The pairing code** lives in RAM on purpose. `POST /v1/pair` is the only auth-exempt write endpoint
  (it must be — a pairing client has no token yet), so a "mint me a code" endpoint could not be
  authenticated either; anyone who could reach `:8787` could then pair themselves, and via the terminal
  that is RCE as the run-user. Restricting the code to the local console/journal makes **host access**
  the authentication. The SIGHUP is a *symptom* of that choice, not a cost: the unit already declares
  `ExecReload=/bin/kill -HUP $MAINPID`, so `gitview-bridgectl pair` sends the identical signal and
  nothing restarts (verified: MainPID stable, `NRestarts=0`).
- **The token store** was the real weakness — 21 bare strings in a JSON array: no identity, no granular
  revocation (a lost phone meant truncating the file and de-authorizing *everything*), plaintext at
  rest, and an O(n) constant-time scan on every request.

Multi-device settled it. B and C both add identity; what separates them under concurrency is per-request
cost — C verifies an **asymmetric signature** every call (EC P-256 ≈ 50–100 µs) where B does a `Map`
lookup plus one hash compare (≈ 1 µs). Under load C is not just more expensive to build, it is **slower**.
Full reasoning + the deferred options in **ADR-035**.

## What shipped
- **Per-device tokens.** A token is now `<deviceId>.<secret>`; the store keeps
  `{id, label, createdAt, lastSeenAt, tokenHash}` and only **sha256(secret)**. Lookup is by id (**O(1)**)
  then ONE `timingSafeEqual` on the hash.
- **Hashing rationale, recorded so it isn't "fixed" later:** the secret is 32 bytes from `randomBytes`,
  not a human password — a plain SHA-256 is right, and a slow KDF (bcrypt/argon2) would only tax every
  request. **Timing:** the `Map` lookup makes *id* existence observable; accepted deliberately (ids are
  not secrets) while the secret stays constant-time compared. This is a change from the old flat-timing
  O(n) loop and is called out in ADR-035 so it is not mistaken for a regression.
- **`GET /v1/devices` / `DELETE /v1/devices/:id`** — list with labels + `connected`, and revoke.
  `connected` comes from the **live socket set**, not `lastSeenAt`: with several devices you want to
  know who is on the wire *now*.
- **Revocation is immediate, not eventual.** A WS authenticates once at connect (`conn.authed`), so
  revoking also closes that device's sockets with **4401** and kills its terminals; the response reports
  `connectionsClosed`. Self-revocation is refused (403) — it would sever the very request answering it.
- **Terminal cap moved per-DEVICE** (was `MAX_TERMINALS_PER_CONN`). One device can hold several sockets
  across reconnects, so a per-connection cap multiplied by however many times it reconnected.
- **Audit attributes the device** — `AuditEntry.device`, so `terminal.open` and writes name a device
  instead of the anonymous `"app"` shared by everyone.
- **`lastSeenAt` is coalesced (~10 s), never fsynced per request.** The rimba soak issued 59 diff polls
  in 30 s — per-request writes would have meant 59 file writes. The timer is `unref`'d and flushed on
  shutdown.
- **Atomic persistence** — tmp + `rename`, mode `0600`, so a crash or concurrent read never sees a
  half-written store.

## Migration — nobody re-pairs
Pre-ADR-035 bare tokens still verify (via the old flat scan) and surface as ONE synthetic entry
(`id: "legacy"`), since they carry no identity and genuinely cannot be told apart. They can be revoked
wholesale once every real device has re-paired. The owner's 21 accumulated tokens keep working as-is.

## A real bug found while testing
The E2E client set `Content-Type: application/json` on a **body-less DELETE** and got a **500**
("Body cannot be empty when content-type is set to 'application/json'") — Fastify's default JSON parser
rejects an empty body. That is a genuine API bug for any client that sets the header globally, not just a
test artifact. Fixed with a tolerant content-type parser (empty body → `undefined`, malformed → 400
rather than 500). **The shipped app was never affected** — OkHttp's `.delete()` sends no `Content-Type`
(checked `BridgeApi.kt`) — so this was latent, not a live regression.

## Verification
- `tsc` clean; bridge suite **133 pass / 0 fail** (121 before + 12 new in `test/devices.test.ts`:
  token shape, secret-never-stored, tampered secret/unknown id, selective revoke, label sanitizing,
  lastSeen advance, legacy verify/co-existence/wholesale-revoke, persistence + `0600`).
- **E2E against a live bridge** (`:8899`, clean store) — the parts unit tests can't reach:
  two devices paired with labels → distinct ids; the secret absent from disk while `tokenHash` is
  present; `connected` true only for the device holding the WS; self-revoke 403; unknown id 404; then
  **device B revoked device A mid-connection** → 200 with `connectionsClosed: 1`, **A's WebSocket closed
  with 4401**, A's REST calls 401, **B unaffected**; audit showed `terminal.open` attributed to A and
  `device.revoke` recording who revoked whom. Since that client sets `Content-Type` on every request
  including DELETE, its passing is also the regression check for the empty-body fix.
- The owner's systemd bridge was **not** touched (MainPID 843, `NRestarts=0`, still healthy on 0.1.7) —
  testing ran on a separate scratch instance.

## Not done (deliberate)
- **App UI** — a device list with a revoke action, and sending a real device name as `label` at pair
  time. The bridge accepts `label` already and defaults to `"device"` when absent, so an unchanged app
  keeps working. Proposed as the follow-up.
- **Options A and C** (file-backed pairing code; per-device signing keypairs) — deferred, with the
  conditions for revisiting C recorded in ADR-035.
