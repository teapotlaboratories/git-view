package com.gitview.app.ui.kicad

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The KiCad tab's two rules (ADR-038).
 *
 * Every case here is one that shipped wrong, not one that was imagined: the extension check governs
 * whether a 66 MB board gets downloaded as a string, and the layer selection governs whether a refresh
 * keeps or discards what the user chose to look at.
 */
class KicadTabRulesTest {

    @Test
    fun `recognises both KiCad file types, whatever the case`() {
        assertTrue(isKicadPath("hw/board.kicad_pcb"))
        assertTrue(isKicadPath("hw/sheet.kicad_sch"))
        assertTrue(isKicadPath("HW/BOARD.KICAD_PCB"))
    }

    @Test
    fun `does not claim files that merely look related`() {
        // Each of these would be silently emptied if it matched: the tab would skip the blob fetch and
        // then have no drawing to show either, because the bridge cannot build a scene from them.
        for (p in listOf(
            "hw/board.kicad_pro",     // project file — real, adjacent, not drawable
            "hw/board.kicad_prl",
            "hw/fp-lib-table",
            "docs/kicad_pcb.md",      // the extension as a *name*
            "hw/board.kicad_pcb.bak",
            "README.md",
        )) {
            assertFalse(p, isKicadPath(p))
        }
    }

    @Test
    fun `a first open shows the outline`() {
        val live = setOf("Edge.Cuts", "F.Cu", "B.Cu", "F.SilkS")
        assertEquals(setOf("Edge.Cuts"), boardLayersToShow(live, previouslyShown = null, probing = false))
    }

    @Test
    fun `a first open while probing a net also shows copper`() {
        // A cross-probe that arrives at a board showing only its outline has highlighted nothing the
        // user can see — the net is on the copper layers.
        val live = setOf("Edge.Cuts", "F.Cu", "In1.Cu", "B.Cu", "F.SilkS")
        assertEquals(
            setOf("Edge.Cuts", "F.Cu", "In1.Cu", "B.Cu"),
            boardLayersToShow(live, previouslyShown = null, probing = true),
        )
    }

    @Test
    fun `a first open only offers layers that actually carry something`() {
        // The index reports every layer the board declares; `live` is already filtered to those with a
        // non-zero count. A board with no copper must not come back claiming copper.
        assertEquals(
            setOf("Edge.Cuts"),
            boardLayersToShow(setOf("Edge.Cuts"), previouslyShown = null, probing = true),
        )
    }

    @Test
    fun `a re-solve keeps the layers the user picked`() {
        // The bug this pins: saving the board re-solved the tab and reset it to the outline, throwing
        // away the user's selection for a reason that had nothing to do with it.
        val live = setOf("Edge.Cuts", "F.Cu", "B.Cu", "F.SilkS")
        assertEquals(
            setOf("F.Cu", "F.SilkS"),
            boardLayersToShow(live, previouslyShown = setOf("F.Cu", "F.SilkS"), probing = false),
        )
    }

    @Test
    fun `a re-solve drops a layer the edit emptied`() {
        // The other half of the same rule. Keeping the selection verbatim would leave a chip lit for a
        // layer that no longer has anything on it, and a request for it would come back empty.
        assertEquals(
            setOf("F.Cu"),
            boardLayersToShow(setOf("Edge.Cuts", "F.Cu"), previouslyShown = setOf("F.Cu", "B.Cu"), probing = false),
        )
    }

    @Test
    fun `probing does not re-add copper on a re-solve`() {
        // Probing is a first-open default, not a standing override. If the user turned copper off and
        // then the file changed, turning it back on would be the app arguing with them.
        val live = setOf("Edge.Cuts", "F.Cu", "B.Cu")
        assertEquals(
            setOf("Edge.Cuts"),
            boardLayersToShow(live, previouslyShown = setOf("Edge.Cuts"), probing = true),
        )
    }

    @Test
    fun `a re-solve that empties everything yields an empty set, not the first-open default`() {
        // An empty selection is a legitimate state — the user turned everything off. It must not be
        // confused with "no selection yet", which is what `null` means.
        assertEquals(
            emptySet<String>(),
            boardLayersToShow(setOf("Edge.Cuts", "F.Cu"), previouslyShown = emptySet(), probing = false),
        )
    }
}

/**
 * The pinch-zoom rule (ADR-038).
 *
 * Shipped wrong in v0.1.14: scaling about the canvas origin rather than the pinch centroid made the board
 * accelerate off-screen, and one pinch on a large board left an empty canvas. It is pure arithmetic, so it
 * is asserted here rather than left to be noticed on a device.
 */
class ZoomAboutTest {

    @org.junit.Test
    fun `the point under the fingers stays under the fingers`() {
        // The whole property. If this holds, zoom feels anchored; if it does not, the board runs away.
        for (z in listOf(1.2f, 0.8f, 2f, 0.5f)) {
            val (ox, oy, s) = zoomAbout(300f, 400f, offsetX = -50f, offsetY = 20f, scale = 3f, zoom = z, panX = 0f, panY = 0f)
            // board-space point under the centroid, before and after
            val beforeX = (300f - (-50f)) / 3f
            val afterX = (300f - ox) / s
            assertEquals("x anchored at zoom $z", beforeX, afterX, 1e-3f)
            val beforeY = (400f - 20f) / 3f
            val afterY = (400f - oy) / s
            assertEquals("y anchored at zoom $z", beforeY, afterY, 1e-3f)
        }
    }

    @org.junit.Test
    fun `pan still translates`() {
        val (ox, oy, _) = zoomAbout(0f, 0f, 10f, 10f, scale = 1f, zoom = 1f, panX = 25f, panY = -15f)
        assertEquals(35f, ox, 1e-3f)
        assertEquals(-5f, oy, 1e-3f)
    }

    @org.junit.Test
    fun `scale is clamped at both ends`() {
        assertEquals(MAX_BOARD_SCALE, zoomAbout(0f, 0f, 0f, 0f, scale = 60f, zoom = 100f, panX = 0f, panY = 0f).third, 1e-3f)
        assertEquals(MIN_BOARD_SCALE, zoomAbout(0f, 0f, 0f, 0f, scale = 0.1f, zoom = 0.001f, panX = 0f, panY = 0f).third, 1e-3f)
    }

    @org.junit.Test
    fun `a degenerate scale is refused rather than dividing by zero`() {
        // `scale` starts at 0 before the first layout pass, and a gesture can arrive first.
        val (ox, oy, s) = zoomAbout(100f, 100f, 5f, 6f, scale = 0f, zoom = 2f, panX = 1f, panY = 1f)
        assertEquals(5f, ox, 1e-6f); assertEquals(6f, oy, 1e-6f); assertEquals(0f, s, 1e-6f)
    }
}

/**
 * Picking the part under a long-press (ADR-038, Phase 4a.3).
 *
 * Kept apart from net hit-testing because the two search different things: a net lives on drawables on
 * *visible* layers, a part lives at its placement whether or not any layer showing it is switched on.
 */
class NearestPartTest {

    private fun c(ref: String, x: Double, y: Double, vararg models: String) =
        com.gitview.app.data.BoardComponent(ref = ref, at = listOf(x, y), models = models.toList())

    private val ready = { m: String -> m.startsWith("ok:") }

    @org.junit.Test
    fun `picks the closest component that has a mesh`() {
        val got = nearestPart(
            listOf(c("R1", 0.0, 0.0, "ok:a"), c("R2", 3.0, 0.0, "ok:b")),
            x = 2.6f, y = 0f, tolerance = 5f, hasModel = ready,
        )
        assertEquals("R2" to "ok:b", got)
    }

    @org.junit.Test
    fun `skips components whose model has no mesh, rather than offering an empty viewer`() {
        // On vme-wren only 164 of 1,508 placements have a mesh. Returning the nearest *component* would
        // usually open a viewer with nothing in it, which reads as a broken feature rather than an
        // unconverted part.
        val got = nearestPart(
            listOf(c("U1", 0.0, 0.0, "missing:x"), c("R9", 4.0, 0.0, "ok:y")),
            x = 0.1f, y = 0f, tolerance = 10f, hasModel = ready,
        )
        assertEquals("R9" to "ok:y", got)
    }

    @org.junit.Test
    fun `respects the tolerance`() {
        assertNull(nearestPart(listOf(c("R1", 50.0, 50.0, "ok:a")), 0f, 0f, 5f, ready))
    }

    @org.junit.Test
    fun `ignores components with no models and malformed positions`() {
        assertNull(nearestPart(listOf(c("TP1", 0.0, 0.0)), 0f, 0f, 5f, ready))
        val noPos = com.gitview.app.data.BoardComponent(ref = "X", at = emptyList(), models = listOf("ok:a"))
        assertNull(nearestPart(listOf(noPos), 0f, 0f, 5f, ready))
    }

    @org.junit.Test
    fun `picks the first model of a multi-model part that is actually ready`() {
        // A connector with a separate shroud has several models and they convert independently.
        val got = nearestPart(listOf(c("J1", 0.0, 0.0, "missing:shroud", "ok:body")), 0f, 0f, 5f, ready)
        assertEquals("J1" to "ok:body", got)
    }
}
