package com.gitview.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.AppViewModel
import com.gitview.app.ui.chat.AttachmentViewKind
import com.gitview.app.ui.chat.MarkdownText
import com.gitview.app.ui.theme.GitViewTheme
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/**
 * Full-screen in-app viewer for a well-known chat attachment, so the user can look at a file without
 * downloading it first (viewer scope = text/code/data + images + PDF; Markdown renders formatted with a
 * Raw toggle). Chrome mirrors [DiffOverlay] (Surface + systemBarsPadding + a close/title/save bar).
 *
 * Every async stage carries an explicit [Load] state (Loading / Ready / Failed) so a fetch/decode/render
 * failure shows an error instead of an indistinguishable-from-loading spinner. Bytes and heavy
 * decode/render run off the main thread; images are downsampled and PDF pages are size- and count-capped
 * so a large attachment degrades to an error rather than an OOM. The save result is echoed inline because
 * the opaque overlay occludes the app's Scaffold snackbar.
 */
@Composable
fun AttachmentViewerOverlay(vm: AppViewModel) {
    val item = vm.ui.viewingAttachment ?: return
    val kind = item.viewKind
    val eink = GitViewTheme.profile.isEink
    val colors = GitViewTheme.colors
    BackHandler(enabled = true) { vm.closeAttachmentViewer() }
    var showRaw by remember(item.id) { mutableStateOf(false) }
    val load by produceState<Load<ByteArray>>(Load.Loading, item.id) {
        value = vm.attachmentBytes(item.id)?.let { Load.Ready(it) } ?: Load.Failed
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = vm::closeAttachmentViewer, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.Close, "close viewer", tint = MaterialTheme.colorScheme.onSurface)
                }
                Text(item.name, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, modifier = Modifier.weight(1f))
                if (kind == AttachmentViewKind.MARKDOWN) {
                    TextButton(onClick = { showRaw = !showRaw }) { Text(if (showRaw) "Rendered" else "Raw") }
                }
                IconButton(onClick = { vm.saveAttachment(item) }, modifier = Modifier.size(GitViewTheme.spacing.touchTarget)) {
                    Icon(Icons.Filled.Download, "save to Downloads", tint = MaterialTheme.colorScheme.onSurface)
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (val l = load) {
                    is Load.Loading -> Centered { CircularProgressIndicator() }
                    is Load.Failed -> ViewerMessage("Couldn't load ${item.name}")
                    is Load.Ready -> {
                        val b = l.value
                        when {
                            kind == AttachmentViewKind.IMAGE -> ImageViewer(b)
                            kind == AttachmentViewKind.PDF -> PdfViewer(b)
                            kind == AttachmentViewKind.MARKDOWN && !showRaw ->
                                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(GitViewTheme.spacing.md)) {
                                    MarkdownText(remember(b) { decodeText(b) })
                                }
                            else -> CodeEditorView(
                                initialText = remember(b) { decodeText(b) }, path = item.name, editable = false, eink = eink,
                                holder = remember(item.id) { EditorHolder() }, onDirty = {}, modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                }
            }
            // The opaque overlay covers the app's Scaffold snackbar, so echo the save result inline here.
            val msg = vm.ui.error ?: vm.ui.notice
            if (msg != null) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outline)
                Text(
                    msg, color = colors.textHi, fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
    }
}

/** Loading / Ready(value) / Failed — an explicit state so a failure is never mistaken for "still loading". */
private sealed interface Load<out T> {
    object Loading : Load<Nothing>
    object Failed : Load<Nothing>
    data class Ready<out T>(val value: T) : Load<T>
}

@Composable
private fun Centered(content: @Composable () -> Unit) =
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }

@Composable
private fun ViewerMessage(text: String) =
    Centered { Text(text, color = GitViewTheme.colors.textLow, fontSize = 14.sp, modifier = Modifier.padding(24.dp)) }

/** Pinch-to-zoom / pan image viewer (scale 1x–6x). Pan resets when zoomed fully out; double-tap resets. */
@Composable
private fun ImageViewer(bytes: ByteArray) {
    val img by produceState<Load<ImageBitmap>>(Load.Loading, bytes) {
        value = withContext(Dispatchers.Default) { decodeSampledImage(bytes, IMAGE_MAX_PX) }
            ?.let { Load.Ready(it) } ?: Load.Failed
    }
    when (val l = img) {
        is Load.Loading -> Centered { CircularProgressIndicator() }
        is Load.Failed -> ViewerMessage("Couldn't display this image")
        is Load.Ready -> {
            var scale by remember { mutableFloatStateOf(1f) }
            var offset by remember { mutableStateOf(Offset.Zero) }
            val state = rememberTransformableState { zoomChange, panChange, _ ->
                scale = (scale * zoomChange).coerceIn(1f, 6f)
                offset = if (scale <= 1f) Offset.Zero else offset + panChange
            }
            Box(
                Modifier.fillMaxSize().clipToBounds()
                    .pointerInput(Unit) { detectTapGestures(onDoubleTap = { scale = 1f; offset = Offset.Zero }) },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    l.value, "attachment image",
                    modifier = Modifier.fillMaxSize()
                        .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y)
                        .transformable(state),
                    contentScale = ContentScale.Fit,
                )
            }
        }
    }
}

/** Render PDF pages to bitmaps (Android's built-in PdfRenderer) and stack them, page numbers below. */
@Composable
private fun PdfViewer(bytes: ByteArray) {
    val ctx = LocalContext.current
    val colors = GitViewTheme.colors
    val pages by produceState<Load<List<ImageBitmap>>>(Load.Loading, bytes) {
        value = withContext(Dispatchers.IO) { runCatching { renderPdf(ctx, bytes) }.getOrNull() }
            ?.takeIf { it.isNotEmpty() }?.let { Load.Ready(it) } ?: Load.Failed
    }
    when (val l = pages) {
        is Load.Loading -> Centered { CircularProgressIndicator() }
        is Load.Failed -> ViewerMessage("Couldn't render this PDF")
        is Load.Ready -> LazyColumn(
            Modifier.fillMaxSize(), contentPadding = PaddingValues(GitViewTheme.spacing.sm),
            verticalArrangement = Arrangement.spacedBy(GitViewTheme.spacing.sm),
        ) {
            itemsIndexed(l.value) { i, page ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Image(
                        page, "page ${i + 1}",
                        modifier = Modifier.fillMaxWidth().border(GitViewTheme.spacing.hairline, colors.border),
                        contentScale = ContentScale.FillWidth,
                    )
                    Text("${i + 1} / ${l.value.size}", fontSize = 11.sp, color = colors.textLow, modifier = Modifier.padding(top = 2.dp))
                }
            }
        }
    }
}

/** Decode an image with `inSampleSize` downsampling so a 20MP photo doesn't allocate a ~48MB bitmap.
 *  Returns null on any decode failure (unsupported format, corrupt data, OOM). Shared with the card. */
fun decodeSampledImage(bytes: ByteArray, maxPx: Int): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    val maxDim = maxOf(bounds.outWidth, bounds.outHeight)
    while (maxDim > 0 && maxDim / sample > maxPx) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}.getOrNull()

/**
 * Blocking-ish PDF render (call on IO). Caps page count AND per-page resolution/height so a huge PDF can
 * degrade to an error rather than OOM, checks for cancellation between pages, and closes the page →
 * renderer → PFD in nested finally blocks so one failure (e.g. OOM at createBitmap) never leaks the FD.
 */
private suspend fun renderPdf(ctx: Context, bytes: ByteArray): List<ImageBitmap> {
    val out = ArrayList<ImageBitmap>()
    val tmp = File.createTempFile("att-view", ".pdf", ctx.cacheDir)
    try {
        tmp.writeBytes(bytes)
        // ParcelFileDescriptor is Closeable → `use` always closes it, even if the PdfRenderer ctor throws.
        ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
            val renderer = PdfRenderer(pfd)
            try {
                val count = renderer.pageCount.coerceAtMost(MAX_PDF_PAGES)
                for (i in 0 until count) {
                    currentCoroutineContext().ensureActive() // stop rendering if the viewer closed
                    val page = renderer.openPage(i)
                    try {
                        val scale = PDF_TARGET_W.toFloat() / page.width.coerceAtLeast(1)
                        val h = (page.height * scale).toInt().coerceIn(1, PDF_MAX_PAGE_H)
                        val bitmap = Bitmap.createBitmap(PDF_TARGET_W, h, Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(Color.WHITE) // PDF pages are transparent where unpainted; paper white
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        out.add(bitmap.asImageBitmap())
                    } finally {
                        page.close() // must close the page BEFORE renderer.close(), even on an exception
                    }
                }
            } finally {
                renderer.close() // PdfRenderer isn't AutoCloseable below API 34 — close by hand
            }
        }
    } finally {
        tmp.delete()
    }
    return out
}

private const val MAX_PDF_PAGES = 24
private const val PDF_TARGET_W = 1000
private const val PDF_MAX_PAGE_H = 4000
private const val IMAGE_MAX_PX = 2560
private const val MAX_TEXT_BYTES = 1_500_000

/** Decode the (byte-capped) payload as UTF-8. Slices the bytes BEFORE decoding so a huge file never
 *  allocates a full-size String just to throw most of it away. Callers wrap in remember(bytes). */
private fun decodeText(b: ByteArray): String {
    val truncated = b.size > MAX_TEXT_BYTES
    val s = String(if (truncated) b.copyOf(MAX_TEXT_BYTES) else b, Charsets.UTF_8)
    return if (truncated) "$s\n…(truncated)" else s
}
