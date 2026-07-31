package com.gitview.app.ui.kicad

import androidx.compose.ui.geometry.Offset
import com.gitview.app.data.KicadScene
import com.gitview.app.data.SceneComponent
import com.gitview.app.data.ScenePrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Schematic hit-testing and selection (ADR-038, Phase 2).
 *
 * Phase 2 shipped two defects that a build could not see — a net chip that selected but never deselected,
 * and body graphics that ignored selection entirely — and it shipped with no tests at all. These cover the
 * pure logic underneath: what a tap resolves to, and what a selection matches.
 */
class SchematicHitTestTest {

    private fun rect(ref: String, x0: Double, y0: Double, x1: Double, y1: Double) =
        ScenePrimitive(t = "rect", a = listOf(x0, y0), b = listOf(x1, y1), ref = ref)

    private fun pin(ref: String, x: Double, y: Double, net: String? = null) =
        ScenePrimitive(t = "pin", at = listOf(x, y), ref = ref, pin = "1", net = net)

    private fun scene(prims: List<ScenePrimitive>, comps: List<SceneComponent>) =
        KicadScene(primitives = prims, components = comps)

    private val r1 = SceneComponent(ref = "R1", value = "1k", libId = "Device:R")

    @Test
    fun `a tap inside a component body selects it`() {
        val s = scene(listOf(rect("R1", 0.0, 0.0, 10.0, 10.0)), listOf(r1))
        val hit = pickComponent(s, Offset(5f, 5f))
        assertEquals("R1", hit?.ref)
        assertEquals("1k", hit?.value)
        assertEquals("Device:R", hit?.libId)
    }

    @Test
    fun `a tap outside every body selects nothing`() {
        val s = scene(listOf(rect("R1", 0.0, 0.0, 10.0, 10.0)), listOf(r1))
        assertNull(pickComponent(s, Offset(50f, 50f)))
    }

    @Test
    fun `pins are not hit-tested, so a tap on a pin can still reach its net`() {
        // A pin sits exactly where a wire ends. If pins were pickable, a component would steal every tap
        // aimed at a net — the single most common thing a user wants to select.
        val s = scene(listOf(pin("R1", 5.0, 5.0, net = "SIG")), listOf(r1))
        assertNull(pickComponent(s, Offset(5f, 5f)))
    }

    @Test
    fun `a sub-sheet box is not pickable as a component`() {
        // Sheet symbols carry a ref so they highlight as a unit, but they are not parts. Picking one
        // produced a card with an empty value and "0 pins" — a sheet presented as a component.
        val s = scene(listOf(rect("child", 0.0, 0.0, 40.0, 30.0)), emptyList())
        assertNull(pickComponent(s, Offset(20f, 15f)))
    }

    @Test
    fun `the smallest containing body wins`() {
        // A part drawn inside a larger outline must resolve to the part, not the thing wrapping it.
        val small = SceneComponent(ref = "U2", value = "", libId = "")
        val s = scene(
            listOf(rect("R1", 0.0, 0.0, 100.0, 100.0), rect("U2", 40.0, 40.0, 60.0, 60.0)),
            listOf(r1, small),
        )
        assertEquals("U2", pickComponent(s, Offset(50f, 50f))?.ref)
    }

    @Test
    fun `pin count comes from the primitives, not the component record`() {
        val s = scene(
            listOf(rect("R1", 0.0, 0.0, 10.0, 10.0), pin("R1", 0.0, 5.0), pin("R1", 10.0, 5.0)),
            listOf(r1),
        )
        assertEquals(2, pickComponent(s, Offset(5f, 5f))?.pins)
    }

    @Test
    fun `a component selection matches only its own primitives`() {
        val sel = Selection.Component("R1", "1k", "Device:R", 2)
        assertTrue(sel.matches(pin("R1", 0.0, 0.0)))
        assertTrue(!sel.matches(pin("R2", 0.0, 0.0)))
        assertTrue(!sel.matches(ScenePrimitive(t = "wire", net = "GND")))
    }

    @Test
    fun `a net selection matches by net, across different components`() {
        val sel = Selection.Net("GND")
        assertTrue(sel.matches(ScenePrimitive(t = "wire", net = "GND")))
        assertTrue(sel.matches(pin("R1", 0.0, 0.0, net = "GND")))
        assertTrue(sel.matches(pin("C9", 5.0, 5.0, net = "GND")))
        assertTrue(!sel.matches(pin("R1", 0.0, 0.0, net = "VCC")))
    }

    @Test
    fun `the component label carries everything the card shows`() {
        val label = Selection.Component("R1", "1k", "Device:R", 2).label
        assertTrue(label, label.contains("R1"))
        assertTrue(label, label.contains("1k"))
        assertTrue(label, label.contains("Device:R"))
        assertTrue(label, label.contains("2 pins"))
    }

    @Test
    fun `point in polygon handles a concave outline`() {
        // An L shape: the notch must read as outside, or a tap in empty space selects the part.
        val l = listOf(
            listOf(0.0, 0.0), listOf(10.0, 0.0), listOf(10.0, 4.0),
            listOf(4.0, 4.0), listOf(4.0, 10.0), listOf(0.0, 10.0),
        )
        assertTrue("inside the arm", pointInPolygon(Offset(2f, 8f), l))
        assertTrue("inside the base", pointInPolygon(Offset(8f, 2f), l))
        assertTrue("the notch is outside", !pointInPolygon(Offset(8f, 8f), l))
    }

    @Test
    fun `polygon area is orientation-independent`() {
        val cw = listOf(listOf(0.0, 0.0), listOf(0.0, 10.0), listOf(10.0, 10.0), listOf(10.0, 0.0))
        val ccw = cw.reversed()
        assertEquals(100f, polygonArea(cw), 0.01f)
        assertEquals(100f, polygonArea(ccw), 0.01f)
    }
}
