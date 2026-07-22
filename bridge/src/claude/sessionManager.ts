import type { RepoConfig } from "../config.js";
import type { ServerEvent, SessionInfo, TranscriptMessage } from "../wire.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import { isInteractive, optionsForProfile, permissionDecision, preToolUseDenyHook } from "./permissions.js";
import { createGitViewMcpServer } from "./mcpServer.js";
import { buildSandboxConfig } from "./sandbox.js";
import type { RawConfig } from "../config.js";
import type { ClaudeSettingsStore } from "./settingsStore.js";

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
  getSessionMessages?: (
    sessionId: string,
    options?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
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
  // Pending interactive permission prompts, keyed by requestId → resolver + owning session.
  private pendingPerms = new Map<string, { sessionId: string; resolve: (allow: boolean) => void }>();
  // Sessions where the user chose "Allow for session" — behave as Auto-edit for the rest of the session.
  private sessionAutoAllow = new Set<string>();
  private permSeq = 0;

  constructor(
    private readonly claudeCfg: RawConfig["claude"],
    private readonly files: FileService,
    private readonly gitWrite: GitWrite,
    private readonly settings: ClaudeSettingsStore,
  ) {}

  private async sdk(): Promise<Sdk> {
    // @ts-ignore optional dependency resolved at runtime
    return (await import("@anthropic-ai/claude-agent-sdk")) as Sdk;
  }

  /** Enumerate resumable sessions via the SDK (NOT by reading jsonl files). */
  async listForRepo(repo: RepoConfig): Promise<SessionInfo[]> {
    const sdk = await this.sdk().catch(() => null);
    if (!sdk?.listSessions) return [];
    // `dir` (NOT cwd) scopes to this project's sessions; with cwd the option is ignored and it returns
    // sessions across ALL projects (same dir-not-cwd gotcha as getSessionMessages).
    const raw = await sdk.listSessions({ dir: repo.path }).catch(() => []);
    return raw
      .map((s) => {
        // The installed SDK's SDKSessionInfo uses sessionId / lastModified(ms) / summary; older field names
        // are kept as fallbacks so a version bump degrades gracefully rather than emitting empty rows.
        const id = String(s["sessionId"] ?? s["id"] ?? s["session_id"] ?? "");
        const modified = s["lastModified"] ?? s["updatedAt"] ?? s["updated_at"];
        const title = s["customTitle"] ?? s["summary"] ?? s["firstPrompt"] ?? s["title"];
        return {
          id,
          updatedAt:
            typeof modified === "number" ? new Date(modified).toISOString() : String(modified ?? ""),
          title: title ? String(title) : undefined,
          turns:
            typeof s["messageCount"] === "number"
              ? (s["messageCount"] as number)
              : typeof s["num_turns"] === "number"
                ? (s["num_turns"] as number)
                : undefined,
        };
      })
      .filter((s) => s.id); // drop any row we still couldn't identify (unusable — can't resume)
  }

  /**
   * Full chronological transcript for a resumed session, mapped to TranscriptMessage[]. Uses the SDK's
   * getSessionMessages (dir-scoped — passing `dir`, NOT `cwd`, or it would search ALL projects). Degrades
   * to an empty transcript when the installed SDK lacks the method (mirrors listForRepo).
   */
  async messagesForRepo(
    repo: RepoConfig,
    id: string,
  ): Promise<{ sessionId: string; messages: TranscriptMessage[] }> {
    const sdk = await this.sdk().catch(() => null);
    if (!sdk?.getSessionMessages) return { sessionId: id, messages: [] };
    const raw = await sdk.getSessionMessages(id, { dir: repo.path }).catch(() => []);
    return { sessionId: id, messages: mapSessionMessages(raw) };
  }

  /** Start (or resume) a local-SDK session and stream normalized events to `onEvent`. */
  async start(args: StartLocalArgs): Promise<string> {
    const { repo, profile, prompt, resume, onEvent } = args;
    const sdk = await this.sdk();
    if (!sdk.query) throw new Error("claude-agent-sdk: query() not found — check the installed SDK version");

    const perm = optionsForProfile(profile);
    let sessionId = resume ?? "pending"; // declared before options so canUseTool can close over it
    const options: Record<string, unknown> = {
      cwd: repo.path, // sessions must resume from the repo cwd (verified)
      includePartialMessages: true, // enable content_block_delta / content_block_start streaming
      ...perm,
      hooks: { PreToolUse: [preToolUseDenyHook()] }, // backstop deny (applies even in bypass)
    };
    // Pin the effective model + inject the in-app credential env (if any) on every query. When no
    // credential override is stored, credentialEnv() is null → we DON'T set options.env, so the child
    // inherits process.env and the host ~/.claude credentials apply.
    options["model"] = this.settings.model;
    const credEnv = this.settings.credentialEnv();
    if (credEnv) options["env"] = credEnv;
    if (resume) options["resume"] = resume;
    if (this.claudeCfg.maxBudgetUsd) options["maxBudgetUsd"] = this.claudeCfg.maxBudgetUsd;

    // Interactive tiers (Ask first / Auto-edit / Auto-run) pause tools for the user's OK (redesign step 3):
    // canUseTool emits a permission_request and awaits the app's permission_response (see resolvePermission).
    // "Allow for session" flips the session to Auto-edit behavior via sessionAutoAllow.
    if (isInteractive(profile)) {
      options["canUseTool"] = async (toolName: string, toolInput: Record<string, unknown>) => {
        const effective = this.sessionAutoAllow.has(sessionId) ? "acceptEdits" : profile;
        const decision = permissionDecision(effective, toolName, toolInput);
        if (decision === "allow") return { behavior: "allow" as const, updatedInput: toolInput };
        if (decision === "deny") return { behavior: "deny" as const, message: "denied by permission tier" };
        const requestId = `perm_${++this.permSeq}`;
        onEvent({ type: "permission_request", sessionId, requestId, tool: toolName, input: toolInput });
        const allowed = await new Promise<boolean>((resolve) => {
          this.pendingPerms.set(requestId, { sessionId, resolve });
        });
        return allowed
          ? { behavior: "allow" as const, updatedInput: toolInput }
          : { behavior: "deny" as const, message: "denied by user" };
      };
    }

    // Confined-agent additionally mounts the audited MCP write surface (an extra, audited path).
    if (profile === "confined-agent") {
      const server = await createGitViewMcpServer({ repo, files: this.files, gitWrite: this.gitWrite });
      if (server) options["mcpServers"] = { gitview: server };
    }

    // Document sandbox intent for the local agent (whole-process confinement is applied by launching
    // the bridge under `srt`; see docs/SECURITY.md). Config is validated here so misconfig fails fast.
    if (this.claudeCfg.sandbox.enabled) buildSandboxConfig(this.claudeCfg.sandbox);

    const handle = sdk.query({ prompt, options });
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

  /** Answer an interactive permission_request (routed from the app's permission_response frame). */
  resolvePermission(requestId: string, allow: boolean, scope: "once" | "session"): void {
    const pending = this.pendingPerms.get(requestId);
    if (!pending) return;
    this.pendingPerms.delete(requestId);
    if (allow && scope === "session") this.sessionAutoAllow.add(pending.sessionId);
    pending.resolve(allow);
  }

  /** Normalize the SDK message stream to GitView ServerEvents. Best-effort mapping of documented shapes. */
  private async pump(
    handle: QueryHandle,
    initialId: string,
    setId: (id: string) => void,
    emit: (e: ServerEvent) => void,
  ): Promise<void> {
    let sessionId = initialId;
    // Correlate tool results to their calls by SDK tool_use_id, and recover the tool NAME for the
    // result (SDK tool_result blocks carry only tool_use_id, not a name).
    const toolNames = new Map<string, string>();
    try {
      for await (const msg of handle) {
        const type = String(msg["type"] ?? "");

        if (type === "system") {
          // Capture/track the session id from any system message, but emit session.init ONCE —
          // only the real `init` carries the model; later system messages would re-fire it with
          // model=undefined and reset the client's session state.
          if (msg["session_id"]) { sessionId = String(msg["session_id"]); setId(sessionId); }
          if (msg["subtype"] === "init") {
            emit({ type: "session.init", sessionId, provider: "local-sdk",
              resumed: Boolean(msg["resumed"] ?? initialId !== "pending"),
              model: msg["model"] ? String(msg["model"]) : undefined,
              maxBudgetUsd: this.claudeCfg.maxBudgetUsd });
          }
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
            // Only the assistant's TEXT stream is chat-message content. A tool_use block streams its
            // input as `input_json_delta`/`partial_json`, which must NOT leak into the message text
            // (the full tool input is surfaced separately via the `tool_use` event).
            const text = delta["text"];
            if (typeof text === "string" && text) emit({ type: "assistant.delta", sessionId, text });
          }
          continue;
        }

        if (type === "assistant") {
          for (const block of blocksOf(msg)) {
            if (block["type"] === "tool_use") {
              const id = String(block["id"] ?? "");
              const name = String(block["name"] ?? "");
              if (id) toolNames.set(id, name);
              emit({ type: "tool_use", sessionId, id, name, input: block["input"] });
            }
          }
          emit({ type: "assistant.done", sessionId });
          continue;
        }

        if (type === "user") {
          for (const block of blocksOf(msg)) {
            if (block["type"] === "tool_result") {
              const id = String(block["tool_use_id"] ?? "");
              const ok = !block["is_error"];
              const text = toolResultText(block["content"]);
              emit({ type: "tool_result", sessionId, id,
                name: toolNames.get(id) ?? String(block["name"] ?? "tool"), ok,
                summary: summarizeToolResult(text, ok),
                content: capToolPreview(text) });
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

/**
 * Map an SDK SessionMessage[] (chronological) to TranscriptMessage[]. Pure — unit-testable in isolation.
 *
 * This is the HISTORY path, deliberately distinct from the live pump(): the live stream ignores assistant
 * text blocks (text arrives only via stream deltas), but a persisted transcript carries the text inline, so
 * here we read text blocks directly. A `user` message can be either a real prompt OR a tool_result carrier
 * (never both, in practice) — we branch on block type. Tool names are recovered by forward-scanning
 * tool_use ids, since tool_result blocks carry only tool_use_id. Caps match the live path exactly.
 */
export function mapSessionMessages(raw: Array<Record<string, unknown>>): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const msg of raw) {
    const type = String(msg["type"] ?? "");

    if (type === "assistant") {
      // Collapse contiguous text blocks in THIS message into one assistant item; a tool_use flushes it.
      let textBuf = "";
      const flush = () => {
        if (textBuf) out.push({ role: "assistant", text: textBuf });
        textBuf = "";
      };
      for (const block of blocksOf(msg)) {
        const bt = block["type"];
        if (bt === "text") {
          if (typeof block["text"] === "string") textBuf += block["text"] as string;
        } else if (bt === "tool_use") {
          flush();
          const id = String(block["id"] ?? "");
          const name = String(block["name"] ?? "");
          if (id) toolNames.set(id, name);
          out.push({ role: "tool_use", id, name, input: (block["input"] ?? {}) as object });
        }
        // 'thinking' (and any other block type) is skipped
      }
      flush();
      continue;
    }

    if (type === "user") {
      const message = (msg["message"] ?? msg) as Record<string, unknown>;
      const content = message["content"];
      if (typeof content === "string") {
        if (content) out.push({ role: "user", text: content });
        continue;
      }
      const blocks = blocksOf(msg);
      const toolResults = blocks.filter((b) => b["type"] === "tool_result");
      if (toolResults.length > 0) {
        // A tool_result carrier — NOT a user bubble. Emit one tool_result per block.
        for (const block of toolResults) {
          const id = String(block["tool_use_id"] ?? "");
          const ok = !block["is_error"];
          const text = toolResultText(block["content"]);
          out.push({
            role: "tool_result",
            id,
            name: toolNames.get(id) ?? "",
            ok,
            summary: summarizeToolResult(text, ok),
            content: capToolPreview(text),
          });
        }
        continue;
      }
      // A real user prompt carried as text blocks — concatenate them.
      const text = blocks
        .filter((b) => b["type"] === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("");
      if (text) out.push({ role: "user", text });
      continue;
    }
    // 'system' (and anything else) is skipped
  }
  return out;
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

/** Extract text from an SDK tool_result `content` (a string, or an array of `{type:"text",text}`). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const rec = (b ?? {}) as Record<string, unknown>;
        return typeof rec["text"] === "string" ? (rec["text"] as string) : "";
      })
      .join("");
  }
  return "";
}

/** A one-line badge descriptor for a tool result (e.g. `"142 lines"`), or undefined when empty. */
function summarizeToolResult(text: string, ok: boolean): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!ok) {
    const first = trimmed.split("\n", 1)[0] ?? "";
    return first.length > 80 ? first.slice(0, 77) + "…" : first;
  }
  const lines = trimmed.split("\n").length;
  return lines > 1 ? `${lines} lines` : `${trimmed.length} chars`;
}

const PREVIEW_MAX_LINES = 120;
const PREVIEW_MAX_CHARS = 8192;

/** Cap a tool result to a small preview for the wire — the WS never carries whole files. */
function capToolPreview(text: string): string | undefined {
  if (!text) return undefined;
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > PREVIEW_MAX_LINES) { out = lines.slice(0, PREVIEW_MAX_LINES).join("\n"); truncated = true; }
  if (out.length > PREVIEW_MAX_CHARS) { out = out.slice(0, PREVIEW_MAX_CHARS); truncated = true; }
  return truncated ? out + "\n… (truncated)" : out;
}
