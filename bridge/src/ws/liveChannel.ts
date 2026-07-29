import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RepoRegistry } from "../repoRegistry.js";
import type { AuthManager, DeviceIdentity } from "../auth/pairing.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { AgentProvider } from "../agent/types.js";
import type { ClientFrame, ServerEvent, ServerFrame } from "../wire.js";
import type { RawConfig } from "../config.js";
import type { AuditLog } from "../util/audit.js";
import { spawnTerminal, type PtyTerminal } from "../terminal/ptyTerminal.js";
import { homedir } from "node:os";

/**
 * The single live channel (`/v1/live`). One WebSocket per app instance.
 *
 * Auth (see docs/SECURITY.md): the token is NEVER in the URL query string. Two accepted paths:
 *  1. FIRST-FRAME: client sends {type:"auth",token} as the first message; nothing else is processed
 *     until it validates (constant-time). On failure we close with 4401.
 *  2. SUBPROTOCOL: `Sec-WebSocket-Protocol: gitview.bearer.<token>` at upgrade time.
 *
 * Every server→client frame carries a monotonic per-connection `eventId`; a ring buffer (512) backs
 * `replay` so a reconnecting client can recover missed events.
 */
const RING_SIZE = 512;
const SUBPROTOCOL_PREFIX = "gitview.bearer.";
// Bound the shells one connection can spawn — each `terminal.open` forks a process, so an unbounded
// client (buggy or hostile) could otherwise fork-bomb the host through the API.
// Bound shells PER DEVICE, not per connection: one device may hold several sockets, so a
// per-connection cap multiplies by however many times it reconnects (ADR-035).
const MAX_TERMINALS_PER_DEVICE = 8;

interface Conn {
  ws: WebSocket;
  authed: boolean;
  /** Which paired device is on this socket (ADR-035) — null until the auth frame validates. */
  device: DeviceIdentity | null;
  nextId: number;
  ring: ServerFrame[];
  terminals: Map<string, PtyTerminal>; // live PTY shells opened on this connection, by client termId
}

export class LiveChannel {
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  // Which agent provider owns each live session, so an interrupt routes to the right one.
  private sessionProvider = new Map<string, AgentProvider>();

  constructor(
    private readonly auth: AuthManager,
    private readonly agents: AgentRegistry,
    private readonly registry: RepoRegistry,
    private readonly terminalCfg: RawConfig["terminal"],
    private readonly audit: AuditLog,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Attach to the Fastify/Node HTTP server's upgrade event, scoped to /v1/live. */
  attach(server: Server): void {
    server.on("upgrade", (req, socket: Duplex, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== "/v1/live") {
        socket.destroy();
        return;
      }
      // Optional subprotocol auth.
      const proto = String(req.headers["sec-websocket-protocol"] ?? "");
      const subToken = proto.split(",").map((s) => s.trim()).find((s) => s.startsWith(SUBPROTOCOL_PREFIX));
      const preAuthed = subToken ? this.auth.authenticate(subToken.slice(SUBPROTOCOL_PREFIX.length)) : null;

      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, preAuthed));
    });
  }

  private onConnection(ws: WebSocket, preAuthed: DeviceIdentity | null): void {
    const conn: Conn = { ws, authed: preAuthed !== null, device: preAuthed, nextId: 1, ring: [], terminals: new Map() };
    this.conns.add(conn);
    if (preAuthed) this.emit(conn, { type: "ready" });

    // Kill every PTY this connection opened when it drops, so a closed app never leaves shells running.
    const teardown = () => {
      this.conns.delete(conn);
      for (const t of conn.terminals.values()) t.kill();
      conn.terminals.clear();
    };
    ws.on("message", (data) => this.onMessage(conn, data.toString()));
    ws.on("close", teardown);
    ws.on("error", teardown);
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
      return this.emit(conn, { type: "error", code: "internal", message: "malformed frame" });
    }

    if (!conn.authed) {
      const device = frame.type === "auth" ? this.auth.authenticate(frame.token) : null;
      if (device) {
        conn.authed = true;
        conn.device = device;
        return this.emit(conn, { type: "ready" });
      }
      conn.ws.close(4401, "unauthorized");
      return;
    }

    switch (frame.type) {
      case "auth":
        return; // already authed
      case "subscribe":
        return; // subscription is implicit; hook for repo-scoped filtering later
      case "replay":
        return this.replay(conn, frame.fromEventId);
      case "interrupt":
        await (this.sessionProvider.get(frame.sessionId) ?? this.agents.get()).interrupt(frame.sessionId).catch(() => {});
        return;
      case "permission_response":
        // The response carries only a requestId (no provider), so offer it to every provider; only the
        // one holding that pending request acts (the rest no-op).
        for (const p of this.agents.all()) p.resolvePermission(frame.requestId, frame.allow, frame.scope);
        return;
      case "prompt":
        return this.onPrompt(conn, frame);
      case "terminal.open":
        return this.onTerminalOpen(conn, frame);
      case "terminal.input":
        conn.terminals.get(frame.termId)?.write(frame.data);
        return;
      case "terminal.resize":
        conn.terminals.get(frame.termId)?.resize(frame.cols, frame.rows);
        return;
      case "terminal.close":
        conn.terminals.get(frame.termId)?.kill(); // exit handler removes it from the map
        return;
    }
  }

  /**
   * Shells this connection's DEVICE holds across all its sockets. A device that reconnects (backgrounded
   * app, flaky wifi) can hold several `Conn`s at once, so counting per-connection under-counts it.
   *
   * Since ADR-037 every authenticated connection carries a real device id, so the budget is genuinely
   * per-device. Pre-0.1.8 tokens used to collapse into one shared `legacy` id and split a single budget
   * between unrelated phones; those tokens are no longer accepted, so that under-allocation is gone. The
   * `!id` fallback is belt-and-braces — an authenticated connection always carries an identity.
   */
  private terminalCountForDevice(conn: Conn): number {
    const id = conn.device?.id;
    if (!id) return conn.terminals.size;
    let n = 0;
    for (const c of this.conns) if (c.device?.id === id) n += c.terminals.size;
    return n;
  }

  /** Device ids with at least one live authenticated socket — powers `connected` on GET /v1/devices. */
  connectedDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.conns) if (c.authed && c.device) ids.add(c.device.id);
    return ids;
  }

  /**
   * Force every socket belonging to a device shut (4401), killing its shells. Called on revoke: a WS
   * authenticates ONCE at connect, so without this a revoked device keeps streaming until it happens
   * to disconnect. Returns how many connections were closed.
   */
  disconnectDevice(id: string): number {
    let closed = 0;
    for (const c of [...this.conns]) {
      if (c.device?.id !== id) continue;
      for (const t of c.terminals.values()) t.kill();
      c.terminals.clear();
      c.authed = false;
      c.ws.close(4401, "device revoked");
      closed++;
    }
    return closed;
  }

  /**
   * Open a PTY shell for this connection. Gated by `config.terminal.enabled` (a shell is arbitrary code
   * execution as the run-user — see docs/SECURITY.md). cwd is the requested repo's dir, else the run
   * user's home. Streams output as `terminal.data`; `terminal.exit` ends it. Audited.
   */
  private onTerminalOpen(conn: Conn, frame: Extract<ClientFrame, { type: "terminal.open" }>): void {
    const { termId } = frame;
    if (!this.terminalCfg.enabled) {
      this.emit(conn, { type: "error", code: "forbidden", message: "terminal is disabled on this bridge" });
      this.emit(conn, { type: "terminal.exit", termId, code: null });
      return;
    }
    if (conn.terminals.has(termId)) return; // already open under this id — ignore a duplicate open
    if (this.terminalCountForDevice(conn) >= MAX_TERMINALS_PER_DEVICE) {
      this.emit(conn, { type: "error", code: "forbidden", message: "too many open terminals" });
      this.emit(conn, { type: "terminal.exit", termId, code: null });
      return;
    }
    const cwd = (frame.repo && this.registry.byId(frame.repo)?.path) || homedir();
    const shell = this.terminalCfg.shell || process.env["SHELL"] || "/bin/bash";
    void this.audit.record({
      actor: "app", device: conn.device?.id, repo: frame.repo ?? "-", action: "terminal.open",
      target: shell, ok: true,
    });

    const term = spawnTerminal({
      cwd, shell,
      cols: frame.cols ?? 80,
      rows: frame.rows ?? 24,
      onData: (data) => this.emit(conn, { type: "terminal.data", termId, data }),
      onExit: (code) => {
        conn.terminals.delete(termId);
        this.emit(conn, { type: "terminal.exit", termId, code });
      },
    });
    conn.terminals.set(termId, term);
  }

  private async onPrompt(conn: Conn, frame: Extract<ClientFrame, { type: "prompt" }>): Promise<void> {
    const repo = this.registry.byId(frame.repo);
    if (!repo) return this.emit(conn, { type: "error", code: "not_found", message: `repo not found: ${frame.repo}` });

    try {
      const provider = this.agents.get(frame.agent); // runtime-selected agent (default when unset)
      const sessionId = await provider.start({
        repo,
        profile: frame.profile,
        prompt: frame.text,
        resume: frame.sessionId,
        // start() returns "pending" for a NEW session; the real SDK id only arrives via session.init.
        // Register the provider under the REAL id there, so interrupt routing for a non-default agent
        // (Codex etc.) resolves correctly instead of falling back to the default provider.
        onEvent: (e) => {
          if (e.type === "session.init" && e.sessionId) this.sessionProvider.set(e.sessionId, provider);
          this.emit(conn, e);
        },
      });
      if (sessionId && sessionId !== "pending") this.sessionProvider.set(sessionId, provider);
    } catch (err) {
      this.emit(conn, { type: "error", code: "internal", message: (err as Error).message });
    }
  }

  private replay(conn: Conn, fromEventId: number): void {
    for (const f of conn.ring) {
      if (f.eventId > fromEventId && conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify(f));
      }
    }
  }

  private emit(conn: Conn, event: ServerEvent): void {
    const frame: ServerFrame = { ...event, eventId: conn.nextId++ };
    // High-volume PTY output is deliberately NOT ringed: a busy shell would otherwise evict chat events
    // from the replay window, and the shell is killed on disconnect so replaying its bytes is pointless.
    if (event.type !== "terminal.data") {
      conn.ring.push(frame);
      if (conn.ring.length > RING_SIZE) conn.ring.shift();
    }
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  /** Push a repo-change event to all authed connections (called by the fs watcher — Phase 4). */
  broadcastRepoChanged(repo: string, paths: string[]): void {
    for (const conn of this.conns) {
      if (conn.authed) this.emit(conn, { type: "repo.changed", repo, paths });
    }
  }
}
