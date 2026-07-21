package com.gitview.app.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onEach
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
import java.util.concurrent.TimeUnit

/** Live-channel connection state, surfaced to the UI for the reconnect banner + editor read-only lock. */
enum class ConnState { CONNECTING, CONNECTED, RECONNECTING, DISCONNECTED }

/**
 * The single live channel client. Opens a WebSocket to `/v1/live`, authenticates on the FIRST FRAME
 * (token never in the URL), and emits parsed [ServerEvent]s as a Flow. Prompt/interrupt/replay go up.
 *
 * [connect] is a LONG-LIVED flow that **auto-reconnects** with capped backoff: one socket drop no longer
 * ends the channel — it flips [state] to RECONNECTING and dials again, until [close] is called or the
 * collector is cancelled (leaving the workspace). [state] drives the reconnect banner (ADR-029).
 *
 * The Color E-Ink DisplayProfile batches AssistantDelta events per completed line before repainting
 * (see EInkRefreshController / EINK.md); this client streams every delta and leaves batching to the UI.
 */
class BridgeClient(
    private val baseUrl: String,
    private val token: String,
    private val client: OkHttpClient = wsClient,
) {
    companion object {
        // A dead peer on an OPEN WebSocket is otherwise never detected (OkHttp doesn't apply the read
        // timeout to frame reads) — the emulator NAT in particular swallows the FIN. A ping interval
        // makes OkHttp fail the socket when a pong is missed, which drives the auto-reconnect.
        val wsClient: OkHttpClient = BridgeApi.defaultClient.newBuilder()
            .pingInterval(10, TimeUnit.SECONDS)
            .build()
    }

    private val json = Json { ignoreUnknownKeys = true }
    private var socket: WebSocket? = null
    private var closed = false

    private val _state = MutableStateFlow(ConnState.CONNECTING)
    val state: StateFlow<ConnState> = _state.asStateFlow()

    /** Auto-reconnecting event stream. Emits parsed [ServerEvent]s; drops flip [state] and re-dial. */
    fun connect(): Flow<ServerEvent> = flow {
        var attempt = 0
        while (!closed) {
            _state.value = if (attempt == 0) ConnState.CONNECTING else ConnState.RECONNECTING
            // CONNECTED is set when the server's `ready` arrives (auth accepted), not just on socket open;
            // a successful connect also RESETS the backoff so the next drop retries fast, not at the cap.
            runCatching {
                emitAll(connectOnce().onEach {
                    if (it is ServerEvent.Ready) { _state.value = ConnState.CONNECTED; attempt = 0 }
                })
            }
            if (closed) break
            _state.value = ConnState.DISCONNECTED
            attempt++
            delay(backoffMs(attempt))
        }
    }

    private fun connectOnce(): Flow<ServerEvent> = callbackFlow {
        val wsUrl = baseUrl.trimEnd('/').replaceFirst("http", "ws") + "/v1/live"
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // FIRST-FRAME AUTH: send the token before anything else.
                webSocket.send(buildJsonObject { put("type", "auth"); put("token", token) }.toString())
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                parse(text)?.let { trySend(it) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { close(t) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { close() }
        }
        socket = client.newWebSocket(Request.Builder().url(wsUrl).build(), listener)
        awaitClose { socket?.close(1000, "client closed"); socket = null }
    }

    /** 1s, 2s, 4s, 8s, capped at 15s — snappy first retry, gentle when the bridge is down for a while. */
    private fun backoffMs(attempt: Int): Long = minOf(1000L shl minOf(attempt - 1, 4), 15_000L)

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

    fun sendPermissionResponse(requestId: String, allow: Boolean, scope: String) {
        socket?.send(buildJsonObject {
            put("type", "permission_response"); put("requestId", requestId); put("allow", allow); put("scope", scope)
        }.toString())
    }

    fun replay(fromEventId: Long) {
        socket?.send(buildJsonObject { put("type", "replay"); put("fromEventId", fromEventId) }.toString())
    }

    /** True only when the socket is open AND the server accepted auth (`ready` seen) — the send guard. */
    val isConnected: Boolean get() = _state.value == ConnState.CONNECTED

    fun close() { closed = true; socket?.close(1000, "bye"); socket = null }

    private fun parse(text: String): ServerEvent? {
        val obj = runCatching { json.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return null
        val id = obj["eventId"]?.jsonPrimitive?.long ?: 0L
        val sid = obj["sessionId"]?.jsonPrimitive?.content ?: ""
        fun s(k: String) = obj[k]?.jsonPrimitive?.content
        return when (obj["type"]?.jsonPrimitive?.content) {
            "ready" -> ServerEvent.Ready(id)
            "session.init" -> ServerEvent.SessionInit(id, sid, s("provider") ?: "", obj["resumed"]?.jsonPrimitive?.booleanOrNull ?: false, s("model"), obj["maxBudgetUsd"]?.jsonPrimitive?.doubleOrNull)
            "assistant.block_start" -> ServerEvent.BlockStart(id, sid, obj["index"]?.jsonPrimitive?.intOrNull ?: 0, s("blockType") ?: "text")
            "assistant.delta" -> ServerEvent.AssistantDelta(id, sid, s("text") ?: "")
            "assistant.done" -> ServerEvent.AssistantDone(id, sid)
            "tool_use" -> ServerEvent.ToolUse(id, sid, s("id") ?: "", s("name") ?: "", obj["input"] as? JsonObject)
            "tool_result" -> ServerEvent.ToolResult(id, sid, s("id") ?: "", s("name") ?: "", obj["ok"]?.jsonPrimitive?.booleanOrNull ?: true, s("summary"), s("content"))
            "permission_request" -> ServerEvent.PermissionRequest(id, sid, s("requestId") ?: "", s("tool") ?: "", obj["input"] as? JsonObject)
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
