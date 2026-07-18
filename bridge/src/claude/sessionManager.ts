import type { RepoConfig } from "../config.js";
import type { ServerEvent, SessionInfo } from "../wire.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import { optionsForProfile, preToolUseDenyHook } from "./permissions.js";
import { createGitViewMcpServer } from "./mcpServer.js";
import { buildSandboxConfig } from "./sandbox.js";
import type { RawConfig } from "../config.js";

/**
 * FALLBACK session provider: the local Claude Agent SDK (API-key / fully-local-transcript case).
 *
 * Design rules (verified mid-2026 — see docs/DECISIONS.md ADR-011):
 *  - Session discovery/resume uses the SDK's OWN interfaces: `listSessions()`, `resume` (by id),
 *    `continue` (most recent). We NEVER glob/parse ~/.claude/projects/*.jsonl (internal/unstable,
 *    location is CLAUDE_CONFIG_DIR-configurable).
 *  - SDK sessions must be resumed from the repo's cwd → we always pass `cwd: repo.path`.
 *  - Partial per-token streaming requires `includePartialMessages: true`.
 *  - `maxBudgetUsd` is a SOFT cap; exhaustion surfaces as result subtype `error_max_budget_usd`.
 *
 * SDK types are intentionally kept local + loose so this module compiles without the optional SDK.
 */

type QueryHandle = AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
type QueryFn = (args: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => QueryHandle;

interface Sdk {
  query?: QueryFn;
  listSessions?: (options?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
}

export interface StartLocalArgs {
  repo: RepoConfig;
  profile: RepoConfig["profile"];
  prompt: string;
  resume?: string;
  onEvent: (e: ServerEvent) => void;
}

export class SessionManager {
  private active = new Map<string, QueryHandle>();

  constructor(
    private readonly claudeCfg: RawConfig["claude"],
    private readonly files: FileService,
    private readonly gitWrite: GitWrite,
  ) {}

  private async sdk(): Promise<Sdk> {
    // @ts-ignore optional dependency resolved at runtime
    return (await import("@anthropic-ai/claude-agent-sdk")) as Sdk;
  }

  /** Enumerate resumable sessions via the SDK (NOT by reading jsonl files). */
  async listForRepo(repo: RepoConfig): Promise<SessionInfo[]> {
    const sdk = await this.sdk().catch(() => null);
    if (!sdk?.listSessions) return [];
    const raw = await sdk.listSessions({ cwd: repo.path }).catch(() => []);
    return raw.map((s) => ({
      id: String(s["id"] ?? s["session_id"] ?? ""),
      updatedAt: String(s["updatedAt"] ?? s["updated_at"] ?? ""),
      title: s["title"] ? String(s["title"]) : undefined,
      turns: typeof s["num_turns"] === "number" ? (s["num_turns"] as number) : undefined,
    }));
  }

  /** Start (or resume) a local-SDK session and stream normalized events to `onEvent`. */
  async start(args: StartLocalArgs): Promise<string> {
    const { repo, profile, prompt, resume, onEvent } = args;
    const sdk = await this.sdk();
    if (!sdk.query) throw new Error("claude-agent-sdk: query() not found — check the installed SDK version");

    const perm = optionsForProfile(profile);
    const options: Record<string, unknown> = {
      cwd: repo.path, // sessions must resume from the repo cwd (verified)
      includePartialMessages: true, // enable content_block_delta / content_block_start streaming
      ...perm,
      hooks: { PreToolUse: [preToolUseDenyHook()] }, // backstop deny (applies even in bypass)
    };
    if (resume) options["resume"] = resume;
    if (this.claudeCfg.maxBudgetUsd) options["maxBudgetUsd"] = this.claudeCfg.maxBudgetUsd;

    // Confined-agent writes flow through the in-process MCP server.
    if (profile === "confined-agent") {
      const server = await createGitViewMcpServer({ repo, files: this.files, gitWrite: this.gitWrite });
      if (server) options["mcpServers"] = { gitview: server };
    }

    // Document sandbox intent for the local agent (whole-process confinement is applied by launching
    // the bridge under `srt`; see docs/SECURITY.md). Config is validated here so misconfig fails fast.
    if (this.claudeCfg.sandbox.enabled) buildSandboxConfig(this.claudeCfg.sandbox);

    const handle = sdk.query({ prompt, options });
    let sessionId = resume ?? "pending";
    this.active.set(sessionId, handle);

    void this.pump(handle, sessionId, (id) => {
      if (id !== sessionId) {
        this.active.delete(sessionId);
        this.active.set(id, handle);
        sessionId = id;
      }
    }, onEvent);

    return sessionId;
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.active.get(sessionId)?.interrupt?.();
  }

  /** Normalize the SDK message stream to GitView ServerEvents. Best-effort mapping of documented shapes. */
  private async pump(
    handle: QueryHandle,
    initialId: string,
    setId: (id: string) => void,
    emit: (e: ServerEvent) => void,
  ): Promise<void> {
    let sessionId = initialId;
    try {
      for await (const msg of handle) {
        const type = String(msg["type"] ?? "");

        if (type === "system" && (msg["subtype"] === "init" || msg["session_id"])) {
          sessionId = String(msg["session_id"] ?? sessionId);
          setId(sessionId);
          emit({ type: "session.init", sessionId, provider: "local-sdk",
            resumed: Boolean(msg["resumed"] ?? initialId !== "pending"),
            model: msg["model"] ? String(msg["model"]) : undefined });
          continue;
        }

        if (type === "stream_event") {
          const ev = (msg["event"] ?? msg) as Record<string, unknown>;
          const et = String(ev["type"] ?? "");
          if (et === "content_block_start") {
            const block = (ev["content_block"] ?? {}) as Record<string, unknown>;
            emit({ type: "assistant.block_start", sessionId, index: Number(ev["index"] ?? 0),
              blockType: String(block["type"] ?? "text") });
          } else if (et === "content_block_delta") {
            const delta = (ev["delta"] ?? {}) as Record<string, unknown>;
            const text = String(delta["text"] ?? delta["partial_json"] ?? "");
            if (text) emit({ type: "assistant.delta", sessionId, text });
          }
          continue;
        }

        if (type === "assistant") {
          for (const block of blocksOf(msg)) {
            if (block["type"] === "tool_use") {
              emit({ type: "tool_use", sessionId, name: String(block["name"] ?? ""), input: block["input"] });
            }
          }
          emit({ type: "assistant.done", sessionId });
          continue;
        }

        if (type === "user") {
          for (const block of blocksOf(msg)) {
            if (block["type"] === "tool_result") {
              emit({ type: "tool_result", sessionId, name: String(block["name"] ?? "tool"),
                ok: !block["is_error"] });
            }
          }
          continue;
        }

        if (type === "result") {
          emit({ type: "result", sessionId,
            subtype: normalizeResultSubtype(String(msg["subtype"] ?? "success")),
            costUsd: typeof msg["total_cost_usd"] === "number" ? (msg["total_cost_usd"] as number) : undefined,
            turns: typeof msg["num_turns"] === "number" ? (msg["num_turns"] as number) : undefined });
        }
      }
    } catch (err) {
      emit({ type: "error", code: "internal", message: (err as Error).message, sessionId });
    } finally {
      this.active.delete(sessionId);
    }
  }
}

function blocksOf(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = (msg["message"] ?? msg) as Record<string, unknown>;
  const content = message["content"];
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function normalizeResultSubtype(s: string): "success" | "error_max_budget_usd" | "error_max_turns" | "error" {
  if (s === "error_max_budget_usd" || s === "error_max_turns" || s === "success") return s;
  return "error";
}
