package com.gitview.app.data

import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * REST contract — mirrors docs/API.md. GET = browse; PUT/POST/DELETE = edit the working tree.
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

    // Working-tree version of a file — what the editor opens/edits.
    @GET("api/repos/{repo}/working")
    suspend fun working(@Path("repo") repo: String, @Query("path") path: String): WorkingFile

    @GET("api/repos/{repo}/sessions")
    suspend fun sessions(@Path("repo") repo: String): SessionsResponse

    // ---- edit (working tree, direct) ----

    @PUT("api/repos/{repo}/blob")
    suspend fun save(@Path("repo") repo: String, @Body body: SaveRequest): SaveResult

    @POST("api/repos/{repo}/file")
    suspend fun createFile(@Path("repo") repo: String, @Body body: SaveRequest): CreateResult

    @DELETE("api/repos/{repo}/file")
    suspend fun deleteFile(@Path("repo") repo: String, @Query("path") path: String): DeleteResult

    @POST("api/repos/{repo}/rename")
    suspend fun rename(@Path("repo") repo: String, @Body body: RenameRequest): RenameResult

    @POST("api/repos/{repo}/stage")
    suspend fun stage(@Path("repo") repo: String, @Body body: PathsRequest): StageResult

    @POST("api/repos/{repo}/commit")
    suspend fun commit(@Path("repo") repo: String, @Body body: CommitRequest): CommitResult

    // DELETE with a body isn't idiomatic; discard uses POST.
    @HTTP(method = "POST", path = "api/repos/{repo}/discard", hasBody = true)
    suspend fun discard(@Path("repo") repo: String, @Body body: PathsRequest): DiscardResult
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

// ---- edit request/response DTOs ----

@Serializable
data class WorkingFile(
    val path: String,
    val size: Long,
    val truncated: Boolean,
    val encoding: String,
    val binary: Boolean = false,
    val content: String? = null,
)

@Serializable data class SaveRequest(val path: String, val content: String, val encoding: String = "utf-8")
@Serializable data class SaveResult(val path: String, val size: Long, val savedAt: String)
@Serializable data class CreateResult(val path: String, val created: Boolean)
@Serializable data class DeleteResult(val path: String, val removed: Boolean)

@Serializable data class RenameRequest(val from: String, val to: String)
@Serializable data class RenameResult(val from: String, val to: String)

@Serializable data class PathsRequest(val paths: List<String>)
@Serializable data class StageResult(val staged: List<String>)
@Serializable data class DiscardResult(val discarded: List<String>)

@Serializable data class CommitRequest(val message: String, val paths: List<String>? = null)
@Serializable data class CommitResult(val committed: Boolean, val output: String)
