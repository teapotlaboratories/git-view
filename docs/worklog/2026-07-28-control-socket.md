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

## Review findings (PR #42)
- **`removeStaleSocket()` never detected a live socket.** Its comment said "if a bridge is listening it
  will answer a connect" — but it never connected; it bound a *different* path (`.sock.probe`), which
  essentially always succeeds, so it concluded "stale" every time and unlinked the real socket. Proven:
  a second `ControlSocket` on the same path **took it over**, leaving the first serving HTTP while the
  CLI talked to the second — admin commands landing on a store the operator did not mean. It now
  actually connects: something answers → refuse to bind and log it; `ECONNREFUSED` → the file is stale
  and safe to clear. A test covers it and fails against the old probe.
- Oversized requests now **destroy** the connection instead of replying and letting the client keep
  streaming into the buffer until the idle timeout reaped it.
- Recorded why `SIGHUP` still mints a code *and* reloads: it is the legacy coupled path, kept so
  `systemctl reload` works and a hand-edited store can still be picked up. The socket is the precise one.

That is the same shape as the hollow tests from the day before — code whose comment described behaviour
it did not have. Reading it agreed with itself; only running it disagreed.

Suite **167 pass**. Redeployed and re-verified: pair → 200, `devices` shows `CONNECTED`, revoke leaves a
freshly minted pairing code usable.

## Second review pass — four more findings, applied

- **The socket check ran unprivileged.** `[ ! -S "$SOCK" ]` was evaluated as *you*, but on a stock install
  the bridge runs as `gitview-bridge` and `RuntimeDirectory` is `0700`, so an operator cannot stat inside
  it. Every command answered *"bridge is not running"* — and then advised `start`, which is a no-op on a
  running service — while the `$SUDO env … node` line directly below would have connected. It was also a
  regression: the pre-ADR-036 `devices`/`revoke` read the store through `$SUDO` and worked.
  The check now happens inside the privileged client, as `ENOENT`/`ECONNREFUSED` from the connect itself,
  with a distinct message for `EACCES`.

  Two reasons it survived the first pass, both worth remembering: every live check ran as `argonite`
  **with sudo**, and this box's unit carries a drop-in overriding `User=argonite` — the one configuration
  where the guard passes. And `bridgectl.test.ts` sets `GITVIEW_SUDO=""` against a socket the test user
  owns, so the sudo-dependent path was untestable there by construction. `ctl_socket()` was already using
  `$SUDO grep` for the same config file; that inconsistency was the tell.

  Reproduced live before and after, with real sudo (askpass so stdin stays free for the request), a
  root-owned `0700` directory and the installed CLI: `-S` is false for the operator, and the fixed CLI
  lists the device anyway.

- Consolidated the two near-identical embedded node clients into one `ctl_send`.
- **The CLI's header comment described the opposite of the code** — "devices/revoke read and edit
  `tokens.json` DIRECTLY" is precisely what this branch removes. `tokens_file()` was dead and is gone.
  Third comment-vs-code mismatch on this branch; they read as correct because they agree with themselves.
- **Docs:** `docs/html/PLAN.html` never got the ADR-036 entry its `.md` twin gained, and the plan still
  said *"proposed / awaiting the owner's decision"* while `DECISIONS.md` said *decided and implemented*.
  Both fixed, plus the older `bridgectl devices/revoke` entry which still documented the `SIGHUP`-reload
  mechanism this branch replaced.

Suite **168 pass** — the new CLI test fails against the old guard.
