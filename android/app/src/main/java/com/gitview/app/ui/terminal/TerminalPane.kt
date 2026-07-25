package com.gitview.app.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The workspace terminal view. Renders a [TerminalEmulator]'s scrollback and streams input **directly**
 * to the host PTY, character by character (the shell echoes it back), like a real terminal — there is no
 * separate line-edit field. Tapping the console (or opening the pane) shows the keyboard; the console
 * resizes to sit above it. A slim control row supplies the keys a soft keyboard can't send (Ctrl-C/-D,
 * Tab, Esc, arrows). Full-screen TUIs remain out of scope (see the emulator note).
 */
@Composable
fun TerminalPane(
    emulator: TerminalEmulator?,
    exited: Boolean,
    onInput: (String) -> Unit,
    onNewShell: () -> Unit,
    fontScale: Float,
    onFontScale: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    // imePadding() lifts the whole console above the soft keyboard when it opens (window is adjustResize).
    Column(modifier.background(TERM_BG).imePadding()) {
        if (emulator == null) {
            Text("Starting shell…", color = TERM_FG, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
            return@Column
        }

        val listState = rememberLazyListState()
        val hScroll = rememberScrollState()
        val focus = remember { FocusRequester() }
        val keyboard = LocalSoftwareKeyboardController.current
        // Pinch-to-zoom the monospace font. The scale is hoisted (ViewModel) so it's one global level
        // that survives pane/repo switches — the pane itself unmounts on switch.
        val fontSize = (BASE_FONT_SP * fontScale).sp
        // Latest scale readable inside the Unit-keyed pinch handler without restarting it.
        val latestScale by rememberUpdatedState(fontScale)
        // Observe the emulator's revision so new output recomposes; then read the styled lines.
        @Suppress("UNUSED_VARIABLE") val rev = emulator.revision
        val lines = emulator.lines

        // Follow the tail: whenever output grows, jump to the newest line.
        LaunchedEffect(rev) { if (lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex) }
        // Grab focus (and the keyboard) when a live shell is shown, so you can type immediately.
        LaunchedEffect(exited) { if (!exited) runCatching { focus.requestFocus() } }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize()
                    // Tap anywhere on the console to focus it / re-open the keyboard.
                    .pointerInput(exited) { if (!exited) detectTapGestures { runCatching { focus.requestFocus() }; keyboard?.show() } }
                    // Pinch (2-finger) to zoom the font. Only consumes multi-touch, so single-finger
                    // scroll and tap still reach the list underneath. The block is keyed on Unit (so a
                    // gesture isn't cancelled mid-pinch by the scale changing), so we can't read `fontScale`
                    // directly — it'd be captured stale at 1×. Instead we accumulate locally within the
                    // gesture, seeding from the latest value via rememberUpdatedState.
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            var scale = latestScale
                            do {
                                val event = awaitPointerEvent()
                                if (event.changes.size >= 2) {
                                    val zoom = event.calculateZoom()
                                    if (zoom != 1f) {
                                        scale = (scale * zoom).coerceIn(MIN_FONT_SCALE, MAX_FONT_SCALE)
                                        onFontScale(scale)
                                        event.changes.forEach { it.consume() }
                                    }
                                }
                            } while (event.changes.any { it.pressed })
                        }
                    }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                items(lines.size) { i ->
                    Text(
                        lines[i], color = TERM_FG, fontFamily = FontFamily.Monospace, fontSize = fontSize,
                        // Tight, terminal-like rows: line height == font size, no extra font padding/leading.
                        lineHeight = fontSize, style = TERM_TEXT_STYLE,
                        softWrap = false, maxLines = 1, modifier = Modifier.horizontalScroll(hScroll),
                    )
                }
            }
            // Invisible field that owns the IME connection; its keystrokes go straight to the PTY.
            if (!exited) ConsoleKeyInput(focus, onInput)
        }

        if (exited) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Shell exited.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = onNewShell) { Text("New shell") }
            }
        } else {
            ControlRow(onInput)
        }
    }
}

/**
 * A zero-visibility [BasicTextField] that turns soft-keyboard input into raw PTY bytes. We keep the buffer
 * pinned to a single zero-width anchor and, on every change, forward whatever was typed past the anchor
 * (including a newline) — or a DEL when the anchor itself was deleted (backspace) — then reset. This makes
 * the field behave like a stream of keystrokes rather than an editable line.
 */
@Composable
private fun ConsoleKeyInput(focus: FocusRequester, onInput: (String) -> Unit) {
    val anchor = "\u200B" // zero-width space; gives backspace something to delete
    var tfv by remember { mutableStateOf(TextFieldValue(anchor, TextRange(anchor.length))) }
    BasicTextField(
        value = tfv,
        onValueChange = { new ->
            val t = new.text
            when {
                t.length > anchor.length -> onInput(t.substring(anchor.length)) // typed char(s), incl. "\n"
                t.length < anchor.length -> onInput("\u007F")                    // deleted the anchor = backspace (DEL)
            }
            tfv = TextFieldValue(anchor, TextRange(anchor.length))               // pin back to the anchor
        },
        modifier = Modifier.size(1.dp).alpha(0f).focusRequester(focus),
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(
            autoCorrect = false,
            capitalization = KeyboardCapitalization.None,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.None,
        ),
    )
}

/** Keys a soft keyboard can't send: Ctrl-C / Ctrl-D, Tab, Esc, and arrows — each written raw to the PTY. */
@Composable
private fun ControlRow(onInput: (String) -> Unit) {
    val keys = listOf(
        "^C" to "\u0003", "^D" to "\u0004", "Tab" to "\t", "Esc" to "\u001B",
        "↑" to "\u001B[A", "↓" to "\u001B[B", "←" to "\u001B[D", "→" to "\u001B[C",
    )
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)
            .horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        keys.forEach { (label, seq) ->
            AssistChip(onClick = { onInput(seq) }, label = { Text(label, fontSize = 12.sp) })
        }
    }
}

// Terminal rows hug the glyphs: drop the platform font padding and trim the line box to the text so
// consecutive lines aren't spaced out by default leading.
private val TERM_TEXT_STYLE = TextStyle(
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.Both),
)
private const val BASE_FONT_SP = 13f
private const val MIN_FONT_SCALE = 0.6f // ~8sp
private const val MAX_FONT_SCALE = 2.6f // ~34sp
private val TERM_BG = Color(0xFF101216)
private val TERM_FG = Color(0xFFD7DAE0)
