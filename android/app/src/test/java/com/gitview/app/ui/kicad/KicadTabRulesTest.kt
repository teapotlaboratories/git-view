package com.gitview.app.ui.kicad

import org.junit.Assert.assertEquals
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
