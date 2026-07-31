/**
 * Deriving schematic nets from geometry (ADR-038, Phase 0).
 *
 * This is the one genuinely hard part of reading a schematic. A `.kicad_pcb` tags every track and pad
 * with its net; a `.kicad_sch` tags nothing — 81 wires on a typical sheet, not one of them carrying a net
 * name. Connectivity is implied by what touches what, so it has to be computed.
 *
 * The failure mode is the dangerous kind: a wrong answer still renders a perfect-looking sheet, and only
 * shows up as a highlight that lights the wrong wires, or two supplies silently merged into one net. So
 * the rules below are stated explicitly rather than left to fall out of the implementation.
 *
 * **What connects**
 *  - The two ends of a wire segment (that is what a wire *is*).
 *  - Two wires sharing an endpoint.
 *  - A wire endpoint landing anywhere on another wire, including mid-span — a T. KiCad draws a junction
 *    dot for these and would place one on save, but the file may predate that, so the geometry decides.
 *  - A pin at the same point as a wire endpoint, or anywhere along a wire.
 *  - Everything touching an explicit `(junction)`.
 *
 * **What does NOT connect**
 *  - Two wires that merely *cross* — an X with no junction and no endpoint at the intersection. This is
 *    the rule that makes crossing signals legal on a schematic, and getting it wrong silently merges
 *    unrelated nets. Handled by only ever joining at a point where a wire *ends* (or a junction sits).
 */
import type { Sheet, Point, LabelKind } from "./schematic.js";
import { pointKey } from "./transform.js";

export interface Net {
  /** Net name: from a label if the net carries one, else auto-generated and stable for the sheet. */
  name: string;
  /** True when the name was invented rather than taken from a label. */
  unnamed: boolean;
  /** Pins on this net, as `REF.PIN` (e.g. `U1.14`). Sorted, so output is comparable run to run. */
  pins: string[];
  /**
   * Wires carrying this net, qualified by the sheet instance they live on — what to highlight when the
   * net is selected. Bare indices would be ambiguous the moment a design has more than one sheet: every
   * sheet has a wire 7.
   */
  wires: { sheet: string; index: number }[];
  /** Every label attached to the net, in file order. */
  labels: string[];
}

/** Textbook union-find, keyed by canonical point string. Exported so `design.ts` can span several sheets. */
export class DisjointSet {
  private parent = new Map<string, string>();

  /** Membership test that does *not* create the node — `find` would, which makes it useless as a guard. */
  has(k: string): boolean {
    return this.parent.has(k);
  }

  find(k: string): string {
    const p = this.parent.get(k);
    if (p === undefined) {
      this.parent.set(k, k);
      return k;
    }
    if (p === k) return k;
    const root = this.find(p);
    this.parent.set(k, root); // path compression
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Is `p` on the segment a–b (inclusive), within a tolerance far below any schematic grid? */
export function onSegment(p: Point, a: Point, b: Point, eps = 1e-6): boolean {
  const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > eps) return false; // not collinear
  const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
  if (dot < -eps) return false; // before a
  const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= len2 + eps; // at or before b
}

/**
 * Label priority when several name the same net.
 *
 * A global label names the net across every sheet, so it outranks a hierarchical one, which outranks a
 * local. Ties break on the name itself, so the result does not depend on file order — a net whose name
 * changed because someone reordered the file would be a maddening bug to chase.
 */
type NameKind = LabelKind | "power";
const RANK: Record<NameKind, number> = { power: 4, global: 3, hierarchical: 2, local: 1 };

function bestLabel(labels: { text: string; kind: NameKind }[]): string | undefined {
  if (!labels.length) return undefined;
  return [...labels].sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.text.localeCompare(b.text))[0]!.text;
}

/**
 * KiCad's own name for a net that carries no label: `Net-(R1-Pad2)`, or `Net-(U1-+)` when the pin has a
 * name. Reproduced exactly so derived netlists can be diffed against `kicad-cli` output directly — a
 * cosmetic difference would otherwise drown the real disagreements.
 */
function autoName(pin: { ref: string; number: string; name: string }): string {
  const part = pin.name && pin.name !== "~" ? pin.name : `Pad${pin.number}`;
  return `Net-(${pin.ref}-${part})`;
}

/**
 * A node key. `ns` namespaces a sheet *instance*, because the same file placed twice is two separate sets
 * of nets — the point (100, 50) in one placement of `ampli_ht` is not the point (100, 50) in the other.
 */
export const nodeKey = (ns: string, x: number, y: number): string => `${ns}\u0000${pointKey(x, y)}`;

/** Key for a name-based connection. Scope is either one sheet instance or the whole design. */
export const nameKey = (ns: string, name: string): string => `${ns}\u0000N\u0000${name}`;

/** Names that reach across every sheet: global labels, power symbols, hidden power pins. */
export const GLOBAL_SCOPE = "\u0000GLOBAL";

/**
 * The net name a power symbol imposes: its **pin's** name, not its Value.
 *
 * These usually agree, which is how the difference stays hidden. In `kit-dev-coldfire` they do not — one
 * supply symbol carries the Value `+3,3V` (with a comma) while its pin is named `+3.3V`, and KiCad puts
 * every such pin on `+3.3V`. Trusting Value split that supply into two nets differing by one character,
 * which is precisely the sort of thing nobody catches by eye in a 90-pin net.
 *
 * A pin name of `~` means "unnamed" — KiCad 10's `power:GND` is written that way — so Value is the
 * fallback, not the primary.
 */
export function powerName(p: { name: string; value: string }): string {
  return p.name && p.name !== "~" ? p.name : p.value;
}

/**
 * Bus members. `AN[0..7]` is eight nets `AN0`…`AN7`; `{SDA SCL}` is a group of two.
 *
 * This matters most at a hierarchy boundary. `kit-dev-coldfire` passes a bus sheet pin `AN[0..7]` into a
 * child that refers to its members as plain local labels `AN0`…`AN7`. Without expansion the parent and
 * the child each keep their own disconnected `AN0`, and every one of those nets splits in half.
 *
 * Returns `[]` for a plain name, so "not a bus" and "no members" are the same case to a caller.
 */
export function busMembers(name: string): string[] {
  const vector = /^(.*)\[(\d+)\.\.(\d+)\]$/.exec(name);
  if (vector) {
    const [, prefix, a, b] = vector;
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    if (hi - lo > 4096) return []; // refuse an absurd range rather than allocate for a malformed file
    return Array.from({ length: hi - lo + 1 }, (_, i) => `${prefix}${lo + i}`);
  }
  const group = /^\{(.*)\}$/.exec(name);
  if (group) return group[1]!.trim().split(/\s+/).filter(Boolean);
  return [];
}

/**
 * Join two scopes' views of a name — how a name crosses a hierarchy boundary. Pass `nameB` to join two
 * *different* names, which is what bus-member aliasing needs (`DQ0` in one scope is `PC_D0` in another).
 */
export function unionName(ds: DisjointSet, nsA: string, nsB: string, name: string, nameB = name): void {
  if (name && nameB) ds.union(nameKey(nsA, name), nameKey(nsB, nameB));
}

/**
 * Apply one sheet's connection rules into a shared union-find, under namespace `ns`.
 *
 * Split out from `computeNets` so a hierarchical design can run it per sheet instance and then link the
 * instances, rather than duplicating rules that took an oracle to get right.
 */
export function unionSheet(ds: DisjointSet, ns: string, sheet: Sheet): void {
  const K = (p: Point) => nodeKey(ns, p.x, p.y);

  // 1. Each wire joins its own endpoints — including the interior vertices of a multi-point wire.
  sheet.wires.forEach((w) => {
    for (let i = 1; i < w.points.length; i++) ds.union(K(w.points[i - 1]!), K(w.points[i]!));
  });

  // 2. Mid-span contact. Anything meeting a wire at its *endpoint* is already joined for free — nodes are
  //    keyed by coordinate, so a pin sitting on a wire end is literally the same key. This step is only
  //    about the interior of a segment, and there the rule depends on what is touching:
  //
  //    - **A junction, pin or label connects.** These are connection points in their own right; a wire
  //      drawn across a pin lands on it.
  //    - **Another wire's endpoint does not**, unless a junction is also there. This is the one that was
  //      wrong at first, in exactly the way that costs a viewer its credibility. The original code joined
  //      *any* node on a segment, reasoning that a wire ending mid-span is a T and KiCad would have saved
  //      a junction there anyway. It does not: in `electric.kicad_sch` a vertical wire ends at
  //      (115.57, 20.32), dead mid-span of a horizontal wire, with no junction — and KiCad keeps the two
  //      nets apart. Joining them silently shorted two unrelated nets, which is the failure this whole
  //      file exists to prevent. The junction dot is not decoration; for wire-to-wire it *is* the
  //      connection.
  //
  //    Both halves are measured, and each is load-bearing in a different direction: dropping the second
  //    merges nets in `electric`, while extending the second to pins splits 59 of `carte_test`'s 100.
  //
  //    Two wires that merely *cross* still never join — a crossing puts no node at the intersection.
  //    A child sheet's pins count as contacts too — they are ordinary connection points on *this* sheet,
  //    and only their binding to the child's interior is special.
  const contacts: Point[] = [
    ...sheet.junctions,
    ...sheet.pins.map((p) => p.at),
    ...sheet.labels.map((l) => l.at),
    ...sheet.sheets.flatMap((s) => s.pins.map((p) => p.at)),
  ];
  //    This scan is contacts × segments, which is quadratic in sheet size, so each segment rejects
  //    out-of-range contacts by bounding box first. Schematic wires are short and axis-aligned, so the
  //    box discards nearly everything for the cost of four comparisons. Purely a speed-up: the box is a
  //    superset of the segment, so nothing that `onSegment` would have accepted is skipped.
  const EPS = 1e-6;
  for (const w of sheet.wires) {
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[i - 1]!;
      const b = w.points[i]!;
      const ka = K(a);
      const kb = K(b);
      const minX = Math.min(a.x, b.x) - EPS;
      const maxX = Math.max(a.x, b.x) + EPS;
      const minY = Math.min(a.y, b.y) - EPS;
      const maxY = Math.max(a.y, b.y) + EPS;
      for (const n of contacts) {
        if (n.x < minX || n.x > maxX || n.y < minY || n.y > maxY) continue;
        const kn = K(n);
        if (kn === ka || kn === kb) continue; // already the same node
        if (onSegment(n, a, b)) ds.union(kn, ka);
      }
    }
  }

  // 3. A name IS a connection. Two points carrying the same label are joined even with no wire between
  //    them — that is the entire purpose of a label — and likewise every `GND` power symbol on the sheet
  //    is one net. Skipping this is what made a sheet's ground arrive as one island per symbol.
  //
  //    **Scope is the subtle part.** Within one sheet every kind of label joins by name. But a global
  //    label, a power symbol and a hidden power pin also reach *across sheets*, so those additionally join
  //    a design-wide key. A local label deliberately does not: two sheets may both use `CLK` locally and
  //    mean different nets, and merging them would be the silent-short failure again.
  const join = (scope: string, name: string, at: Point) => {
    if (name) ds.union(nameKey(scope, name), K(at));
  };
  for (const l of sheet.labels) {
    join(ns, l.text, l.at);
    if (l.kind === "global") join(GLOBAL_SCOPE, l.text, l.at);
  }
  for (const p of sheet.pins) {
    if (p.power) {
      const n = powerName(p);
      join(ns, n, p.at);
      join(GLOBAL_SCOPE, n, p.at); // a power symbol is global by definition
    } else if (p.hidden && p.type === "power_in") {
      // The old 74xx convention: a symbol's supply pins are drawn nowhere and connect implicitly to the
      // global net matching the *pin's own name* — `U1` pin 7 named `GND` joins GND with no wire in
      // sight. KiCad discourages this for new libraries but still honours it, so a reader must too.
      // Without it every such pin becomes its own one-pin net and the supplies quietly lose members.
      join(ns, p.name, p.at);
      join(GLOBAL_SCOPE, p.name, p.at);
    }
  }
}

/** One connected component, before it is given a name. */
export interface Group {
  pins: string[];
  /** `${instancePath}\u0000${index}` — see `Net.wires` for why the instance has to be part of the key. */
  wires: Set<string>;
  labels: { text: string; kind: NameKind }[];
  /** Candidate auto-name sources, in file order — a net with no label is named after one of its pins. */
  anchors: { ref: string; number: string; name: string }[];
}

/**
 * Fold one sheet's pins, wires and labels into `groups`, keyed by union-find root.
 *
 * Wire indices are prefixed with `ns` so a design can tell one instance's wire 7 from another's.
 */
export function collectSheet(ds: DisjointSet, ns: string, sheet: Sheet, groups: Map<string, Group>): void {
  const group = (k: string) => {
    const root = ds.find(k);
    let g = groups.get(root);
    if (!g) { g = { pins: [], wires: new Set(), labels: [], anchors: [] }; groups.set(root, g); }
    return g;
  };

  sheet.wires.forEach((w, i) => group(nodeKey(ns, w.points[0]!.x, w.points[0]!.y)).wires.add(`${ns}\u0000${i}`));
  for (const p of sheet.pins) {
    const g = group(nodeKey(ns, p.at.x, p.at.y));
    // A power symbol is a net *name*, not a node on it: KiCad's netlist lists `GND` with the pins it
    // reaches and no `#PWR0x` node of its own. Emitting one would be a phantom connection.
    if (p.power) {
      g.labels.push({ text: powerName(p), kind: "power" });
      continue;
    }
    // A `#`-prefixed reference is a virtual symbol, not a part — `#PWR0x`, and `#FLG0x` for PWR_FLAG,
    // which is flagged power but has a `power_out` pin so it names nothing either. KiCad emits no node
    // for these, and neither should we; one showing up in a netlist is a phantom component.
    if (p.ref.startsWith("#")) continue;
    // Deduplicate. A multi-unit part carries its supply pins on unit 0, the shared body, which is placed
    // once per unit — so a quad NAND contributes `U2.7` four times at the same coordinate. They are one
    // pin on one net; listing it four times is both wrong and enough to fail an exact set comparison.
    const id = `${p.ref}.${p.number}`;
    if (g.pins.includes(id)) continue;
    g.pins.push(id);
    g.anchors.push({ ref: p.ref, number: p.number, name: p.name });
  }
  // A label attaches at its own coordinate; if nothing is there it names nothing, which is a real
  // (and reportable) schematic error rather than something to paper over.
  for (const l of sheet.labels) {
    const k = nodeKey(ns, l.at.x, l.at.y);
    if (!ds.has(k)) continue;
    group(k).labels.push({ text: l.text, kind: l.kind });
  }
}

/**
 * Name the collected groups. Auto-names are derived from a group's own contents, not a counter, so they
 * stay stable when unrelated parts of the design change.
 */
export function nameGroups(groups: Map<string, Group>, rootsOut?: Map<string, string>): Net[] {
  const nets: Net[] = [];
  for (const [root, g] of groups) {
    if (!g.pins.length && !g.wires.size) continue;
    const named = bestLabel(g.labels);
    // KiCad anchors an auto-name on the net's lowest-sorting pin, so the name survives file reordering.
    const anchor = [...g.anchors].sort((a, b) => `${a.ref}.${a.number}`.localeCompare(`${b.ref}.${b.number}`))[0];
    nets.push({
      name: named ?? (anchor ? autoName(anchor) : `Net-(W${[...g.wires].sort()[0]?.split("\u0000")[1]})`),
      unnamed: named === undefined,
      pins: [...g.pins].sort(),
      wires: [...g.wires]
        .sort()
        .map((k) => {
          const cut = k.lastIndexOf("\u0000");
          return { sheet: k.slice(0, cut), index: Number(k.slice(cut + 1)) };
        }),
      labels: g.labels.map((l) => l.text),
    });
    // The root -> name mapping is free here and quadratic to reconstruct afterwards, so hand it back.
    if (rootsOut) rootsOut.set(root, nets[nets.length - 1]!.name);
  }
  return nets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compute the nets on one sheet, ignoring any hierarchy below it.
 *
 * Only wire endpoints, junctions and pins become nodes. Interior points of a wire are deliberately *not*
 * nodes: that is precisely what stops two crossing wires from being merged. For a design with sub-sheets
 * use `loadDesign` in `design.ts` — this function will report a child sheet's pins as unconnected stubs.
 */
export function computeNets(sheet: Sheet): Net[] {
  const ds = new DisjointSet();
  const groups = new Map<string, Group>();
  unionSheet(ds, "", sheet);
  collectSheet(ds, "", sheet, groups);
  return nameGroups(groups);
}
