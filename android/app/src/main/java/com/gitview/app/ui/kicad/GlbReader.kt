package com.gitview.app.ui.kicad

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Reading the `.glb` the bridge serves (ADR-038, Phase 4a).
 *
 * Deliberately **not** a general glTF loader. We generate these files ourselves in
 * `bridge/src/kicad/glb.ts`, so their shape is known: one buffer, one mesh, N primitives, `POSITION` and
 * optional `NORMAL` as float32 `VEC3`, indices as uint32 `SCALAR`, and an optional `baseColorFactor`.
 * A general loader for that is 11 MB of `gltfio` — measured against a 21.3 MB APK — to read a format we
 * control both ends of.
 *
 * What it must nonetheless do is **distrust the bytes**. They arrive over the network, and a truncated
 * download or a corrupted cache entry must produce a refusal rather than an out-of-bounds read: every
 * offset and length here is checked against the buffer it indexes, and every failure is a `null` with a
 * reason rather than an exception escaping into a composable.
 */

/** One drawable solid: triangles, and the colour the STEP file gave it. */
data class GlbPrimitive(
    /** Interleaved XYZ, three floats per vertex. */
    val positions: FloatArray,
    /** Interleaved XYZ normals, or null — a renderer can compute face normals instead. */
    val normals: FloatArray?,
    /** Triangle indices into [positions]. */
    val indices: IntArray,
    /** Linear RGB in 0..1 when the source carried one. */
    val color: Triple<Float, Float, Float>?,
) {
    val triangleCount: Int get() = indices.size / 3

    // Arrays in a data class need these spelled out; the generated ones compare by identity.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is GlbPrimitive) return false
        return positions.contentEquals(other.positions) &&
            (normals?.contentEquals(other.normals ?: FloatArray(0)) ?: (other.normals == null)) &&
            indices.contentEquals(other.indices) && color == other.color
    }

    override fun hashCode(): Int =
        positions.contentHashCode() * 31 + indices.contentHashCode() + (color?.hashCode() ?: 0)
}

data class GlbModel(
    val primitives: List<GlbPrimitive>,
    /** Axis-aligned bounds over every primitive, from the file's own accessor min/max. */
    val min: FloatArray,
    val max: FloatArray,
) {
    val triangleCount: Int get() = primitives.sumOf { it.triangleCount }

    override fun equals(other: Any?): Boolean =
        other is GlbModel && primitives == other.primitives &&
            min.contentEquals(other.min) && max.contentEquals(other.max)

    override fun hashCode(): Int = primitives.hashCode() * 31 + min.contentHashCode()
}

/** Why a `.glb` could not be read. Surfaced so the UI can say something truer than "failed". */
sealed interface GlbResult {
    data class Ok(val model: GlbModel) : GlbResult
    data class Failed(val reason: String) : GlbResult
}

private const val GLB_MAGIC = 0x46546C67   // "glTF"
private const val CHUNK_JSON = 0x4E4F534A
private const val CHUNK_BIN = 0x004E4942
private const val FLOAT = 5126
private const val UINT32 = 5125
private const val UINT16 = 5123

private val lenientJson = Json { ignoreUnknownKeys = true }

/**
 * Parse a `.glb`.
 *
 * Never throws: every failure path returns [GlbResult.Failed]. A malformed model is a thing to report
 * next to the board, not a crash in the middle of a render pass.
 */
fun readGlb(bytes: ByteArray): GlbResult {
    fun fail(why: String) = GlbResult.Failed(why)
    if (bytes.size < 20) return fail("too short to be a glb")
    val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    if (b.getInt(0) != GLB_MAGIC) return fail("not a glb")
    // The declared length is checked against the real one: a truncated download otherwise reads as a
    // valid header followed by whatever arrived.
    if (b.getInt(8) != bytes.size) return fail("length header disagrees with the file")

    val jsonLen = b.getInt(12)
    if (b.getInt(16) != CHUNK_JSON) return fail("first chunk is not JSON")
    if (20L + jsonLen > bytes.size) return fail("JSON chunk overruns the file")
    val gltf = try {
        lenientJson.parseToJsonElement(String(bytes, 20, jsonLen, Charsets.UTF_8)).jsonObject
    } catch (e: Exception) {
        return fail("JSON chunk is unreadable")
    }

    // The BIN chunk follows the JSON one. Absent is legal glTF but useless to us — every accessor here
    // points into it.
    var bin: Int = -1
    var binLen = 0
    val binHeader = 20 + jsonLen
    if (binHeader + 8 <= bytes.size && b.getInt(binHeader + 4) == CHUNK_BIN) {
        binLen = b.getInt(binHeader)
        bin = binHeader + 8
    }
    if (bin < 0) return fail("no binary chunk")
    if (bin.toLong() + binLen > bytes.size) return fail("binary chunk overruns the file")

    val accessors = gltf["accessors"]?.jsonArray ?: return fail("no accessors")
    val views = gltf["bufferViews"]?.jsonArray ?: return fail("no bufferViews")
    val materials = gltf["materials"]?.jsonArray

    /** Byte range of an accessor, checked against the binary chunk before anything reads it. */
    fun range(accessorIndex: Int, expectStride: Int): Triple<Int, Int, Int>? {
        val a = accessors.getOrNull(accessorIndex)?.jsonObject ?: return null
        val count = a["count"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
        val type = a["componentType"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
        val vi = a["bufferView"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
        val v = views.getOrNull(vi)?.jsonObject ?: return null
        val off = v["byteOffset"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
        val len = v["byteLength"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
        val start = bin + off
        // Both halves matter: the view must fit the chunk, and the accessor must fit the view.
        if (off < 0 || len < 0 || off.toLong() + len > binLen) return null
        if (count.toLong() * expectStride > len) return null
        return Triple(start, count, type)
    }

    fun floats(accessorIndex: Int): FloatArray? {
        val (start, count, type) = range(accessorIndex, 12) ?: return null
        if (type != FLOAT) return null
        val out = FloatArray(count * 3)
        for (i in out.indices) out[i] = b.getFloat(start + i * 4)
        return out
    }

    fun ints(accessorIndex: Int): IntArray? {
        val a = accessors.getOrNull(accessorIndex)?.jsonObject ?: return null
        val type = a["componentType"]?.jsonPrimitive?.content?.toIntOrNull() ?: return null
        val stride = when (type) { UINT32 -> 4; UINT16 -> 2; else -> return null }
        val (start, count, _) = range(accessorIndex, stride) ?: return null
        val out = IntArray(count)
        // uint16 is accepted as well as the uint32 we emit: it is a legal narrowing a future writer might
        // choose, and reading it costs one branch.
        for (i in out.indices) {
            out[i] = if (stride == 4) b.getInt(start + i * 4) else (b.getShort(start + i * 2).toInt() and 0xFFFF)
        }
        return out
    }

    val primitives = mutableListOf<GlbPrimitive>()
    val min = floatArrayOf(Float.MAX_VALUE, Float.MAX_VALUE, Float.MAX_VALUE)
    val max = floatArrayOf(-Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE)

    for (mesh in gltf["meshes"]?.jsonArray.orEmpty()) {
        for (p in mesh.jsonObject["primitives"]?.jsonArray.orEmpty()) {
            val po = p.jsonObject
            val attrs = po["attributes"]?.jsonObject ?: continue
            val posIdx = attrs["POSITION"]?.jsonPrimitive?.content?.toIntOrNull() ?: continue
            val idxIdx = po["indices"]?.jsonPrimitive?.content?.toIntOrNull() ?: continue
            val positions = floats(posIdx) ?: return fail("POSITION accessor is out of bounds")
            val indices = ints(idxIdx) ?: return fail("index accessor is out of bounds")
            // An index past the end of the vertex array would be an out-of-bounds read in the renderer,
            // which is the one failure that would not be visible as a failure.
            val vertexCount = positions.size / 3
            if (indices.any { it < 0 || it >= vertexCount }) return fail("an index points outside the mesh")

            val normals = attrs["NORMAL"]?.jsonPrimitive?.content?.toIntOrNull()?.let { floats(it) }
                ?.takeIf { it.size == positions.size }

            val color = po["material"]?.jsonPrimitive?.content?.toIntOrNull()
                ?.let { materials?.getOrNull(it)?.jsonObject }
                ?.get("pbrMetallicRoughness")?.jsonObject?.get("baseColorFactor")?.jsonArray
                ?.takeIf { it.size >= 3 }
                ?.let {
                    Triple(
                        it[0].jsonPrimitive.content.toFloatOrNull() ?: 1f,
                        it[1].jsonPrimitive.content.toFloatOrNull() ?: 1f,
                        it[2].jsonPrimitive.content.toFloatOrNull() ?: 1f,
                    )
                }

            for (i in positions.indices step 3) {
                for (a in 0..2) {
                    val v = positions[i + a]
                    if (v < min[a]) min[a] = v
                    if (v > max[a]) max[a] = v
                }
            }
            primitives += GlbPrimitive(positions, normals, indices, color)
        }
    }

    if (primitives.isEmpty()) return fail("no drawable geometry")
    return GlbResult.Ok(GlbModel(primitives, min, max))
}
