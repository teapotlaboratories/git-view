/**
 * Turning a solved design into a **tagged scene** the app can draw (ADR-038, Phase 1).
 *
 * The whole architecture rests on this file being both things at once:
 *
 *  - **Drawable** — enough primitives that the sheet looks like the schematic, not like a wiring diagram
 *    of boxes. Symbol bodies are rectangles, polylines, circles, arcs and text, and they live in the
 *    symbol's own frame, so every point goes through the same measured `placePoint` the pins do. Get that
 *    wrong and the graphics land somewhere the pins don't.
 *  - **Tagged** — every primitive carries the `net` and/or `ref` it belongs to. That is what makes Phase 2
 *    cheap: highlighting a net becomes a style change over primitives that already know their net, and
 *    hit-testing is exact rather than an overlay approximation. Sending SVG plus a bounding-box index
 *    would "work" and then die at the first tap.
 *
 * Coordinates stay in **millimetres in sheet space**. The app pans and zooms; the bridge does not guess a
 * viewport. `bbox` is supplied so the client can fit-to-view without walking every primitive first.
 */
import { loadDesign, type Design } from "./design.js";
import { placePoint, type Placement } from "./transform.js";
import { children, child, descendants, nums, parseSexpr, type SNode } from "./sexpr.js";
import type { Sheet } from "./schematic.js";

export type Pt = [number, number];

/** A drawable. `net` / `ref` are present wherever the element belongs to one. */
export type Primitive =
  | { t: "wire" | "bus"; pts: Pt[]; net?: string }
  | { t: "poly"; pts: Pt[]; ref?: string; net?: string; w?: number; fill?: boolean }
  | { t: "rect"; a: Pt; b: Pt; ref?: string; w?: number; fill?: boolean }
  | { t: "circle"; c: Pt; r: number; ref?: string; w?: number; fill?: boolean }
  | { t: "arc"; a: Pt; m: Pt; b: Pt; ref?: string; w?: number }
  | {
      t: "text";
      at: Pt;
      /** Raw string. May contain newlines — 3 sheet texts in the KiCad 7 corpus do. Split when drawing. */
      s: string;
      size: number;
      rot?: number;
      /**
       * Anchor, from KiCad's `(justify …)`. Carried because the app cannot guess it: `PWR_FLAG` sitting
       * beside a `VDD` symbol renders as one overlapping smear without it. Defaults match KiCad's own —
       * horizontally centred, vertically centred — which is what an absent `justify` means.
       */
      hjust?: "left" | "center" | "right";
      vjust?: "top" | "center" | "bottom";
      ref?: string;
      net?: string;
      kind?: string;
    }
  | { t: "pin"; at: Pt; ref: string; pin: string; name?: string; net?: string }
  | { t: "junction"; at: Pt; net?: string }
  | { t: "nc"; at: Pt };

export interface SceneComponent {
  ref: string;
  value: string;
  libId: string;
  at: Pt;
}

export interface Scene {
  /** Sheet instance name (`/` for the root) and the instance path that identifies it in the design. */
  sheet: string;
  path: string;
  /** Schematic file format version, carried so a client can reason about what it is looking at. */
  version: number;
  /** `[minX, minY, maxX, maxY]` in mm, for fit-to-view without walking the primitives. */
  bbox: [number, number, number, number];
  primitives: Primitive[];
  components: SceneComponent[];
  /** Net names present on this sheet, sorted — enough to drive a net picker without a second request. */
  nets: string[];
  /** Sibling sheets in the same design, so the app can offer a sheet switcher from one response. */
  sheets: { name: string; path: string }[];
  /** Anything unreadable in the design. Non-empty means the scene is incomplete — say so in the UI. */
  problems: string[];
}

/** Text anchor from `(effects (justify left bottom))`. Absent means centred, which is KiCad's default. */
function justify(eff: SNode[] | undefined): { hjust?: "left" | "center" | "right"; vjust?: "top" | "center" | "bottom" } {
  const j = eff ? child(eff, "justify") : undefined;
  if (!j) return {};
  const words = j.slice(1).filter((w): w is string => typeof w === "string");
  const out: { hjust?: "left" | "center" | "right"; vjust?: "top" | "center" | "bottom" } = {};
  for (const w of words) {
    if (w === "left" || w === "right") out.hjust = w;
    else if (w === "top" || w === "bottom") out.vjust = w;
  }
  return out;
}

/**
 * Hidden? Spelled `hide` as a bare atom in KiCad 7 and `(hide yes)` in KiCad 10 — both appear in the
 * corpora, and a property that is hidden must not be drawn.
 */
function isHiddenNode(node: SNode[]): boolean {
  for (const c of node) {
    if (c === "hide") return true;
    if (Array.isArray(c) && c[0] === "hide") return c[1] !== "no";
  }
  return false;
}

/** Stroke width, dropping KiCad's `0` which means "use the default". */
function strokeWidth(node: SNode[]): number | undefined {
  const st = child(node, "stroke");
  const w = st ? nums(st, "width")[0] : undefined;
  return w ? w : undefined;
}

function filled(node: SNode[]): boolean {
  const f = child(node, "fill");
  const type = f ? child(f, "type") : undefined;
  return !!type && type[1] !== "none";
}

/** Flatten a cubic Bézier to a polyline. The app should not need a curve rasteriser for 312 curves. */
function flattenBezier(p: Pt[], segments = 12): Pt[] {
  if (p.length < 4) return p;
  const [p0, p1, p2, p3] = p as [Pt, Pt, Pt, Pt];
  const out: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/**
 * Graphics from a `lib_symbols` entry, placed by an instance's transform.
 *
 * Unit selection mirrors the pin logic: the instance's own unit plus unit 0, the shared body. The same
 * `placePoint` is used throughout — symbol graphics and symbol pins have to agree, and they only do if
 * they go through one transform.
 */
function symbolGraphics(
  sym: SNode[],
  unit: number,
  at: Placement,
  ref: string,
  netAt: (x: number, y: number) => string | undefined,
): Primitive[] {
  const out: Primitive[] = [];
  const P = (x: number, y: number): Pt => placePoint(x, y, at);

  for (const sub of children(sym, "symbol")) {
    const parts = String(sub[1]).split("_");
    const subUnit = Number(parts[parts.length - 2] ?? 0);
    if (Number.isFinite(subUnit) && subUnit !== unit && subUnit !== 0) continue;

    for (const r of descendants(sub, "rectangle")) {
      const a = nums(r, "start");
      const b = nums(r, "end");
      if (a.length < 2 || b.length < 2) continue;
      out.push({ t: "rect", a: P(a[0]!, a[1]!), b: P(b[0]!, b[1]!), ref, w: strokeWidth(r), fill: filled(r) });
    }
    for (const pl of descendants(sub, "polyline")) {
      const pts = child(pl, "pts");
      if (!pts) continue;
      out.push({
        t: "poly",
        pts: children(pts, "xy").map((q) => P(q[1] as number, q[2] as number)),
        ref,
        w: strokeWidth(pl),
        fill: filled(pl),
      });
    }
    for (const c of descendants(sub, "circle")) {
      const ctr = nums(c, "center");
      const rad = nums(c, "radius")[0];
      if (ctr.length < 2 || !Number.isFinite(rad)) continue;
      out.push({ t: "circle", c: P(ctr[0]!, ctr[1]!), r: rad!, ref, w: strokeWidth(c), fill: filled(c) });
    }
    for (const a of descendants(sub, "arc")) {
      const s = nums(a, "start");
      const m = nums(a, "mid");
      const e = nums(a, "end");
      if (s.length < 2 || m.length < 2 || e.length < 2) continue;
      out.push({ t: "arc", a: P(s[0]!, s[1]!), m: P(m[0]!, m[1]!), b: P(e[0]!, e[1]!), ref, w: strokeWidth(a) });
    }
    for (const bz of descendants(sub, "bezier")) {
      const pts = child(bz, "pts");
      if (!pts) continue;
      const ctrl = children(pts, "xy").map((q) => [q[1] as number, q[2] as number] as Pt);
      out.push({ t: "poly", pts: flattenBezier(ctrl).map((q) => P(q[0], q[1])), ref, w: strokeWidth(bz) });
    }
    // **Pin lead lines.** A KiCad pin is not a point: `at` is the *connection* end and the symbol body sits
    // `length` away, with a line drawn between them. Emitting only the connection dot leaves a visible gap
    // between every wire and the part it lands on — the schematic reads as though nothing is wired up.
    // 3536 of 3684 pins in the KiCad 7 demos carry a nonzero length, so this is the common case, not an
    // edge case. The lead is tagged with the pin's net as well as its ref, because electrically it is a
    // continuation of the wire and should highlight with it.
    for (const pin of descendants(sub, "pin")) {
      if (isHiddenNode(pin)) continue; // a hidden power pin is drawn nowhere, by definition
      const pat = nums(pin, "at");
      const len = nums(pin, "length")[0] ?? 0;
      if (pat.length < 2 || !(len > 0)) continue;
      const rad = ((pat[2] ?? 0) * Math.PI) / 180;
      const tip = P(pat[0]!, pat[1]!);
      out.push({
        t: "poly",
        pts: [tip, P(pat[0]! + len * Math.cos(rad), pat[1]! + len * Math.sin(rad))],
        ref,
        net: netAt(tip[0], tip[1]),
        w: strokeWidth(pin),
      });
    }

    for (const tx of descendants(sub, "text")) {
      if (typeof tx[1] !== "string") continue;
      const p = nums(tx, "at");
      if (p.length < 2) continue;
      const eff = child(tx, "effects");
      const font = eff ? child(eff, "font") : undefined;
      out.push({
        t: "text",
        at: P(p[0]!, p[1]!),
        s: tx[1],
        size: font ? (nums(font, "size")[1] ?? 1.27) : 1.27,
        ref,
        ...justify(eff),
      });
    }
  }
  return out;
}

/** Sheet-level graphics: free text, boxes and drawn shapes that belong to no symbol. */
function sheetGraphics(root: SNode[]): Primitive[] {
  const out: Primitive[] = [];
  for (const tag of ["text", "text_box"] as const) {
    for (const tx of children(root, tag)) {
      if (typeof tx[1] !== "string") continue;
      const p = nums(tx, "at");
      if (p.length < 2) continue;
      const eff = child(tx, "effects");
      const font = eff ? child(eff, "font") : undefined;
      out.push({
        t: "text",
        at: [p[0]!, p[1]!],
        s: tx[1],
        rot: p[2],
        size: font ? (nums(font, "size")[1] ?? 1.27) : 1.27,
        kind: tag,
        ...justify(eff),
      });
    }
  }
  for (const pl of children(root, "polyline")) {
    const pts = child(pl, "pts");
    if (pts) out.push({ t: "poly", pts: children(pts, "xy").map((q) => [q[1] as number, q[2] as number]), w: strokeWidth(pl) });
  }
  for (const r of children(root, "rectangle")) {
    const a = nums(r, "start");
    const b = nums(r, "end");
    if (a.length >= 2 && b.length >= 2) {
      out.push({ t: "rect", a: [a[0]!, a[1]!], b: [b[0]!, b[1]!], w: strokeWidth(r), fill: filled(r) });
    }
  }
  return out;
}

function bboxOf(prims: Primitive[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of prims) {
    switch (p.t) {
      case "wire":
      case "bus":
      case "poly":
        for (const q of p.pts) eat(q[0], q[1]);
        break;
      case "rect":
        eat(p.a[0], p.a[1]);
        eat(p.b[0], p.b[1]);
        break;
      case "circle":
        eat(p.c[0] - p.r, p.c[1] - p.r);
        eat(p.c[0] + p.r, p.c[1] + p.r);
        break;
      case "arc":
        eat(p.a[0], p.a[1]);
        eat(p.m[0], p.m[1]);
        eat(p.b[0], p.b[1]);
        break;
      default:
        eat(p.at[0], p.at[1]);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

/**
 * Build the scene for one sheet instance of an already-solved design.
 *
 * Split from `loadDesign` deliberately: solving is per *design*, drawing is per *sheet*, and the app opens
 * one sheet at a time. Sharing the solved design across its sheets is what makes the sibling-warming in
 * ADR-038 worth doing.
 */
export function buildScene(design: Design, instancePath: string, text: string): Scene {
  const inst = design.instances.find((i) => i.path === instancePath);
  if (!inst) throw new Error(`no sheet instance ${instancePath} in this design`);
  const sheet: Sheet = inst.sheet;
  const root = parseSexpr(text);
  const net = (x: number, y: number) => design.netAt(instancePath, x, y);

  const primitives: Primitive[] = [];

  for (const w of sheet.wires) {
    primitives.push({ t: "wire", pts: w.points.map((p) => [p.x, p.y]), net: net(w.points[0]!.x, w.points[0]!.y) });
  }
  // Buses carry no single net by construction — a bundle is not a net — so they are drawn untagged.
  for (const b of sheet.buses) primitives.push({ t: "bus", pts: b.points.map((p) => [p.x, p.y]) });
  for (const j of sheet.junctions) primitives.push({ t: "junction", at: [j.x, j.y], net: net(j.x, j.y) });
  for (const n of sheet.noConnects) primitives.push({ t: "nc", at: [n.x, n.y] });

  // Labels are text *and* a connection point, so they carry both their net and their anchor.
  const labelJustify = new Map<string, ReturnType<typeof justify>>();
  for (const tag of ["label", "hierarchical_label", "global_label"]) {
    for (const l of children(root, tag)) {
      const la = nums(l, "at");
      if (typeof l[1] === "string" && la.length >= 2) {
        labelJustify.set(`${l[1]}\u0000${la[0]}\u0000${la[1]}`, justify(child(l, "effects")));
      }
    }
  }
  for (const l of sheet.labels) {
    primitives.push({
      t: "text",
      at: [l.at.x, l.at.y],
      s: l.text,
      size: 1.27,
      kind: `${l.kind}_label`,
      net: net(l.at.x, l.at.y),
      ...(labelJustify.get(`${l.text}\u0000${l.at.x}\u0000${l.at.y}`) ?? {}),
    });
  }
  for (const p of sheet.pins) {
    primitives.push({ t: "pin", at: [p.at.x, p.at.y], ref: p.ref, pin: p.number, name: p.name, net: net(p.at.x, p.at.y) });
  }

  // Symbol bodies, transformed by each instance's placement.
  const libs = child(root, "lib_symbols");
  const byName = new Map<string, SNode[]>();
  if (libs) for (const sym of children(libs, "symbol")) byName.set(String(sym[1]), sym);
  for (const si of children(root, "symbol")) {
    const lib = child(si, "lib_id");
    const at = nums(si, "at");
    if (!lib || typeof lib[1] !== "string" || at.length < 2) continue;
    const sym = byName.get(lib[1]);
    if (!sym) continue;
    const mirrorNode = child(si, "mirror");
    const place: Placement = {
      x: at[0]!,
      y: at[1]!,
      rotation: at[2] ?? 0,
      mirror: mirrorNode ? (String(mirrorNode[1]) as "x" | "y") : undefined,
    };
    let ref = "";
    for (const pr of children(si, "property")) if (pr[1] === "Reference" && typeof pr[2] === "string") ref = pr[2];
    primitives.push(...symbolGraphics(sym, nums(si, "unit")[0] ?? 1, place, ref, net));

    // Instance properties — the refdes and value a human actually reads. Easy to forget, because the
    // symbol's own graphics already produce something that *looks* like a schematic; it just has no `R1`
    // or `10k` on it. Found by rendering the scene and looking at it, not by counting primitives.
    //
    // These carry their own absolute `at` (already in sheet space — not the symbol frame, so no
    // placePoint) and are frequently hidden: every power symbol hides both, and Footprint/Datasheet are
    // hidden almost always. Drawing hidden ones covers the sheet in noise.
    for (const pr of children(si, "property")) {
      if (typeof pr[1] !== "string" || typeof pr[2] !== "string" || !pr[2]) continue;
      const eff = child(pr, "effects");
      if (!eff || isHiddenNode(eff)) continue;
      const pa = nums(pr, "at");
      if (pa.length < 2) continue;
      const font = child(eff, "font");
      primitives.push({
        t: "text",
        at: [pa[0]!, pa[1]!],
        s: pr[2],
        rot: pa[2],
        size: font ? (nums(font, "size")[1] ?? 1.27) : 1.27,
        ref,
        kind: `property:${pr[1]}`,
        ...justify(eff),
      });
    }
  }

  // Sub-sheet boxes. Easy to miss because the solver only ever wants their *pins*, so nothing failed
  // until a hierarchical root was drawn on a device and its seven sub-sheets appeared as rows of floating
  // pin stubs with no boxes and no names around them.
  for (const sub of sheet.sheets) {
    if (sub.size.x > 0 && sub.size.y > 0) {
      primitives.push({
        t: "rect",
        a: [sub.at.x, sub.at.y],
        b: [sub.at.x + sub.size.x, sub.at.y + sub.size.y],
        ref: sub.name,
      });
    }
    // Name above the box, file below — the convention KiCad itself draws.
    if (sub.name) {
      primitives.push({ t: "text", at: [sub.at.x, sub.at.y - 0.8], s: sub.name, size: 1.27, hjust: "left", vjust: "bottom", ref: sub.name, kind: "sheet:name" });
    }
    if (sub.file) {
      primitives.push({ t: "text", at: [sub.at.x, sub.at.y + sub.size.y + 0.8], s: sub.file, size: 1.27, hjust: "left", vjust: "top", ref: sub.name, kind: "sheet:file" });
    }
    // A sheet pin is a connection point on *this* sheet, so it carries the net like any other pin.
    for (const p of sub.pins) {
      primitives.push({ t: "text", at: [p.at.x, p.at.y], s: p.name, size: 1.0, hjust: "left", vjust: "center", ref: sub.name, kind: "sheet:pin", net: net(p.at.x, p.at.y) });
    }
  }

  primitives.push(...sheetGraphics(root));

  const netNames = new Set<string>();
  for (const p of primitives) if ("net" in p && p.net) netNames.add(p.net);

  return {
    sheet: inst.name,
    path: inst.path,
    version: sheet.version,
    bbox: bboxOf(primitives),
    primitives,
    components: sheet.components
      .filter((c) => !c.ref.startsWith("#"))
      .map((c) => ({ ref: c.ref, value: c.value, libId: c.libId, at: [c.at.x, c.at.y] as Pt })),
    nets: [...netNames].sort(),
    sheets: design.instances.map((i) => ({ name: i.name, path: i.path })),
    problems: design.problems,
  };
}

/** Convenience for a single flat sheet with no hierarchy — used by tests and the CLI probe. */
export async function sceneFromText(text: string): Promise<Scene> {
  const design = await loadDesign("/sheet.kicad_sch", () => text);
  return buildScene(design, design.instances[0]!.path, text);
}
