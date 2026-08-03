package com.gitview.app.ui.kicad

import androidx.compose.ui.geometry.Offset
import com.gitview.app.data.BoardPrimitive
import com.gitview.app.data.KicadBoardLayer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Board hit-testing and selection (ADR-038, Phase 3).
 *
 * The schematic viewer shipped its hit-testing untested and a review caught it; this is the same logic on
 * the board side, so it gets tests in the same change rather than after someone points at the gap.
 *
 * What is actually at stake: `nearestNet` decides what a tap means on a board where 20,000 primitives can
 * be on screen. Getting "nearest" or "only tracks and pads carry nets" wrong produces a viewer that
 * selects the wrong net — which looks like the *solver* being wrong, and would be chased in the wrong file.
 */
class BoardHitTestTest {

    private fun track(x1: Double, y1: Double, x2: Double, y2: Double, net: String?) =
        BoardPrimitive(t = "track", a = listOf(x1, y1), b = listOf(x2, y2), w = 0.2, net = net)

    private fun via(x: Double, y: Double, net: String?) =
        BoardPrimitive(t = "via", at = listOf(x, y), d = 0.6, net = net)

    private fun pad(x: Double, y: Double, net: String?) =
        BoardPrimitive(t = "pad", at = listOf(x, y), size = listOf(1.0, 1.0), net = net)

    private fun layer(name: String, vararg p: BoardPrimitive) =
        name to KicadBoardLayer(layer = name, primitives = p.toList())

    @Test
    fun `a tap on a track selects its net`() {
        val layers = mapOf(layer("F.Cu", track(0.0, 0.0, 10.0, 0.0, "GND")))
        assertEquals("GND", nearestNet(layers, setOf("F.Cu"), Offset(5f, 0.2f), 1f))
    }

    @Test
    fun `a tap beyond the tolerance selects nothing`() {
        val layers = mapOf(layer("F.Cu", track(0.0, 0.0, 10.0, 0.0, "GND")))
        assertNull(nearestNet(layers, setOf("F.Cu"), Offset(5f, 40f), 1f))
    }

    @Test
    fun `distance is to the segment, not to its endpoints`() {
        // A long track is nearest along its whole length. Measuring to endpoints would make the middle of
        // every trace unselectable — which on a board is most of it.
        val layers = mapOf(layer("F.Cu", track(0.0, 0.0, 100.0, 0.0, "SIG")))
        assertEquals("SIG", nearestNet(layers, setOf("F.Cu"), Offset(50f, 0.1f), 1f))
    }

    @Test
    fun `the nearest of two competing nets wins`() {
        val layers = mapOf(
            layer("F.Cu", track(0.0, 0.0, 10.0, 0.0, "NEAR"), track(0.0, 5.0, 10.0, 5.0, "FAR")),
        )
        assertEquals("NEAR", nearestNet(layers, setOf("F.Cu"), Offset(5f, 0.5f), 8f))
        assertEquals("FAR", nearestNet(layers, setOf("F.Cu"), Offset(5f, 4.5f), 8f))
    }

    @Test
    fun `a hidden layer is not hit-tested`() {
        // Only what is drawn can be selected. Testing a layer the user has switched off would select
        // something invisible — the tap would appear to do nothing, or worse, the wrong thing.
        val layers = mapOf(layer("B.Cu", track(0.0, 0.0, 10.0, 0.0, "HIDDEN")))
        assertNull(nearestNet(layers, shown = emptySet(), p = Offset(5f, 0f), tolerance = 5f))
        assertEquals("HIDDEN", nearestNet(layers, setOf("B.Cu"), Offset(5f, 0f), 5f))
    }

    @Test
    fun `vias and pads carry nets too`() {
        val layers = mapOf(layer("F.Cu", via(20.0, 20.0, "VCC")))
        assertEquals("VCC", nearestNet(layers, setOf("F.Cu"), Offset(20f, 20f), 2f))
        val pads = mapOf(layer("F.Cu", pad(30.0, 30.0, "D0")))
        assertEquals("D0", nearestNet(pads, setOf("F.Cu"), Offset(30f, 30f), 2f))
    }

    @Test
    fun `a primitive with no net is never selected`() {
        // Silkscreen and the board outline have no net. Returning one for them would invent connectivity.
        val layers = mapOf(
            "F.SilkS" to KicadBoardLayer(
                layer = "F.SilkS",
                primitives = listOf(BoardPrimitive(t = "line", a = listOf(0.0, 0.0), b = listOf(10.0, 0.0))),
            ),
        )
        assertNull(nearestNet(layers, setOf("F.SilkS"), Offset(5f, 0f), 5f))
    }

    @Test
    fun `selection matches only primitives on its own net`() {
        val sel = BoardSelection("GND")
        assertTrue(sel.matches(track(0.0, 0.0, 1.0, 0.0, "GND")))
        assertTrue(sel.matches(via(0.0, 0.0, "GND")))
        assertTrue(!sel.matches(track(0.0, 0.0, 1.0, 0.0, "VCC")))
        assertTrue(!sel.matches(BoardPrimitive(t = "line", a = listOf(0.0, 0.0), b = listOf(1.0, 0.0))))
        assertTrue(sel.label.contains("GND"))
    }

    @Test
    fun `a degenerate zero-length track does not blow up the distance`() {
        // Boards do contain them. A naive projection divides by zero and yields NaN, which compares false
        // against everything and silently makes the whole layer unselectable.
        val layers = mapOf(layer("F.Cu", track(5.0, 5.0, 5.0, 5.0, "DOT")))
        assertEquals("DOT", nearestNet(layers, setOf("F.Cu"), Offset(5f, 5f), 1f))
    }
}
