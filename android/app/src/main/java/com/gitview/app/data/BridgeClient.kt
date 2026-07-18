package com.gitview.app.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The single live channel client. Opens a WebSocket to `/v1/live`, authenticates on the FIRST FRAME
 * (token never in the URL), and emits parsed [ServerEvent]s as a Flow. Prompt/interrupt/replay go up.
 *
 * The Color E-Ink DisplayProfile batches AssistantDelta events per completed line before repainting
 * (see EInkRefreshController / EINK.md); this client streams every delta and leaves batching to the UI.
 */
class BridgeClient(
    private val baseUrl: String,
    private val token: String,
    private val client: OkHttpClient = BridgeApi.defaultClient,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private var socket: WebSocket? = null

    fun connect(): Flow<ServerEvent> = callbackFlow {
        val wsUrl = baseUrl.trimEnd('/').replaceFirst("http", "ws") + "/v1/live"
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // FIRST-FRAME AUTH: send the token before anything else.
                webSocket.send(buildJsonObject { put("type", "auth"); put("token", token) }.toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                parse(text)?.let { trySend(it) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                trySend(ServerEvent.Error(0, "socket", t.message ?: "socket failure", null)); close(t)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
        }
        socket = client.newWebSocket(Request.Builder().url(wsUrl).build(), listener)
        awaitClose { socket?.close(1000, "client closed"); socket = null }
    }

    fun sendPrompt(repo: String, sessionId: String?, provider: SessionProvider, profile: PermissionProfile, text: String) {
        socket?.send(buildJsonObject {
            put("type", "prompt"); put("repo", repo)
            sessionId?.let { put("sessionId", it) }
            put("provider", if (provider == SessionProvider.REMOTE_CONTROL) "remote-control" else "local-sdk")
            put("profile", profileWire(profile))
            put("text", text)
        }.toString())
    }

    fun interrupt(sessionId: String) {
        socket?.send(buildJsonObject { put("type", "interrupt"); put("sessionId", sessionId) }.toString())
    }

    fun replay(fromEventId: Long) {
        socket?.send(buildJsonObject { put("type", "replay"); put("fromEventId", fromEventId) }.toString())
    }

    fun close() { socket?.close(1000, "bye"); socket = null }

    private fun parse(text: String): ServerEvent? {
        val obj = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return null
        val id = obj["eventId"]?.jsonPrimitive?.long ?: 0L
        val sid = obj["sessionId"]?.jsonPrimitive?.content ?: ""
        fun s(k: String) = obj[k]?.jsonPrimitive?.content
        return when (obj["type"]?.jsonPrimitive?.content) {
            "ready" -> ServerEvent.Ready(id)
            "session.init" -> ServerEvent.SessionInit(id, sid, s("provider") ?: "", obj["resumed"]?.jsonPrimitive?.booleanOrNull ?: false, s("model"))
            "assistant.block_start" -> ServerEvent.BlockStart(id, sid, obj["index"]?.jsonPrimitive?.intOrNull ?: 0, s("blockType") ?: "text")
            "assistant.delta" -> ServerEvent.AssistantDelta(id, sid, s("text") ?: "")
            "assistant.done" -> ServerEvent.AssistantDone(id, sid)
            "tool_use" -> ServerEvent.ToolUse(id, sid, s("name") ?: "")
            "tool_result" -> ServerEvent.ToolResult(id, sid, s("name") ?: "", obj["ok"]?.jsonPrimitive?.booleanOrNull ?: true)
            "result" -> ServerEvent.Result(id, sid, s("subtype") ?: "success", obj["costUsd"]?.jsonPrimitive?.doubleOrNull, obj["turns"]?.jsonPrimitive?.intOrNull)
            "repo.changed" -> ServerEvent.RepoChanged(id, s("repo") ?: "", obj["paths"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList())
            "error" -> ServerEvent.Error(id, s("code") ?: "internal", s("message") ?: "", s("sessionId"))
            else -> null
        }
    }

    private fun profileWire(p: PermissionProfile): String = when (p) {
        PermissionProfile.READ_ONLY -> "read-only"
        PermissionProfile.CONFINED_AGENT -> "confined-agent"
        PermissionProfile.ACCEPT_EDITS -> "acceptEdits"
        PermissionProfile.AUTO -> "auto"
        PermissionProfile.DONT_ASK -> "dontAsk"
        PermissionProfile.BYPASS -> "bypassPermissions"
    }
}
