import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type { Config, Env } from "../config.js";
import { repoById } from "../config.js";
import { SessionManager } from "../claude/sessionManager.js";

/**
 * The single live channel. One WebSocket per app connection, multiplexed by {repoId, sessionId}.
 *   client -> server: prompt | interrupt | attach | new_session | subscribe_changes | ack
 *   server -> client: session.started | assistant.delta | tool_use | tool_result
 *                     | assistant.done | result | repo_changed | error
 * Every server event carries a monotonic eventId (for reconnect/replay — Phase 7).
 * See docs/API.md for the full message shapes.
 */
export function attachLiveChannel(
  server: Server,
  cfg: Config,
  env: Env,
  sessions: SessionManager,
) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    if (env.bridgeToken && token !== env.bridgeToken) {
      ws.close(4401, "unauthorized");
      return;
    }

    let eventId = 0;
    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...msg, eventId: ++eventId }));
    };

    ws.on("message", async (data) => {
      let msg: { type?: string; repoId?: string; sessionId?: string; text?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send({ type: "error", code: "bad_message", message: "invalid JSON" });
      }

      switch (msg.type) {
        // `attach`/`new_session` just carry context; streaming begins on `prompt`
        // (attach → resume msg.sessionId; new_session → omit it).
        case "attach":
        case "new_session":
          return;

        case "prompt": {
          const repo = msg.repoId ? repoById(cfg, msg.repoId) : undefined;
          if (!repo) return send({ type: "error", code: "not_found", message: "unknown repo" });
          if (!msg.text) return send({ type: "error", code: "bad_message", message: "empty prompt" });
          try {
            await sessions.start(repo, msg.text, msg.sessionId, (ev) => send(ev));
          } catch (err) {
            send({ type: "error", code: "internal", message: (err as Error).message });
          }
          return;
        }

        case "interrupt":
          if (msg.sessionId) await sessions.interrupt(msg.sessionId);
          return;

        case "subscribe_changes":
        case "ack":
          // TODO(phase-4/7): repo-change fanout (fs watcher) and event replay from a ring buffer.
          return;

        default:
          return send({ type: "error", code: "bad_message", message: `unknown type: ${msg.type}` });
      }
    });

    send({ type: "ready" });
  });

  return wss;
}
