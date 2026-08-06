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

/**
 * The 3D viewer's palette (ADR-038, Phase 4a.3).
 *
 * Both colours were constants, so the viewport was the same grey on every profile: an unpainted part
 * measured 2.4:1 against it on Color E-Ink and 3.5:1 on Standard dark, in a UI running near 20:1. The
 * guarantee asserted here is the one the old code could not make — that the fallback part contrasts
 * with the backdrop whatever theme the viewer is dropped into.
 */
class ViewerPaletteTest {

    /** Relative luminance of a linear neutral grey is the component itself. */
    private fun lumOfLinearGrey(c: Triple<Float, Float, Float>) = c.first

    private fun backdropLuminance(p: ViewerPalette): Float {
        val (r, g, b) = p.backdrop
        return relativeLuminance(linearToSrgbComponent(r), linearToSrgbComponent(g), linearToSrgbComponent(b))
    }

    @org.junit.Test
    fun `an unpainted part clears the contrast floor on any ground`() {
        // The whole property, swept rather than sampled — including the mid greys where a
        // threshold-based rule collapses.
        var checked = 0
        for (i in 0..20) {
            val v = i / 20f
            for (ground in listOf(
                Triple(v, v, v),                       // neutral
                Triple(v, v * 0.9f, v * 0.8f),         // warm
                Triple(v * 0.8f, v * 0.9f, v),         // cool
            )) {
                val p = viewerPalette(ground.first, ground.second, ground.third)
                val ratio = contrastRatio(lumOfLinearGrey(p.part), backdropLuminance(p))
                assertTrue(
                    "ground=$ground gave ${"%.2f".format(ratio)}:1",
                    ratio >= VIEWER_MIN_CONTRAST - 0.01f,
                )
                checked++
            }
        }
        assertEquals("the sweep must actually run", 63, checked)
    }

    @org.junit.Test
    fun `the mid-grey backdrop that a luminance threshold gets wrong`() {
        // Pinning the trap the implementation comment describes. A rule of "light part below 0.5
        // luminance, dark above" sends a ground just under the line to the light branch, which lands
        // near 1.4:1 — worse than the 2.4:1 bug this replaced. Solving for the ratio avoids it.
        val ground = Triple(0.72f, 0.72f, 0.72f)   // relative luminance just under 0.5
        assertTrue("fixture must sit below the threshold", relativeLuminance(0.72f, 0.72f, 0.72f) < 0.5f)
        val p = viewerPalette(ground.first, ground.second, ground.third)
        val ratio = contrastRatio(lumOfLinearGrey(p.part), backdropLuminance(p))
        assertTrue("a threshold rule would give ~1.4:1 here, got ${"%.2f".format(ratio)}:1", ratio >= 4.4f)
    }

    @org.junit.Test
    fun `a dark theme keeps a dark backdrop and puts a lighter part on it`() {
        // Standard dark: #191a23-ish. The viewport must not invert to white just because the rule now
        // reads the theme. Direction is asserted rather than a magic number — these are LINEAR values,
        // where 0.32 is already a light grey (sRGB ~0.60), so a 0.5 threshold here means nothing.
        val p = viewerPalette(0.098f, 0.102f, 0.137f)
        assertTrue("backdrop should stay dark", backdropLuminance(p) < 0.25f)
        assertTrue("part must be lighter than its ground", lumOfLinearGrey(p.part) > backdropLuminance(p))
    }

    @org.junit.Test
    fun `the e-ink profile gets a paper backdrop and a darker part`() {
        // The case that prompted this: a white ground must produce a near-white viewport with a dark
        // part, not the dark-theme slab.
        val p = viewerPalette(1f, 1f, 1f)
        assertTrue("backdrop should read as paper", backdropLuminance(p) > 0.7f)
        assertTrue("part must be darker than paper", lumOfLinearGrey(p.part) < backdropLuminance(p))
    }

    @org.junit.Test
    fun `the dark theme is not made worse than the constant it replaced`() {
        // The regression this change shipped once and had to be measured to catch. Solving for the
        // 4.5 floor pulled the dark theme's part from 0.62 down to 0.315 — still "passing" the floor
        // while rendering at 2.86:1 on the tablet, against 3.50:1 before the fix. A minimum is a
        // guarantee to clear, not a number to land on.
        val p = viewerPalette(0.098f, 0.102f, 0.137f)
        assertEquals(
            "the dark theme must keep the light part it already had",
            PART_LIGHT, lumOfLinearGrey(p.part), 1e-6f,
        )
        assertTrue(
            "and clear the floor with room to spare, not sit on it",
            contrastRatio(lumOfLinearGrey(p.part), backdropLuminance(p)) > VIEWER_MIN_CONTRAST + 1f,
        )
    }

    @org.junit.Test
    fun `the two profiles land on opposite sides, which is the whole point`() {
        // Guards the regression directly: before this, both profiles got the SAME backdrop, so the
        // e-ink one sat at 2.4:1. If a future change re-flattens them, this fails rather than the
        // difference going unnoticed on a screenshot.
        val dark = viewerPalette(0.098f, 0.102f, 0.137f)
        val paper = viewerPalette(1f, 1f, 1f)
        assertTrue(
            "the two backdrops must differ, not share one constant",
            backdropLuminance(paper) - backdropLuminance(dark) > 0.5f,
        )
        assertTrue("dark theme takes a lighter part", lumOfLinearGrey(dark.part) > backdropLuminance(dark))
        assertTrue("paper takes a darker part", lumOfLinearGrey(paper.part) < backdropLuminance(paper))
    }

    @org.junit.Test
    fun `the backdrop keeps the theme hue rather than flattening to grey`() {
        // A tinted surface should stay tinted; collapsing every theme to neutral grey is the thing
        // being fixed, so a fix that flattens differently is no better.
        val p = viewerPalette(0.10f, 0.11f, 0.16f)
        assertTrue("blue channel should stay the largest", p.backdrop.third > p.backdrop.first)
    }

    @org.junit.Test
    fun `neither part colour is pushed to an extreme that flattens the shading`() {
        // Both directions of the same lesson. A part at 0.02 cleared 14:1 on e-ink and rendered as a
        // black silhouette with no visible facets — a worse picture at a better ratio. The floor is
        // what must be cleared; past that, the part has to still read as a solid.
        assertTrue("a light part must not blow out", PART_LIGHT <= 0.85f)
        assertTrue("a dark part must keep some shading headroom", PART_DARK >= 0.08f)
        // ...and the moderate dark must still clear the floor on the lightest possible ground.
        val paper = viewerPalette(1f, 1f, 1f)
        assertEquals("a white ground should take PART_DARK unmodified", PART_DARK, lumOfLinearGrey(paper.part), 1e-6f)
        assertTrue(
            "even so it must clear the floor",
            contrastRatio(lumOfLinearGrey(paper.part), backdropLuminance(paper)) >= VIEWER_MIN_CONTRAST,
        )
    }

    @org.junit.Test
    fun `the returned colours are in range and finite`() {
        for (v in listOf(0f, 0.5f, 1f)) {
            val p = viewerPalette(v, v, v)
            for (c in listOf(p.backdrop.first, p.backdrop.second, p.backdrop.third, p.part.first)) {
                assertTrue("component $c out of range for ground $v", c.isFinite() && c in 0f..1f)
            }
        }
    }
}

/**
 * Framing a part in the viewport (ADR-038, Phase 4a.3).
 *
 * `distance = radius * 3` shipped first and never mentioned the field of view or the viewport, so the
 * same part framed well in a tablet's wide pane and clipped at the edges of a phone's tall one. Both
 * were observed on real screens, which is why this is arithmetic with a test rather than a constant.
 */
class FitDistanceTest {

    private val fov = 45f

    @org.junit.Test
    fun `a wide viewport is limited by the vertical field of view`() {
        // When the viewport is wider than tall, the horizontal half-angle is the larger one, so the
        // vertical constrains the fit — distance follows radius / sin(vHalf).
        val d = fitDistance(radius = 10f, verticalFovDegrees = fov, aspect = 2f, margin = 1f)
        val vHalf = Math.toRadians((fov / 2).toDouble()).toFloat()
        assertEquals(10f / kotlin.math.sin(vHalf), d, 1e-3f)
    }

    @org.junit.Test
    fun `a tall viewport pulls the camera further back than the old formula did`() {
        // The bug, stated as a test: a phone-shaped viewport needs MORE distance than a wide one for the
        // same part, and more than the old flat `radius * 3`.
        val wide = fitDistance(10f, fov, aspect = 2.0f, margin = 1f)
        val tall = fitDistance(10f, fov, aspect = 0.45f, margin = 1f)
        assertTrue("a tall viewport must need more distance, got wide=$wide tall=$tall", tall > wide)
        assertTrue("and more than the old radius*3 = 30, got $tall", tall > 30f)
    }

    @org.junit.Test
    fun `distance scales linearly with the part`() {
        val small = fitDistance(1f, fov, 1f, margin = 1f)
        val big = fitDistance(10f, fov, 1f, margin = 1f)
        assertEquals("ten times the part, ten times the distance", small * 10f, big, 1e-3f)
    }

    @org.junit.Test
    fun `a degenerate viewport does not produce NaN or infinity`() {
        // `aspect` is 0 before the first layout pass, and a model can arrive first.
        for (a in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            val d = fitDistance(5f, fov, a)
            assertTrue("aspect=$a gave $d", d.isFinite() && d > 0f)
        }
    }

    @org.junit.Test
    fun `the margin leaves room around the part`() {
        val tight = fitDistance(10f, fov, 1f, margin = 1f)
        val roomy = fitDistance(10f, fov, 1f, margin = 1.15f)
        assertEquals(tight * 1.15f, roomy, 1e-3f)
    }
}
