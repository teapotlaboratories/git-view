package com.gitview.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** Thrown when the bridge returns a structured error body. */
class BridgeException(val code: String, message: String, val httpStatus: Int) : Exception(message)

/**
 * REST client for the GitView bridge. Cacheable GETs for browse; PUT/POST/DELETE for edits.
 * All calls are suspend (run on Dispatchers.IO). The bearer token is attached to every request
 * except pairing/health.
 */
class BridgeApi(
    private val baseUrl: String,
    private var token: String?,
    private val client: OkHttpClient = defaultClient,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val jsonMedia = "application/json".toMediaType()

    fun withToken(t: String?) = apply { token = t }

    // ---- meta / pairing -----------------------------------------------------
    suspend fun health(): HealthResult = get("v1/health", auth = false)
    suspend fun pair(code: String): String =
        post<PairResult>("v1/pair", json.encodeToString(PairBody.serializer(), PairBody(code)), auth = false).token

    // ---- read ---------------------------------------------------------------
    suspend fun repos(): List<RepoSummary> = get<ReposResponse>("v1/repos").repos
    suspend fun refs(repo: String): RefsResponse = get("v1/repos/$repo/refs")
    suspend fun tree(repo: String, path: String = "", ref: String? = null): TreeResponse =
        get("v1/repos/$repo/tree", mapOf("path" to path, "ref" to ref))
    suspend fun blob(repo: String, path: String, ref: String? = null): BlobResponse =
        get("v1/repos/$repo/blob", mapOf("path" to path, "ref" to ref))
    suspend fun log(repo: String, path: String? = null, ref: String? = null, limit: Int = 50): List<CommitSummary> =
        get<LogResponse>("v1/repos/$repo/log", mapOf("path" to path, "ref" to ref, "limit" to limit.toString())).commits
    suspend fun diff(repo: String, kind: String = "worktree", ref: String? = null, path: String? = null): String =
        get<DiffResponse>("v1/repos/$repo/diff", mapOf("kind" to kind, "ref" to ref, "path" to path)).diff
    suspend fun status(repo: String): List<StatusEntry> = get<StatusResponse>("v1/repos/$repo/status").status

    // ---- write --------------------------------------------------------------
    suspend fun saveFile(repo: String, path: String, content: String, encoding: String = "utf-8"): WriteResult =
        put("v1/repos/$repo/file", mapOf("path" to path), json.encodeToString(SaveFileBody.serializer(), SaveFileBody(encoding, content)))
    suspend fun createFile(repo: String, path: String, content: String, encoding: String = "utf-8"): WriteResult =
        post("v1/repos/$repo/file", json.encodeToString(CreateFileBody.serializer(), CreateFileBody(path, encoding, content)))
    suspend fun deleteFile(repo: String, path: String): WriteResult = delete("v1/repos/$repo/file", mapOf("path" to path))
    suspend fun rename(repo: String, from: String, to: String): WriteResult =
        post("v1/repos/$repo/rename", json.encodeToString(RenameBody.serializer(), RenameBody(from, to)))
    suspend fun stage(repo: String, paths: List<String>): WriteResult =
        post("v1/repos/$repo/stage", json.encodeToString(PathsBody.serializer(), PathsBody(paths)))
    suspend fun commit(repo: String, message: String, paths: List<String>? = null): WriteResult =
        post("v1/repos/$repo/commit", json.encodeToString(CommitBody.serializer(), CommitBody(message, paths)))
    suspend fun discard(repo: String, paths: List<String>): WriteResult =
        post("v1/repos/$repo/discard", json.encodeToString(PathsBody.serializer(), PathsBody(paths)))
    suspend fun checkout(repo: String, ref: String, create: Boolean = false): WriteResult =
        post("v1/repos/$repo/checkout", json.encodeToString(CheckoutBody.serializer(), CheckoutBody(ref, create)))
    suspend fun push(repo: String, remote: String? = null, branch: String? = null, setUpstream: Boolean = false): WriteResult =
        post("v1/repos/$repo/push", json.encodeToString(PushBody.serializer(), PushBody(remote, branch, setUpstream)))

    // ---- sessions -----------------------------------------------------------
    suspend fun sessions(repo: String): List<SessionInfo> = get<SessionsResponse>("v1/repos/$repo/sessions").sessions

    // ---- internals ----------------------------------------------------------
    private fun url(path: String, query: Map<String, String?> = emptyMap()) =
        baseUrl.trimEnd('/').toHttpUrl().newBuilder().apply {
            path.trim('/').split('/').forEach { addPathSegment(it) }
            query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
        }.build()

    private fun Request.Builder.authed(auth: Boolean): Request.Builder =
        also { if (auth) token?.let { header("Authorization", "Bearer $it") } }

    private suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap(), auth: Boolean = true): T =
        exec(Request.Builder().url(url(path, query)).get().authed(auth).build())

    private suspend inline fun <reified T> post(path: String, body: String, query: Map<String, String?> = emptyMap(), auth: Boolean = true): T =
        exec(Request.Builder().url(url(path, query)).post(body.toRequestBody(jsonMedia)).authed(auth).build())

    private suspend inline fun <reified T> put(path: String, query: Map<String, String?> = emptyMap(), body: String): T =
        exec(Request.Builder().url(url(path, query)).put(body.toRequestBody(jsonMedia)).authed(true).build())

    private suspend inline fun <reified T> delete(path: String, query: Map<String, String?> = emptyMap()): T =
        exec(Request.Builder().url(url(path, query)).delete().authed(true).build())

    private suspend inline fun <reified T> exec(req: Request): T = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val err = runCatching { json.decodeFromString(WireErrorBody.serializer(), text) }.getOrNull()
                throw BridgeException(err?.error?.code ?: "http_${resp.code}", err?.error?.message ?: text, resp.code)
            }
            json.decodeFromString<T>(text)
        }
    }

    companion object {
        val defaultClient: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
