package com.gitview.app.ui.kicad

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gitview.app.data.BoardPrimitive
import com.gitview.app.data.KicadBoard
import com.gitview.app.data.KicadBoardLayer
import kotlin.math.max
import kotlin.math.min

/**
 * The board viewer (ADR-038, Phase 3).
 *
 * The schematic viewer draws one scene; this draws **a chosen set of layers**, and that difference is the
 * whole design. A board is ~357,000 primitives if shipped flat, so nothing is fetched until someone asks
 * for it: the tab opens on the index (layers + their populations), draws the outline, and every other
 * layer arrives when its chip is switched on.
 *
 * Coordinates are millimetres in board space, Y-down, same as the schematic scene. This view owns only a
 * scale and a translation.
 *
 * **E-ink is a first-class case.** On colour, layers are tinted and a selected net goes accent. On a mono
 * panel neither reads, so selection is carried by **stroke weight** — the same weight-not-hue rule the
 * diff and schematic viewers follow.
 */

/** Colour per layer role. Kept as a function rather than a map so an unknown layer still draws. */
private fun layerColour(layer: String, eink: Boolean, dark: Boolean): Color {
    if (eink) return Color(0xFF000000)
    return when {
        layer == "F.Cu" -> if (dark) Color(0xFFE05A4A) else Color(0xFFB03A2E)
        layer == "B.Cu" -> if (dark) Color(0xFF4E8FD0) else Color(0xFF1B4F8A)
        layer.endsWith(".Cu") -> if (dark) Color(0xFFCFA13A) else Color(0xFF8A6A16)
        layer == "Edge.Cuts" -> if (dark) Color(0xFFE8E8E8) else Color(0xFF202020)
        layer.endsWith("SilkS") -> if (dark) Color(0xFFBFC6CF) else Color(0xFF4A5560)
        layer.endsWith("Mask") -> if (dark) Color(0xFF7A5BA8) else Color(0xFF5B3A8A)
        layer.endsWith("Paste") -> if (dark) Color(0xFF8A8A8A) else Color(0xFF6A6A6A)
        else -> if (dark) Color(0xFF7E8894) else Color(0xFF7A828C)
    }
}

/**
 * What is picked out on the board.
 *
 * Only a net for now. A board's other obvious selection — a component — needs footprint-level hit-testing
 * that the per-layer wire format does not carry yet, and claiming it in the UI before it works would be
 * the viewer-that-lies problem in a smaller costume.
 */
internal data class BoardSelection(val net: String) {
    val label get() = "Net: $net"
    fun matches(p: BoardPrimitive) = p.net == net
}

@Composable
fun BoardView(
    /**
     * The board's repo path. Used only as a **cheap identity** for `remember`/`LaunchedEffect` keys.
     *
     * Keying on `board` itself looked harmless and was not: `KicadBoard` is a data class, so every key
     * comparison is structural — on `video.kicad_pcb` that walks 1,508 components, 1,800 nets and 39
     * layers, seven times per recomposition, and recomposition runs per frame during a pinch. The
     * schematic viewer has always keyed on `scene.path` for the same reason.
     */
    path: String,
    board: KicadBoard,
    layers: Map<String, KicadBoardLayer>,
    shown: Set<String>,
    loading: Set<String>,
    eink: Boolean,
    onToggleLayer: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** A net to select on arrival, set when the user cross-probed here from the schematic. */
    initialNet: String? = null,
    /** Called once [initialNet] has been applied, so it cannot re-apply on every recomposition. */
    onInitialNetConsumed: () -> Unit = {},
    /**
     * Does this raw model reference have a mesh ready to draw?
     *
     * Passed in rather than derived here: only the caller knows what the bridge reported, and a viewer
     * offered for a part with nothing behind it reads as broken rather than as unconverted.
     */
    hasMesh: (String) -> Boolean = { false },
    /** Long-pressed a component with a drawable model — `(refdes, raw model reference)`. */
    onOpenPart: (String, String) -> Unit = { _, _ -> },
    /** Called with the currently selected net to open the schematic showing the same one. */
    onCrossProbe: (String) -> Unit = {},
) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f

    var scale by remember(path) { mutableFloatStateOf(0f) }
    var offset by remember(path) { mutableStateOf(Offset.Zero) }
    var selection by remember(path) { mutableStateOf<BoardSelection?>(null) }
    var viewport by remember { mutableStateOf(Size.Zero) }
    var userMoved by remember(path) { mutableStateOf(false) }

    // Apply a cross-probe seed exactly once — see the schematic viewer for why it is consumed.
    androidx.compose.runtime.LaunchedEffect(initialNet, path) {
        if (initialNet != null) {
            selection = BoardSelection(initialNet)
            onInitialNetConsumed()
        }
    }

    // Fit in the layout phase, not the draw phase — the schematic viewer learned this the hard way: the
    // first frame reports a transient pre-layout size, and baking it in leaves the board small forever.
    androidx.compose.runtime.LaunchedEffect(viewport, board.bbox) {
        if (viewport.width > 0f && viewport.height > 0f && !userMoved && board.bbox.size >= 4) {
            val w = (board.bbox[2] - board.bbox[0]).toFloat().coerceAtLeast(1f)
            val h = (board.bbox[3] - board.bbox[1]).toFloat().coerceAtLeast(1f)
            val s = min(viewport.width / w, viewport.height / h) * 0.92f
            scale = s
            offset = Offset(
                (viewport.width - w * s) / 2f - board.bbox[0].toFloat() * s,
                (viewport.height - h * s) / 2f - board.bbox[1].toFloat() * s,
            )
        }
    }

    Column(modifier) {
        if (board.problems.isNotEmpty()) {
            Text(
                board.problems.first(),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
        // Truncation must be visible. A layer cut short that looks complete is precisely the failure the
        // caps were introduced to prevent, so it is surfaced here rather than left in a field nobody reads.
        val cut = shown.mapNotNull { layers[it] }.filter { it.truncated }
        if (cut.isNotEmpty()) {
            Text(
                cut.joinToString(", ") { "${it.layer} truncated — not all of it is drawn" },
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            )
        }
        selection?.let { sel ->
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${sel.label}   (tap empty space to clear)",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.weight(1f),
                )
                if (board.counterpart != null) {
                    Box(
                        Modifier
                            .selectable(
                                selected = false,
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                role = Role.Button,
                                onClick = { onCrossProbe(sel.net) },
                            )
                            .defaultMinSize(minHeight = 48.dp)
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "on schematic →",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }

        // Layer chips, each carrying its population. Only layers that actually hold something are offered —
        // a board declares 39 and most are empty, so listing them all would bury the four that matter.
        val offered = remember(board.layers) { board.layers.filter { it.count > 0 }.sortedByDescending { it.count } }
        LazyRow(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(offered, key = { it.name }) { layer ->
                val on = shown.contains(layer.name)
                val busy = loading.contains(layer.name)
                Box(
                    modifier = Modifier
                        .selectable(
                            selected = on,
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            role = Role.Checkbox,
                            onClick = { onToggleLayer(layer.name) },
                        )
                        .defaultMinSize(minHeight = 48.dp)
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        // The count is the point: it is what lets someone decide *before* pulling 2.6 MB.
                        text = if (busy) "${layer.name} …" else "${layer.name}  ${layer.count}",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                        color = when {
                            on -> layerColour(layer.name, eink, dark)
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                }
            }
        }

        // Draw in the order a board is read: copper under silkscreen, outline last so the edge stays
        // legible over whatever is beneath it. Computed on `shown` rather than inside the draw lambda —
        // there it allocated a fresh sorted list on every frame, including every frame of a pinch.
        val drawOrder = remember(shown) {
            shown.sortedBy {
                when {
                    it == "Edge.Cuts" -> 3
                    it.endsWith("SilkS") -> 2
                    else -> 1
                }
            }
        }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .navigationBarsPadding()
                .clipToBounds()
                .background(MaterialTheme.colorScheme.surface),
        ) {
            Canvas(
                Modifier
                    .fillMaxSize()
                    .onSizeChanged { viewport = Size(it.width.toFloat(), it.height.toFloat()) }
                    .pointerInput(board) {
                        detectTransformGestures { centroid, pan, zoom, _ ->
                            // Zoom about the pinch centroid, and clamp. `scale *= zoom` with `offset += pan`
                            // scales about the canvas ORIGIN, so the board accelerates off-screen as you
                            // zoom: one pinch on `vme-wren` left an empty canvas. The schematic viewer has
                            // always done this correctly; the board viewer was written without carrying it
                            // over. Same numbers, deliberately — the two viewers should not drift.
                            if (scale <= 0f) return@detectTransformGestures
                            userMoved = true
                            val (ox, oy, s) = zoomAbout(
                                centroid.x, centroid.y, offset.x, offset.y, scale, zoom, pan.x, pan.y,
                            )
                            offset = Offset(ox, oy)
                            scale = s
                        }
                    }
                    .pointerInput(board, layers, shown) {
                        detectTapGestures(
                            onTap = { tap ->
                                val p = Offset((tap.x - offset.x) / scale, (tap.y - offset.y) / scale)
                                selection = nearestNet(layers, shown, p, 8f / scale)?.let { BoardSelection(it) }
                            },
                            // Long-press rather than tap: tap already means "select this net", and one
                            // gesture with two meanings on overlapping targets — a pad belongs to a
                            // component — would make both feel unreliable.
                            onLongPress = { tap ->
                                val p = Offset((tap.x - offset.x) / scale, (tap.y - offset.y) / scale)
                                // Much looser than the net tolerance above, and deliberately: a net
                                // lives on tracks, which are long targets, while a part is a single
                                // point. At 6px this was ~0.8 mm of board space at a normal zoom —
                                // unhittable by a finger, which is exactly how it behaved on a device.
                                nearestPart(board.components, p.x, p.y, 28f / scale, hasMesh)
                                    ?.let { (ref, model) -> onOpenPart(ref, model) }
                            },
                        )
                    },
            ) {
                if (scale > 0f) {
                    for (name in drawOrder) {
                        val layer = layers[name] ?: continue
                        drawLayer(layer, layerColour(name, eink, dark), scale, offset, selection, eink)
                    }
                }
            }
        }
    }
}

/** The net of the nearest drawable within tolerance, or null. Tracks and pads are what carry nets. */
internal fun nearestNet(
    layers: Map<String, KicadBoardLayer>,
    shown: Set<String>,
    p: Offset,
    tolerance: Float,
): String? {
    var best: String? = null
    var bestDist = tolerance
    for (name in shown) {
        val layer = layers[name] ?: continue
        for (prim in layer.primitives) {
            val net = prim.net ?: continue
            val d = when (prim.t) {
                "track" -> {
                    val a = prim.a ?: continue
                    val b = prim.b ?: continue
                    if (a.size < 2 || b.size < 2) continue
                    distanceToSegment(
                        p,
                        Offset(a[0].toFloat(), a[1].toFloat()),
                        Offset(b[0].toFloat(), b[1].toFloat()),
                    )
                }
                "via", "pad" -> {
                    val at = prim.at ?: continue
                    if (at.size < 2) continue
                    (Offset(at[0].toFloat(), at[1].toFloat()) - p).getDistance()
                }
                else -> continue
            }
            if (d < bestDist) { bestDist = d; best = net }
        }
    }
    return best
}

private fun DrawScope.drawLayer(
    layer: KicadBoardLayer,
    base: Color,
    scale: Float,
    offset: Offset,
    selection: BoardSelection?,
    eink: Boolean,
) {
    fun map(x: Double, y: Double) = Offset(x.toFloat() * scale + offset.x, y.toFloat() * scale + offset.y)
    fun map(v: List<Double>) = map(v[0], v[1])

    // Same rule as the schematic: on colour the selected net goes accent and the rest dims; on e-ink
    // nothing dims usefully and there is no accent, so weight carries it.
    val accent = Color(0xFFFFC107)
    val dim = if (eink) base else base.copy(alpha = 0.28f)
    fun colourFor(p: BoardPrimitive): Color = when {
        selection == null -> base
        selection.matches(p) -> if (eink) base else accent
        else -> dim
    }
    fun widthFor(p: BoardPrimitive, w: Float): Float = when {
        selection == null -> w
        selection.matches(p) -> w * (if (eink) 3.0f else 2.0f)
        else -> w
    }

    for (p in layer.primitives) {
        when (p.t) {
            "track" -> {
                val a = p.a ?: continue; val b = p.b ?: continue
                if (a.size < 2 || b.size < 2) continue
                val w = max(1f, (p.w ?: 0.2).toFloat() * scale)
                drawLine(colourFor(p), map(a), map(b), strokeWidth = widthFor(p, w))
            }
            "arc" -> {
                val a = p.a ?: continue; val m = p.m ?: continue; val b = p.b ?: continue
                if (a.size < 2 || m.size < 2 || b.size < 2) continue
                val p0 = map(a); val p1 = map(b); val mid = map(m)
                // Quadratic through the recorded mid-point — close enough at board scale, and it keeps the
                // arc attached to its endpoints, which is what matters for reading a route.
                val ctrl = Offset(2f * mid.x - (p0.x + p1.x) / 2f, 2f * mid.y - (p0.y + p1.y) / 2f)
                val path = Path().apply {
                    moveTo(p0.x, p0.y)
                    quadraticBezierTo(ctrl.x, ctrl.y, p1.x, p1.y)
                }
                drawPath(path, colourFor(p), style = Stroke(widthFor(p, max(1f, (p.w ?: 0.2).toFloat() * scale))))
            }
            "via" -> {
                val at = p.at ?: continue
                if (at.size < 2) continue
                val c = map(at)
                val r = max(1.5f, (p.d ?: 0.6).toFloat() / 2f * scale)
                drawCircle(colourFor(p), r, c, style = Stroke(widthFor(p, max(1f, 0.1f * scale))))
                // The drill, when it is big enough on screen to read as a hole rather than a smudge. The
                // wire format carried `drill` from the start and the renderer ignored it, which made every
                // via look like a filled ring — a field claiming to matter that did not.
                val hole = (p.drill ?: 0.0).toFloat() / 2f * scale
                if (hole >= 1.5f) drawCircle(colourFor(p), hole, c, style = Stroke(max(1f, 0.06f * scale)))
            }
            "pad" -> {
                val at = p.at ?: continue
                if (at.size < 2) continue
                val sz = p.size
                val c = map(at)
                if (p.shape == "circle" || sz == null || sz.size < 2) {
                    val r = max(1.5f, ((sz?.firstOrNull() ?: 1.0).toFloat() / 2f) * scale)
                    drawCircle(colourFor(p), r, c)
                } else {
                    val w = sz[0].toFloat() * scale
                    val h = sz[1].toFloat() * scale
                    drawRect(
                        colourFor(p),
                        topLeft = Offset(c.x - w / 2f, c.y - h / 2f),
                        size = Size(max(1f, w), max(1f, h)),
                    )
                }
            }
            "line" -> {
                val a = p.a ?: continue; val b = p.b ?: continue
                if (a.size < 2 || b.size < 2) continue
                drawLine(colourFor(p), map(a), map(b), strokeWidth = max(1f, (p.w ?: 0.12).toFloat() * scale))
            }
            "circle" -> {
                val c = p.c ?: continue
                if (c.size < 2) continue
                drawCircle(
                    colourFor(p),
                    (p.r ?: 0.0).toFloat() * scale,
                    map(c),
                    style = Stroke(max(1f, (p.w ?: 0.12).toFloat() * scale)),
                )
            }
            "poly", "zone" -> {
                val pts = p.pts ?: continue
                if (pts.size < 2) continue
                val path = Path()
                var started = false
                for (v in pts) {
                    if (v.size < 2) continue
                    val q = map(v)
                    if (!started) { path.moveTo(q.x, q.y); started = true } else path.lineTo(q.x, q.y)
                }
                if (!started) continue
                path.close()
                // A zone is a filled pour; a poly is an outline. Pours are drawn faintly so the routing on
                // top of them stays readable — the reason the zones switch exists at all.
                if (p.t == "zone") drawPath(path, colourFor(p).copy(alpha = if (eink) 0.10f else 0.18f))
                else drawPath(path, colourFor(p), style = Stroke(max(1f, (p.w ?: 0.12).toFloat() * scale)))
            }
        }
    }
}

private fun distanceToSegment(p: Offset, a: Offset, b: Offset): Float {
    val ab = b - a
    val len2 = ab.x * ab.x + ab.y * ab.y
    if (len2 <= 0f) return (p - a).getDistance()
    val t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2).coerceIn(0f, 1f)
    return (p - Offset(a.x + ab.x * t, a.y + ab.y * t)).getDistance()
}
