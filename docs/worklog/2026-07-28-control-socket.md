# Control socket for host administration (ADR-036)

Replaces two mechanisms — signals, and the CLI writing `tokens.json` itself — with one unix socket.
Authentication stays **none**: filesystem permissions are the gate, exactly as for the token store.

## What it fixed
1. **A signal carries no payload**, so the handler minted a pairing code *and* reloaded on every ring —
   `revoke` invalidated an outstanding code. **Verified live**: mint a code, revoke a device, the code
   still pairs. It did not before.
2. **No reply** → the CLI printed `Revoked` before the bridge agreed. It now reports what the bridge did.
3. **Two writers** on one file → the bridge is the single writer; the race is gone, not narrowed.
4. **Ownership** → the CLI writes nothing, so a `sudo` write can no longer leave the store unreadable.
5. **`connected`** is knowable again; the column is back.
6. **`pair`** reads the code from the reply instead of grepping `journalctl`.

`flock`, the staging file and the `chown` handling all **deleted**.

## Three bugs the tests caught, each only by running them
- **`allowHalfOpen`.** The client half-closes after sending; without it the server socket auto-ends on
  that FIN, so any handler that awaits — `revoke` writes the store — lost the race and the caller read an
  empty reply. `pair`/`devices` answer synchronously and survived, which is why it looked selective.
- **Lingering connections.** With `allowHalfOpen` set, `server.close()` waits on open sockets forever.
  Connections are now tracked and destroyed, with a 10s per-connection timeout.
- **`mkdir -p` hangs on a `/proc` path** rather than failing. My "cannot bind" test used one, so it hung
  instead of failing. The test path changed to one that fails fast (`ENOTDIR`) — and `start()` gained a
  5s bound, because a misconfigured socket path must not be able to stall bridge startup.

## Two shell traps
- `GV_SOCK=… node -e '…'` with the assignment **after** the script passes it as *argv*, not an env var.
- Moving it before `$SUDO` is not enough either: `sh` recognises assignment prefixes at **parse** time, so
  once `$SUDO` expands to empty the shell tries to *execute* `GV_SOCK=…`. Fixed with `env(1)`, which works
  whether or not `$SUDO` is set.

## Cost, as designed
A stopped bridge has no socket, so `devices`/`revoke`/`pair` now fail with "bridge is not running"
instead of falling back to editing the store. Covered by a test.

## Verification
Suite **165 pass** (9 new socket tests; the CLI tests rewritten against a live socket). Deployed to the
dev box: socket present as `srw------- argonite`, `pair` returns a working code, `devices` shows
`CONNECTED`, and a revoke left a freshly minted pairing code usable.
