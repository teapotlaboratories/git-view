package com.gitview.app.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.ui.decodeSampledImage
import com.gitview.app.ui.theme.GitViewTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A file the agent handed to the chat. An image decodes inline (bounded height, tap to open the
 * full-screen viewer); any other file renders as a card with a document icon, name/size, and — for a
 * well-known type ([AttachmentItem.isViewable]) — a View affordance beside Save. The bytes are fetched
 * lazily through [onBytes] (an authed GET of `/v1/attachments/:id`) so a long transcript doesn't preload
 * every attachment; [onView] opens the in-app viewer, [onSave] writes it to Downloads. Honors `hueless`.
 */
@Composable
fun AttachmentCard(
    item: AttachmentItem,
    onBytes: suspend (String) -> ByteArray?,
    onView: (AttachmentItem) -> Unit,
    onSave: (AttachmentItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val eink = GitViewTheme.profile.isEink
    val colors = GitViewTheme.colors
    val shape = MaterialTheme.shapes.small
    val viewable = item.isViewable
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .then(if (eink) Modifier.border(GitViewTheme.spacing.hairline, colors.border, shape) else Modifier),
    ) {
        if (item.isImage) {
            // Decode downsampled + off the main thread (a 20MP screenshot must not allocate ~48MB on the
            // UI thread as this card scrolls into view). A decode failure shows a placeholder, not a spinner.
            val thumb by produceState<Thumb>(Thumb.Loading, item.id) {
                val bytes = onBytes(item.id)
                value = if (bytes == null) Thumb.Failed
                else withContext(Dispatchers.Default) { decodeSampledImage(bytes, CARD_IMAGE_MAX_PX) }
                    ?.let { Thumb.Ready(it) } ?: Thumb.Failed
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 96.dp, max = 320.dp)
                    .clickable { onView(item) }, // tap the thumbnail → full-screen zoomable viewer
                contentAlignment = Alignment.Center,
            ) {
                when (val t = thumb) {
                    is Thumb.Loading -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = colors.textLow)
                    is Thumb.Failed -> Text("Preview unavailable", color = colors.textLow, fontSize = 12.sp)
                    is Thumb.Ready -> Image(
                        bitmap = t.bitmap, contentDescription = item.name,
                        modifier = Modifier.fillMaxWidth(), contentScale = ContentScale.Fit,
                    )
                }
            }
        }
        Row(
            Modifier.fillMaxWidth()
                // The name area opens the viewer for a well-known type; the trailing icons handle their own taps.
                .then(if (viewable) Modifier.clickable { onView(item) } else Modifier)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!item.isImage) {
                Icon(
                    Icons.Filled.InsertDriveFile, contentDescription = null,
                    modifier = Modifier.size(20.dp), tint = colors.textLow,
                )
                Spacer(Modifier.width(8.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    item.name, color = colors.textHi, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val meta = attachmentMeta(item)
                if (meta != null) Text(meta, color = colors.textLow, fontSize = 11.sp, maxLines = 1)
            }
            if (viewable) {
                Spacer(Modifier.width(8.dp))
                Icon(
                    Icons.Filled.Visibility, contentDescription = "View ${item.name}",
                    modifier = Modifier.size(20.dp).clip(MaterialTheme.shapes.small).clickable { onView(item) },
                    tint = if (eink) colors.textHi else colors.primarySoft,
                )
            }
            Spacer(Modifier.width(8.dp))
            Icon(
                Icons.Filled.Download, contentDescription = "Save ${item.name}",
                modifier = Modifier.size(20.dp).clip(MaterialTheme.shapes.small).clickable { onSave(item) },
                tint = if (eink) colors.textHi else colors.primarySoft,
            )
        }
    }
}

/** "PNG · 128 KB" style subtitle — the file kind (from the mime tail) and a human size when known. */
private fun attachmentMeta(item: AttachmentItem): String? {
    val kind = item.mime.substringAfterLast('/').substringBefore('+').uppercase().ifBlank { null }
    val size = item.size?.let { humanBytes(it) }
    return listOfNotNull(kind, size).joinToString(" · ").ifBlank { null }
}

private fun humanBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${n / 1024} KB"
    else -> "%.1f MB".format(n / (1024.0 * 1024.0))
}

/** Inline thumbnail decode state — distinguishes a still-loading fetch from a decode failure. */
private sealed interface Thumb {
    object Loading : Thumb
    object Failed : Thumb
    data class Ready(val bitmap: ImageBitmap) : Thumb
}

private const val CARD_IMAGE_MAX_PX = 1080
