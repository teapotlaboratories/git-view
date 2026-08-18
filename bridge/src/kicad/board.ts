/**
 * Reading a `.kicad_pcb` into a per-layer board scene (ADR-038, Phase 3).
 *
 * A board is not "a bigger schematic", and the numbers say so. On the largest KiCad 10 demo
 * (`jetson-agx-thor-baseboard`, 83 MB):
 *
 *   copper tracks, all layers   19,835   ≈1.3 MB     estimate, tracks only
 *   zone fill vertices         523,351   ≈11 MB      125 zones
 *   User.9 (a *user overlay*)  286,742 refs          one person's annotation, not structure
 *
 * Those were regex estimates made while planning. **Measured through this reader**, a real layer request
 * is bigger, because a layer holds more than tracks — pads, footprint silk and zone fills all land on it:
 *
 *   parse the 81 MB file      6.0 s   once, then every layer is served from the tree
 *   index (no geometry)       1.3 s   37 layers · 1,125 components · 1,387 nets
 *   F.Cu                     12,579 prims  1,622 KB  0.69 s   ← the real worst case, not 437 KB
 *   F.Cu without zones       12,530 prims  1,421 KB  0.66 s
 *   B.Cu                     10,087 prims  1,315 KB  0.68 s
 *   B.SilkS                     537 prims     53 KB  0.63 s
 *   Edge.Cuts                     6 prims      1 KB  0.62 s
 *
 * Three consequences, all decided before this file existed and none invalidated by the above:
 *
 *  - **Per layer, no streaming.** 1.6 MB is a large but ordinary response, and it is the *worst* layer on
 *    the largest board in the corpus. The 27 MB "whole board" figure is an artefact of one overlay layer.
 *    (Known cost, not yet paid: each layer re-walks the tree for ~0.65 s. A per-layer index built during
 *    `parseBoard` would make that near-zero; deliberately deferred until a client makes it matter.)
 *  - **Zones ship KiCad's own `filled_polygon`.** Re-deriving them means clearances, thermal reliefs and
 *    island removal — a solver the size of Phase 0 that would be wrong invisibly. The file has the answer.
 *  - **Its own primitive union.** A track has a width and a layer; a via spans two layers; a pad spans
 *    three and carries shape, rotation and a corner ratio. A schematic primitive has none of those, and
 *    one shared type would leave both renderers reading something that half-describes their world.
 *
 * **Nets are already solved here.** Unlike a schematic, every track, via and pad carries its net, so
 * there is nothing to derive — highlighting is a filter. The net *names* come from the board's own
 * `(net N "name")` table, which is what lets schematic ⇄ board cross-probe key on a shared name.
 */
import { parseSexpr, children, child, nums, descendants, type SNode } from "./sexpr.js";

export type Pt = [number, number];

/**
 * A drawable on a board. Deliberately **not** the schematic's `Primitive` — see the header. Every variant
 * carries the layer(s) it lives on, because layer visibility is the mechanism that makes a board
 * tractable rather than a display preference.
 *
 * **One key, one type.** `text` used to carry its font size as `size: number` while `pad` carries
 * `size: Pt` — the same key with two shapes. A strict client cannot model that: the app decoded `size` as
 * an array, so a single `text` primitive threw and took the *whole layer* with it. `video.kicad_pcb` has
 * no text on `F.Cu` and worked; `vme-wren` has three, and its 20,887-primitive copper layer silently drew
 * nothing. The schema-less stance is about unknown *kinds* degrading gracefully — it was never a licence
 * to overload a field name.
 */
export type BoardPrimitive =
  | { t: "track"; a: Pt; b: Pt; w: number; layer: string; net?: string }
  | { t: "arc"; a: Pt; m: Pt; b: Pt; w: number; layer: string; net?: string }
  | { t: "via"; at: Pt; d: number; drill: number; layers: string[]; net?: string }
  | { t: "pad"; at: Pt; size: Pt; rot?: number; shape: string; layers: string[]; ref: string; net?: string }
  | { t: "line"; a: Pt; b: Pt; w: number; layer: string; ref?: string }
  | { t: "poly"; pts: Pt[]; layer: string; ref?: string; fill?: boolean }
  | { t: "circle"; c: Pt; r: number; w: number; layer: string; ref?: string }
  | { t: "text"; at: Pt; s: string; fontSize: number; rot?: number; layer: string; ref?: string }
  | { t: "zone"; pts: Pt[]; layer: string; net?: string };

export interface BoardLayer {
  /** Canonical name, e.g. `F.Cu`, `In3.Cu`, `B.SilkS`. */
  name: string;
  /** `signal`, `user`, `power`, … from the layer table. */
  kind: string;
  /** How many primitives sit on it — lets a client decide what is worth asking for. */
  count: number;
}

export interface BoardComponent {
  ref: string;
  value: string;
  libId: string;
  at: Pt;
  rot?: number;
  layer: string;
  /**
   * The 3D models this footprint references, raw.
   *
   * Coverage counts *unique* models across the board, which answers "can this board be shown" but not
   * "what does R12 look like" — and without that, a tap on a component has nothing to open. Carried per
   * component rather than looked up by `libId`: two footprints of the same library part can override
   * their models individually, so the association is a property of the placement, not of the library.
   *
   * Usually one entry; occasionally several (a connector with a separate shroud), and often none.
   *
   * **Models the board hides are not here** — see [BoardComponent.placements].
   */
  models?: string[];
  /**
   * The same models with the transform each one is placed by (ADR-040 Decision 6).
   *
   * Parallel to [models] rather than replacing it because the two answer different questions: `models`
   * is a list of *lookup keys* for the mesh endpoint, which is all a tap-to-open-one-part view needs,
   * while an assembled board has to know **where** each mesh goes. Dropping the transform is not a
   * rounding error — measured over the corpus, **962 of 3,611** model blocks carry a non-zero `offset`
   * and 360 a non-zero `rotate`, so a board drawn without them has a quarter of its parts in the wrong
   * place, which reads as a rendering bug rather than as missing data.
   *
   * Omitted entirely when the footprint has no visible model, and each field within an entry is omitted
   * when it is the identity — this rides on the largest response the bridge sends, and the common case
   * is all three at their defaults.
   */
  placements?: ModelPlacement[];
}

/**
 * Where one model sits relative to its footprint.
 *
 * KiCad writes all three on essentially every model block (3,606 of 3,611 carry `rotate` and `scale`,
 * all 3,611 carry `offset`), overwhelmingly at their defaults — so they are stored only when they are
 * *not* the identity.
 */
export interface ModelPlacement {
  /** The raw reference — the same string [BoardComponent.models] carries, and the mesh endpoint's key. */
  model: string;
  /** Millimetres, relative to the footprint origin. Absent when zero. */
  offset?: [number, number, number];
  /** Absent when 1,1,1. */
  scale?: [number, number, number];
  /** Degrees. Absent when zero. */
  rotate?: [number, number, number];
}

export interface Board {
  version: number;
  /** Every declared layer with its population, so a client can pick before fetching. */
  layers: BoardLayer[];
  components: BoardComponent[];
  /** Net names present on the board, sorted. Already explicit in the file — nothing is derived. */
  nets: string[];
  /** `[minX, minY, maxX, maxY]` in mm over the board outline if present, else everything drawable. */
  bbox: [number, number, number, number];
  /** 3D model coverage — what *could* be rendered, before anything is fetched. See [ModelCoverage]. */
  models: ModelCoverage;
  problems: string[];
}

/** A layer's drawables, fetched on demand. Kept apart from `Board` so the index stays small. */
export interface BoardLayerScene {
  layer: string;
  primitives: BoardPrimitive[];
  /** True when the layer was truncated — see `MAX_LAYER_PRIMITIVES`. */
  truncated: boolean;
  problems: string[];
}

/**
 * Caps on primitives returned for one layer. Two of them, because one number was wrong.
 *
 * The cap started at a flat 20,000, justified by a single board: `User.9` on `jetson-agx-thor-baseboard`
 * carries 286,621 elements — an overlay somebody filled with annotation — while its `F.Cu` sits at 12,581.
 * That looked like ample headroom. Surveying the rest of the corpus killed it:
 *
 * | board | F.Cu | worst layer |
 * | --- | --- | --- |
 * | StickHub | 976 | — |
 * | CM5_MINIMA_3 | 1,794 | — |
 * | kit-dev-coldfire-xilinx_5213 | 2,312 | — |
 * | video | 5,376 | — |
 * | jetson-agx-thor-baseboard | 12,581 | `User.9` 286,621 |
 * | **vme-wren** | **20,887** | `F.Cu` 20,887 |
 *
 * `vme-wren`'s `F.Cu` is over the flat cap, so a *copper* layer was being silently shortened by 4% —
 * missing traces on the one layer the whole feature exists to show. That is the viewer-that-lies failure,
 * arriving through the mechanism meant to prevent it.
 *
 * So the cap is by **role, not by one number**. Structural layers — copper, silkscreen, board outline —
 * are the drawing; they get a ceiling high enough that nothing real hits it (5× the worst measured), kept
 * only as a backstop against a hostile file. Everything else — fab, courtyard, adhesive, paste, user
 * overlays — is annotation nobody is reading on a phone, and keeps the tight cap.
 *
 * Truncation is reported either way. A partial layer that looks complete is the original problem.
 */
export const MAX_LAYER_PRIMITIVES = 20_000;
export const MAX_STRUCTURAL_PRIMITIVES = 100_000;

/**
 * Is this layer part of the drawing, or annotation on top of it?
 *
 * KiCad's own `kind` marks copper as `signal`, but files it and `Edge.Cuts` and `B.SilkS` all as `user`,
 * so the declared kind alone cannot separate a board outline from a scratch overlay. Name is what
 * distinguishes them.
 */
export function isStructuralLayer(name: string, kind: string): boolean {
  return kind === "signal" || /\.Cu$/.test(name) || name === "Edge.Cuts" || /^[FB]\.SilkS$/.test(name);
}

export function capFor(name: string, kind: string): number {
  return isStructuralLayer(name, kind) ? MAX_STRUCTURAL_PRIMITIVES : MAX_LAYER_PRIMITIVES;
}

const pt = (v: number[]): Pt => [v[0] ?? 0, v[1] ?? 0];

/**
 * Does a `(model …)` block say not to show this one?
 *
 * **Two different shapes, not two spellings** — checked against both corpora rather than assumed, because
 * the guess was wrong. KiCad 7 writes a **bare atom on the model list itself**:
 *
 * ```
 * (model "${KISYS3DMOD}/Connector_JST.3dshapes/JST_SH…step" hide
 *   (offset (xyz 0 1.325 0))
 * ```
 *
 * while KiCad 10 writes a **child list**, `(hide yes)`. A `child(model, "hide")` lookup finds only the
 * second, so reading the newer form alone would silently draw every part a v6–v8 author had switched
 * off. `StickHub` at v7 is exactly that board.
 *
 * `(hide no)` must not count, which is why the child branch inspects the value rather than the tag's
 * existence. A bare `(hide)` with no value is read as hiding, matching how the flag forms read elsewhere
 * in the format.
 */
function isHidden(model: SNode[]): boolean {
  // v6/v7: a bare `hide` among the list's own elements, after the path at index 1.
  for (let i = 2; i < model.length; i += 1) if (model[i] === "hide") return true;
  // v8+: `(hide yes)`.
  const h = child(model, "hide");
  if (!h) return false;
  return h[1] === undefined || h[1] === "yes";
}

/** `(offset (xyz 1 2 3))` → the three numbers, or undefined when the node is absent or malformed. */
function xyz(node: SNode[], tag: string): [number, number, number] | undefined {
  const outer = child(node, tag);
  if (!outer) return undefined;
  const v = nums(outer, "xyz");
  if (v.length < 3) return undefined;
  return [v[0]!, v[1]!, v[2]!];
}

/** Is this placement anything other than the identity? See [ModelPlacement]. */
const isPlaced = (p: ModelPlacement): boolean =>
  p.offset !== undefined || p.scale !== undefined || p.rotate !== undefined;

/** Read one model's transform, keeping only what differs from the default. */
function placementOf(raw: string, model: SNode[]): ModelPlacement {
  const offset = xyz(model, "offset");
  const scale = xyz(model, "scale");
  const rotate = xyz(model, "rotate");
  const zero = (v?: [number, number, number]) => v && v.every((n) => n === 0);
  const one = (v?: [number, number, number]) => v && v.every((n) => n === 1);
  return {
    model: raw,
    ...(offset && !zero(offset) ? { offset } : {}),
    ...(scale && !one(scale) ? { scale } : {}),
    ...(rotate && !zero(rotate) ? { rotate } : {}),
  };
}

/** `(net 3 "GND")` on the board's net table → id → name. Tracks reference nets by integer. */
function netTable(root: SNode[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const n of children(root, "net")) {
    const id = typeof n[1] === "number" ? n[1] : Number(n[1]);
    if (Number.isFinite(id)) out.set(id, typeof n[2] === "string" ? n[2] : "");
  }
  return out;
}

/** The layer stack, as declared. `(0 "F.Cu" signal)` / `(55 "User.9" user "overlay")`. */
function layerTable(root: SNode[]): { name: string; kind: string }[] {
  const block = child(root, "layers");
  if (!block) return [];
  const out: { name: string; kind: string }[] = [];
  for (const row of block.slice(1)) {
    if (!Array.isArray(row)) continue;
    const name = row[1];
    const kind = row[2];
    if (typeof name === "string") out.push({ name, kind: typeof kind === "string" ? kind : "" });
  }
  return out;
}

/** Layer(s) of an element: `(layer "F.Cu")` or `(layers "F.Cu" "B.Cu")`. */
function layersOf(node: SNode[]): string[] {
  const one = child(node, "layer");
  if (one && typeof one[1] === "string") return [one[1]];
  const many = child(node, "layers");
  if (many) return many.slice(1).filter((x): x is string => typeof x === "string");
  return [];
}

function netOf(node: SNode[], nets: Map<number, string>): string | undefined {
  const n = child(node, "net");
  if (!n) return undefined;
  const id = typeof n[1] === "number" ? n[1] : Number(n[1]);
  // A pad writes `(net 1 "GND")`; a track writes `(net 1)` and the name comes from the table.
  if (typeof n[2] === "string" && n[2]) return n[2];
  return Number.isFinite(id) ? nets.get(id) : undefined;
}

/**
 * Read the board index: layer stack with populations, components, nets and extent — but **no geometry**.
 *
 * This is what a client asks for first. It is small on any board, and it is what makes the per-layer
 * decision informed rather than a guess: a layer's `count` tells you before you fetch it.
 */
/**
 * A parsed board, held so layers can be served without re-parsing.
 *
 * Measured before adding this: `readBoardLayer` used to take the raw text and parse it each time, which
 * cost **6.5 seconds per layer** on the 81 MB demo — parsing dominated, and a client toggling three
 * layers paid it three times. Parsing once and keeping the tree makes every subsequent layer nearly free.
 */
export interface ParsedBoard {
  root: SNode[];
  nets: Map<number, string>;
  layers: { name: string; kind: string }[];
}

export function parseBoard(text: string): ParsedBoard {
  const root = parseSexpr(text);
  return { root, nets: netTable(root), layers: layerTable(root) };
}

export function readBoard(parsed: ParsedBoard, knownVars: ReadonlySet<string> = new Set()): Board {
  const { root, nets } = parsed;
  const declared = parsed.layers;
  const problems: string[] = [];

  // Population per layer, counted across everything that declares one.
  const pop = new Map<string, number>();
  const bump = (l: string) => pop.set(l, (pop.get(l) ?? 0) + 1);
  for (const tag of ["segment", "arc", "via", "zone", "gr_line", "gr_circle", "gr_text", "gr_poly", "gr_arc"]) {
    for (const n of children(root, tag)) for (const l of layersOf(n)) bump(l);
  }
  for (const fp of children(root, "footprint")) {
    for (const n of descendants(fp, "fp_line")) for (const l of layersOf(n)) bump(l);
    for (const n of descendants(fp, "fp_poly")) for (const l of layersOf(n)) bump(l);
    for (const n of descendants(fp, "fp_circle")) for (const l of layersOf(n)) bump(l);
    for (const n of descendants(fp, "fp_text")) for (const l of layersOf(n)) bump(l);
    for (const n of descendants(fp, "pad")) for (const l of layersOf(n)) bump(l);
  }

  const components: BoardComponent[] = [];
  // 3D model coverage, gathered on the walk we are already doing. Counts are over UNIQUE models because
  // reuse is ~22x — `vme-wren` makes 1,480 references to 66 distinct models, and it is the 66 that would
  // ever have to be fetched or converted.
  const seenModels = new Set<string>();
  // Models stored in the file itself. Two filters, and both are load-bearing:
  //
  //  - **a payload**, not a declaration. Each footprint declares the embedded file it uses; the bytes
  //    appear once at board level. `vme-wren` has 155 declarations against 45 payloads.
  //  - **`(type model)`**. A board embeds more than geometry — `vme-wren` carries 12 PDF datasheets
  //    alongside its 33 models. Listing those as models would have us claim a part is renderable and
  //    then hand a renderer a PDF.
  const embedded = new Set<string>();
  for (const ef of descendants(root, "embedded_files")) {
    for (const f of children(ef, "file")) {
      const name = child(f, "name")?.[1];
      const type = child(f, "type")?.[1];
      if (typeof name === "string" && type === "model" && child(f, "data")) embedded.add(name);
    }
  }
  const byOrigin: Record<ModelOrigin, number> = { project: 0, configured: 0, unmapped: 0, absolute: 0, embedded: 0 };
  const byVariable: Record<string, number> = {};
  let modelRefs = 0;
  let footprintsWithModel = 0;

  for (const fp of children(root, "footprint")) {
    const at = nums(fp, "at");
    let ref = "";
    let value = "";
    for (const p of children(fp, "property")) {
      if (p[1] === "Reference" && typeof p[2] === "string") ref = p[2];
      if (p[1] === "Value" && typeof p[2] === "string") value = p[2];
    }
    // KiCad 6/7 keep the refdes in `(fp_text reference "C1" …)`; `(property …)` on a footprint is a v8+
    // spelling. Reading only the new one is not a partial result on an older board, it is a total one:
    // the index ends with `components.filter(c => c.ref)`, so **every** component is dropped. Measured
    // across the v7 corpus — 0 `(property "Reference")` and 94/189/68/… `fp_text` — which meant a v6/v7
    // board reported zero components, and with them went cross-probe and every 3D part.
    if (!ref || !value) {
      for (const t of children(fp, "fp_text")) {
        if (!ref && t[1] === "reference" && typeof t[2] === "string") ref = t[2];
        if (!value && t[1] === "value" && typeof t[2] === "string") value = t[2];
      }
    }
    let hasModel = false;
    const fpModels: string[] = [];
    const fpPlacements: ModelPlacement[] = [];
    for (const m of children(fp, "model")) {
      if (typeof m[1] !== "string") continue;
      const raw = m[1];
      // `(hide yes)` is the board saying "do not show this one" — the Show checkbox on a footprint's 3D
      // tab. Skipped entirely rather than carried with a flag: every consumer of this list wants models
      // it may draw, and one that forgets to check the flag draws a part the author switched off. It
      // also keeps coverage honest, since a hidden model is not a mesh anybody is missing. 55 of 3,611
      // model blocks in the corpus are hidden.
      if (isHidden(m)) continue;
      hasModel = true;
      modelRefs += 1;
      fpModels.push(raw);
      fpPlacements.push(placementOf(raw, m));
      if (seenModels.has(raw)) continue;   // unique models only, see above
      seenModels.add(raw);
      const info = classifyModel(raw, knownVars);
      byOrigin[info.origin] += 1;
      if (info.variable) byVariable[info.variable] = (byVariable[info.variable] ?? 0) + 1;
    }
    if (hasModel) footprintsWithModel += 1;

    components.push({
      ref,
      value,
      libId: typeof fp[1] === "string" ? fp[1] : "",
      at: pt(at),
      rot: at[2],
      layer: layersOf(fp)[0] ?? "F.Cu",
      // Omitted entirely when empty: most boards have components without models, and an empty array on
      // every one of them is pure weight on an index that is already the largest response we send.
      ...(fpModels.length ? { models: fpModels } : {}),
      // Only when at least one entry says something a default would not — see [ModelPlacement].
      ...(fpPlacements.some(isPlaced) ? { placements: fpPlacements } : {}),
    });
  }

  // Extent: prefer the board outline, which is what a person means by "the board". Fall back to all
  // geometry when a design has no Edge.Cuts, rather than returning a degenerate box.
  let bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const eat = (p: Pt) => {
    if (p[0] < bbox[0]) bbox[0] = p[0];
    if (p[1] < bbox[1]) bbox[1] = p[1];
    if (p[0] > bbox[2]) bbox[2] = p[0];
    if (p[1] > bbox[3]) bbox[3] = p[1];
  };
  let sawOutline = false;
  for (const tag of ["gr_line", "gr_arc", "gr_circle", "gr_poly"]) {
    for (const n of children(root, tag)) {
      if (!layersOf(n).includes("Edge.Cuts")) continue;
      sawOutline = true;
      for (const k of ["start", "end", "center", "mid"]) {
        const v = nums(n, k);
        if (v.length >= 2) eat(pt(v));
      }
    }
  }
  if (!sawOutline) {
    for (const n of children(root, "segment")) {
      for (const k of ["start", "end"]) {
        const v = nums(n, k);
        if (v.length >= 2) eat(pt(v));
      }
    }
    if (Number.isFinite(bbox[0])) problems.push("no Edge.Cuts outline; extent derived from copper");
  }
  if (!Number.isFinite(bbox[0])) bbox = [0, 0, 0, 0];

  return {
    version: nums(root, "version")[0] ?? 0,
    layers: declared.map((l) => ({ name: l.name, kind: l.kind, count: pop.get(l.name) ?? 0 })),
    components: components.filter((c) => c.ref),
    models: {
      paths: [...seenModels].sort(),
      footprintsWithModel,
      refs: modelRefs,
      unique: seenModels.size,
      byOrigin,
      byVariable,
      embedded: [...embedded].sort(),
    },
    nets: [...new Set([...nets.values()].filter(Boolean))].sort(),
    bbox,
    problems,
  };
}

/**
 * Read one layer's drawables.
 *
 * Separate from `readBoard` because that is the whole design: a client picks layers from the index and
 * asks only for what it will draw. Zones are included here — they belong to a layer — but they are the
 * bulk of the payload (523,351 fill vertices on the big demo), so a caller that only wants routing can
 * skip them with `includeZones: false`.
 */
export function readBoardLayer(
  parsed: ParsedBoard,
  layer: string,
  opts: { includeZones?: boolean } = {},
): BoardLayerScene {
  const { includeZones = true } = opts;
  const { root, nets, layers } = parsed;
  const primitives: BoardPrimitive[] = [];
  const problems: string[] = [];
  let truncated = false;

  // Structural layers get the high ceiling; annotation keeps the tight one. An undeclared layer is
  // treated as annotation — the conservative side, since a layer the board never declared is not
  // something the drawing depends on.
  const declared = layers.find((l) => l.name === layer);
  const cap = capFor(layer, declared?.kind ?? "");

  const push = (p: BoardPrimitive): boolean => {
    if (primitives.length >= cap) {
      if (!truncated) {
        truncated = true;
        problems.push(
          isStructuralLayer(layer, declared?.kind ?? "")
            ? `layer ${layer} exceeds ${cap} primitives and was truncated — this is a structural layer, ` +
              `so the drawing is incomplete rather than merely missing annotation`
            : `layer ${layer} exceeds ${cap} primitives and was truncated — ` +
              `it is almost certainly an annotation overlay rather than routing`,
        );
      }
      return false;
    }
    primitives.push(p);
    return true;
  };

  const on = (n: SNode[]) => layersOf(n).includes(layer);

  for (const n of children(root, "segment")) {
    if (!on(n)) continue;
    if (!push({ t: "track", a: pt(nums(n, "start")), b: pt(nums(n, "end")), w: nums(n, "width")[0] ?? 0.2, layer, net: netOf(n, nets) })) break;
  }
  for (const n of children(root, "arc")) {
    if (!on(n)) continue;
    if (!push({ t: "arc", a: pt(nums(n, "start")), m: pt(nums(n, "mid")), b: pt(nums(n, "end")), w: nums(n, "width")[0] ?? 0.2, layer, net: netOf(n, nets) })) break;
  }
  // A via spans layers; it belongs to any layer it connects, not one.
  for (const n of children(root, "via")) {
    const ls = layersOf(n);
    if (!ls.includes(layer)) continue;
    if (!push({ t: "via", at: pt(nums(n, "at")), d: nums(n, "size")[0] ?? 0.6, drill: nums(n, "drill")[0] ?? 0.3, layers: ls, net: netOf(n, nets) })) break;
  }
  for (const n of children(root, "gr_line")) {
    if (!on(n)) continue;
    if (!push({ t: "line", a: pt(nums(n, "start")), b: pt(nums(n, "end")), w: nums(n, "width")[0] ?? 0.1, layer })) break;
  }
  for (const n of children(root, "gr_circle")) {
    if (!on(n)) continue;
    const c = pt(nums(n, "center"));
    const e = pt(nums(n, "end"));
    if (!push({ t: "circle", c, r: Math.hypot(e[0] - c[0], e[1] - c[1]), w: nums(n, "width")[0] ?? 0.1, layer })) break;
  }
  for (const n of children(root, "gr_text")) {
    if (!on(n)) continue;
    const at = nums(n, "at");
    const eff = child(n, "effects");
    const font = eff ? child(eff, "font") : undefined;
    if (typeof n[1] !== "string") continue;
    if (!push({ t: "text", at: pt(at), s: n[1], fontSize: font ? (nums(font, "size")[1] ?? 1) : 1, rot: at[2], layer })) break;
  }

  for (const fp of children(root, "footprint")) {
    let ref = "";
    for (const p of children(fp, "property")) if (p[1] === "Reference" && typeof p[2] === "string") ref = p[2];
    const fat = nums(fp, "at");
    const frot = ((fat[2] ?? 0) * Math.PI) / 180;
    // Footprint children are in the footprint's own frame: rotate then translate.
    const place = (v: number[]): Pt => {
      const x = v[0] ?? 0;
      const y = v[1] ?? 0;
      return [
        (fat[0] ?? 0) + x * Math.cos(frot) - y * Math.sin(frot),
        (fat[1] ?? 0) + x * Math.sin(frot) + y * Math.cos(frot),
      ];
    };
    for (const n of descendants(fp, "fp_line")) {
      if (!on(n)) continue;
      if (!push({ t: "line", a: place(nums(n, "start")), b: place(nums(n, "end")), w: nums(n, "width")[0] ?? 0.1, layer, ref })) break;
    }
    for (const n of descendants(fp, "pad")) {
      const ls = layersOf(n);
      if (!ls.includes(layer)) continue;
      const sz = nums(n, "size");
      const pa = nums(n, "at");
      if (!push({ t: "pad", at: place(pa), size: [sz[0] ?? 0, sz[1] ?? 0], rot: (pa[2] ?? 0) + (fat[2] ?? 0), shape: typeof n[3] === "string" ? n[3] : "rect", layers: ls, ref, net: netOf(n, nets) })) break;
    }
  }

  if (includeZones) {
    for (const z of children(root, "zone")) {
      if (!layersOf(z).includes(layer)) continue;
      const net = netOf(z, nets);
      // The fill is already solved in the file; we never re-derive it.
      for (const fp of descendants(z, "filled_polygon")) {
        const pts = child(fp, "pts");
        if (!pts) continue;
        if (!push({ t: "zone", pts: children(pts, "xy").map((q) => [q[1] as number, q[2] as number]), layer, net })) break;
      }
    }
  }

  return { layer, primitives, truncated, problems };
}

/**
 * Where a footprint's 3D model would come from (ADR-038, Phase 4 — coverage only, nothing is rendered).
 *
 * Measured over the 19-board corpus before designing this: **3,616 model references, 392 unique**, and
 * they resolve through **13 different environment variables**. `${KICAD9_3DMODEL_DIR}` is 1,324 refs;
 * `${ANT3DMDL}` is 1,007 and is somebody's *private* library, defined in their KiCad settings and shipped
 * nowhere. The bridge cannot know what those point at, so it is told — never guessed.
 *
 * The honest reason this exists before any renderer: **27% of unique models cannot be resolved at all**,
 * and it is concentrated. `jetson-agx-thor-baseboard` has 66 of 67 unresolvable — a 3D view of it would
 * show one part out of 67. Coverage says that *before* anyone downloads 5.7 GB of assets or looks at a
 * board that cannot be drawn.
 */
export type ModelOrigin =
  /** `${KIPRJMOD}/…` or a relative path — resolvable from the repo alone, no configuration needed. */
  | "project"
  /** `${SOMEVAR}/…` where the operator has told us what `SOMEVAR` is. */
  | "configured"
  /** `${SOMEVAR}/…` with no mapping. Nothing can render it; saying so is the whole point. */
  | "unmapped"
  /** An absolute host path from someone else's machine. */
  | "absolute"
  /**
   * `kicad-embed://…` — the model is stored *inside the board file* (KiCad 9 embedded files), base64
   * over zstd. The cheapest case there is: nothing to download, nothing for an operator to configure,
   * and no variable that can fail to resolve.
   *
   * Called out as its own origin because treating it as a relative path is wrong in the worst
   * direction: it looks up a file that was never on disk, finds nothing, and reports the model missing
   * from a board that is carrying it. On `vme-wren` that is **33 of 66** unique models.
   */
  | "embedded";

export interface ModelRef {
  /** The raw path exactly as the board writes it, variable and all. */
  raw: string;
  /** The variable it is addressed through, when it uses one. */
  variable?: string;
  origin: ModelOrigin;
}

/** Per-board 3D model coverage. Counts are over **unique** models, because reuse is ~22x. */
export interface ModelCoverage {
  /**
   * The unique model paths, raw, exactly as the board writes them.
   *
   * Carried so a layer that *can* touch the filesystem can try to resolve them — `readBoard` deliberately
   * cannot, which is what keeps it pure and testable without a disk.
   */
  paths: string[];
  /** Footprints that reference at least one model. */
  footprintsWithModel: number;
  /** Total references, and how many distinct models they name. */
  refs: number;
  unique: number;
  /** Unique models by where they would come from. */
  byOrigin: Record<ModelOrigin, number>;
  /** Unique models per variable, so an operator can see which mapping would unlock the most. */
  byVariable: Record<string, number>;
  /**
   * Names of models the board carries **inside itself**, and for which a payload is actually present.
   *
   * Presence of the payload is the test, not the declaration. A footprint declares the file it uses —
   * `vme-wren` has 155 such declarations — while the bytes appear once in a board-level
   * `(embedded_files)` block, 33 times. Counting declarations would claim models the file does not
   * carry.
   */
  embedded: string[];
}

const VAR_RE = /^\$\{([^}]+)\}/;

/** How a board names a model it carries inside itself. */
export const EMBED_SCHEME = "kicad-embed://";

/**
 * Every name the *official* KiCad 3D library has been addressed by.
 *
 * `${KISYS3DMOD}` is the pre-v6 name; v6 onward numbers it per generation. They are all the same
 * library, so an operator who has mapped one has told us where all of them live — requiring six
 * identical entries in the config would be busywork that silently costs coverage when they miss one.
 *
 * Measured before relying on it, because the plan had flagged "do v7 filenames satisfy v9/v10
 * references?" as unverified: comparing basenames per directory at 6.0.11 / 7.0.11 / 9.0.9 / 10.0.5,
 * **926 of 965 v7 names (95%) still exist at v10** — 100% for `Resistor_SMD`,
 * `Connector_PinHeader_2.54mm` and `Capacitor_THT`, 86% for `Package_QFP`, 85% for `Package_SO`. The
 * ~5% that were renamed resolve to `missing`, which is the same answer an operator would get for a file
 * genuinely absent from the version they *did* map. Nothing is reported as present that is not.
 */
const OFFICIAL_LIB_VAR = /^(?:KISYS3DMOD|KICAD\d+_3DMODEL_DIR)$/;

/** Is this variable one of the official library's names? See [OFFICIAL_LIB_VAR]. */
export function isOfficialLibVar(v: string): boolean {
  return OFFICIAL_LIB_VAR.test(v);
}

/**
 * The variable to actually look under for `variable`, given what the operator has mapped.
 *
 * Exact mapping always wins. Otherwise an official-library name falls back to whichever official name
 * *is* mapped, preferring the newest — a v10 library is the most likely to still carry a part. Anything
 * outside that family never falls back: `${ANT3DMDL}` is somebody's private library, and pointing it at
 * the official one would resolve to the wrong geometry rather than to nothing.
 */
export function libVarFor(variable: string, known: ReadonlySet<string>): string | undefined {
  if (known.has(variable)) return variable;
  if (!isOfficialLibVar(variable)) return undefined;
  const gen = (v: string): number => Number(/^KICAD(\d+)_/.exec(v)?.[1] ?? 0);
  return [...known].filter(isOfficialLibVar).sort((a, b) => gen(b) - gen(a))[0];
}

/**
 * The base64 payload of an embedded file, by name.
 *
 * Lives here rather than in the converter because the s-expression layout is this module's business:
 * the payload arrives as `(data |AAAA BBBB CCCC)` — one `|`-prefixed run wrapped across many lines, so
 * the parser yields it as several bare tokens that have to be rejoined. Returned still encoded, since
 * decoding needs a zstd implementation and nothing in the bridge should have to carry one.
 */
export function embeddedPayload(root: SNode[], name: string): string | undefined {
  for (const ef of descendants(root, "embedded_files")) {
    for (const f of children(ef, "file")) {
      if (child(f, "name")?.[1] !== name) continue;
      const data = child(f, "data");
      if (data) return data.slice(1).filter((v): v is string => typeof v === "string").join("");
    }
  }
  return undefined;
}

/** The name an embedded reference points at — `kicad-embed://part.step` → `part.step`. */
export function embeddedName(raw: string): string | undefined {
  const p = raw.replace(/\\/g, "/");
  return p.startsWith(EMBED_SCHEME) ? p.slice(EMBED_SCHEME.length) : undefined;
}

/**
 * Classify one model path. Pure and exported so the rule is testable without a board.
 *
 * `known` is the set of variables the operator has mapped. Whether the file is actually *on disk* is a
 * separate question this deliberately does not ask — it is about whether the path can even be addressed.
 */
export function classifyModel(raw: string, known: ReadonlySet<string> = new Set()): ModelRef {
  const p = raw.replace(/\\/g, "/");
  // Checked before the variable and path rules: it is a URI, not a path, and every other branch here
  // would mis-answer it.
  if (p.startsWith(EMBED_SCHEME)) return { raw, origin: "embedded" };
  const m = VAR_RE.exec(p);
  if (!m) return { raw, origin: p.startsWith("/") ? "absolute" : "project" };
  const variable = m[1]!;
  if (variable === "KIPRJMOD") return { raw, variable, origin: "project" };
  // `known.has` is not the question — `libVarFor` is, because one mapped official-library name answers
  // for all of them. See [libVarFor].
  return { raw, variable, origin: libVarFor(variable, known) ? "configured" : "unmapped" };
}

/**
 * The other half of a KiCad project, by name alone.
 *
 * Pure and exported so the rule is testable: a `.kicad_sch` pairs with a `.kicad_pcb` and vice versa, and
 * **nothing else pairs with anything** — a `.kicad_pro`, a `.kicad_sym`, a plain file all return undefined.
 * Whether the named file actually *exists* is a separate question the route answers with `blobExists`,
 * because only the bridge can know that and only at a given ref.
 */
export function counterpartPath(path: string): string | undefined {
  if (path.endsWith(".kicad_sch")) return `${path.slice(0, -".kicad_sch".length)}.kicad_pcb`;
  if (path.endsWith(".kicad_pcb")) return `${path.slice(0, -".kicad_pcb".length)}.kicad_sch`;
  return undefined;
}
