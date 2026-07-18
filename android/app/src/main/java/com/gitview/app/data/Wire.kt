package com.gitview.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
        val DEFAULT = AUTO
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
)

@Serializable data class LogResponse(val commits: List<CommitSummary>)
@Serializable data class RefsResponse(val head: String, val branches: List<String>, val tags: List<String>)
@Serializable data class DiffResponse(val diff: String)

@Serializable data class StatusEntry(val path: String, val index: String, val worktree: String)
@Serializable data class StatusResponse(val status: List<StatusEntry>)

@Serializable data class SessionInfo(val id: String, val updatedAt: String, val title: String? = null, val turns: Int? = null)
@Serializable data class SessionsResponse(val sessions: List<SessionInfo>)

// ---- REST: write ------------------------------------------------------------

@Serializable data class SaveFileBody(val encoding: String, val content: String)
@Serializable data class CreateFileBody(val path: String, val encoding: String, val content: String)
@Serializable data class RenameBody(val from: String, val to: String)
@Serializable data class PathsBody(val paths: List<String>)
@Serializable data class CommitBody(val message: String, val paths: List<String>? = null)
@Serializable data class WriteResult(val ok: Boolean = true, val oid: String? = null)

@Serializable data class PairBody(val code: String)
@Serializable data class PairResult(val token: String)
@Serializable data class HealthResult(val ok: Boolean, val protocol: Int, val bridge: String)

@Serializable data class WireErrorBody(val error: WireErrorDetail)
@Serializable data class WireErrorDetail(val code: String, val message: String)

// ---- WebSocket events (parsed manually in BridgeClient; keyed on `type`) -----

sealed interface ServerEvent {
    val eventId: Long
    data class Ready(override val eventId: Long) : ServerEvent
    data class SessionInit(override val eventId: Long, val sessionId: String, val provider: String, val resumed: Boolean, val model: String?) : ServerEvent
    data class BlockStart(override val eventId: Long, val sessionId: String, val index: Int, val blockType: String) : ServerEvent
    data class AssistantDelta(override val eventId: Long, val sessionId: String, val text: String) : ServerEvent
    data class AssistantDone(override val eventId: Long, val sessionId: String) : ServerEvent
    data class ToolUse(override val eventId: Long, val sessionId: String, val name: String) : ServerEvent
    data class ToolResult(override val eventId: Long, val sessionId: String, val name: String, val ok: Boolean) : ServerEvent
    data class Result(override val eventId: Long, val sessionId: String, val subtype: String, val costUsd: Double?, val turns: Int?) : ServerEvent
    data class RepoChanged(override val eventId: Long, val repo: String, val paths: List<String>) : ServerEvent
    data class Error(override val eventId: Long, val code: String, val message: String, val sessionId: String?) : ServerEvent
}
