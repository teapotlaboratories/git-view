package com.gitview.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.gitview.app.ui.eink.EinkPaginator
import com.gitview.app.ui.permission.InlineApprovalCard
import com.gitview.app.ui.theme.GitViewTheme

/**
 * The agent transcript: a `LazyColumn` over kind-tagged [ChatItem]s fed by the bridge WebSocket. Auto-
 * scrolls to the newest item on update by setting the list position explicitly (animated on Standard,
 * a discrete jump on E-Ink — never `scrollIntoView`). User prompts are right-aligned primary bubbles;
 * assistant text streams as markdown; tool calls render as expandable [ToolActivityCard]s.
 */
@Composable
fun ChatTranscript(
    items: List<ChatItem>,
    onToggleTool: (String) -> Unit,
    onPermissionDecision: (requestId: String, allow: Boolean, scope: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val animate = GitViewTheme.motion.enabled
    val tailLen = (items.lastOrNull() as? AssistantMsg)?.text?.length ?: 0
    LaunchedEffect(items.size, tailLen) {
        if (items.isNotEmpty()) {
            val target = items.lastIndex
            if (animate) listState.animateScrollToItem(target) else listState.scrollToItem(target)
        }
    }
    EinkPaginator(
        paginate = GitViewTheme.settings.paginate,
        modifier = modifier,
        state = listState,
        contentPadding = PaddingValues(GitViewTheme.spacing.md),
        verticalArrangement = Arrangement.spacedBy(GitViewTheme.spacing.sm),
    ) {
        items(items, key = { it.id }) { item ->
            when (item) {
                is UserMsg -> UserBubble(item.text)
                is AssistantMsg -> StreamingText(item.text, item.streaming, Modifier.fillMaxWidth())
                is ToolActivity -> ToolActivityCard(item, { onToggleTool(item.id) })
                is PendingPermission -> InlineApprovalCard(item, { allow, scope -> onPermissionDecision(item.id, allow, scope) })
            }
        }
    }
}

@Composable
private fun UserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Box(
            Modifier
                .widthIn(max = 320.dp)
                .clip(MaterialTheme.shapes.medium)
                .background(MaterialTheme.colorScheme.primaryContainer)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}
