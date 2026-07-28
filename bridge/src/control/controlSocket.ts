import { connect, createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthManager, DeviceSummary } from "../auth/pairing.js";

/**
 * Host administration over a unix socket (ADR-036).
 *
 * `gitview-bridgectl` runs on the same machine, as the same user, shipped in the same package. It has
 * no credential and does not need one: **filesystem permissions are the gate**, exactly as they are for
 * the token store. Anyone who can open this socket could already edit `tokens.json` or signal the
 * process, so this adds no trust boundary — only a better channel across the existing one.
 *
 * It replaces two mechanisms that had each cost us something:
 *
 *  - **Signals.** `SIGHUP` carries no payload, so the handler could not tell why it rang and had to mint
 *    a pairing code *and* re-read the store every time. Consequence: revoking a device invalidated an
 *    outstanding pairing code — exactly when an operator revokes a lost phone to re-pair a good one.
 *  - **The CLI writing `tokens.json` itself.** Two writers raced over one file, and a write under `sudo`
 *    left it root-owned, which the bridge could not read; before `reload()` was hardened that wiped every
 *    device on a live install. The bridge is now the single writer, so neither is possible.
 *
 * Protocol: one JSON request per connection, one JSON reply, then close. Deliberately dumb — there is no
 * session, no streaming, and no reason for either.
 */

/** Requests the CLI may send. Unknown commands are refused rather than ignored. */
export type ControlRequest =
  | { cmd: "pair"; label?: string }
  | { cmd: "devices" }
  | { cmd: "revoke"; id: string };

export type ControlReply =
  | { ok: true; cmd: "pair"; code: string; expiresInSeconds: number }
  | { ok: true; cmd: "devices"; devices: (DeviceSummary & { connected: boolean })[] }
  | { ok: true; cmd: "revoke"; id: string; removed: number; connectionsClosed: number }
  | { ok: false; error: string };

export interface ControlDeps {
  auth: AuthManager;
  /** Live connection state — the reason `connected` is knowable here but never was from the CLI. */
  connectedDeviceIds: () => Set<string>;
  /** Close a revoked device's sockets, matching what DELETE /v1/devices/:id already does. */
  disconnectDevice: (id: string) => number;
  pairingTtlMs: number;
}

/** Binding must not be able to stall startup — see start(). */
const START_TIMEOUT_MS = 5_000;
/** How long to wait for an existing socket to answer before assuming it belongs to a live bridge. */
const PROBE_TIMEOUT_MS = 1_000;

const MAX_REQUEST_BYTES = 8 * 1024; // a request is one short JSON line; anything larger is a bug or an abuse

export class ControlSocket {
  private server: Server | null = null;
  /** Open connections, so close() can tear them down — server.close() alone waits for them forever. */
  private conns = new Set<Socket>();

  constructor(
    private readonly path: string,
    private readonly deps: ControlDeps,
  ) {}

  /**
   * Bind the socket. Returns false (without throwing) when it cannot — a bridge that serves repos fine
   * must not fail to start because its admin channel is unavailable, e.g. a dev run with no /run dir.
   */
  async start(): Promise<boolean> {
    try {
      // Bounded: a pathological socket path can make mkdir hang rather than fail — /proc does exactly
      // that — and the admin channel must never be able to stall the bridge's startup.
      return await Promise.race([
        this.bind(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), START_TIMEOUT_MS).unref?.()),
      ]);
    } catch {
      return false;
    }
  }

  private async bind(): Promise<boolean> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      if (!(await this.claimSocketPath())) {
        console.error(`  Host admin socket ${this.path} is already in use by another bridge — not binding.`);
        return false;
      }

      // allowHalfOpen: the client sends its request and half-closes. Without this the socket is ended
      // automatically on that FIN, so any handler that awaits — revoke writes the store — loses the race
      // and the caller reads an empty reply.
      const server = createServer({ allowHalfOpen: true }, (sock) => void this.onConnection(sock));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.path, () => { server.removeListener("error", reject); resolve(); });
      });
      // Owner-only: this is the same gate as the token store's 0600.
      await chmod(this.path, 0o600);
      server.on("error", () => {}); // a transient accept error must not take the bridge down
      this.server = server;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear a socket file left by an unclean exit — but ONLY if nothing is listening on it.
   *
   * The first cut probed by binding a *different* path (`.sock.probe`), which essentially always
   * succeeds, so it concluded "stale" every time and unlinked the real socket. A second bridge started
   * against the same config would silently steal it: the first kept serving HTTP while `bridgectl`
   * talked to the second, so admin commands landed on a different store than the operator expected.
   *
   * Returns false when a live bridge already owns the path, so the caller refuses to bind.
   */
  private async claimSocketPath(): Promise<boolean> {
    try {
      await stat(this.path);
    } catch {
      return true; // nothing there — the path is ours
    }
    const live = await new Promise<boolean>((resolve) => {
      const probe = connect(this.path);
      const settle = (v: boolean): void => { probe.destroy(); resolve(v); };
      probe.on("connect", () => settle(true));
      probe.on("error", () => settle(false)); // ECONNREFUSED on a stale file: nobody is home
      probe.setTimeout(PROBE_TIMEOUT_MS, () => settle(true)); // answered but hung: still someone's socket
    });
    if (live) return false;
    await unlink(this.path).catch(() => {});
    return true;
  }

  private async onConnection(sock: Socket): Promise<void> {
    this.conns.add(sock);
    sock.on("close", () => this.conns.delete(sock));
    // allowHalfOpen keeps the socket alive until we reply, so a client that connects and says nothing
    // would otherwise hold it open indefinitely. Nothing legitimate takes longer than this.
    sock.setTimeout(10_000, () => sock.destroy());
    sock.setEncoding("utf-8");
    let buf = "";
    let done = false;

    const reply = (r: ControlReply): void => {
      if (done) return;
      done = true;
      // end() flushes the reply and sends FIN; destroySoon() then releases our side once it drains, so a
      // half-open connection cannot linger and stall close().
      sock.end(`${JSON.stringify(r)}\n`, () => sock.destroySoon());
    };

    sock.on("error", () => sock.destroy());
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        // Destroy rather than just replying: otherwise the client can keep streaming into buf until the
        // idle timeout reaps the connection.
        reply({ ok: false, error: "request too large" });
        sock.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return; // wait for a full line
      const line = buf.slice(0, nl);
      void this.handle(line).then(reply, (err: unknown) =>
        reply({ ok: false, error: (err as Error).message || "control command failed" }));
    });
  }

  private async handle(line: string): Promise<ControlReply> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return { ok: false, error: "malformed request" };
    }

    switch (req.cmd) {
      case "pair": {
        // The code comes back in the reply, so the CLI no longer greps journalctl for something it just
        // caused to be printed.
        const code = this.deps.auth.refreshPairingCode();
        return { ok: true, cmd: "pair", code, expiresInSeconds: Math.round(this.deps.pairingTtlMs / 1000) };
      }
      case "devices": {
        const online = this.deps.connectedDeviceIds();
        return {
          ok: true,
          cmd: "devices",
          devices: this.deps.auth.list().map((d) => ({ ...d, connected: online.has(d.id) })),
        };
      }
      case "revoke": {
        if (!req.id) return { ok: false, error: "revoke needs a device id" };
        // The bridge revokes through its OWN store, so there is no second writer and no ownership to get
        // wrong — and the reply tells the operator what actually happened instead of the CLI guessing.
        const removed = await this.deps.auth.revoke(req.id);
        if (!removed) return { ok: false, error: `unknown device: ${req.id}` };
        const closed = this.deps.disconnectDevice(req.id);
        // `removed` is what the store actually dropped, not a hardcoded 1: revoking `legacy` clears the
        // whole pre-ADR-035 bucket, and the operator deserves to know it was twenty-one and not one.
        return { ok: true, cmd: "revoke", id: req.id, removed, connectionsClosed: closed };
      }
      default:
        return { ok: false, error: `unknown command: ${String((req as { cmd?: unknown }).cmd)}` };
    }
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    await unlink(this.path).catch(() => {});
  }
}
