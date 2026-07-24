import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RepoRegistry } from "../repoRegistry.js";
import type { AuthManager } from "../auth/pairing.js";
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

interface Conn {
  ws: WebSocket;
  authed: boolean;
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
      const preAuthed = subToken ? this.auth.verify(subToken.slice(SUBPROTOCOL_PREFIX.length)) : false;

      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, preAuthed));
    });
  }

  private onConnection(ws: WebSocket, preAuthed: boolean): void {
    const conn: Conn = { ws, authed: preAuthed, nextId: 1, ring: [], terminals: new Map() };
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
      if (frame.type === "auth" && this.auth.verify(frame.token)) {
        conn.authed = true;
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
    const cwd = (frame.repo && this.registry.byId(frame.repo)?.path) || homedir();
    const shell = this.terminalCfg.shell || process.env["SHELL"] || "/bin/bash";
    void this.audit.record({ actor: "app", repo: frame.repo ?? "-", action: "terminal.open", target: shell, ok: true });

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
    conn.ring.push(frame);
    if (conn.ring.length > RING_SIZE) conn.ring.shift();
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  /** Push a repo-change event to all authed connections (called by the fs watcher — Phase 4). */
  broadcastRepoChanged(repo: string, paths: string[]): void {
    for (const conn of this.conns) {
      if (conn.authed) this.emit(conn, { type: "repo.changed", repo, paths });
    }
  }
}
