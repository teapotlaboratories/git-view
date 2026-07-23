import type { RepoConfig } from "../config.js";
import type { AgentInfo, ServerEvent, SessionInfo, SessionMessagesResponse } from "../wire.js";

export interface AgentStartArgs {
  repo: RepoConfig;
  profile: RepoConfig["profile"];
  prompt: string;
  resume?: string;
  onEvent: (e: ServerEvent) => void;
}

/**
 * A pluggable chat backend. Claude is the first implementation ([[ClaudeAgentProvider]] = SessionManager);
 * Codex or any other agentic CLI slots in by implementing this same interface. The CRITICAL contract: every
 * provider maps ITS OWN native stream to the SAME neutral GitView [ServerEvent]s (assistant deltas, tool_use,
 * tool_result, permission_request, result), so the app — and the rest of the bridge — stay agent-agnostic.
 */
export interface AgentProvider extends AgentInfo {
  /** Start (or resume) a session; streams normalized ServerEvents via `onEvent`; returns the session id. */
  start(args: AgentStartArgs): Promise<string>;
  interrupt(sessionId: string): Promise<void>;
  resolvePermission(requestId: string, allow: boolean, scope: "once" | "session"): void;
  listForRepo(repo: RepoConfig): Promise<SessionInfo[]>;
  messagesForRepo(repo: RepoConfig, id: string): Promise<SessionMessagesResponse>;
  deleteForRepo(repo: RepoConfig, id: string): Promise<void>;
}
