package com.gitview.app.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Wire compatibility across independently-versioned app and bridge (ADR-038).
 *
 * `.ai/AGENTS.md` states app-only and bridge-only releases are normal, so a new app *will* meet an old
 * bridge. This pins the one field where that difference is fatal rather than cosmetic: a v0.1.14 bridge
 * sends a text primitive's font size as a bare `size`, and a strict decoder meeting `1.5` where it wants
 * `[w, h]` throws — losing the entire layer, which is the bug the rename was meant to end.
 */
class WireCompatTest {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Test
    fun `a scalar size from an older bridge decodes instead of killing the layer`() {
        val old = """{"layer":"F.Cu","primitives":[
            {"t":"text","at":[1.0,2.0],"s":"HELLO","size":1.5,"layer":"F.Cu"},
            {"t":"track","a":[0.0,0.0],"b":[1.0,1.0],"w":0.2,"layer":"F.Cu"}
        ]}"""
        val layer = json.decodeFromString(KicadBoardLayer.serializer(), old)
        assertEquals("both primitives survive — this used to throw and lose all of them", 2, layer.primitives.size)
        assertEquals(listOf(1.5), layer.primitives[0].size)
    }

    @Test
    fun `a pad's paired size still decodes as a pair`() {
        val cur = """{"layer":"F.Cu","primitives":[
            {"t":"pad","at":[1.0,2.0],"size":[1.2,1.3],"layer":"F.Cu"}
        ]}"""
        val layer = json.decodeFromString(KicadBoardLayer.serializer(), cur)
        assertEquals(listOf(1.2, 1.3), layer.primitives[0].size)
    }

    @Test
    fun `a current bridge's fontSize decodes and leaves size absent`() {
        val cur = """{"layer":"F.Cu","primitives":[
            {"t":"text","at":[1.0,2.0],"s":"HI","fontSize":1.5,"layer":"F.Cu"}
        ]}"""
        val layer = json.decodeFromString(KicadBoardLayer.serializer(), cur)
        assertEquals(1.5, layer.primitives[0].fontSize!!, 1e-9)
        assertNull(layer.primitives[0].size)
    }
}
