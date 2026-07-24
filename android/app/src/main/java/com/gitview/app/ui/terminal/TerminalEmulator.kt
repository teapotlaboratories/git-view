package com.gitview.app.ui.terminal

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

/**
 * A deliberately small, **line-oriented** ANSI/VT terminal model — enough for interactive shell use
 * (colored output, prompt line-editing, clear-screen, streaming build logs), NOT a full-screen VT100.
 * Full cursor addressing (`ESC[row;colH`), scroll regions, and alt-screen apps (vim / htop / tmux) are
 * intentionally out of scope — that's the trade for staying MIT with no terminal-emulator dependency.
 *
 * What it handles: printable text, `\n` `\r` `\b` `\t` `\a`(ignored); SGR (`ESC[…m`) colors + bold/reset;
 * erase-line (`ESC[K`), clear-screen (`ESC[2J`) and cursor-home (`ESC[H`); in-line cursor moves
 * (`ESC[C`/`ESC[D`) and column-absolute (`ESC[G`); OSC title (`ESC]…BEL`, ignored). Unknown escapes are
 * swallowed so they never print as garbage.
 *
 * Rendering: [lines] is a snapshot of styled rows; [revision] is a Compose state that bumps on every
 * change so a reader recomposes. Scrollback is capped at [maxLines].
 */
class TerminalEmulator(private val maxLines: Int = 4000, private val cols: Int = 0) {
    private data class Cell(val ch: Char, val style: SpanStyle)

    private val rows = ArrayList<ArrayList<Cell>>().apply { add(ArrayList()) }
    private var row = 0
    private var col = 0
    private var cur = SpanStyle() // current SGR style

    // Compose observability: readers touch `revision`; we bump it whenever the buffer changes.
    private var _rev by mutableIntStateOf(0)
    val revision: Int get() = _rev

    /** Feed raw PTY bytes (utf-8 text). Parses escapes and mutates the grid. */
    fun feed(text: String) {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == ESC -> i = handleEscape(text, i)
                c == '\n' -> { newline(); i++ }
                c == '\r' -> { col = 0; i++ }
                c == '\b' -> { if (col > 0) col--; i++ }
                c == '\t' -> { val next = (col / 8 + 1) * 8; while (col < next) putChar(' '); i++ }
                c == '\u0007' -> i++ // BEL — ignore
                c.code < 0x20 -> i++ // other C0 control — ignore
                else -> { putChar(c); i++ }
            }
        }
        _rev++
    }

    private fun line(): ArrayList<Cell> = rows[row]

    private fun putChar(c: Char) {
        val l = line()
        while (l.size < col) l.add(Cell(' ', SpanStyle()))
        if (col < l.size) l[col] = Cell(c, cur) else l.add(Cell(c, cur))
        col++
        // Soft-wrap to keep long lines readable when a width is known.
        if (cols > 0 && col >= cols) newline()
    }

    private fun newline() {
        row++
        if (row >= rows.size) rows.add(ArrayList())
        col = 0
        // Trim scrollback from the top.
        while (rows.size > maxLines) { rows.removeAt(0); row-- }
        if (row < 0) row = 0
    }

    /** Returns the index just past the consumed escape sequence. */
    private fun handleEscape(t: String, start: Int): Int {
        if (start + 1 >= t.length) return start + 1
        return when (t[start + 1]) {
            '[' -> handleCsi(t, start + 2)
            ']' -> handleOsc(t, start + 2)
            else -> start + 2 // other 2-char escapes (e.g. ESC=, ESC>) — swallow
        }
    }

    /** CSI: ESC [ params letter. */
    private fun handleCsi(t: String, start: Int): Int {
        var i = start
        val sb = StringBuilder()
        while (i < t.length && (t[i].isDigit() || t[i] == ';' || t[i] == '?')) { sb.append(t[i]); i++ }
        if (i >= t.length) return i
        val final = t[i]; i++
        val params = sb.toString().removePrefix("?").split(';').map { it.toIntOrNull() }
        val p0 = params.getOrNull(0) ?: 0
        when (final) {
            'm' -> applySgr(params)
            'K' -> { // erase in line: 0=to-end (default), 1=to-start, 2=whole
                val l = line()
                when (p0) {
                    0 -> while (l.size > col) l.removeAt(l.size - 1)
                    1 -> for (x in 0 until minOf(col, l.size)) l[x] = Cell(' ', SpanStyle())
                    2 -> l.clear()
                }
            }
            'J' -> if (p0 == 2 || p0 == 3) { rows.clear(); rows.add(ArrayList()); row = 0; col = 0 }
            'H', 'f' -> { row = 0; col = 0 } // cursor home only (no full addressing)
            'C' -> col += (p0.takeIf { it > 0 } ?: 1)
            'D' -> col = (col - (p0.takeIf { it > 0 } ?: 1)).coerceAtLeast(0)
            'G' -> col = (p0 - 1).coerceAtLeast(0)
            else -> {} // unhandled — swallowed
        }
        return i
    }

    /** OSC: ESC ] … terminated by BEL or ST (ESC \). Used for window titles — ignored. */
    private fun handleOsc(t: String, start: Int): Int {
        var i = start
        while (i < t.length) {
            if (t[i] == '\u0007') return i + 1
            if (t[i] == ESC && i + 1 < t.length && t[i + 1] == '\\') return i + 2
            i++
        }
        return i
    }

    private fun applySgr(params: List<Int?>) {
        if (params.isEmpty() || (params.size == 1 && params[0] == null)) { cur = SpanStyle(); return }
        var idx = 0
        while (idx < params.size) {
            when (val p = params[idx] ?: 0) {
                0 -> cur = SpanStyle()
                1 -> cur = cur.copy(fontWeight = FontWeight.Bold)
                22 -> cur = cur.copy(fontWeight = FontWeight.Normal)
                in 30..37 -> cur = cur.copy(color = ANSI16[p - 30])
                39 -> cur = cur.copy(color = Color.Unspecified)
                in 90..97 -> cur = cur.copy(color = ANSI16[p - 90 + 8])
                in 40..47 -> cur = cur.copy(background = ANSI16[p - 40])
                49 -> cur = cur.copy(background = Color.Unspecified)
                in 100..107 -> cur = cur.copy(background = ANSI16[p - 100 + 8])
                38, 48 -> { // 256/truecolor — consume the args, map 256 palette to nearest basic
                    val mode = params.getOrNull(idx + 1)
                    if (mode == 5) { val n = params.getOrNull(idx + 2) ?: 0; val col = xterm256(n); if (p == 38) cur = cur.copy(color = col) else cur = cur.copy(background = col); idx += 2 }
                    else if (mode == 2) { idx += 4 } // skip r;g;b (kept simple)
                }
                else -> {}
            }
            idx++
        }
    }

    /** Snapshot of styled rows for rendering. Cheap enough for shell output cadence. */
    val lines: List<AnnotatedString>
        get() = rows.map { cells ->
            buildAnnotatedString {
                var run = 0
                while (run < cells.size) {
                    val style = cells[run].style
                    val sb = StringBuilder()
                    while (run < cells.size && cells[run].style == style) { sb.append(cells[run].ch); run++ }
                    withStyle(style) { append(sb.toString()) }
                }
            }
        }

    companion object {
        private const val ESC = '\u001B'
        // Standard 16-color ANSI palette tuned for a dark background.
        private val ANSI16 = listOf(
            Color(0xFF3B3B3B), Color(0xFFE05561), Color(0xFF8CC265), Color(0xFFD18F52),
            Color(0xFF4AA5F0), Color(0xFFC162DE), Color(0xFF42B3C2), Color(0xFFD7DAE0),
            Color(0xFF6B6B6B), Color(0xFFFF616E), Color(0xFFA5E075), Color(0xFFF0A45D),
            Color(0xFF4DC4FF), Color(0xFFDE73FF), Color(0xFF4CD1E0), Color(0xFFFFFFFF),
        )

        /** Map an xterm-256 index to a reasonable Color (16 base + 216 cube + 24 grays). */
        private fun xterm256(n: Int): Color = when {
            n < 16 -> ANSI16[n]
            n in 16..231 -> {
                val v = n - 16
                val r = (v / 36) % 6; val g = (v / 6) % 6; val b = v % 6
                fun s(x: Int) = if (x == 0) 0 else 55 + x * 40
                Color(s(r), s(g), s(b))
            }
            else -> { val g = 8 + (n - 232) * 10; Color(g, g, g) }
        }
    }
}
