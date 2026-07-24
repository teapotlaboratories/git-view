package com.gitview.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Wire protocol types (v1) — hand-mirrored from docs/API.md, the single source of truth.
 * The bridge mirrors the SAME shapes in wire.ts. Change docs/API.md first, then both ends.
 */

@Serializable
enum class PermissionProfile {
    @SerialName("read-only") READ_ONLY,
    @SerialName("confined-agent") CONFINED_AGENT,
    @SerialName("acceptEdits") ACCEPT_EDITS,
    @SerialName("auto") AUTO,
    @SerialName("dontAsk") DONT_ASK,
    @SerialName("bypassPermissions") BYPASS;

    companion object {
        val DEFAULT = CONFINED_AGENT // redesign default: "Ask first"
        val ordered = listOf(READ_ONLY, CONFINED_AGENT, ACCEPT_EDITS, AUTO, DONT_ASK, BYPASS)
    }
}

@Serializable
enum class SessionProvider {
    @SerialName("remote-control") REMOTE_CONTROL,
    @SerialName("local-sdk") LOCAL_SDK,
}

// ---- REST: read -------------------------------------------------------------

@Serializable
data class RepoSummary(
    val id: String,
    val name: String,
    val defaultBranch: String,
    val provider: SessionProvider,
    val profile: PermissionProfile,
    val branch: String = "",         // current HEAD
    val ahead: Int? = null,          // null when there is no upstream
    val behind: Int? = null,
    val dirty: Int = 0,
    val removable: Boolean = false,  // opened workspaces are removable; config repos + older bridges default false
)

@Serializable data class ReposResponse(val repos: List<RepoSummary>)

@Serializable
data class TreeEntry(
    val name: String,
    val path: String,
    val type: String, // "blob" | "tree"
    val size: Int? = null,
    val oid: String,
) { val isDir: Boolean get() = type == "tree" }

@Serializable data class TreeResponse(val ref: String, val path: String, val entries: List<TreeEntry>)

@Serializable
data class BlobResponse(
    val path: String,
    val ref: String,
    val oid: String,
    val size: Int,
    val binary: Boolean,
    val encoding: String, // "utf-8" | "base64"
    val content: String,
)

@Serializable
data class CommitSummary(
    val oid: String,
    val shortOid: String,
    val subject: String,
    val author: String,
    val authorEmail: String,
    val date: String,
    val files: Int = 0,
    val additions: Int = 0,
    val deletions: Int = 0,
)

@Serializable data class LogResponse(val commits: List<CommitSummary>)
@Serializable data class RefsResponse(val head: String, val branches: List<String>, val tags: List<String>)
@Serializable data class DiffResponse(val diff: String)

@Serializable data class StatusEntry(val path: String, val index: String, val worktree: String)
@Serializable data class StatusResponse(val status: List<StatusEntry>)

@Serializable data class SessionInfo(val id: String, val updatedAt: String, val title: String? = null, val turns: Int? = null)

// Chat providers (Claude today; Codex etc. later). `capabilities` tells the app which provider-specific
// controls to show (Claude has model pin + in-app login; another agent may not).
@Serializable data class AgentCapabilities(val modelPin: Boolean = false, val inAppLogin: Boolean = false, val permissionTiers: Boolean = true)
@Serializable data class AgentInfo(val id: String, val label: String, val capabilities: AgentCapabilities = AgentCapabilities())
@Serializable data class AgentsResponse(val agents: List<AgentInfo> = emptyList())
@Serializable data class SessionsResponse(val sessions: List<SessionInfo>)
@Serializable data class OkResponse(val ok: Boolean = true)

/**
 * One entry in a resumed session transcript. A flat object discriminated by [role] — the bridge sends
 * a role-tagged flat shape per message, and with `ignoreUnknownKeys` a single all-nullable class
 * decodes every variant cleanly: user/assistant carry [text]; tool_use carries [id]/[name]/[input];
 * tool_result carries [id]/[name]/[ok]/[summary]/[content].
 */
@Serializable data class TranscriptMessage(
    val role: String,
    val text: String? = null,
    val id: String? = null,
    val name: String? = null,
    val input: JsonObject? = null,
    val ok: Boolean? = null,
    val summary: String? = null,
    val content: String? = null,
)

@Serializable data class SessionMessagesResponse(val sessionId: String, val messages: List<TranscriptMessage> = emptyList())

// ---- REST: write ------------------------------------------------------------

@Serializable data class SaveFileBody(val encoding: String, val content: String)
@Serializable data class CreateFileBody(val path: String, val encoding: String, val content: String)
@Serializable data class RenameBody(val from: String, val to: String)
@Serializable data class PathsBody(val paths: List<String>)
@Serializable data class CommitBody(val message: String, val paths: List<String>? = null)
@Serializable data class CheckoutBody(val ref: String, val create: Boolean = false)
@Serializable data class PushBody(val remote: String? = null, val branch: String? = null, val setUpstream: Boolean = false)
@Serializable data class WriteResult(val ok: Boolean = true, val oid: String? = null)

@Serializable data class PairBody(val code: String)
@Serializable data class PairResult(val token: String)
@Serializable data class HealthResult(val ok: Boolean, val protocol: Int, val bridge: String, val features: Features? = null)

/** Bridge capability flags echoed by `GET /v1/health`. `workspaces` = workspaceRoots configured & non-empty. */
@Serializable data class Features(val workspaces: Boolean = false)

// ---- REST: browse host filesystem + open a folder as a workspace ------------

@Serializable data class FsRoot(val id: String, val path: String, val label: String)
@Serializable data class FsRootsResponse(val roots: List<FsRoot>)

@Serializable data class FsEntry(val name: String, val kind: String, val isRepo: Boolean = false) {
    val isDir: Boolean get() = kind == "dir"
}

/** A directory listing under one root; [parent] is null at the root itself. */
@Serializable data class FsListing(val root: String, val path: String, val parent: String?, val entries: List<FsEntry>)

@Serializable data class FsMkdirBody(val root: String, val path: String, val name: String)
@Serializable data class FsMkdirResult(val path: String)

@Serializable data class OpenWorkspaceRequest(
    val root: String,
    val path: String,
    val initGit: Boolean = false,
    val provider: SessionProvider? = null,
    val profile: PermissionProfile? = null,
)

/** Either the registered [repo] (opened) or [needsInit] with the [path] awaiting a git-init confirm. */
@Serializable data class OpenWorkspaceResult(
    val repo: RepoSummary? = null,
    val needsInit: Boolean = false,
    val path: String? = null,
)

@Serializable data class WireErrorBody(val error: WireErrorDetail)
@Serializable data class WireErrorDetail(val code: String, val message: String)

// ---- REST: Claude agent settings (model + host credential) ------------------

/** Effective Claude-agent config for the SDK query. [hint] is a masked secret tail (null when auth=host). */
@Serializable data class ClaudeSettings(
    val model: String,
    val configModel: String,
    // Effective reasoning effort + the config.yaml default. null on either = unset, i.e. the bridge
    // passes no `effort` and the Claude CLI's own default applies.
    val effort: String? = null,
    val configEffort: String? = null,
    val auth: String, // "host" | "api-key" | "subscription"
    val hint: String? = null,
    val host: ClaudeHost = ClaudeHost(),
)

/** Host-side credential presence flags echoed by the bridge. */
@Serializable data class ClaudeHost(val credentials: Boolean = false, val apiKeyEnv: Boolean = false)

@Serializable data class PutClaudeAuth(val mode: String, val secret: String? = null)
@Serializable data class PutClaudeSettings(
    val model: String? = null,
    // "" clears the override; otherwise low|medium|high|xhigh|max (the bridge 400s on anything else).
    val effort: String? = null,
    val auth: PutClaudeAuth? = null,
)

// ---- REST: Claude "Log in with subscription" (host PTY-spawns `claude setup-token`) ----
// The pasted code and any captured token are NEVER logged, echoed, or returned in a response.
@Serializable data class StartLoginResponse(val loginId: String, val url: String)
@Serializable data class SubmitLoginRequest(val loginId: String, val code: String)
@Serializable data class SubmitLoginResponse(val status: String, val message: String? = null)

// ---- WebSocket events (parsed manually in BridgeClient; keyed on `type`) -----

sealed interface ServerEvent {
    val eventId: Long
    data class Ready(override val eventId: Long) : ServerEvent
    data class SessionInit(override val eventId: Long, val sessionId: String, val provider: String, val resumed: Boolean, val model: String?, val maxBudgetUsd: Double? = null) : ServerEvent
    data class BlockStart(override val eventId: Long, val sessionId: String, val index: Int, val blockType: String) : ServerEvent
    data class AssistantDelta(override val eventId: Long, val sessionId: String, val text: String) : ServerEvent
    data class AssistantDone(override val eventId: Long, val sessionId: String) : ServerEvent
    data class ToolUse(override val eventId: Long, val sessionId: String, val id: String, val name: String, val input: JsonObject?) : ServerEvent
    data class ToolResult(override val eventId: Long, val sessionId: String, val id: String, val name: String, val ok: Boolean, val summary: String?, val content: String?) : ServerEvent
    data class PermissionRequest(override val eventId: Long, val sessionId: String, val requestId: String, val tool: String, val input: JsonObject?) : ServerEvent
    data class Attachment(override val eventId: Long, val sessionId: String, val id: String, val name: String, val mime: String, val size: Long?, val source: String) : ServerEvent
    data class Result(override val eventId: Long, val sessionId: String, val subtype: String, val costUsd: Double?, val turns: Int?) : ServerEvent
    data class RepoChanged(override val eventId: Long, val repo: String, val paths: List<String>) : ServerEvent
    data class Error(override val eventId: Long, val code: String, val message: String, val sessionId: String?) : ServerEvent
}
