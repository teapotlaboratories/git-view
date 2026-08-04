package com.gitview.app.ui.kicad

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading the `.glb` the bridge serves (ADR-038, Phase 4a).
 *
 * The fixture is **not hand-written here** — `two-primitives.glb` was produced by the bridge's own
 * `buildGlb`, so these tests check that the writer and the reader actually agree. A reader tested only
 * against bytes this file invented would pass happily while disagreeing with the thing on the other end
 * of the wire, which is the only disagreement that can actually happen.
 *
 * The rest is refusal: these bytes arrive over a network, and a truncated download or a corrupted cache
 * entry must produce a reported failure rather than an out-of-bounds read inside a render pass.
 */
class GlbReaderTest {

    private fun fixture(): ByteArray =
        checkNotNull(javaClass.classLoader!!.getResourceAsStream("two-primitives.glb")) {
            "fixture missing — regenerate with the bridge's buildGlb"
        }.readBytes()

    private fun ok(bytes: ByteArray): GlbModel =
        (readGlb(bytes) as? GlbResult.Ok)?.model ?: error("expected a readable glb")

    private fun why(bytes: ByteArray): String =
        (readGlb(bytes) as? GlbResult.Failed)?.reason ?: error("expected a refusal, got a model")

    @Test
    fun `reads what the bridge wrote`() {
        val m = ok(fixture())
        assertEquals("both solids survive as separate primitives", 2, m.primitives.size)
        assertEquals("1 triangle + 2 triangles", 3, m.triangleCount)
        assertEquals(3, m.primitives[0].positions.size / 3)
        assertEquals(4, m.primitives[1].positions.size / 3)
    }

    @Test
    fun `carries normals and per-part colour across`() {
        val m = ok(fixture())
        assertNotNull("the writer emitted normals", m.primitives[0].normals)
        assertEquals(m.primitives[0].positions.size, m.primitives[0].normals!!.size)
        // The colour a STEP file gave the part. Losing it silently would render every part the same shade
        // and look like a deliberate style rather than dropped data.
        val c = assertNotNull("baseColorFactor should survive", m.primitives[0].color).let { m.primitives[0].color!! }
        assertEquals(0.25f, c.first, 1e-6f)
        assertEquals(0.5f, c.second, 1e-6f)
        assertEquals(0.75f, c.third, 1e-6f)
        assertNull("and a part without a material stays uncoloured", m.primitives[1].color)
    }

    @Test
    fun `bounds come out of the geometry`() {
        val m = ok(fixture())
        assertEquals(0f, m.min[0], 1e-6f)
        assertEquals(1f, m.max[0], 1e-6f)
        assertEquals(0f, m.min[2], 1e-6f)
        assertEquals(2f, m.max[2], 1e-6f)   // the second solid sits at z=2
    }

    @Test
    fun `a truncated download is refused, not half-read`() {
        // The realistic corruption: a connection dropped mid-body. The header still says how long the file
        // should be, which is why that is checked against the bytes actually present.
        val full = fixture()
        assertTrue(why(full.copyOf(full.size - 40)).contains("length", ignoreCase = true))
        assertEquals("too short to be a glb", why(full.copyOf(8)))
    }

    @Test
    fun `something that is not a glb is refused`() {
        assertEquals("not a glb", why(ByteArray(64) { 0x41 }))
        // An HTML error page from a proxy is the classic thing to receive where a mesh was expected.
        assertEquals("not a glb", why("<!doctype html><title>502</title>".toByteArray().copyOf(64)))
    }

    @Test
    fun `a corrupted JSON chunk is refused`() {
        val bad = fixture().clone()
        bad[20] = 'A'.code.toByte()   // structurally, at the opening brace
        assertEquals("JSON chunk is unreadable", why(bad))
    }

    @Test
    fun `an index pointing outside the mesh is refused`() {
        // The one corruption that would NOT look like a failure: the renderer would read past the vertex
        // array and draw whatever was next in memory. Every other bad-file case fails loudly on its own.
        val bytes = fixture().clone()
        val text = String(bytes, Charsets.UTF_8)
        val binStart = text.indexOf("BIN")
        assertTrue("fixture layout changed", binStart > 0)
        // The first primitive's indices are the third accessor's view; rather than locate it exactly, flip
        // the last four bytes of the file, which lie inside the final index buffer.
        for (i in 1..4) bytes[bytes.size - i] = 0x7F
        assertEquals("an index points outside the mesh", why(bytes))
    }

    @Test
    fun `an empty model is refused rather than returned as nothing to draw`() {
        // A file that parses but contains no geometry would otherwise reach the renderer as a blank
        // viewport, which is indistinguishable from a bug in the renderer.
        val empty = """{"asset":{"version":"2.0"},"meshes":[{"primitives":[]}],"accessors":[],"bufferViews":[],"buffers":[{"byteLength":4}]}"""
        val json = empty.toByteArray(Charsets.UTF_8)
        val pad = (4 - json.size % 4) % 4
        val jsonLen = json.size + pad
        val total = 12 + 8 + jsonLen + 8 + 4
        val out = java.nio.ByteBuffer.allocate(total).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        out.putInt(0x46546C67); out.putInt(2); out.putInt(total)
        out.putInt(jsonLen); out.putInt(0x4E4F534A); out.put(json); repeat(pad) { out.put(0x20) }
        out.putInt(4); out.putInt(0x004E4942); out.putInt(0)
        assertEquals("no drawable geometry", why(out.array()))
    }
}
