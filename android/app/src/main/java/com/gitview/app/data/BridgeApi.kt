package com.gitview.app.data

import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * REST browse contract — mirrors docs/API.md. All GET, all read-only.
 * Build the Retrofit instance per-connection with the bridge base URL + a Bearer auth interceptor.
 */
interface BridgeApi {
    @GET("api/health")
    suspend fun health(): Health

    @GET("api/repos")
    suspend fun repos(): ReposResponse

    @GET("api/repos/{repo}/refs")
    suspend fun refs(@Path("repo") repo: String): Refs

    @GET("api/repos/{repo}/tree")
    suspend fun tree(
        @Path("repo") repo: String,
        @Query("ref") ref: String? = null,
        @Query("path") path: String? = null,
    ): TreeResponse

    @GET("api/repos/{repo}/blob")
    suspend fun blob(
        @Path("repo") repo: String,
        @Query("path") path: String,
        @Query("ref") ref: String? = null,
    ): Blob

    @GET("api/repos/{repo}/log")
    suspend fun log(
        @Path("repo") repo: String,
        @Query("ref") ref: String? = null,
        @Query("path") path: String? = null,
        @Query("limit") limit: Int? = null,
    ): LogResponse

    @GET("api/repos/{repo}/sessions")
    suspend fun sessions(@Path("repo") repo: String): SessionsResponse
}

@Serializable data class Health(val ok: Boolean, val name: String, val version: String)
@Serializable data class RepoSummary(val id: String, val name: String, val defaultRef: String)
@Serializable data class ReposResponse(val repos: List<RepoSummary>)
@Serializable data class Refs(val branches: List<String>, val tags: List<String>)

@Serializable
data class TreeEntry(
    val name: String,
    val path: String,
    val type: String, // "blob" | "tree"
    val size: Long? = null,
    val sha: String,
)

@Serializable data class TreeResponse(val ref: String, val path: String, val entries: List<TreeEntry>)

@Serializable
data class Blob(
    val path: String,
    val ref: String,
    val sha: String,
    val size: Long,
    val encoding: String, // "utf-8" | "base64" | "none"
    val binary: Boolean,
    val truncated: Boolean,
    val content: String? = null,
)

@Serializable data class Commit(val sha: String, val author: String, val date: String, val subject: String)
@Serializable data class LogResponse(val commits: List<Commit>)

@Serializable
data class SessionInfo(
    val id: String,
    val updatedAt: String,
    val title: String? = null,
    val messages: Int? = null,
)

@Serializable data class SessionsResponse(val sessions: List<SessionInfo>)
