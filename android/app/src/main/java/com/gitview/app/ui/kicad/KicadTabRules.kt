package com.gitview.app.ui.kicad

import kotlin.math.pow

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
 * Is this the file that names a whole KiCad design (ADR-040)?
 *
 * The project file is what a person means when they say they are opening a board: it is what KiCad
 * itself opens, and the schematic and PCB are halves of it. Recognised separately from [isKicadPath]
 * because it behaves differently — there is nothing to *draw* in a `.kicad_pro`, so it is never a scene
 * or a board fetch; it is a request for the project's shape, which the bridge answers.
 */
fun isKicadProjectPath(path: String): Boolean = path.endsWith(".kicad_pro", ignoreCase = true)

/**
 * Anything the KiCad viewer has an opinion about — a project or either of its halves.
 *
 * Case-insensitive throughout, and that is not decoration: the corpus has 22 references written in a
 * non-canonical case, and the bridge's own routes had to be fixed after a `Board.KICAD_PCB` came back as
 * "not found" from a file sitting right there.
 */
fun isKicadDesignPath(path: String): Boolean = isKicadPath(path) || isKicadProjectPath(path)

/** The tabs a KiCad project view can show. */
enum class KicadTab { SCHEMATIC, BOARD, THREE_D }

/**
 * Which tabs a project view offers, in order, given what the bridge says exists.
 *
 * **Never a fixed triple.** Measured over the KiCad 10 demos: of 36 projects, 17 have both halves, 18
 * are schematic-only and 1 is board-only — so a hard `schematic | pcb | 3D` shows at least one dead tab
 * on more than half of them.
 *
 * **3D is not offered yet, deliberately.** The tab exists in [KicadTab] and the assembled-board renderer
 * does not, so wiring it now would give it the board's own view under a label promising something else —
 * the same "viewer that lies" shape this project has had to unpick more than once. It comes back with
 * the renderer, and `hasBoard` is already the condition it will use, since a board is what 3D is built
 * from.
 */
fun projectTabs(hasSchematic: Boolean, hasBoard: Boolean): List<KicadTab> = buildList {
    if (hasSchematic) add(KicadTab.SCHEMATIC)
    if (hasBoard) add(KicadTab.BOARD)
}

/**
 * Which tab to land on, given the file the user actually opened.
 *
 * Opening a `.kicad_pcb` and being shown the schematic would be a small betrayal of the tap; opening the
 * project file itself has no such preference, so it takes the first tab there is. A sub-sheet is a
 * schematic, so it lands on the schematic tab and the sheet tree does the rest.
 */
fun initialTab(requested: String, tabs: List<KicadTab>): KicadTab? = when {
    tabs.isEmpty() -> null
    requested.endsWith(".kicad_pcb", ignoreCase = true) && KicadTab.BOARD in tabs -> KicadTab.BOARD
    requested.endsWith(".kicad_sch", ignoreCase = true) && KicadTab.SCHEMATIC in tabs -> KicadTab.SCHEMATIC
    else -> tabs.first()
}

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

/**
 * How far back the camera must sit to fit a part of the given bounding radius.
 *
 * `distance = radius * 3` looked reasonable and is not: it never mentions the field of view or the
 * viewport, so the same part that frames well in a tablet's wide pane is clipped at the edges of a
 * phone's tall one — observed on both.
 *
 * A sphere of [radius] fits when the camera sits at `radius / sin(halfAngle)`. The vertical half-angle
 * comes from the projection; the horizontal one follows from the aspect. Whichever is *smaller* is the
 * constraint, because that is the axis the part runs out of room on first — for a wide part in a narrow
 * viewport that is the horizontal one, which is precisely the case the old formula got wrong.
 */
/**
 * The 3D viewer's backdrop and its fallback part colour, both **linear** — the space Filament's
 * `Skybox` and material `baseColor` take, not the sRGB a theme hands out.
 */
data class ViewerPalette(
    val backdrop: Triple<Float, Float, Float>,
    val part: Triple<Float, Float, Float>,
)

/** sRGB component → linear. */
private fun toLinear(c: Float): Float =
    if (c <= 0.04045f) c / 12.92f else ((c + 0.055f) / 1.055f).pow(2.4f)

/** Linear component → sRGB. */
private fun toSrgb(c: Float): Float =
    if (c <= 0.0031308f) c * 12.92f else 1.055f * c.pow(1f / 2.4f) - 0.055f

/** WCAG relative luminance of an sRGB colour. */
fun relativeLuminance(r: Float, g: Float, b: Float): Float =
    0.2126f * toLinear(r) + 0.7152f * toLinear(g) + 0.0722f * toLinear(b)

/** WCAG contrast between two relative luminances, always >= 1. */
fun contrastRatio(l1: Float, l2: Float): Float {
    val hi = kotlin.math.max(l1, l2)
    val lo = kotlin.math.min(l1, l2)
    return (hi + 0.05f) / (lo + 0.05f)
}

/** The contrast the viewer guarantees between an unpainted part and its backdrop. */
const val VIEWER_MIN_CONTRAST = 4.5f

/**
 * The unpainted-part greys, linear. [PART_LIGHT] is the constant the dark theme shipped with — kept
 * exactly, so deriving the palette from the theme cannot make that case worse than it already was.
 *
 * [PART_DARK] is deliberately **not** as dark as it could be. Pushed to 0.02 it measured 14.3:1 on the
 * e-ink profile and rendered as a black silhouette: the facet shading that makes the part read as a
 * solid disappeared, so the shape was harder to see at the higher ratio. Contrast is the floor this
 * has to clear, not the quantity to maximise — the part still has to look like an object.
 */
const val PART_LIGHT = 0.62f
const val PART_DARK = 0.15f

/**
 * Colours for the 3D viewer, derived from the theme background it sits in (ADR-038, Phase 4a.3).
 *
 * Both values were hardcoded — a `0.10, 0.11, 0.13` skybox and a `0.62, 0.64, 0.67` part — so the
 * viewport was the same slab of grey on every profile. Measured on captures of the same build: an
 * unpainted part landed at **2.4:1** against it on the Color E-Ink profile and **3.5:1** on Standard
 * dark, the difference being only which way the lights happened to fall. The surrounding e-ink UI runs
 * near 20:1, so the viewport read as a foreign panel dropped into the page — and e-ink is the display
 * with no backlight to recover the difference.
 *
 * The board viewer never had this problem because it draws through Compose and picks up
 * `MaterialTheme.colorScheme` for free ([BoardView] keys off `background.luminance()`). Filament draws
 * outside Compose, so the theme has to be carried across by hand.
 *
 * The backdrop keeps the theme's hue and shifts slightly away from the pane, so the viewport still
 * reads as its own surface rather than a hole — that was the point of the original flat colour, and a
 * viewport indistinguishable from a failed load is the thing being avoided.
 *
 * The part colour picks the side with more room and only *then* checks the floor. Solving directly for
 * [VIEWER_MIN_CONTRAST] instead is a trap this went through: it lands the part exactly on the floor, so
 * a dark theme that already had 8:1 of albedo separation gets pulled down to 4.5 and measured **worse**
 * on screen than before the fix (3.50:1 → 2.86:1 rendered, on the tablet). The floor is a guarantee to
 * exceed, not a target to hit.
 *
 * Picking the side by a luminance threshold is the other trap: a backdrop just below the line takes the
 * light branch and lands near 1.4:1. Comparing both candidates has no such edge, and the solve is kept
 * only for the narrow mid-grey band where neither candidate clears the floor on its own.
 *
 * This bounds the *albedo* contrast. Lighting still modulates what reaches the screen — the rendered
 * part is consistently darker than its albedo — so the on-screen figure is measured on a device rather
 * than claimed from here.
 */
fun viewerPalette(groundR: Float, groundG: Float, groundB: Float): ViewerPalette {
    val dark = relativeLuminance(groundR, groundG, groundB) < 0.5f
    // Keep the hue, move off the pane: lighter on a dark theme, darker on a light one.
    val t = if (dark) 0.10f else 0.06f
    val target = if (dark) 1f else 0f
    val bR = groundR + (target - groundR) * t
    val bG = groundG + (target - groundG) * t
    val bB = groundB + (target - groundB) * t

    val bl = relativeLuminance(bR, bG, bB)
    // Two candidates, then take whichever separates further. PART_LIGHT is the value the dark theme
    // shipped with and looked right at; keeping it verbatim is why this change leaves that theme alone.
    val lightRatio = contrastRatio(PART_LIGHT, bl)
    val darkRatio = contrastRatio(PART_DARK, bl)
    val p = if (kotlin.math.max(lightRatio, darkRatio) >= VIEWER_MIN_CONTRAST) {
        if (lightRatio >= darkRatio) PART_LIGHT else PART_DARK
    } else {
        // A mid-grey backdrop can leave both candidates short. Pick the side by how far it can
        // *reach* — pure white vs pure black — not by which candidate scored better: against a 0.22
        // backdrop the light candidate wins on points yet tops out at 3.9:1, while black reaches 5.4:1.
        //
        // The floor is always attainable. max(toWhite, toBlack) is minimised where the two are equal,
        // at bl = sqrt(0.0525) ≈ 0.229, and there it is 4.58 — which is why 4.5 is the floor and not a
        // rounder, unreachable 5.
        val toWhite = contrastRatio(1f, bl)
        val toBlack = contrastRatio(0f, bl)
        if (toWhite >= toBlack) (VIEWER_MIN_CONTRAST * (bl + 0.05f) - 0.05f).coerceAtMost(1f)
        else ((bl + 0.05f) / VIEWER_MIN_CONTRAST - 0.05f).coerceAtLeast(0f)
    }

    return ViewerPalette(
        backdrop = Triple(toLinear(bR), toLinear(bG), toLinear(bB)),
        part = Triple(p, p, p),
    )
}

/** sRGB grey whose relative luminance is [linear] — for asserting what [viewerPalette] returns. */
fun linearToSrgbComponent(linear: Float): Float = toSrgb(linear)

fun fitDistance(radius: Float, verticalFovDegrees: Float, aspect: Float, margin: Float = 1.15f): Float {
    val vHalf = Math.toRadians((verticalFovDegrees / 2f).toDouble()).toFloat()
    // A degenerate viewport (0-width before first layout) must not produce an infinite or NaN distance.
    val a = if (aspect.isFinite() && aspect > 0f) aspect else 1f
    val hHalf = kotlin.math.atan(kotlin.math.tan(vHalf) * a)
    val limiting = kotlin.math.min(vHalf, hHalf)
    if (limiting <= 0f) return radius * 3f
    return (radius / kotlin.math.sin(limiting)) * margin
}
