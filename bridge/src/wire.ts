/**
 * Wire protocol types (v1) — hand-mirrored from docs/API.md, the single source of truth.
 * The Android app mirrors the SAME shapes in Wire.kt. Change docs/API.md first, then both ends.
 */

export const PROTOCOL_VERSION = 1;

// ---- shared enums -----------------------------------------------------------

export type SessionProvider = "remote-control" | "local-sdk";

export type PermissionProfile =
  | "read-only"
  | "confined-agent"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export type BlobEncoding = "utf-8" | "base64";

export type DiffKind = "worktree" | "staged" | "commit";

// ---- REST: read -------------------------------------------------------------

export interface RepoSummary {
  id: string;
  name: string;
  defaultBranch: string;
  provider: SessionProvider;
  profile: PermissionProfile;
  // false for config repos; true for opened workspaces (which can be un-registered). Defaults false.
  removable: boolean;
  // Live working-tree state (undefined ahead/behind when there is no upstream).
  branch: string;
  ahead?: number;
  behind?: number;
  dirty: number;
}

export type TreeEntryType = "blob" | "tree";

export interface TreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  size?: number;
  oid: string;
}

export interface TreeResponse {
  ref: string;
  path: string;
  entries: TreeEntry[];
}

export interface BlobResponse {
  path: string;
  ref: string;
  oid: string;
  size: number;
  binary: boolean;
  encoding: BlobEncoding;
  content: string;
}

export interface CommitSummary {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string; // ISO-8601
  files: number;
  additions: number;
  deletions: number;
}

export interface RefsResponse {
  head: string;
  branches: string[];
  tags: string[];
}

export interface StatusEntry {
  path: string;
  index: string; // porcelain XY, index side
  worktree: string; // porcelain XY, worktree side
}

// ---- REST: write ------------------------------------------------------------

export interface SaveFileBody {
  encoding: BlobEncoding;
  content: string;
}

export interface CreateFileBody {
  path: string;
  encoding: BlobEncoding;
  content: string;
}

export interface RenameBody {
  from: string;
  to: string;
}

export interface StageBody {
  paths: string[];
}

export interface CommitBody {
  message: string;
  paths?: string[];
}

export interface CheckoutBody {
  ref: string;
  create?: boolean;
}

export interface PushBody {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export interface WriteResult {
  ok: true;
  oid?: string;
}

// ---- REST: sessions ---------------------------------------------------------

export interface SessionInfo {
  id: string;
  updatedAt: string;
  title?: string;
  turns?: number;
}

/**
 * A single message in a resumed session transcript. Role-tagged union (discriminator `role`),
 * in chronological order. Mirrors the live chat events so a resumed transcript renders identically.
 */
export type TranscriptMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_use"; id: string; name: string; input: object }
  | { role: "tool_result"; id: string; name: string; ok: boolean; summary?: string; content?: string };

export interface AgentCapabilities {
  modelPin: boolean;
  inAppLogin: boolean;
  permissionTiers: boolean;
}
export interface AgentInfo {
  id: string;
  label: string;
  capabilities: AgentCapabilities;
}
export interface AgentsResponse {
  agents: AgentInfo[];
}

export interface SessionMessagesResponse {
  sessionId: string;
  messages: TranscriptMessage[];
}

export interface StartSessionBody {
  provider: SessionProvider;
  profile: PermissionProfile;
  resume?: string;
}

export interface StartSessionResponse {
  sessionId: string;
  provider: SessionProvider;
  // Present for the remote-control provider. `qr` is optional — the app may render a QR from `url`.
  connect?: { url: string; qr?: string };
}

// ---- REST: claude settings (model + in-app credential) ----------------------

export type ClaudeAuthMode = "host" | "api-key" | "subscription";

export interface ClaudeSettingsResponse {
  model: string; // effective model the SDK query will use
  configModel: string; // config.yaml default (claude.model) — for a "reset" affordance
  // Effective reasoning effort, and the config.yaml default (claude.effort) as the reset target.
  // null on either = unset, i.e. the SDK/CLI's own default is used and no `effort` is passed.
  effort: string | null;
  configEffort: string | null;
  auth: ClaudeAuthMode; // effective credential mode
  hint: string | null; // masked secret tail e.g. "…a1b2"; null when auth=host
  host: { credentials: boolean; apiKeyEnv: boolean };
}

export interface PutClaudeSettingsBody {
  model?: string;
  // "" (or blank) clears the override; otherwise one of low|medium|high|xhigh|max (else 400).
  effort?: string;
  auth?: { mode: ClaudeAuthMode; secret?: string };
}

// ---- subscription-login relay (drives `claude setup-token` in a PTY) --------
// The bridge PTY-spawns `claude setup-token`, scrapes the OAuth authorize URL, and feeds back the
// pasted code. The code and any captured token NEVER cross this wire nor land in logs/audit.
export interface ClaudeLoginStartResponse {
  loginId: string;
  url: string; // OAuth authorize URL the app opens in a browser
}

export interface ClaudeLoginSubmitBody {
  loginId: string;
  code: string;
}

export interface ClaudeLoginSubmitResponse {
  status: "ok" | "error";
  message?: string; // present on error only; never contains the code or a token
}

// ---- errors -----------------------------------------------------------------

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "path_escape"
  | "read_only"
  | "too_large"
  | "git_error"
  | "bad_request"
  | "internal";

export interface WireError {
  error: { code: ErrorCode; message: string };
}

// ---- WebSocket: client -> server -------------------------------------------

export type ClientFrame =
  | { type: "auth"; token: string }
  | { type: "subscribe"; repo: string; sessionId?: string }
  | {
      type: "prompt";
      repo: string;
      sessionId?: string;
      provider: SessionProvider;
      agent?: string; // chat provider id (claude | codex | …); absent => the bridge's default agent
      profile: PermissionProfile;
      text: string;
    }
  | { type: "interrupt"; sessionId: string }
  | { type: "replay"; fromEventId: number }
  | { type: "permission_response"; requestId: string; allow: boolean; scope: "once" | "session" };

// ---- WebSocket: server -> client (every frame carries a monotonic eventId) --

export type ServerEvent =
  | { type: "ready" }
  | { type: "session.init"; sessionId: string; provider: SessionProvider; resumed: boolean; model?: string; maxBudgetUsd?: number }
  | { type: "assistant.block_start"; sessionId: string; index: number; blockType: string }
  | { type: "assistant.delta"; sessionId: string; text: string }
  | { type: "assistant.done"; sessionId: string }
  | { type: "tool_use"; sessionId: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; sessionId: string; id: string; name: string; ok: boolean; summary?: string; content?: string }
  | { type: "permission_request"; sessionId: string; requestId: string; tool: string; input: unknown }
  // A file the agent produced/handed over, downloadable at GET /v1/attachments/:id. `source`: a file it
  // wrote, one it explicitly attached (attach_file), or an image from a tool result.
  | { type: "attachment"; sessionId: string; id: string; name: string; mime: string; size?: number; source: "written" | "attached" | "image" }
  | {
      type: "result";
      sessionId: string;
      subtype: "success" | "error_max_budget_usd" | "error_max_turns" | "error";
      costUsd?: number;
      turns?: number;
    }
  | { type: "repo.changed"; repo: string; paths: string[] }
  | { type: "error"; code: ErrorCode; message: string; sessionId?: string };

export type ServerFrame = ServerEvent & { eventId: number };
