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
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.foundation.text.selection.SelectionContainer
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
    // Identifies the open chat by its OLDEST message (ids are globally-unique UUIDs). Stable for a chat's
    // whole life — unlike ui.sessionId, which is null on a brand-new chat until session.init resolves it,
    // so keying on that would reset follow + re-pin mid-first-exchange and yank a user who'd scrolled up.
    // Switching/opening a chat changes the oldest message, which is exactly when we want to re-pin.
    val chatKey = items.firstOrNull()?.id

    // Follow the tail unless the USER scrolls up. KEYED to the open chat: scrolling up to read history
    // survives a config change (rememberSaveable) but does NOT leak into the next chat you open — an
    // unkeyed one left every later chat pinned wherever the previous one was abandoned. `programmatic`
    // tags OUR OWN auto-scrolls so the settle collector doesn't mistake them for a user scroll and flip
    // follow off mid-stream (a self-inflicted race).
    var follow by rememberSaveable(chatKey) { mutableStateOf(true) }
    var programmatic by remember { mutableStateOf(false) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) {
                if (programmatic) programmatic = false     // our own auto-scroll settled — leave follow alone
                // A USER scroll settled → follow iff at the bottom. Uses isAtNewest, NOT canScrollForward,
                // which stays true at the true end here (so follow would never re-enable — see the helper).
                else follow = listState.isAtNewest(listState.layoutInfo.totalItemsCount - 1)
            }
        }
    }
    suspend fun goNewest() {
        programmatic = true
        // Re-scroll across a few frames: markdown/tall items remeasure AFTER the first scroll (notably on
        // resume), so one pass can land short of the true end. Stop as soon as we're actually at the bottom.
        var tries = 0
        while (tries++ < 4) {
            listState.scrollToNewest(items.lastIndex)
            if (listState.isAtNewest(items.lastIndex)) break
            withFrameNanos { } // yield a frame so async content can settle, then try again
        }
    }
    // Opening a chat (or switching to a different one) always lands on the NEWEST message — a resumed
    // transcript is history you've already read, so the useful end is the bottom. Keyed on chatKey, it
    // fires once per chat (on open/switch), NOT on the session-id resolution of the chat you're in.
    LaunchedEffect(chatKey) {
        if (items.isEmpty()) return@LaunchedEffect
        follow = true
        if (paginate) listState.scrollToItem(items.lastIndex) else goNewest()
    }
    LaunchedEffect(items.size, tailLen) {
        if (items.isEmpty()) return@LaunchedEffect
        when {
            paginate -> listState.scrollToItem(items.lastIndex) // paged mode: land on the newest page
            follow -> goNewest()
        }
    }

    // Show the jump button only while genuinely scrolled up (scroll mode only) — via isAtNewest, not
    // canScrollForward (which stays true at the true bottom here and pinned the button on-screen).
    val canScrollDown by remember { derivedStateOf { !listState.isAtNewest(listState.layoutInfo.totalItemsCount - 1) } }
    Box(modifier) {
        // Long-press any message to select + copy its text (replies, code blocks, tool output). Wrapping the
        // whole list rather than each bubble lets a selection run across messages. Taps still reach the
        // children, so the tool-card toggle and the attachment actions keep working; the interactive rows
        // that are pure controls opt out via DisableSelection so a long-press there doesn't start a drag.
        SelectionContainer {
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
                        is PendingPermission -> DisableSelection {
                            InlineApprovalCard(item, { allow, scope -> onPermissionDecision(item.id, allow, scope) }, showActions = false)
                        }
                        is AttachmentItem -> DisableSelection {
                            AttachmentCard(item, onAttachmentBytes, onViewAttachment, onSaveAttachment)
                        }
                    }
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
 *  then consumes whatever scroll remains, clamped to the content end.
 *
 *  `lastIndex` comes from the ITEM LIST, never `layoutInfo.totalItemsCount`: on the first frame after a
 *  transcript loads the list hasn't been measured, so `totalItemsCount` is still 0 and this scrolled to
 *  index 0 — the top — which is exactly what opening a chat did. (An unmeasured list also reports
 *  `canScrollForward == false`, so the caller's settle loop treated the top as "already at the bottom"
 *  and never corrected.) `scrollToItem` accepts an index the layout hasn't seen yet, so the data's index
 *  is both correct and available a frame earlier. */
private suspend fun LazyListState.scrollToNewest(lastIndex: Int) {
    scrollToItem(lastIndex.coerceAtLeast(0))
    scrollBy(Float.MAX_VALUE)
}

/** True when the newest item is laid out with its bottom edge within the viewport — the reliable
 *  "am I at the bottom?" test.
 *
 *  Deliberately NOT `!canScrollForward`: with the transcript's bottom content padding, canScrollForward
 *  stays `true` even at the true end (confirmed on a static transcript — the jump button never hid).
 *  Left as the follow trigger, that meant `follow = !canScrollForward` was permanently false there, so
 *  auto-tail never resumed after a manual scroll. The `+ 4` absorbs rounding; the check works whether or
 *  not `viewportEndOffset` includes that padding. `lastIndex < 0` (empty list) counts as at-newest; a
 *  non-empty but not-yet-measured list counts as NOT, so goNewest's settle loop keeps correcting. */
private fun LazyListState.isAtNewest(lastIndex: Int): Boolean {
    val info = layoutInfo
    val last = info.visibleItemsInfo.lastOrNull() ?: return lastIndex < 0
    return last.index >= lastIndex && last.offset + last.size <= info.viewportEndOffset + 4
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
