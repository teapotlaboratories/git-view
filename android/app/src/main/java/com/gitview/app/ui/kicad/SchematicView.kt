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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gitview.app.data.KicadScene
import com.gitview.app.data.ScenePrimitive
import kotlin.math.max
import kotlin.math.min

/**
 * The schematic viewer (ADR-038, Phase 1).
 *
 * Draws the bridge's **tagged scene** on a Compose Canvas. The tagging is what makes this cheap: every
 * primitive already knows its `net` and `ref`, so selecting a net is a colour decision inside the draw
 * loop rather than an overlay or a second pass. Phase 2's cross-probe is the same mechanism with a
 * different selection source.
 *
 * Scene coordinates are millimetres in sheet space, Y-down (the bridge normalises the library's Y-up
 * frame). This view owns only the viewport: a scale and a translation, fitted to the sheet on first
 * layout and then driven by pinch/pan.
 *
 * **E-ink is a first-class case, not a downgrade.** On the colour profile a selected net turns accent and
 * everything else dims. On a mono panel dimming is nearly invisible and colour is absent, so selection is
 * carried by **stroke weight** instead — the same weight-not-hue rule the diff viewer follows.
 */

/** Palette for one display profile. Kept as data so the two profiles cannot drift apart in the draw code. */
private data class SchematicPalette(
    val wire: Color,
    val bus: Color,
    val body: Color,
    val text: Color,
    val label: Color,
    val pin: Color,
    val junction: Color,
    val noConnect: Color,
    val highlight: Color,
    val dimmed: Color,
)

private fun palette(eink: Boolean, dark: Boolean): SchematicPalette =
    if (eink) {
        // Mono panel: one ink colour, contrast carried by weight. Anything hue-based would vanish.
        val ink = Color(0xFF000000)
        SchematicPalette(
            wire = ink, bus = ink, body = ink, text = ink, label = ink, pin = ink,
            junction = ink, noConnect = ink, highlight = ink, dimmed = Color(0xFF9A9A9A),
        )
    } else if (dark) {
        SchematicPalette(
            wire = Color(0xFF4EC9B0), bus = Color(0xFF6CB6F0), body = Color(0xFFD6DBE1),
            text = Color(0xFF98A1AC), label = Color(0xFFD08BC8), pin = Color(0xFFD6A44A),
            junction = Color(0xFF4EC9B0), noConnect = Color(0xFFF4877A),
            highlight = Color(0xFFFFD34E), dimmed = Color(0xFF3A424B),
        )
    } else {
        SchematicPalette(
            wire = Color(0xFF1A7F5A), bus = Color(0xFF0E4FA0), body = Color(0xFF1F2328),
            text = Color(0xFF5A6572), label = Color(0xFF9A2D8A), pin = Color(0xFF9A6700),
            junction = Color(0xFF1A7F5A), noConnect = Color(0xFFB3261E),
            highlight = Color(0xFFD1690A), dimmed = Color(0xFFC8CDD3),
        )
    }

/** Above this many nets a bare chip row stops being usable and a filter is offered. */
private const val NET_FILTER_THRESHOLD = 12

private fun ScenePrimitive.pt(v: List<Double>?): Offset? =
    if (v != null && v.size >= 2) Offset(v[0].toFloat(), v[1].toFloat()) else null

/** Everything a primitive could be hit-tested or highlighted by. */
private val ScenePrimitive.anchor: Offset?
    get() = pt(at) ?: pt(a) ?: pt(c) ?: pts?.firstOrNull()?.let { pt(it) }

/**
 * What is currently picked out. A net or a component — never both, and never two flags that can drift.
 * `matches` is the single predicate the draw loop consults, so highlight, dim and hit-test can never
 * disagree about what "selected" means.
 */
sealed interface Selection {
    val label: String
    fun matches(p: ScenePrimitive): Boolean

    data class Net(val name: String) : Selection {
        override val label get() = "Net: $name"
        override fun matches(p: ScenePrimitive) = p.net == name
    }

    data class Component(val ref: String, val value: String, val libId: String, val pins: Int) : Selection {
        override val label
            get() = buildString {
                append(ref)
                if (value.isNotBlank()) append("  $value")
                if (libId.isNotBlank()) append("  ·  $libId")
                if (pins > 0) append("  ·  $pins pins")
            }
        override fun matches(p: ScenePrimitive) = p.ref == ref
    }
}

@Composable
fun SchematicView(
    scene: KicadScene,
    eink: Boolean,
    modifier: Modifier = Modifier,
    onSheetSelected: (String) -> Unit = {},
    /** A net to select on arrival, set when the user cross-probed here from the board (ADR-038, 3b). */
    initialNet: String? = null,
    /** Called once [initialNet] has been applied, so it cannot re-apply on every recomposition. */
    onInitialNetConsumed: () -> Unit = {},
    /** Called with the currently selected net to open the board showing the same one. */
    onCrossProbe: (String) -> Unit = {},
) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val pal = remember(eink, dark) { palette(eink, dark) }

    var scale by remember(scene.path) { mutableFloatStateOf(0f) } // 0 = not yet fitted
    var offset by remember(scene.path) { mutableStateOf(Offset.Zero) }
    // ONE selection model, deliberately. A net and a component are alternatives, never both, and both
    // flow through the same highlight path in the draw loop. Two independent "selected" flags would
    // eventually disagree about what is dimmed, and the draw code would grow two subtly different rules.
    var selection by remember(scene.path) { mutableStateOf<Selection?>(null) }
    var viewport by remember { mutableStateOf(Size.Zero) }
    // Has the user panned or zoomed? Until they have, the view stays fitted to the sheet and refits on
    // every size change. Once they take control, their viewport is never yanked out from under them.
    var userMoved by remember(scene.path) { mutableStateOf(false) }
    var netFilter by remember(scene.path) { mutableStateOf("") }
    // Case-insensitive substring; nets are short identifiers, so anything cleverer would be noise.
    val shownNets = remember(scene.nets, netFilter) {
        if (netFilter.isBlank()) scene.nets
        else scene.nets.filter { it.contains(netFilter.trim(), ignoreCase = true) }
    }

    // Apply a cross-probe seed exactly once. Keyed on the net *and* the sheet, so probing to the same net
    // twice still works, and so switching sheets does not silently re-apply a stale one.
    LaunchedEffect(initialNet, scene.path) {
        if (initialNet != null) {
            selection = Selection.Net(initialNet)
            onInitialNetConsumed()
        }
    }

    // Fit in the layout phase, not the draw phase. Computing it inside the Canvas lambda baked in
    // whatever size the very first frame happened to report — on a real device that is a transient
    // pre-layout size, so the sheet drew small and off-centre and never recovered, because the
    // "already fitted" flag was set. Only running it on hardware showed this.
    LaunchedEffect(viewport, scene.path) {
        if (viewport.width > 0f && viewport.height > 0f && !userMoved) {
            val fit = fitTransform(scene, viewport)
            scale = fit.first
            offset = fit.second
        }
    }

    Column(modifier) {
        if (scene.sheets.size > 1) {
            SheetSwitcher(scene, eink, onSheetSelected)
        }
        if (scene.problems.isNotEmpty()) {
            // A partial design that looks complete is the failure this whole feature guards against.
            Text(
                "Incomplete: ${scene.problems.first()}",
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
                // Offered only when the bridge found a board beside this schematic, and only for a *net* —
                // a net name is the identifier both halves genuinely share. A component would need the
                // board to hit-test footprints, which its per-layer format cannot do yet.
                val net = (sel as? Selection.Net)?.name
                if (net != null && scene.counterpart != null) {
                    Box(
                        Modifier
                            .selectable(
                                selected = false,
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                role = Role.Button,
                                onClick = { onCrossProbe(net) },
                            )
                            .defaultMinSize(minHeight = 48.dp)
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "on board →",
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }
        }

        // Net picker. `scene.nets` is already sorted and complete, so this costs one row of chips and
        // saves hunting for a wire thin enough to hit — which matters on a 1600-primitive sheet and
        // doubly on e-ink, where a mis-tap is an expensive full redraw.
        if (scene.nets.isNotEmpty()) {
            // Filter, not just a chip row. The plan called for a *searchable* list and a bare row is only
            // usable on a small sheet: `buspci` has 162 nets, `graphic` 156, `muxdata` 116 — scrolling
            // 162 chips to reach DQ7 is worse than tapping the wire, which is the thing this was meant to
            // beat. Shown only when there are enough nets to warrant it, so a 7-net sheet keeps a bare row
            // and e-ink does not pay for a text field it does not need.
            if (scene.nets.size > NET_FILTER_THRESHOLD) {
                OutlinedTextField(
                    value = netFilter,
                    onValueChange = { netFilter = it },
                    label = { Text("Filter nets (${shownNets.size}/${scene.nets.size})") },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
            LazyRow(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(shownNets, key = { it }) { net ->
                    val active = (selection as? Selection.Net)?.name == net
                    Box(
                        modifier = Modifier
                            // `selectable`, not a raw `pointerInput`. Three things follow from that, and
                            // the first is the one that matters:
                            //
                            // 1. There is no key to get wrong. `pointerInput(net)` restarts only when its
                            //    key changes, but its block closed over the `selection` state that
                            //    `remember(scene.path)` REPLACES on every sheet switch. A net carried
                            //    across sheets — GND is on all 8 of `video`'s, and 182 names appear on
                            //    more than one — keeps its LazyRow slot, so the handler never restarted
                            //    and went on writing to the previous sheet's discarded state: the chip
                            //    looked normal and did nothing. `selectable` takes a plain lambda that is
                            //    replaced on recomposition, so the whole class of bug is gone rather than
                            //    patched with a longer key.
                            // 2. It is actually operable by a screen reader. A bare `semantics { role }`
                            //    announces a button with no click action behind it, which is worse than
                            //    saying nothing.
                            // 3. `selected` is exposed as state, so assistive tech can say which net is on.
                            //
                            // Indication is off deliberately: a ripple on e-ink is a full-panel redraw,
                            // and the selection already reads through weight and colour.
                            .selectable(
                                selected = active,
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                role = Role.Button,
                                onClick = {
                                    // Tapping the active net clears it, so the chip row is a toggle rather
                                    // than a trap you can only escape by tapping empty canvas.
                                    selection =
                                        if ((selection as? Selection.Net)?.name == net) null else Selection.Net(net)
                                },
                            )
                            // A 48dp target, because the picker exists to spare you a fiddly tap on a thin
                            // wire — a chip you have to aim at just moves the problem. It matters most on
                            // e-ink, where a mis-tap costs a full-panel redraw. The modifier order is
                            // load-bearing: `selectable` sits OUTSIDE the sizing, so the touch area is the
                            // whole 48dp box rather than the text inside it.
                            .defaultMinSize(minHeight = 48.dp)
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = net,
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                            color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        // `clipToBounds` is load-bearing, not cosmetic: a Compose Canvas does **not** clip its drawing to
        // its own bounds, so the schematic painted straight over the filter field above it and under the
        // system navigation bar below. `navigationBarsPadding` keeps the drawing clear of the gesture bar
        // rather than hiding a strip of the sheet behind it.
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
                    .pointerInput(scene.path) {
                        detectTransformGestures { centroid, pan, zoom, _ ->
                            // Zoom about the pinch centroid, so the sheet does not slide away under the
                            // fingers. Clamped so a stray gesture cannot lose the drawing entirely.
                            if (scale <= 0f) return@detectTransformGestures
                            userMoved = true
                            val next = (scale * zoom).coerceIn(0.05f, 80f)
                            offset = centroid - (centroid - offset) * (next / scale) + pan
                            scale = next
                        }
                    }
                    .pointerInput(scene.path, scene.primitives) {
                        detectTapGestures { tap ->
                            val sheetPt = Offset((tap.x - offset.x) / scale, (tap.y - offset.y) / scale)
                            // A component body wins over a net: a tap inside a symbol almost always means
                            // "this part", and its pins would otherwise steal the hit at the same point.
                            selection = pickComponent(scene, sheetPt)
                                ?: nearestNet(scene, sheetPt, tolerance = 12f / scale)?.let { Selection.Net(it) }
                        }
                    },
            ) {
                if (scale > 0f) drawScene(scene, pal, scale, offset, selection, eink)
            }
        }
    }
}

/**
 * The box worth framing on: the *circuit*, not every drawable.
 *
 * `scene.bbox` spans everything, so a SPICE directive or a title block parked away from the schematic
 * sets the extent and the circuit renders small and off-centre. On `sallen_key` the directives sit at
 * x=109.2 while the circuit starts at x=152.4 — a third of the width is annotation. That text is genuinely
 * part of the sheet and must still be *drawn*; it just should not decide the zoom.
 *
 * Falls back to the full bbox when a sheet is nothing but annotation, so a text-only sheet still frames.
 */
internal fun circuitBounds(scene: KicadScene): FloatArray? {
    var x0 = Float.MAX_VALUE; var y0 = Float.MAX_VALUE
    var x1 = -Float.MAX_VALUE; var y1 = -Float.MAX_VALUE
    var any = false
    fun eat(x: Float, y: Float) {
        any = true
        if (x < x0) x0 = x; if (y < y0) y0 = y
        if (x > x1) x1 = x; if (y > y1) y1 = y
    }
    for (p in scene.primitives) {
        // Conductors, connection points, and anything belonging to a part. Free-standing text is excluded;
        // text that belongs to a component is too, since its body already contributes.
        when (p.t) {
            "wire", "bus", "junction", "nc", "pin" -> {
                p.pts?.forEach { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
                p.at?.let { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
            }
            "poly" -> if (p.ref != null) p.pts?.forEach { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
            "rect" -> if (p.ref != null) {
                p.a?.let { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
                p.b?.let { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
            }
            "circle" -> if (p.ref != null) p.c?.let {
                if (it.size >= 2) {
                    val r = (p.r ?: 0.0).toFloat()
                    eat(it[0].toFloat() - r, it[1].toFloat() - r)
                    eat(it[0].toFloat() + r, it[1].toFloat() + r)
                }
            }
            "arc" -> if (p.ref != null) {
                p.a?.let { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
                p.b?.let { if (it.size >= 2) eat(it[0].toFloat(), it[1].toFloat()) }
            }
        }
    }
    return if (any) floatArrayOf(x0, y0, x1, y1) else null
}

/** Scale + translation that frames the circuit in the viewport with a small margin. */
private fun fitTransform(scene: KicadScene, size: Size): Pair<Float, Offset> {
    if (scene.bbox.size < 4 || size.width <= 0f || size.height <= 0f) return 1f to Offset.Zero
    val b = circuitBounds(scene)
        ?: floatArrayOf(scene.bbox[0].toFloat(), scene.bbox[1].toFloat(), scene.bbox[2].toFloat(), scene.bbox[3].toFloat())
    val (x0, y0, x1, y1) = listOf(b[0], b[1], b[2], b[3])
    val w = (x1 - x0).coerceAtLeast(1f)
    val h = (y1 - y0).coerceAtLeast(1f)
    val s = min(size.width / w, size.height / h) * 0.92f
    val cx = (x0 + x1) / 2f
    val cy = (y0 + y1) / 2f
    return s to Offset(size.width / 2f - cx * s, size.height / 2f - cy * s)
}

/** The net of the primitive nearest a tapped point, or null to clear the selection. */
private fun nearestNet(scene: KicadScene, p: Offset, tolerance: Float): String? {
    var best: String? = null
    var bestD = tolerance
    for (prim in scene.primitives) {
        val net = prim.net ?: continue
        val points = prim.pts?.mapNotNull { if (it.size >= 2) Offset(it[0].toFloat(), it[1].toFloat()) else null }
            ?: listOfNotNull(prim.anchor)
        for (i in points.indices) {
            val d = if (i + 1 < points.size) distanceToSegment(p, points[i], points[i + 1]) else (points[i] - p).getDistance()
            if (d < bestD) {
                bestD = d
                best = net
            }
        }
    }
    return best
}

/**
 * The component whose body contains `p`, if any.
 *
 * Bodies only — `rect`, `circle` and `poly` outlines of 3+ points — not pins or text. Hit-testing a pin would
 * make the pin's own `ref` win over the net the user was aiming at, and hit-testing a refdes label would
 * select a part from wherever KiCad happened to place its text.
 *
 * The **smallest** containing body wins, so a part drawn inside another (or a sub-sheet box wrapping its
 * contents) still resolves to the thing actually tapped rather than the outermost box.
 */
internal fun pickComponent(scene: KicadScene, p: Offset): Selection.Component? {
    var best: String? = null
    var bestArea = Float.MAX_VALUE
    // Only refs that are actually parts. Sheet symbols are emitted with `ref` set to their sheet name so
    // they highlight as a unit, but they are not components — `video`'s root has 7 such boxes. Picking one
    // showed a card with an empty value, empty lib_id and "0 pins", presenting a sheet as a part and
    // telling the user nothing. They fall through to net selection instead.
    val parts = scene.components.mapTo(HashSet()) { it.ref }
    for (prim in scene.primitives) {
        val ref = prim.ref ?: continue
        if (ref !in parts) continue
        val area = when (prim.t) {
            "rect" -> {
                val a = prim.a ?: continue
                val b = prim.b ?: continue
                val x0 = minOf(a[0], b[0]).toFloat(); val x1 = maxOf(a[0], b[0]).toFloat()
                val y0 = minOf(a[1], b[1]).toFloat(); val y1 = maxOf(a[1], b[1]).toFloat()
                if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue
                (x1 - x0) * (y1 - y0)
            }
            "circle" -> {
                val c = prim.c ?: continue
                val r = (prim.r ?: 0.0).toFloat()
                val d = Offset(c[0].toFloat(), c[1].toFloat()) - p
                if (d.getDistance() > r) continue
                Math.PI.toFloat() * r * r
            }
            "poly" -> {
                // A pin's lead line arrives here: it is emitted as a 2-point `poly` carrying the part's
                // `ref` (see `symbolGraphics` in the bridge), so it is a candidate in this branch. It is
                // never picked, but the 3-point floor is *not* what stops it — a 2-point polygon has two
                // edges between the same pair of points, so any even-odd crossing is counted twice and
                // cancels, and `pointInPolygon` returns false for every probe. Measured, not assumed:
                // removing this line leaves the lead tests green for horizontal and diagonal leads alike.
                // The floor stays as a cheap guard against degenerate input, not as the mechanism.
                val pts = prim.pts ?: continue
                if (pts.size < 3 || !pointInPolygon(p, pts)) continue
                polygonArea(pts)
            }
            else -> continue
        }
        if (area < bestArea) { bestArea = area; best = ref }
    }
    val ref = best ?: return null
    val meta = scene.components.firstOrNull { it.ref == ref }
    val pins = scene.primitives.count { it.t == "pin" && it.ref == ref }
    return Selection.Component(ref, meta?.value ?: "", meta?.libId ?: "", pins)
}

/** Even-odd ray cast. Symbol outlines are small polygons, so the naive form is more than fast enough. */
internal fun pointInPolygon(p: Offset, pts: List<List<Double>>): Boolean {
    var inside = false
    var j = pts.size - 1
    for (i in pts.indices) {
        if (pts[i].size < 2 || pts[j].size < 2) { j = i; continue }
        val xi = pts[i][0].toFloat(); val yi = pts[i][1].toFloat()
        val xj = pts[j][0].toFloat(); val yj = pts[j][1].toFloat()
        if ((yi > p.y) != (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside
        j = i
    }
    return inside
}

/** Shoelace area, used only to rank nested hits — sign is irrelevant. */
internal fun polygonArea(pts: List<List<Double>>): Float {
    var a = 0.0
    var j = pts.size - 1
    for (i in pts.indices) {
        if (pts[i].size < 2 || pts[j].size < 2) { j = i; continue }
        a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
        j = i
    }
    return kotlin.math.abs(a / 2.0).toFloat()
}

private fun distanceToSegment(p: Offset, a: Offset, b: Offset): Float {
    val ab = b - a
    val len2 = ab.x * ab.x + ab.y * ab.y
    if (len2 == 0f) return (p - a).getDistance()
    val t = (((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2).coerceIn(0f, 1f)
    return (p - Offset(a.x + ab.x * t, a.y + ab.y * t)).getDistance()
}

private fun DrawScope.drawScene(
    scene: KicadScene,
    pal: SchematicPalette,
    scale: Float,
    offset: Offset,
    selection: Selection?,
    eink: Boolean,
) {
    fun map(x: Double, y: Double) = Offset(x.toFloat() * scale + offset.x, y.toFloat() * scale + offset.y)
    fun map(v: List<Double>) = map(v[0], v[1])

    // Selection styling. On colour, the chosen net goes accent and the rest dims. On e-ink nothing dims
    // usefully and there is no accent, so weight carries it — the diff viewer's rule.
    fun colourFor(prim: ScenePrimitive, base: Color): Color = when {
        selection == null -> base
        selection.matches(prim) -> if (eink) base else pal.highlight
        else -> if (eink) base else pal.dimmed
    }

    fun widthFor(prim: ScenePrimitive, base: Float): Float = when {
        selection == null -> base
        selection.matches(prim) -> base * (if (eink) 3.0f else 2.0f)
        else -> base
    }

    val baseStroke = max(1f, 0.15f * scale)
    val textPaint = android.graphics.Paint() // one per frame, reused by every text primitive

    for (prim in scene.primitives) {
        when (prim.t) {
            "wire", "bus" -> {
                val pts = prim.pts ?: continue
                val base = if (prim.t == "bus") pal.bus else pal.wire
                val w = widthFor(prim, if (prim.t == "bus") baseStroke * 2.2f else baseStroke)
                for (i in 0 until pts.size - 1) {
                    if (pts[i].size < 2 || pts[i + 1].size < 2) continue
                    drawLine(colourFor(prim, base), map(pts[i]), map(pts[i + 1]), strokeWidth = w)
                }
            }
            "poly" -> {
                val pts = prim.pts ?: continue
                val w = max(1f, (prim.w ?: 0.15).toFloat() * scale)
                if (prim.fill && pts.size > 2) {
                    val path = Path().apply {
                        moveTo(map(pts[0]).x, map(pts[0]).y)
                        for (i in 1 until pts.size) lineTo(map(pts[i]).x, map(pts[i]).y)
                        close()
                    }
                    drawPath(path, pal.body.copy(alpha = 0.12f))
                }
                for (i in 0 until pts.size - 1) {
                    if (pts[i].size < 2 || pts[i + 1].size < 2) continue
                    drawLine(colourFor(prim, pal.body), map(pts[i]), map(pts[i + 1]), strokeWidth = widthFor(prim, w))
                }
            }
            "rect" -> {
                val a = prim.a ?: continue
                val b = prim.b ?: continue
                val p0 = map(a)
                val p1 = map(b)
                val topLeft = Offset(min(p0.x, p1.x), min(p0.y, p1.y))
                val size = Size(kotlin.math.abs(p1.x - p0.x), kotlin.math.abs(p1.y - p0.y))
                if (prim.fill) drawRect(pal.body.copy(alpha = 0.10f), topLeft, size)
                drawRect(colourFor(prim, pal.body), topLeft, size, style = Stroke(widthFor(prim, max(1f, (prim.w ?: 0.15).toFloat() * scale))))
            }
            "circle" -> {
                val c = prim.c ?: continue
                val r = (prim.r ?: 0.0).toFloat() * scale
                if (prim.fill) drawCircle(pal.body.copy(alpha = 0.10f), r, map(c))
                drawCircle(colourFor(prim, pal.body), r, map(c), style = Stroke(widthFor(prim, max(1f, (prim.w ?: 0.15).toFloat() * scale))))
            }
            "arc" -> {
                // Quadratic through the recorded mid-point: close enough at schematic scale, and it keeps
                // the app free of a conic solver for 297 arcs in the whole corpus.
                val a = prim.a ?: continue
                val m = prim.m ?: continue
                val b = prim.b ?: continue
                val p0 = map(a)
                val pm = map(m)
                val p1 = map(b)
                val ctrl = Offset(2f * pm.x - (p0.x + p1.x) / 2f, 2f * pm.y - (p0.y + p1.y) / 2f)
                val path = Path().apply {
                    moveTo(p0.x, p0.y)
                    quadraticBezierTo(ctrl.x, ctrl.y, p1.x, p1.y)
                }
                drawPath(path, colourFor(prim, pal.body), style = Stroke(widthFor(prim, max(1f, (prim.w ?: 0.15).toFloat() * scale))))
            }
            "junction" -> {
                val at = prim.at ?: continue
                drawCircle(colourFor(prim, pal.junction), max(1.5f, 0.5f * scale), map(at))
            }
            "nc" -> {
                val at = prim.at ?: continue
                val p = map(at)
                val d = max(2f, 0.6f * scale)
                drawLine(pal.noConnect, Offset(p.x - d, p.y - d), Offset(p.x + d, p.y + d), strokeWidth = baseStroke)
                drawLine(pal.noConnect, Offset(p.x - d, p.y + d), Offset(p.x + d, p.y - d), strokeWidth = baseStroke)
            }
            "pin" -> {
                val at = prim.at ?: continue
                drawCircle(colourFor(prim, pal.pin), max(1.5f, 0.35f * scale), map(at))
            }
            "text" -> drawSceneText(prim, pal, scale, ::map, selection, eink, textPaint)
        }
    }
}

/**
 * Text via the native canvas — Compose's `drawText` needs a TextMeasurer per string, which at a few
 * hundred labels per sheet is measurably worse than asking Skia directly.
 */
private fun DrawScope.drawSceneText(
    prim: ScenePrimitive,
    pal: SchematicPalette,
    scale: Float,
    map: (List<Double>) -> Offset,
    selection: Selection?,
    eink: Boolean,
    paint: android.graphics.Paint,
) {
    val at = prim.at ?: return
    val s = prim.s ?: return
    val px = ((prim.size ?: 1.27) * scale).toFloat()
    if (px < 4f) return // below legibility; drawing it is just noise and costs time

    val isLabel = prim.kind?.contains("label") == true
    val base = if (isLabel) pal.label else pal.text
    val colour = when {
        selection == null -> base
        selection.matches(prim) -> if (eink) base else pal.highlight
        prim.net != null || prim.ref != null -> if (eink) base else pal.dimmed
        else -> base
    }
    val origin = map(at)
    drawContext.canvas.nativeCanvas.apply {
        // `paint` is reused across every text primitive in the frame, not allocated per string. The
        // densest demo sheets carry 356-431 text primitives, so allocating here cost ~26k Paints/second
        // during a pan — GC pressure on precisely the gesture that has to stay smooth, and worse on
        // e-ink where each redraw is expensive.
        paint.reset()
        paint.isAntiAlias = !eink // e-ink panels ghost on antialiased edges; crisp text reads better
        paint.textSize = px
        paint.color = android.graphics.Color.argb(
            (colour.alpha * 255).toInt(), (colour.red * 255).toInt(),
            (colour.green * 255).toInt(), (colour.blue * 255).toInt(),
        )
        paint.isFakeBoldText = eink && selection != null && selection.matches(prim)
        paint.textAlign = when (prim.hjust) {
            "right" -> android.graphics.Paint.Align.RIGHT
            "left" -> android.graphics.Paint.Align.LEFT
            else -> android.graphics.Paint.Align.CENTER
        }
        // KiCad's vertical justify is about the text box, not the baseline; approximate it.
        val dy = when (prim.vjust) {
            "top" -> px
            "bottom" -> 0f
            else -> px * 0.35f
        }
        for ((i, line) in s.split('\n').withIndex()) {
            drawText(line, origin.x, origin.y + dy + i * px * 1.2f, paint)
        }
    }
}

@Composable
private fun SheetSwitcher(scene: KicadScene, eink: Boolean, onSelect: (String) -> Unit) {
    LazyRow(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(scene.sheets, key = { it.path }) { sheet ->
            val selected = sheet.path == scene.path
            Text(
                text = if (sheet.name == "/") "root" else sheet.name,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .pointerInput(sheet.path) { detectTapGestures { onSelect(sheet.path) } }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** Rough perceptual luminance, used by both KiCad viewers to pick a light/dark palette. */
internal fun Color.luminance(): Float = 0.299f * red + 0.587f * green + 0.114f * blue
