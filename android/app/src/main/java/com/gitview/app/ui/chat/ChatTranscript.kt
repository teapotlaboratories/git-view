package com.gitview.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.gitview.app.ui.eink.EinkPaginator
import com.gitview.app.ui.permission.InlineApprovalCard
import com.gitview.app.ui.theme.GitViewTheme
import kotlinx.coroutines.launch

/**
 * The agent transcript: a `LazyColumn` over kind-tagged [ChatItem]s fed by the bridge WebSocket. It
 * FOLLOWS the tail (auto-scrolls to the newest item, animated on Standard / a discrete jump on E-Ink)
 * only while you're already at the bottom — scroll up to read history and it stops yanking you down. A
 * jump-to-bottom button appears while you're scrolled up (scroll mode only; Paginate has its own pager).
 * User prompts are right-aligned bubbles; assistant text streams as markdown; tools are [ToolActivityCard]s.
 */
@Composable
fun ChatTranscript(
    items: List<ChatItem>,
    onToggleTool: (String) -> Unit,
    onPermissionDecision: (requestId: String, allow: Boolean, scope: String) -> Unit,
    onAttachmentBytes: suspend (String) -> ByteArray?,
    onViewAttachment: (AttachmentItem) -> Unit,
    onSaveAttachment: (AttachmentItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val paginate = GitViewTheme.settings.paginate
    val tailLen = (items.lastOrNull() as? AssistantMsg)?.text?.length ?: 0

    // Follow the tail unless the USER scrolls up. Survives rotation (rememberSaveable) so scrolling up to
    // read history isn't undone by a config change. `programmatic` tags OUR OWN auto-scrolls so the settle
    // collector doesn't mistake them for a user scroll and flip follow off mid-stream (a self-inflicted race).
    var follow by rememberSaveable { mutableStateOf(true) }
    var programmatic by remember { mutableStateOf(false) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) {
                if (programmatic) programmatic = false     // our own auto-scroll settled — leave follow alone
                else follow = !listState.canScrollForward  // a USER scroll settled → follow iff at the bottom
            }
        }
    }
    suspend fun goNewest() {
        programmatic = true
        // Re-scroll across a few frames: markdown/tall items remeasure AFTER the first scroll (notably on
        // resume), so one pass can land short of the true end. Stop as soon as we're actually at the bottom.
        var tries = 0
        while (tries++ < 4) {
            listState.scrollToNewest()
            if (!listState.canScrollForward) break
            withFrameNanos { } // yield a frame so async content can settle, then try again
        }
    }
    LaunchedEffect(items.size, tailLen) {
        if (items.isEmpty()) return@LaunchedEffect
        when {
            paginate -> listState.scrollToItem(items.lastIndex) // paged mode: land on the newest page
            follow -> goNewest()
        }
    }

    // canScrollForward is false at the bottom; show the jump button when scrolled up (scroll mode only).
    val canScrollDown by remember { derivedStateOf { listState.canScrollForward } }
    Box(modifier) {
        EinkPaginator(
            paginate = paginate,
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(GitViewTheme.spacing.md),
            verticalArrangement = Arrangement.spacedBy(GitViewTheme.spacing.sm),
        ) {
            items(items, key = { it.id }) { item ->
                when (item) {
                    is UserMsg -> UserBubble(item.text)
                    is AssistantMsg -> StreamingText(item.text, item.streaming, Modifier.fillMaxWidth())
                    is ToolActivity -> ToolActivityCard(item, { onToggleTool(item.id) })
                    // Context only — the Deny/Allow buttons are pinned below the transcript (ApprovalActionBar)
                    // so they stay reachable in Paginate mode, where a too-tall card can't scroll to its footer.
                    is PendingPermission -> InlineApprovalCard(item, { allow, scope -> onPermissionDecision(item.id, allow, scope) }, showActions = false)
                    is AttachmentItem -> AttachmentCard(item, onAttachmentBytes, onViewAttachment, onSaveAttachment)
                }
            }
        }
        if (!paginate && canScrollDown) {
            JumpToBottom(
                modifier = Modifier.align(Alignment.BottomEnd).padding(GitViewTheme.spacing.md),
                onClick = { follow = true; scope.launch { goNewest() } },
            )
        }
    }
}

/** Scroll to the true bottom (end of the newest message), not just the last item's top — a long
 *  streaming reply is one tall item, so aligning its top would hide the newest text and (via a
 *  still-scrollable viewport) spuriously pause follow. `scrollToItem` composes the last item; `scrollBy`
 *  then consumes whatever scroll remains, clamped to the content end. */
private suspend fun LazyListState.scrollToNewest() {
    val last = (layoutInfo.totalItemsCount - 1).coerceAtLeast(0)
    scrollToItem(last)
    scrollBy(Float.MAX_VALUE)
}

/** A small circular "jump to newest" affordance. Neutral fill + border so it reads on both profiles
 *  (weight/border over hue on Color E-Ink; no shadow there, to avoid halo ghosting). */
@Composable
private fun JumpToBottom(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = GitViewTheme.colors
    Box(
        modifier
            .size(GitViewTheme.spacing.touchTarget)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(GitViewTheme.spacing.hairline, colors.border, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Filled.KeyboardArrowDown, contentDescription = "scroll to newest",
            tint = if (GitViewTheme.profile.isEink) colors.textHi else colors.primarySoft,
            modifier = Modifier.size(24.dp),
        )
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
