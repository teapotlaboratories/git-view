package com.gitview.app.ui.eink

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.foundation.clickable
import com.gitview.app.ui.theme.GitViewTheme
import kotlinx.coroutines.launch

/**
 * Long-list container that honors the "Paginate long lists" comfort toggle (default OFF — the Bigme
 * B7 Pro is 80Hz and scrolls fine; ADR-028). When [paginate] is false this is just a plain
 * [LazyColumn]. When true it turns OFF free/fling scrolling and navigates in discrete full-viewport
 * jumps via a `‹ prev · N–M of T · next ›` footer — instant `scrollToItem` (no animation), so an EPD
 * gets one clean full-page repaint per turn instead of continuous momentum smear.
 *
 * The window is derived from the live `layoutInfo`, so it works for variable-height rows (chat, diff,
 * history) without pre-measuring: "next" makes the last-visible item the new top; "prev" steps back
 * by the visible count.
 */
@Composable
fun EinkPaginator(
    paginate: Boolean,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
    contentPadding: androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues(0.dp),
    reverseLayout: Boolean = false,
    verticalArrangement: Arrangement.Vertical =
        if (reverseLayout) Arrangement.Bottom else Arrangement.Top,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    content: LazyListScope.() -> Unit,
) {
    if (!paginate) {
        LazyColumn(
            modifier = modifier,
            state = state,
            contentPadding = contentPadding,
            reverseLayout = reverseLayout,
            verticalArrangement = verticalArrangement,
            horizontalAlignment = horizontalAlignment,
            content = content,
        )
        return
    }
    Column(modifier) {
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            state = state,
            contentPadding = contentPadding,
            reverseLayout = reverseLayout,
            verticalArrangement = verticalArrangement,
            horizontalAlignment = horizontalAlignment,
            userScrollEnabled = false, // pagination replaces free scroll — navigate via the footer only
            content = content,
        )
        PageFooter(state)
    }
}

@Composable
private fun PageFooter(state: LazyListState) {
    val scope = rememberCoroutineScope()
    val info = state.layoutInfo
    val total = info.totalItemsCount
    val first = state.firstVisibleItemIndex
    val visible = info.visibleItemsInfo.size.coerceAtLeast(1)
    val last = (first + visible - 1).coerceIn(0, (total - 1).coerceAtLeast(0))
    val atTop = first <= 0
    val atEnd = last >= total - 1

    HorizontalDivider(color = MaterialTheme.colorScheme.outline, thickness = GitViewTheme.spacing.hairline)
    Row(
        Modifier.fillMaxWidth().heightIn(min = GitViewTheme.spacing.touchTarget)
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically,
    ) {
        PagerButton(Icons.AutoMirrored.Filled.KeyboardArrowLeft, "previous page", enabled = !atTop) {
            scope.launch { state.scrollToItem((first - visible).coerceAtLeast(0)) }
        }
        Text(
            if (total == 0) "empty" else "${first + 1}–${last + 1} of $total",
            fontSize = 12.sp, fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PagerButton(Icons.AutoMirrored.Filled.KeyboardArrowRight, "next page", enabled = !atEnd) {
            scope.launch { state.scrollToItem(last.coerceIn(0, (total - 1).coerceAtLeast(0))) }
        }
    }
}

@Composable
private fun PagerButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    desc: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        Modifier.heightIn(min = GitViewTheme.spacing.touchTarget)
            .widthIn(min = GitViewTheme.spacing.touchTarget)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .alpha(if (enabled) 1f else 0.35f)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, desc, tint = MaterialTheme.colorScheme.onSurface)
    }
}
