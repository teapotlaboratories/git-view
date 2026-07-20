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
      profile: PermissionProfile;
      text: string;
    }
  | { type: "interrupt"; sessionId: string }
  | { type: "replay"; fromEventId: number };

// ---- WebSocket: server -> client (every frame carries a monotonic eventId) --

export type ServerEvent =
  | { type: "ready" }
  | { type: "session.init"; sessionId: string; provider: SessionProvider; resumed: boolean; model?: string }
  | { type: "assistant.block_start"; sessionId: string; index: number; blockType: string }
  | { type: "assistant.delta"; sessionId: string; text: string }
  | { type: "assistant.done"; sessionId: string }
  | { type: "tool_use"; sessionId: string; name: string; input: unknown }
  | { type: "tool_result"; sessionId: string; name: string; ok: boolean; summary?: string }
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
