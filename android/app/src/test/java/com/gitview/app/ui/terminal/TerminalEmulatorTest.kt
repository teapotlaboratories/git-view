package com.gitview.app.ui.terminal

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-logic tests for the line-oriented ANSI/VT model. We assert on the plain text of each rendered
 * row (styles are applied on top and don't change the text), so no Compose composition is needed.
 */
class TerminalEmulatorTest {
    private val esc = "\u001B" // CSI introducer used to build test sequences
    private fun emu(vararg chunks: String) = TerminalEmulator().apply { chunks.forEach { feed(it) } }
    private fun textOf(e: TerminalEmulator) = e.lines.map { it.text }

    @Test fun printsTextAndSplitsOnNewline() {
        assertEquals(listOf("hello", "world"), textOf(emu("hello\nworld")))
    }

    @Test fun carriageReturnOverwritesFromColumnZero() {
        assertEquals(listOf("Xbc"), textOf(emu("abc\rX")))
    }

    @Test fun backspaceMovesCursorBack() {
        // "abc" -> back twice to col 1 -> 'Z' overwrites the 'b'
        assertEquals(listOf("aZc"), textOf(emu("abc\b\bZ")))
    }

    @Test fun tabAdvancesToNextEightColumnStop() {
        // 'a' at col 0 -> tab fills to col 8 (7 spaces) -> 'b'
        assertEquals(listOf("a       b"), textOf(emu("a\tb")))
    }

    @Test fun sgrColorLeavesTextIntact() {
        assertEquals(listOf("RED."), textOf(emu("${esc}[31mRED${esc}[0m.")))
    }

    @Test fun eraseToEndOfLineTruncates() {
        // write 6, return, overwrite 2, then ESC[K erases from the cursor to end -> "ab"
        assertEquals(listOf("ab"), textOf(emu("abcdef\rab${esc}[K")))
    }

    @Test fun clearScreenResetsBuffer() {
        assertEquals(listOf("clean"), textOf(emu("junk${esc}[2Jclean")))
    }

    @Test fun unknownPrivateEscapeIsSwallowed() {
        // ESC[?25l (hide cursor) must not print as literal text
        assertEquals(listOf("ab"), textOf(emu("a${esc}[?25lb")))
    }

    @Test fun escapeSplitAcrossChunksIsParsedWhole() {
        // The SGR sequence is cut across two feed() calls; it must NOT print "1mZ" as garbage.
        assertEquals(listOf("aZ"), textOf(emu("a${esc}[31", "mZ")))
    }

    @Test fun loneEscapeAtChunkEndBuffersUntilCompleted() {
        assertEquals(listOf("xY"), textOf(emu("x$esc", "[32mY")))
    }
}
