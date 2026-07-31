/**
 * Pulling the connectivity-relevant bits out of a `.kicad_sch` (ADR-038).
 *
 * A board tags every drawable with its net; a schematic tags **none**. Nets there are a property of
 * geometry — what touches what — so the first job is to get every wire, junction, label and pin into one
 * coordinate space. That is this file. Deciding which of them are connected is `nets.ts`.
 */
import { parseSexpr, children, child, nums, descendants, type SNode } from "./sexpr.js";
import { placePoint, pointKey, type Placement } from "./transform.js";

export interface Point {
  x: number;
  y: number;
}

/** A wire segment. KiCad writes exactly two points per `(wire (pts …))`, but the format permits more. */
export interface Wire {
  points: Point[];
}

/** A pin, placed on the sheet: `ref` identifies the component, `number` the pin on it. */
export interface PlacedPin {
  ref: string;
  number: string;
  name: string;
  /** Electrical type: `power_in`, `passive`, `output`, … Decides which pins name a net. */
  type: string;
  /** Hidden pins are drawn nowhere; a hidden `power_in` still connects, by name. See `nets.ts`. */
  hidden: boolean;
  at: Point;
  /** True when this pin belongs to a power symbol — it names its net instead of appearing on it. */
  power: boolean;
  /** The owning symbol's Value, which is the net name when `power` is set. */
  value: string;
}

/** Label kinds, in the order they win a naming contest — see `nets.ts`. */
export type LabelKind = "local" | "hierarchical" | "global";

export interface Label {
  text: string;
  kind: LabelKind;
  at: Point;
}

/**
 * A *sheet symbol* — a box on this sheet standing for another file. Its `pins` are the connection points
 * that bind to `hierarchical_label`s of the same name inside the child, and they sit in **this** sheet's
 * coordinate space, not the child's.
 */
export interface SheetSymbol {
  /** `Sheetname` property — the instance's name, which may differ from the file's. */
  name: string;
  /** `Sheetfile` property, relative to this sheet's directory. */
  file: string;
  /** This sheet symbol's uuid — one link in the instance path that identifies references. */
  uuid: string;
  pins: { name: string; at: Point }[];
}

export interface Sheet {
  /** Sheet file format version, e.g. 20250114. Worth carrying: it is the only version signal in the file. */
  version: number;
  /** This file's own uuid. The root sheet's uuid is the first element of every instance path. */
  uuid: string;
  /** Child sheets placed on this one. Empty for a flat design. */
  sheets: SheetSymbol[];
  wires: Wire[];
  /** Bus segments, kept separate from `wires`: a bus bundles nets, it is not one. */
  buses: Wire[];
  junctions: Point[];
  labels: Label[];
  pins: PlacedPin[];
  /** Explicit "nothing is connected here" markers. Also the oracle the pin transform was measured against. */
  noConnects: Point[];
  components: { ref: string; value: string; libId: string; power: boolean; at: Point }[];
}

interface LibPinDef {
  x: number;
  y: number;
  type: string;
  number: string;
  name: string;
  hidden: boolean;
}

/**
 * Is this pin hidden? Spelled two ways across the versions we read: KiCad 7 writes a bare `hide` atom
 * among the pin's children, KiCad 10 writes `(hide yes)`. Both appear in the corpora, so both are read.
 */
function isHidden(node: SNode[]): boolean {
  for (const c of node) {
    if (c === "hide") return true;
    if (Array.isArray(c) && c[0] === "hide") return c[1] !== "no";
  }
  return false;
}

/**
 * Is this library symbol a *power symbol* — a GND/VCC marker that names its net rather than joining it?
 *
 * Measured against `kicad-cli`'s own netlist, two plausible tests are wrong:
 *  - **Library name.** `power:GND` is only a convention; the sallen_key demo keeps its GND in
 *    `sallen_key_schlib:` and KiCad still treats it as a power symbol.
 *  - **Hidden pin.** True in KiCad 7, false for KiCad 10's `power:GND`, whose pin is visible.
 *
 * What actually holds is the `(power)` flag *plus* a `power_in` pin. The flag alone is not enough:
 * `PWR_FLAG` carries it but its pin is `power_out`, and KiCad correctly refuses to name a net `PWR_FLAG`.
 */
function isPowerSymbol(sym: SNode[], pins: LibPinDef[]): boolean {
  return !!child(sym, "power") && pins.some((p) => p.type === "power_in");
}

/** Value of a `(property "Name" "value" …)` child, if present. */
function property(node: SNode[], name: string): string | undefined {
  for (const p of children(node, "property")) {
    if (p[1] === name) return typeof p[2] === "string" ? p[2] : undefined;
  }
  return undefined;
}

/**
 * Pins declared by a `lib_symbols` entry, grouped by unit.
 *
 * Unit 0 is the shared body — power pins on a multi-unit part live there and are placed for every unit.
 * The unit number is read from the sub-symbol's name (`<symbol>_<unit>_<bodyStyle>`), which is a naming
 * convention rather than a declared field. That is the shakiest step in this file; it is flagged here
 * rather than buried, and it holds across both the KiCad 7 and KiCad 10 demo corpora.
 */
function libPinsByUnit(sym: SNode[]): Map<number, LibPinDef[]> {
  const out = new Map<number, LibPinDef[]>();
  for (const sub of children(sym, "symbol")) {
    const parts = String(sub[1]).split("_");
    const unit = Number(parts[parts.length - 2] ?? 0);
    if (!Number.isFinite(unit)) continue;
    const pins = descendants(sub, "pin")
      .map((p) => {
        const at = nums(p, "at");
        const num = child(p, "number");
        const nm = child(p, "name");
        return {
          x: at[0]!,
          y: at[1]!,
          // `(pin power_in line …)` — electrical type first, graphic style second.
          type: typeof p[1] === "string" ? p[1] : "",
          number: num && typeof num[1] === "string" ? num[1] : "",
          name: nm && typeof nm[1] === "string" ? nm[1] : "",
          hidden: isHidden(p),
        };
      })
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pins.length) out.set(unit, [...(out.get(unit) ?? []), ...pins]);
  }
  return out;
}

/**
 * How a library point maps onto the sheet. Injectable for one reason only: `tools/kicad-netlist-oracle.ts`
 * sweeps candidate transforms and scores them against KiCad's own netlist. Production always uses
 * `placePoint`; nothing in the bridge passes this.
 */
export type PlaceFn = (px: number, py: number, at: Placement) => [number, number];

export interface ReadOptions {
  place?: PlaceFn;
  /**
   * Instance path (`/rootUuid/sheetUuid…`) identifying *which placement of this file* is being read.
   *
   * This matters more than it looks. A reference designator is **not** a property of a symbol; it is a
   * property of a symbol *at a path*. `complex_hierarchy` places `ampli_ht.kicad_sch` twice, and the very
   * same potentiometer is `RV1` in one instance and `RV2` in the other — the `Reference` property holds
   * only one of them. Omit this and the property is used, which is right for a flat design and wrong for
   * any sheet placed more than once.
   */
  instancePath?: string;
}

/** The reference for this symbol at `path`, from its `instances` block; undefined if not listed there. */
function referenceAtPath(inst: SNode[], path: string): string | undefined {
  const block = child(inst, "instances");
  if (!block) return undefined;
  for (const proj of children(block, "project")) {
    for (const p of children(proj, "path")) {
      if (p[1] === path) {
        const r = child(p, "reference");
        if (r && typeof r[1] === "string") return r[1];
      }
    }
  }
  return undefined;
}

/** Read one schematic sheet. Throws only if the file is not parseable s-expression. */
export function readSheet(text: string, opts: ReadOptions | PlaceFn = {}): Sheet {
  // Tolerate the older positional `place` argument so the transform sweep keeps working unchanged.
  const { place = placePoint, instancePath } = typeof opts === "function" ? { place: opts } : opts;
  const root = parseSexpr(text);

  const wires: Wire[] = [];
  for (const w of children(root, "wire")) {
    const pts = child(w, "pts");
    if (!pts) continue;
    const points = children(pts, "xy")
      .map((p) => ({ x: p[1] as number, y: p[2] as number }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length >= 2) wires.push({ points });
  }

  // Bus segments. A bus is **not** a net — it is a bundle whose members are nets — so these are kept
  // apart from `wires` and never joined into signal connectivity. They exist so that two differently
  // named buses meeting on a sheet can have their members paired up. See `aliasBusMembers` in design.ts.
  const buses: Wire[] = [];
  for (const b of children(root, "bus")) {
    const pts = child(b, "pts");
    if (!pts) continue;
    const points = children(pts, "xy")
      .map((q) => ({ x: q[1] as number, y: q[2] as number }))
      .filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
    if (points.length >= 2) buses.push({ points });
  }

  const pointsOf = (tag: string): Point[] =>
    children(root, tag)
      .map((n) => nums(n, "at"))
      .filter((a) => a.length >= 2)
      .map((a) => ({ x: a[0]!, y: a[1]! }));

  const labels: Label[] = [];
  const kinds: [string, LabelKind][] = [
    ["label", "local"],
    ["hierarchical_label", "hierarchical"],
    ["global_label", "global"],
  ];
  for (const [tag, kind] of kinds) {
    for (const l of children(root, tag)) {
      const at = nums(l, "at");
      if (typeof l[1] !== "string" || at.length < 2) continue;
      labels.push({ text: l[1], kind, at: { x: at[0]!, y: at[1]! } });
    }
  }

  // Symbol pins: the library declares them in the symbol's own frame, the instance says where and how it
  // sits. See transform.ts — the mapping is measured, not assumed.
  const libs = child(root, "lib_symbols");
  const byName = new Map<string, ReturnType<typeof libPinsByUnit>>();
  const powerLibs = new Set<string>();
  if (libs) {
    for (const sym of children(libs, "symbol")) {
      const units = libPinsByUnit(sym);
      byName.set(String(sym[1]), units);
      if (isPowerSymbol(sym, [...units.values()].flat())) powerLibs.add(String(sym[1]));
    }
  }

  const pins: PlacedPin[] = [];
  const components: Sheet["components"] = [];
  for (const inst of children(root, "symbol")) {
    const lib = child(inst, "lib_id");
    const at = nums(inst, "at");
    if (!lib || typeof lib[1] !== "string" || at.length < 2) continue;
    const mirrorNode = child(inst, "mirror");
    const placement: Placement = {
      x: at[0]!,
      y: at[1]!,
      rotation: at[2] ?? 0,
      mirror: mirrorNode ? (String(mirrorNode[1]) as "x" | "y") : undefined,
    };
    const ref = (instancePath ? referenceAtPath(inst, instancePath) : undefined) ?? property(inst, "Reference") ?? "";
    const value = property(inst, "Value") ?? "";
    const power = powerLibs.has(lib[1]);
    components.push({ ref, value, libId: lib[1], power, at: { x: placement.x, y: placement.y } });

    const units = byName.get(lib[1]);
    if (!units) continue;
    const unit = nums(inst, "unit")[0] ?? 1;
    for (const p of [...(units.get(unit) ?? []), ...(units.get(0) ?? [])]) {
      const [x, y] = place(p.x, p.y, placement);
      pins.push({ ref, number: p.number, name: p.name, type: p.type, hidden: p.hidden, power, value, at: { x, y } });
    }
  }

  // Child sheets. Their pins live in *this* sheet's coordinate space, which is what lets them be joined
  // to local geometry like any other node; the binding to the child's own labels is by name, in design.ts.
  const sheets: SheetSymbol[] = [];
  for (const sh of children(root, "sheet")) {
    const props = new Map<string, string>();
    for (const p of children(sh, "property")) {
      if (typeof p[1] === "string" && typeof p[2] === "string") props.set(p[1], p[2]);
    }
    const pins: SheetSymbol["pins"] = [];
    for (const pin of children(sh, "pin")) {
      const at = nums(pin, "at");
      if (typeof pin[1] !== "string" || at.length < 2) continue;
      pins.push({ name: pin[1], at: { x: at[0]!, y: at[1]! } });
    }
    sheets.push({
      name: props.get("Sheetname") ?? "",
      file: props.get("Sheetfile") ?? "",
      uuid: String(child(sh, "uuid")?.[1] ?? ""),
      pins,
    });
  }

  return {
    version: nums(root, "version")[0] ?? 0,
    uuid: String(child(root, "uuid")?.[1] ?? ""),
    sheets,
    wires,
    buses,
    junctions: pointsOf("junction"),
    labels,
    pins,
    noConnects: pointsOf("no_connect"),
    components,
  };
}

/** Re-exported so callers key their own maps the same way connectivity does. */
export { pointKey };
