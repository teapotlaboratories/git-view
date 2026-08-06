package com.gitview.app.ui.kicad

import android.view.Choreographer
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.google.android.filament.android.UiHelper

/**
 * The 3D part viewer (ADR-038, Phase 4a.3).
 *
 * Filament draws into a [android.view.TextureView], not a Compose canvas, so this is an `AndroidView`
 * with the engine living beside it. Four things about that are load-bearing:
 *
 *  - **A `TextureView`, not a `SurfaceView`.** Measured on a device: a `SurfaceView` here is laid out,
 *    attached and visible, and its surface is never created — so nothing can ever draw. See
 *    [PartRenderer.attach].
 *
 *  - **Filament's allocations are off-heap and are never garbage collected.** The `DisposableEffect`
 *    below is not tidiness; without it every open of this screen leaks an engine, its buffers and its
 *    swap chain until the process dies.
 *  - **Frames come from the display, not from recomposition.** A `Choreographer` callback drives
 *    rendering; recomposing per frame to draw would fight Compose rather than use it.
 *  - **Gestures are Compose's, state is the renderer's.** The pointer input writes yaw/pitch/distance
 *    straight onto the renderer instead of into Compose state, because a rotation does not change
 *    anything Compose needs to lay out — routing it through state would recompose the tree on every
 *    touch move for no benefit.
 */
@Composable
fun PartViewer(
    /** A `.glb` from the bridge, or null while it is being fetched. */
    glb: ByteArray?,
    /** Shown instead of geometry — "not converted", a fetch error, the name of the part. */
    emptyMessage: String? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var failure by remember(glb) { mutableStateOf<String?>(null) }

    // The compiled material, read once. 41 KB, and re-reading it per open would be per-open I/O for a
    // constant.
    val materialBytes = remember {
        runCatching { context.assets.open("part.filamat").use { it.readBytes() } }.getOrNull()
    }

    if (materialBytes == null) {
        Message("The 3D material is missing from this build.", modifier)
        return
    }

    val model = remember(glb) {
        val bytes = glb ?: return@remember null
        when (val r = readGlb(bytes)) {
            is GlbResult.Ok -> r.model
            // Deliberately surfaced rather than swallowed: a refused mesh and a mesh that has not
            // arrived look identical on screen otherwise, and only one of them is worth reporting.
            is GlbResult.Failed -> { failure = "This model could not be read: ${r.reason}"; null }
        }
    }

    val note = failure ?: emptyMessage ?: if (glb == null) "Loading…" else null
    if (model == null) {
        Message(note ?: "Nothing to show.", modifier)
        return
    }

    // The theme cannot reach Filament, so it is sampled here and carried in. Keyed on the palette so a
    // profile switch rebuilds the renderer — the skybox is built once, at attach; the `DisposableEffect`
    // below releases the old engine.
    val bg = MaterialTheme.colorScheme.background
    val palette = remember(bg) { viewerPalette(bg.red, bg.green, bg.blue) }
    val renderer = remember(materialBytes, palette) { PartRenderer(materialBytes, palette) }

    Box(modifier) {
        AndroidView(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        // Same feel as the board viewer: drag orbits, pinch dollies. Pitch is clamped
                        // short of the poles, where the up-vector degenerates and the view flips.
                        renderer.yaw -= pan.x * 0.01f
                        renderer.pitch = (renderer.pitch + pan.y * 0.01f).coerceIn(-1.5f, 1.5f)
                        if (zoom != 1f) renderer.distance /= zoom
                    }
                },
            factory = { ctx ->
                android.view.TextureView(ctx).also { tv ->
                    // Opaque: the viewer fills its area, and a translucent TextureView costs a blend
                    // per frame for a transparency nothing here uses.
                    tv.isOpaque = true
                    val helper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
                    // The model is set by the LaunchedEffect below, not here: `setModel` defers until
                    // the engine is up, so whichever runs first is fine and neither builds it twice.
                    renderer.attach(tv, helper)
                }
            },
        )
    }

    // One callback for the lifetime of the composable; posting a new one per frame from inside the
    // callback is what keeps it running.
    DisposableEffect(renderer) {
        val callback = PartRenderer.choreographer { renderer.render(it) }
        Choreographer.getInstance().postFrameCallback(callback)
        onDispose {
            Choreographer.getInstance().removeFrameCallback(callback)
            renderer.release()
        }
    }

    LaunchedEffect(model) { renderer.setModel(model) }
}

@Composable
private fun Message(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().padding(24.dp),
        )
    }
}
