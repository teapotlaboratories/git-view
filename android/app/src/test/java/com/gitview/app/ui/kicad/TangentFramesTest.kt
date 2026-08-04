package com.gitview.app.ui.kicad

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Tangent frames for Filament (ADR-038, Phase 4a.3).
 *
 * This exists because the failure mode is invisible. Filament's `TANGENTS` attribute is a quaternion,
 * not a normal; getting it wrong still produces a picture, just one that is lit incorrectly — and
 * "incorrectly lit" is not something a build, a test suite, or a glance at an emulator reliably catches.
 *
 * So the property under test is the one the shader actually performs: rotating `+Z` by the frame must
 * give back the normal we started from.
 */
class TangentFramesTest {

    private fun assertRoundTrip(nx: Float, ny: Float, nz: Float) {
        val got = normalFromFrame(frameFromNormal(nx, ny, nz))
        val len = sqrt(nx * nx + ny * ny + nz * nz)
        for ((i, want) in listOf(nx / len, ny / len, nz / len).withIndex()) {
            assertEquals("axis $i for normal ($nx, $ny, $nz)", want, got[i], 1e-4f)
        }
    }

    @Test
    fun `the six axis normals round-trip`() {
        // Every face of a box. These are exactly the normals a fixed seed axis gets wrong: whichever
        // face is parallel to the seed yields a zero-length tangent and renders black.
        assertRoundTrip(1f, 0f, 0f); assertRoundTrip(-1f, 0f, 0f)
        assertRoundTrip(0f, 1f, 0f); assertRoundTrip(0f, -1f, 0f)
        assertRoundTrip(0f, 0f, 1f); assertRoundTrip(0f, 0f, -1f)
    }

    @Test
    fun `arbitrary directions round-trip`() {
        var seed = 12345
        repeat(400) {
            // A cheap deterministic LCG: reproducible, and no dependency on a test-only random source.
            fun next(): Float { seed = seed * 1103515245 + 12345; return ((seed ushr 8) % 20001) / 10000f - 1f }
            val x = next(); val y = next(); val z = next()
            if (sqrt(x * x + y * y + z * z) > 1e-3f) assertRoundTrip(x, y, z)
        }
    }

    @Test
    fun `the quaternion is unit length and right-handed`() {
        // Filament reads handedness from the sign of w. A frame that comes back left-handed flips the
        // surface, so a part lights as though seen from inside.
        for (n in listOf(
            floatArrayOf(0f, 0f, 1f), floatArrayOf(0f, 0f, -1f),
            floatArrayOf(0.577f, 0.577f, 0.577f), floatArrayOf(-0.267f, 0.535f, -0.802f),
        )) {
            val q = frameFromNormal(n[0], n[1], n[2])
            val len = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
            assertEquals("unit quaternion", 1f, len, 1e-4f)
            assertTrue("w must be non-negative for a right-handed frame, got ${q[3]}", q[3] >= 0f)
        }
    }

    @Test
    fun `a degenerate normal yields identity rather than NaN`() {
        // Tessellators do emit zero-length normals on degenerate triangles. NaN in a vertex buffer takes
        // out the whole draw call, not just that vertex.
        for (q in listOf(frameFromNormal(0f, 0f, 0f), frameFromNormal(1e-20f, 0f, 0f))) {
            assertTrue("no NaN", q.none { it.isNaN() })
            assertEquals(1f, q[3], 1e-6f)
        }
    }

    @Test
    fun `a mesh without normals gets identity frames, not garbage`() {
        val frames = tangentFrames(null, 3)
        assertEquals(12, frames.size)
        for (v in 0 until 3) {
            assertEquals("w", 1f, frames[v * 4 + 3], 1e-6f)
            assertEquals("x", 0f, frames[v * 4], 1e-6f)
        }
    }

    @Test
    fun `a truncated normal array is treated as absent rather than read past the end`() {
        // The array comes from a parsed .glb. `GlbReader` already rejects a mismatch, but this is the
        // last place before a native buffer, and an over-read here is not a Kotlin exception.
        val frames = tangentFrames(FloatArray(3) { 1f }, vertexCount = 8)
        assertEquals(32, frames.size)
        assertTrue("all identity", (0 until 8).all { abs(frames[it * 4 + 3] - 1f) < 1e-6f })
    }

    @Test
    fun `every frame in a real mesh round-trips`() {
        // Against geometry the bridge actually produced, rather than normals invented here.
        val bytes = checkNotNull(javaClass.classLoader!!.getResourceAsStream("two-primitives.glb")).readBytes()
        val model = (readGlb(bytes) as GlbResult.Ok).model
        val p = model.primitives.first { it.normals != null }
        val frames = tangentFrames(p.normals, p.positions.size / 3)
        for (v in 0 until p.positions.size / 3) {
            val q = floatArrayOf(frames[v * 4], frames[v * 4 + 1], frames[v * 4 + 2], frames[v * 4 + 3])
            val got = normalFromFrame(q)
            for (a in 0..2) assertEquals("vertex $v axis $a", p.normals!![v * 3 + a], got[a], 1e-4f)
        }
    }
}
