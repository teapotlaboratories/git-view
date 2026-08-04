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

export function readBoard(parsed: ParsedBoard): Board {
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
  for (const fp of children(root, "footprint")) {
    const at = nums(fp, "at");
    let ref = "";
    let value = "";
    for (const p of children(fp, "property")) {
      if (p[1] === "Reference" && typeof p[2] === "string") ref = p[2];
      if (p[1] === "Value" && typeof p[2] === "string") value = p[2];
    }
    components.push({
      ref,
      value,
      libId: typeof fp[1] === "string" ? fp[1] : "",
      at: pt(at),
      rot: at[2],
      layer: layersOf(fp)[0] ?? "F.Cu",
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
