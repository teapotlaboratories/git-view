package com.gitview.app.ui.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The chat transcript model — kind-tagged so the LazyColumn renders each entry without casting logic,
 * and the tool-call parsing (kind, target path, synthesized edit diff) is pure Kotlin so it unit-tests
 * on the JVM (see `ChatModelsTest`), like `DiffModel`. Fed by the bridge WebSocket in `AppViewModel`.
 */
sealed interface ChatItem {
    val id: String
}

/** A user prompt (right-aligned bubble). */
data class UserMsg(override val id: String, val text: String) : ChatItem

/** Assistant markdown text (left). While [streaming] with empty [text] it renders as "Thinking…". */
data class AssistantMsg(override val id: String, val text: String, val streaming: Boolean) : ChatItem

/** A tool call and its (eventual) result — rendered as a `ToolActivityCard`. [id] is the tool_use_id. */
data class ToolActivity(
    override val id: String,
    val kind: ToolKind,
    val name: String,        // raw tool name (Read, Edit, Bash, mcp__gitview__edit_file, …)
    val path: String?,       // primary target: file_path / path / pattern / url
    val subtitle: String?,   // secondary: command (Bash), pattern (Grep), description (Task)
    val editDiff: String?,   // unified-diff text synthesized from an Edit/Write/MultiEdit input
    val status: ToolStatus,
    val badge: String?,      // result summary for the collapsed badge, e.g. "142 lines"
    val preview: String?,    // truncated result content, for the expanded body (Read/Bash/Grep)
    val expanded: Boolean = false,
) : ChatItem

/**
 * An inline permission gate (the "Ask first" tier): the agent is PAUSED awaiting the user's decision
 * on a specific tool call. [id] is the bridge's requestId. Rendered as an `InlineApprovalCard`.
 */
data class PendingPermission(
    override val id: String,
    val kind: ToolKind,
    val name: String,
    val path: String?,
    val subtitle: String?,
    val editDiff: String?,
) : ChatItem

enum class ToolStatus { RUNNING, OK, ERROR }

enum class ToolKind { READ, EDIT, WRITE, MULTI_EDIT, BASH, GREP, GLOB, LS, WEB, TASK, TODO, OTHER }

/** Classify a raw tool name, tolerating MCP-prefixed names like `mcp__gitview__edit_file`. */
fun toolKindOf(name: String): ToolKind {
    val n = name.substringAfterLast("__").lowercase()
    return when {
        n == "read" || n.contains("read_file") -> ToolKind.READ
        n == "multiedit" || n.contains("multi_edit") -> ToolKind.MULTI_EDIT
        n == "edit" || n.contains("edit_file") -> ToolKind.EDIT
        n == "write" || n.contains("write_file") || n.contains("create_file") -> ToolKind.WRITE
        n == "bash" || n.contains("shell") || n == "run_command" -> ToolKind.BASH
        n == "grep" || n.contains("search") -> ToolKind.GREP
        n == "glob" -> ToolKind.GLOB
        n == "ls" || n.contains("list") -> ToolKind.LS
        n.startsWith("web") -> ToolKind.WEB
        n == "task" || n.contains("agent") -> ToolKind.TASK
        n.contains("todo") -> ToolKind.TODO
        else -> ToolKind.OTHER
    }
}

/** A short display label for the header: known kinds get a clean name; else the last name segment. */
fun toolDisplayName(kind: ToolKind, name: String): String = when (kind) {
    ToolKind.READ -> "Read"
    ToolKind.EDIT -> "Edit"
    ToolKind.WRITE -> "Write"
    ToolKind.MULTI_EDIT -> "MultiEdit"
    ToolKind.BASH -> "Bash"
    ToolKind.GREP -> "Grep"
    ToolKind.GLOB -> "Glob"
    ToolKind.LS -> "List"
    ToolKind.WEB -> "Web"
    ToolKind.TASK -> "Task"
    ToolKind.TODO -> "Todo"
    ToolKind.OTHER -> name.substringAfterLast("__").ifBlank { name }
}

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

/** The primary path/target for the collapsed header, pulled from the tool input. */
fun toolPath(input: JsonObject?): String? {
    input ?: return null
    return input.str("file_path") ?: input.str("filePath") ?: input.str("notebook_path")
        ?: input.str("path") ?: input.str("pattern") ?: input.str("url")
}

/** A secondary descriptor (command / pattern / description) when it isn't already the path. */
fun toolSubtitle(kind: ToolKind, input: JsonObject?): String? {
    input ?: return null
    return when (kind) {
        ToolKind.BASH -> input.str("command")
        ToolKind.GREP -> input.str("pattern")
        ToolKind.TASK -> input.str("description")
        ToolKind.WEB -> input.str("prompt")
        else -> null
    }
}

/**
 * Synthesize a unified-diff string for an Edit/Write/MultiEdit input so the tool card can render the
 * write via the shared diff rows. `classifyDiff` reads a bare `@@ … @@` as a hunk header and `-`/`+`
 * prefixes as remove/add, so this minimal format renders correctly. Returns null when there's no edit.
 */
fun toolEditDiff(kind: ToolKind, path: String?, input: JsonObject?): String? {
    input ?: return null
    return when (kind) {
        ToolKind.EDIT -> input.str("old_string")?.let { old ->
            unifiedFromReplace(path, old, input.str("new_string") ?: "")
        }
        ToolKind.WRITE -> input.str("content")?.let { content ->
            unifiedFromReplace(path, "", content)
        }
        ToolKind.MULTI_EDIT -> {
            val edits = input["edits"] as? JsonArray ?: return null
            val blocks = edits.mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val old = o.str("old_string") ?: return@mapNotNull null
                unifiedFromReplace(path, old, o.str("new_string") ?: "")
            }
            blocks.joinToString("\n").ifBlank { null }
        }
        else -> null
    }
}

private fun unifiedFromReplace(path: String?, old: String, new: String): String {
    val sb = StringBuilder()
    sb.append("@@ ").append(path ?: "edit").append(" @@\n")
    if (old.isNotEmpty()) old.split("\n").forEach { sb.append('-').append(it).append('\n') }
    new.split("\n").forEach { sb.append('+').append(it).append('\n') }
    return sb.toString().trimEnd('\n')
}
