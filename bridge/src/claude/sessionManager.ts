import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, RepoConfig } from "../config.js";

/**
 * Drives / attaches to Claude sessions for a repo, using the Claude Agent SDK.
 *
 * ⚠️ VERIFY BEFORE RELYING: pin `@anthropic-ai/claude-agent-sdk` and confirm the exact option
 * names (permissionMode string, resume/continue keys) and the streamed MESSAGE SHAPES this maps
 * against the current docs — the mapping in start() is best-effort for the documented shapes.
 *
 * Default profile is FULL read/write with direct writes and NO approval prompts (the chosen
 * behavior). That means the session can run Bash/Write/Edit freely — treat a valid token as
 * "arbitrary code execution on this machine" and keep the bridge behind Tailscale + auth.
 * See docs/SECURITY.md. Set claude.profile: read-only in config.yaml to lock a repo down.
 */

export interface SessionInfo {
  id: string;
  updatedAt: string;
  title?: string;
  messages?: number;
}

// Claude Code stores sessions as ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
// The cwd is encoded by replacing path separators; confirm the exact scheme for your SDK version.
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, "-").replace(/^-/, "");
}

export type ClaudeEvent =
  | { type: "session.started"; sessionId: string; repoId: string; resumed: boolean }
  | { type: "assistant.delta"; sessionId: string; text: string }
  | { type: "tool_use"; sessionId: string; name: string; input: unknown }
  | { type: "tool_result"; sessionId: string; name: string; ok: boolean }
  | { type: "assistant.done"; sessionId: string }
  | { type: "result"; sessionId: string; costUsd?: number; turns?: number }
  | { type: "error"; sessionId?: string; code: string; message: string };

// Minimal shape of the Agent SDK's query() we depend on (kept local so this module type-checks
// without the SDK installed; the real import is dynamic below).
type QueryHandle = AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => QueryHandle;

async function loadQuery(): Promise<QueryFn> {
  // @ts-ignore optional dependency resolved at runtime (see package.json)
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  const q = (mod as { query?: QueryFn }).query;
  if (!q) throw new Error("claude-agent-sdk: query() not found — check the installed SDK version");
  return q;
}

export class SessionManager {
  private active = new Map<string, QueryHandle>();

  constructor(private cfg: Config) {}

  /** Discover existing Claude sessions for this repo's directory so the app can attach/resume. */
  async listForRepo(repo: RepoConfig): Promise<SessionInfo[]> {
    const dir = join(homedir(), ".claude", "projects", encodeCwd(repo.path));
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      const infos = await Promise.all(
        files.map(async (f) => {
          const s = await stat(join(dir, f));
          return { id: f.replace(/\.jsonl$/, ""), updatedAt: s.mtime.toISOString() };
        }),
      );
      return infos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return []; // no sessions yet for this cwd
    }
  }

  private options(repo: RepoConfig, sessionId?: string): Record<string, unknown> {
    const readOnly = this.cfg.claude.profile === "read-only";
    const opts: Record<string, unknown> = {
      cwd: repo.path,
      includePartialMessages: true,
      // read-write (chosen default): approve every tool, no prompts.
      // read-only: deny-by-default + a small allow-list (see docs/SECURITY.md; a PreToolUse
      // hook belongs here too for a hard backstop).
      permissionMode: readOnly ? "default" : "bypassPermissions",
      maxTurns: this.cfg.limits.session.maxTurns,
      maxBudgetUsd: this.cfg.limits.session.maxBudgetUsd,
    };
    if (readOnly) opts.allowedTools = ["Read", "Glob", "Grep"];
    if (this.cfg.claude.model) opts.model = this.cfg.claude.model;
    if (sessionId) opts.resume = sessionId; // attach to / resume an existing session
    return opts;
  }

  /**
   * Start (or resume) a chat and stream events via onEvent. Resolves when the turn completes.
   * Pass sessionId to attach to an existing session (the newest for a cwd, from listForRepo()).
   */
  async start(
    repo: RepoConfig,
    prompt: string,
    sessionId: string | undefined,
    onEvent: (ev: ClaudeEvent) => void,
  ): Promise<void> {
    const query = await loadQuery();
    const q = query({ prompt, options: this.options(repo, sessionId) });
    let sid = sessionId ?? "";
    try {
      for await (const raw of q) {
        const m = raw as Record<string, any>;
        switch (m.type) {
          case "system":
            if (m.subtype === "init" && m.session_id) {
              sid = m.session_id as string;
              this.active.set(sid, q);
              onEvent({ type: "session.started", sessionId: sid, repoId: repo.id, resumed: Boolean(sessionId) });
            }
            break;
          case "stream_event": {
            const e = m.event as Record<string, any> | undefined;
            if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
              onEvent({ type: "assistant.delta", sessionId: sid, text: e.delta.text as string });
            } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
              onEvent({
                type: "tool_use",
                sessionId: sid,
                name: e.content_block.name as string,
                input: e.content_block.input,
              });
            }
            break;
          }
          case "result":
            onEvent({
              type: "result",
              sessionId: (m.session_id as string) ?? sid,
              costUsd: m.total_cost_usd as number | undefined,
              turns: m.num_turns as number | undefined,
            });
            break;
        }
      }
      onEvent({ type: "assistant.done", sessionId: sid });
    } catch (err) {
      onEvent({ type: "error", sessionId: sid, code: "session_error", message: (err as Error).message });
    } finally {
      if (sid) this.active.delete(sid);
    }
  }

  /** Interrupt a running session (best-effort; uses the SDK query's interrupt() if present). */
  async interrupt(sessionId: string): Promise<void> {
    const q = this.active.get(sessionId);
    if (q?.interrupt) {
      try {
        await q.interrupt();
      } catch {
        /* ignore */
      }
    }
  }
}
