package com.gitview.app.ui.kicad

/**
 * The two decisions a KiCad tab makes that are *rules* rather than plumbing (ADR-038).
 *
 * Both lived inside coroutines in `AppViewModel`, where nothing could reach them, and both shipped
 * wrong at least once — the first as an out-of-memory crash on a 66 MB board, the second as a refresh
 * that silently discarded the layers the user had picked. They are pure, so they belong somewhere a
 * test can call them.
 */

/**
 * Is this a file the KiCad viewer draws rather than the editor shows?
 *
 * Load-bearing beyond the viewer's own routing: a tab that answers yes must **not** fetch the blob on
 * open. The drawing comes from the bridge already reduced to a scene, so downloading the source as well
 * buys nothing and costs everything — `vme-wren.kicad_pcb` is 66 MB, and asking for it as a string
 * killed the app with a 157 MB allocation before a single trace was drawn.
 */
fun isKicadPath(path: String): Boolean =
    path.endsWith(".kicad_sch", ignoreCase = true) || path.endsWith(".kicad_pcb", ignoreCase = true)

/**
 * Which layers a board tab should draw once its index arrives.
 *
 * `previouslyShown == null` means a first open, and is the whole difference. On a first open we choose
 * for the user: the board outline, plus copper when a net is being probed, because a cross-probe that
 * lands on a board showing only its outline has highlighted nothing visible.
 *
 * On a **re-solve** — the file changed on disk, or a refresh came through — we keep what the user
 * asked for. Resetting to the outline because a file changed throws away their choice for a reason
 * that has nothing to do with it. Intersecting with the live set is what stops that from resurrecting
 * a layer the edit emptied.
 */
fun boardLayersToShow(
    live: Set<String>,
    previouslyShown: Set<String>?,
    probing: Boolean,
): Set<String> =
    if (previouslyShown == null) {
        live.filterTo(mutableSetOf()) { it == "Edge.Cuts" || (probing && it.endsWith(".Cu")) }
    } else {
        previouslyShown intersect live
    }

/**
 * Where the view lands after a pinch.
 *
 * The rule is that the point under the fingers stays under the fingers. `scale *= zoom` with
 * `offset += pan` instead scales about the canvas *origin*, so the board accelerates away as you zoom —
 * one pinch on `vme-wren` left an empty canvas. Extracted for the same reason as the two rules above:
 * it is pure arithmetic that shipped wrong, and a device is a poor place to notice it going wrong again.
 *
 * The clamp bounds are deliberate: 0.05 keeps a board that has been zoomed out still selectable rather
 * than a dot, and 80 is past the point where a 0.1 mm trace fills the screen. Beyond either, floating
 * point starts to cost more precision than the zoom buys.
 */
fun zoomAbout(
    centroidX: Float, centroidY: Float,
    offsetX: Float, offsetY: Float,
    scale: Float,
    zoom: Float,
    panX: Float, panY: Float,
): Triple<Float, Float, Float> {
    if (scale <= 0f) return Triple(offsetX, offsetY, scale)
    val next = (scale * zoom).coerceIn(MIN_BOARD_SCALE, MAX_BOARD_SCALE)
    val k = next / scale
    return Triple(
        centroidX - (centroidX - offsetX) * k + panX,
        centroidY - (centroidY - offsetY) * k + panY,
        next,
    )
}

const val MIN_BOARD_SCALE = 0.05f
const val MAX_BOARD_SCALE = 80f
/**
 * The component nearest [x],[y] that has a 3D model, within [tolerance] mm — or null.
 *
 * Separate from `nearestNet`: that one hit-tests *drawables* on visible layers, because a net lives on
 * tracks and pads. A part lives at its placement, which is drawn only as silkscreen and may not be on a
 * layer the user has switched on — so this searches `board.components` directly and works even when
 * nothing but the outline is shown.
 *
 * Components without a model are skipped rather than returned-and-rejected: on `vme-wren` only 164 of
 * 1,508 placements have a mesh, so offering the nearest *component* would usually offer one with nothing
 * behind it.
 */
fun nearestPart(
    components: List<com.gitview.app.data.BoardComponent>,
    x: Float,
    y: Float,
    tolerance: Float,
    hasModel: (String) -> Boolean,
): Pair<String, String>? {
    var best: Pair<String, String>? = null
    var bestD = tolerance * tolerance
    for (c in components) {
        val model = c.models.firstOrNull(hasModel) ?: continue
        if (c.at.size < 2) continue
        val dx = c.at[0].toFloat() - x
        val dy = c.at[1].toFloat() - y
        val d = dx * dx + dy * dy
        if (d <= bestD) { bestD = d; best = c.ref to model }
    }
    return best
}
