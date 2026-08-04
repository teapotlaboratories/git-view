package com.gitview.app.data

import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.builtins.ListSerializer
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

/** [label] names this device in the bridge's device list (ADR-035); older bridges ignore it. */
@Serializable data class PairBody(val code: String, val label: String? = null)

/**
 * One paired device (ADR-035). Every row is a real, individually revocable device: ADR-037 dropped the
 * synthetic row that used to stand in for the whole pre-0.1.8 bare-token bucket. `connected` comes from
 * the bridge's LIVE socket set, not lastSeenAt. Defaults keep an older bridge (which returns fewer
 * fields, and may still send a `legacy` flag this no longer models) from failing to decode.
 */
@Serializable
data class DeviceSummary(
    val id: String,
    val label: String = "device",
    val createdAt: String = "",
    val lastSeenAt: String = "",
    val connected: Boolean = false,
)

@Serializable data class DevicesResponse(val devices: List<DeviceSummary> = emptyList())

/**
 * The device id inside a bearer token (`<id>.<secret>`), so a client can recognise its OWN row in
 * `GET /v1/devices` without another endpoint. Returns "" for a dotless token — a pre-0.1.8 bare one,
 * which since ADR-037 no bridge accepts, so it matches no row and simply withholds nothing.
 *
 * NOTE this id is scoped to ONE bridge: each bridge issues its own, so a value from one connection is
 * meaningless against another and must not be carried across a bridge switch.
 */
fun deviceIdOf(token: String): String = token.substringBefore('.', missingDelimiterValue = "")

@Serializable
data class RevokeResult(val ok: Boolean = true, val revoked: String = "", val connectionsClosed: Int = 0)
@Serializable data class PairResult(val token: String)
@Serializable data class HealthResult(val ok: Boolean, val protocol: Int, val bridge: String, val features: Features? = null)

/** Bridge capability flags echoed by `GET /v1/health`. `workspaces` = workspaceRoots configured & non-empty. */
@Serializable data class Features(val workspaces: Boolean = false, val terminal: Boolean = false)

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
    data class TerminalData(override val eventId: Long, val termId: String, val data: String) : ServerEvent
    data class TerminalExit(override val eventId: Long, val termId: String, val code: Int?) : ServerEvent
    data class Error(override val eventId: Long, val code: String, val message: String, val sessionId: String?) : ServerEvent
}

// ---- KiCad schematic scene (ADR-038, Phase 1) --------------------------------------------------

/**
 * One drawable from the bridge's tagged scene.
 *
 * Deliberately **one flexible shape rather than a sealed hierarchy**, mirroring the schema-less stance the
 * bridge's s-expression reader takes: `t` is read as a plain string and unknown kinds decode cleanly
 * instead of throwing, so a bridge that learns a new primitive does not hard-fail an older app. The cost
 * is nullable fields; the benefit is that a version skew degrades to "one thing is not drawn".
 *
 * `net` and `ref` are the whole point — every drawable knows what it belongs to, which is what makes
 * highlighting a style change rather than an overlay.
 */
@Serializable
data class ScenePrimitive(
    val t: String,
    val pts: List<List<Double>>? = null,
    val at: List<Double>? = null,
    val a: List<Double>? = null,
    val b: List<Double>? = null,
    val m: List<Double>? = null,
    val c: List<Double>? = null,
    val r: Double? = null,
    val w: Double? = null,
    val fill: Boolean = false,
    val s: String? = null,
    val size: Double? = null,
    val rot: Double? = null,
    val hjust: String? = null,
    val vjust: String? = null,
    val kind: String? = null,
    val ref: String? = null,
    val pin: String? = null,
    val name: String? = null,
    val net: String? = null,
)

@Serializable
data class SceneComponent(val ref: String, val value: String = "", val libId: String = "", val at: List<Double> = emptyList())

@Serializable
data class SceneSheetRef(val name: String, val path: String)

@Serializable
data class KicadScene(
    val sheet: String = "",
    val path: String = "",
    val version: Int = 0,
    /** `[minX, minY, maxX, maxY]` in mm — fit-to-view without walking the primitives. */
    val bbox: List<Double> = emptyList(),
    val primitives: List<ScenePrimitive> = emptyList(),
    val components: List<SceneComponent> = emptyList(),
    val nets: List<String> = emptyList(),
    val sheets: List<SceneSheetRef> = emptyList(),
    /** Non-empty means the design is incomplete — the UI must say so rather than show a partial sheet. */
    val problems: List<String> = emptyList(),
    /**
     * The `.kicad_pcb` beside this schematic, when the bridge found one (ADR-038, Phase 3b).
     *
     * Resolved server-side deliberately: only the bridge can tell whether the sibling exists *at this ref*,
     * and a client that guessed the name would offer a cross-probe action that 404s on any project whose
     * files are not named in step. Null means no counterpart, so the action is simply not offered.
     */
    val counterpart: String? = null,
)

// ---- KiCad board (ADR-038, Phase 3) ------------------------------------------------------------

/**
 * One drawable from a board layer.
 *
 * Same schema-less stance as [ScenePrimitive] — `t` is a plain string so a bridge that learns a new
 * primitive degrades to "one thing is not drawn" rather than failing the whole layer. It is a *separate*
 * type rather than a reuse, for the reasons ADR-038 records: a track carries width and a layer where a
 * schematic wire carries neither, and a via or pad belongs to several layers at once.
 */
/**
 * Accepts `size` as either `[w, h]` or a bare number.
 *
 * Exists purely for version skew: `.ai/AGENTS.md` states app-only and bridge-only releases are normal, so
 * a new app *will* meet an old bridge. Without this, one text primitive from a v0.1.14 bridge throws and
 * the whole copper layer silently disappears — 20,887 primitives lost to three labels.
 */
object LenientSizeSerializer : JsonTransformingSerializer<List<Double>>(ListSerializer(Double.serializer())) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonArray) element else JsonArray(listOf(element))
}

@Serializable
data class BoardPrimitive(
    val t: String,
    val a: List<Double>? = null,
    val b: List<Double>? = null,
    val m: List<Double>? = null,
    val at: List<Double>? = null,
    val c: List<Double>? = null,
    val pts: List<List<Double>>? = null,
    val r: Double? = null,
    val w: Double? = null,
    val d: Double? = null,
    val drill: Double? = null,
    /**
     * Pad extent `[w, h]`. Text carries its own [fontSize] — deliberately a different key, see below.
     *
     * Decoded leniently because **the app and the bridge version independently**, so a v0.1.15 app will
     * meet a v0.1.14 bridge in the wild. That bridge still sends a text primitive's font size *here*, as a
     * scalar, and a strict decoder meeting `1.5` where it wants `[w, h]` throws — taking the entire layer
     * with it, which is exactly the bug renaming the field was meant to end. A scalar is accepted and
     * wrapped; nothing reads it, because the board view does not draw text.
     */
    @Serializable(with = LenientSizeSerializer::class)
    val size: List<Double>? = null,
    /**
     * Font size for a `text` primitive.
     *
     * Separate from [size] because the two are different shapes. They used to share the name: a strict
     * decoder cannot be both an array and a scalar, so one text primitive threw and took the entire layer
     * with it — 20,887 pieces of copper vanishing because of three labels.
     */
    val fontSize: Double? = null,
    val shape: String? = null,
    val rot: Double? = null,
    val layer: String? = null,
    val layers: List<String>? = null,
    val fill: Boolean = false,
    val s: String? = null,
    val ref: String? = null,
    val net: String? = null,
)

/** A declared layer and how much is on it — the index carries this so a client can choose before fetching. */
@Serializable
data class BoardLayerInfo(val name: String, val kind: String = "", val count: Int = 0)

@Serializable
data class BoardComponent(
    val ref: String,
    val value: String = "",
    val footprint: String = "",
    val layer: String = "",
    val at: List<Double> = emptyList(),
    val rot: Double = 0.0,
)

/**
 * The board index: everything except geometry.
 *
 * Fetched on open. It is what makes per-layer requests usable — the counts say that `User.9` holds
 * 286,621 elements and `F.Cu` holds 20,887 *before* either is asked for, so the client (and the person
 * reading it) can choose knowingly.
 */
@Serializable
data class KicadBoard(
    val version: Int = 0,
    val layers: List<BoardLayerInfo> = emptyList(),
    val components: List<BoardComponent> = emptyList(),
    val nets: List<String> = emptyList(),
    /** `[minX, minY, maxX, maxY]` in mm — the board outline where there is one. */
    val bbox: List<Double> = emptyList(),
    val problems: List<String> = emptyList(),
    /** The `.kicad_sch` beside this board, when the bridge found one. See [KicadScene.counterpart]. */
    val counterpart: String? = null,
)

/** One layer's drawables, fetched on demand. `truncated` must be surfaced — a partial layer that looks whole is the failure this guards against. */
@Serializable
data class KicadBoardLayer(
    val layer: String = "",
    val primitives: List<BoardPrimitive> = emptyList(),
    val truncated: Boolean = false,
    val problems: List<String> = emptyList(),
)
