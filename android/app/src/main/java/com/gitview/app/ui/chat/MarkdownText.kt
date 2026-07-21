package com.gitview.app.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.halilibo.richtext.commonmark.Markdown
import com.halilibo.richtext.ui.material3.RichText

/**
 * Renders assistant markdown (inline `code`, bold/italic, lists, fenced code blocks) via
 * compose-richtext's Material 3 integration, so it inherits the active profile's Typography and
 * colors — weight/mono over hue on the E-Ink profile. See the redesign handoff / ADR-024 context.
 */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    RichText(modifier = modifier) {
        Markdown(content = text)
    }
}
