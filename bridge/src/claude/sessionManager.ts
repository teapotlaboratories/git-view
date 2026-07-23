import type { RepoConfig } from "../config.js";
import type { ServerEvent, SessionInfo, TranscriptMessage } from "../wire.js";
import type { FileService } from "../git/fileService.js";
import type { GitWrite } from "../git/gitWrite.js";
import { isInteractive, optionsForProfile, permissionDecision } from "./permissions.js";
import { createGitViewMcpServer } from "./mcpServer.js";
import { buildSandboxConfig } from "./sandbox.js";
import type { RawConfig } from "../config.js";
import type { ClaudeSettingsStore } from "./settingsStore.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { badRequest } from "../util/errors.js";
import type { AgentProvider } from "../agent/types.js";
import type { AgentCapabilities } from "../wire.js";
import type { AttachmentStore } from "../agent/attachments.js";

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

export class SessionManager implements AgentProvider {
  // AgentProvider identity — Claude is the first provider; Codex etc. implement the same interface.
  readonly id = "claude";
  readonly label = "Claude";
  readonly capabilities: AgentCapabilities = { modelPin: true, inAppLogin: true, permissionTiers: true };

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
    private readonly attachments: AttachmentStore,
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
   * Delete a session's transcript. The SDK offers no delete, so we remove the underlying
   * `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<id>.jsonl` — Claude Code encodes the cwd by replacing
   * every non-alphanumeric with `-`. Confined to the projects dir; falls back to scanning project dirs
   * if the encoding ever drifts (session ids are unique). Idempotent (a missing file is a no-op success).
   */
  async deleteForRepo(repo: RepoConfig, sessionId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes("..")) throw badRequest("invalid session id");
    await this.interrupt(sessionId).catch(() => {}); // best-effort: stop it if it's mid-stream
    const projectsDir = join(process.env["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude"), "projects");
    const inProjects = (p: string) => resolve(p).startsWith(resolve(projectsDir) + "/");
    const file = `${sessionId}.jsonl`;
    const primary = join(projectsDir, repo.path.replace(/[^a-zA-Z0-9]/g, "-"), file);
    if (inProjects(primary) && (await this.tryUnlink(primary))) return;
    for (const d of await readdir(projectsDir).catch(() => [] as string[])) {
      const candidate = join(projectsDir, d, file);
      if (inProjects(candidate) && (await this.tryUnlink(candidate))) return;
    }
  }

  private async tryUnlink(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch {
      return false;
    }
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
      // DO NOT add a programmatic `hooks` option here. In claude-agent-sdk v0.2.x, passing `hooks`
      // silently drops IN-PROCESS (SDK) MCP servers from the query — our `gitview` audited-write +
      // attach_file surface would vanish (only config-based servers like Google Drive survive), so
      // the app would lose attach_file and confined-agent's audited writes. The rm-rf / fork-bomb
      // backstop lives in HARD_DENY_RULES (disallowedTools), which IS enforced in every mode incl.
      // bypass — a strict superset of the old PreToolUse hook. (Bisected 2026-07-23; see permissions.ts.)
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

    // Mount the gitview MCP surface for every file-producing profile: confined-agent uses it as its audited
    // write path, and ALL of them get `attach_file` so the agent can hand a file to the chat. `onAttach`
    // closes over the (mutable) sessionId so it targets the live session.
    if (profile !== "read-only") {
      const server = await createGitViewMcpServer({
        repo, files: this.files, gitWrite: this.gitWrite, attachments: this.attachments,
        onAttach: (meta) => onEvent({ type: "attachment", sessionId, ...meta }),
      });
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
    }, onEvent, repo);

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
    repo: RepoConfig,
  ): Promise<void> {
    let sessionId = initialId;
    // Correlate tool results to their calls by SDK tool_use_id, and recover the tool NAME for the
    // result (SDK tool_result blocks carry only tool_use_id, not a name).
    const toolNames = new Map<string, string>();
    // Written-file path per write tool_use id → auto-attach the file once the write SUCCEEDS.
    const toolPaths = new Map<string, string>();
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
              const wpath = writePathOf(name, block["input"]);
              if (id && wpath) toolPaths.set(id, wpath);
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
              if (ok) {
                // Auto-attach: a successful write hands its file to the chat…
                const wpath = toolPaths.get(id);
                if (wpath) {
                  const m = this.attachments.addFile(repo, wpath, "written");
                  if (m) emit({ type: "attachment", sessionId, ...m });
                }
                // …and any image embedded in the tool result renders inline.
                for (const img of imagesOf(block["content"])) {
                  const m = this.attachments.addBytes(img.bytes, img.name, img.mime, "image");
                  emit({ type: "attachment", sessionId, ...m });
                }
              }
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

/** The file path a write tool targets (built-in Write/Edit → file_path; gitview MCP save/create → path). */
function writePathOf(name: string, input: unknown): string | undefined {
  if (!/(^|__)(Write|Edit|MultiEdit|NotebookEdit|saveFile|createFile)$/.test(name)) return undefined;
  const rec = (input ?? {}) as Record<string, unknown>;
  const p = rec["file_path"] ?? rec["path"];
  return typeof p === "string" && p ? p : undefined;
}

/** Base64 images embedded in a tool_result `content` array → decoded bytes + a synthesized name. */
function imagesOf(content: unknown): Array<{ bytes: Buffer; mime: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ bytes: Buffer; mime: string; name: string }> = [];
  let n = 0;
  for (const b of content) {
    const rec = (b ?? {}) as Record<string, unknown>;
    if (rec["type"] !== "image") continue;
    const src = (rec["source"] ?? {}) as Record<string, unknown>;
    const data = src["data"];
    if (src["type"] !== "base64" || typeof data !== "string") continue;
    const mime = typeof src["media_type"] === "string" ? (src["media_type"] as string) : "image/png";
    const ext = (mime.split("/")[1] ?? "png").split("+")[0];
    out.push({ bytes: Buffer.from(data, "base64"), mime, name: `image-${++n}.${ext}` });
  }
  return out;
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
