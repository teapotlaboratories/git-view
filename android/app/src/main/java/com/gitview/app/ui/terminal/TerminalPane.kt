package com.gitview.app.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The workspace terminal view. Renders a [TerminalEmulator]'s scrollback and sends input line-by-line to
 * the host PTY (the shell echoes it back). Ctrl-C / Ctrl-D go up as raw control bytes so a running command
 * can be interrupted. This is line-mode by design (see the emulator note) — great for running commands and
 * reading colored output; live full-screen TUIs are out of scope.
 */
@Composable
fun TerminalPane(
    emulator: TerminalEmulator?,
    exited: Boolean,
    onInput: (String) -> Unit,
    onNewShell: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.background(TERM_BG)) {
        if (emulator == null) {
            Text("Starting shell…", color = TERM_FG, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.padding(12.dp))
            return@Column
        }

        val listState = rememberLazyListState()
        val hScroll = rememberScrollState()
        // Observe the emulator's revision so new output recomposes; then read the styled lines.
        @Suppress("UNUSED_VARIABLE") val rev = emulator.revision
        val lines = emulator.lines

        // Follow the tail: whenever output grows, jump to the newest line.
        LaunchedEffect(rev) { if (lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex) }

        LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
            items(lines.size) { i ->
                Text(
                    lines[i], color = TERM_FG, fontFamily = FontFamily.Monospace, fontSize = 13.sp,
                    softWrap = false, maxLines = 1, modifier = Modifier.horizontalScroll(hScroll),
                )
            }
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
            TerminalInput(onSend = { onInput(it + "\n") }, onCtrl = onInput)
        }
    }
}

@Composable
private fun TerminalInput(onSend: (String) -> Unit, onCtrl: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val send = { if (text.isNotEmpty() || true) { onSend(text); text = "" } }
    Column(Modifier.background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            // Raw control bytes — interrupt / EOF / tab, sent immediately (not part of the line buffer).
            AssistChip(onClick = { onCtrl("\u0003") }, label = { Text("^C", fontSize = 12.sp) })
            AssistChip(onClick = { onCtrl("\u0004") }, label = { Text("^D", fontSize = 12.sp) })
            AssistChip(onClick = { onCtrl("\t") }, label = { Text("Tab", fontSize = 12.sp) })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text, onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("command…", fontFamily = FontFamily.Monospace) },
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                singleLine = true, shape = RoundedCornerShape(10.dp),
                keyboardOptions = KeyboardOptions(
                    autoCorrect = false, capitalization = KeyboardCapitalization.None,
                    keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { send() }),
            )
            TextButton(onClick = { send() }) { Text("Run") }
        }
    }
}

private val TERM_BG = Color(0xFF101216)
private val TERM_FG = Color(0xFFD7DAE0)
