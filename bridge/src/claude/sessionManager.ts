import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, RepoConfig } from "../config.js";

/**
 * Drives / attaches to Claude sessions for a repo, using the Claude Agent SDK.
 *
 * ⚠️ VERIFY BEFORE RELYING: pin `@anthropic-ai/claude-agent-sdk` and confirm the exact option
 * names (permissionMode string, hooks shape, resume/continue keys) against the current docs.
 * The read-only safety profile below is the whole point — see docs/SECURITY.md.
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

export class SessionManager {
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

  /**
   * Start or resume a chat and stream events. Implemented in Phase 2.
   *
   * Intended shape (TypeScript Agent SDK):
   *
   *   import { query } from "@anthropic-ai/claude-agent-sdk";
   *   for await (const msg of query({
   *     prompt,
   *     options: {
   *       cwd: repo.path,
   *       includePartialMessages: true,
   *       resume: sessionId,                  // attach to an existing session, or omit for new
   *       // --- read-only profile (see docs/SECURITY.md) ---
   *       permissionMode: <deny-by-default>,  // unlisted tools DENIED, never auto-approved
   *       allowedTools: ["Read", "Glob", "Grep"],
   *       disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit"],
   *       hooks: { PreToolUse: denyAnyWrite },
   *       maxTurns: this.cfg.limits.session.maxTurns,
   *       maxBudgetUsd: this.cfg.limits.session.maxBudgetUsd,
   *       model: this.cfg.claude.model,
   *     },
   *   })) {
   *     // translate SDK messages -> ClaudeEvent and yield/emit them
   *   }
   */
  async *run(
    _repo: RepoConfig,
    _prompt: string,
    _sessionId?: string,
  ): AsyncGenerator<ClaudeEvent> {
    throw new Error("SessionManager.run not implemented yet (Phase 2)");
  }

  /** Interrupt a running session. Phase 2 (SDK query.interrupt() / process signal). */
  async interrupt(_sessionId: string): Promise<void> {
    throw new Error("interrupt not implemented yet (Phase 2)");
  }
}
