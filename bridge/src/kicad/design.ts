/**
 * Connectivity across a whole hierarchical design (ADR-038).
 *
 * `nets.ts` solves one sheet. Most real projects are several, and the joins between them are not geometric
 * — a sheet symbol on the parent is a box whose *pins* bind by **name** to `hierarchical_label`s inside
 * the child file. So the design walker builds one union-find spanning every sheet instance, namespaced so
 * that the same file placed twice stays two separate sets of nets.
 *
 * Three mechanisms appear in the KiCad demos, and a reader needs all three — each is the *only* mechanism
 * in at least one project, so implementing two of them looks like it works right up until it doesn't:
 *
 *  1. **Sheet pin ↔ hierarchical label**, by name (`video`, `kit-dev-coldfire`, `pic_programmer`).
 *  2. **Global labels and power symbols**, which reach every sheet regardless of nesting
 *     (`flat_hierarchy` connects its three sheets this way and has no sheet pins at all).
 *  3. **Per-instance reference designators** (`complex_hierarchy`). This one is not about nets: it places
 *     `ampli_ht.kicad_sch` twice, and the same potentiometer is `RV1` in one instance and `RV2` in the
 *     other. A reader that trusts the `Reference` property reports one of them twice — two components
 *     collapsed into one, in a netlist that otherwise looks entirely reasonable.
 */
import { dirname, join, normalize } from "node:path";
import { readSheet, type Sheet } from "./schematic.js";
import { pointKey } from "./transform.js";
import {
  DisjointSet,
  busMembers,
  collectSheet,
  nameGroups,
  nameKey,
  nodeKey,
  onSegment,
  unionName,
  unionSheet,
  type Group,
  type Net,
} from "./nets.js";

/** One *placement* of a sheet file. The same file placed twice yields two instances with distinct paths. */
export interface SheetInstance {
  /** Instance path — `/rootUuid/sheetUuid…`. Identifies references and namespaces this sheet's nodes. */
  path: string;
  /** Path of the file on disk, as resolved from the parent's `Sheetfile`. */
  file: string;
  /** `Sheetname`, or `/` for the root. */
  name: string;
  sheet: Sheet;
}

export interface Design {
  instances: SheetInstance[];
  nets: Net[];
  /**
   * Sheets that could not be read, and why. Empty for a healthy design.
   *
   * A design is served even when part of it is unreadable — availability first — but the caller is told,
   * because a viewer that silently drops a sheet renders something wrong that looks complete.
   */
  problems: string[];
}

/** How deep a sheet tree may nest before we call it a cycle. KiCad's own limit is far below this. */
const MAX_DEPTH = 32;

/**
 * Load a design starting at its root sheet.
 *
 * `read` maps an absolute-ish file path to its contents, so callers can serve from a git object store
 * rather than the filesystem — the bridge reads repository blobs, not working trees.
 */
export function loadDesign(rootFile: string, read: (file: string) => string): Design {
  const instances: SheetInstance[] = [];
  const problems: string[] = [];

  // The root's own uuid is the first element of every instance path, including its own — so the file has
  // to be parsed once to learn the path, then again to resolve references against it. The *text* is read
  // only once: `read` may be fetching a git blob, and Phase 1 caches the result by content hash anyway.
  const rootText = read(rootFile);
  const rootPath = `/${readSheet(rootText).uuid}`;
  instances.push({ path: rootPath, file: rootFile, name: "/", sheet: readSheet(rootText, { instancePath: rootPath }) });

  // Breadth-first over placements, not over files: a file placed twice is visited twice, by design.
  const queue: { inst: SheetInstance; depth: number }[] = [{ inst: instances[0]!, depth: 0 }];
  const seenPaths = new Set<string>([rootPath]);
  while (queue.length) {
    const { inst, depth } = queue.shift()!;
    if (depth >= MAX_DEPTH) continue;
    for (const sub of inst.sheet.sheets) {
      if (!sub.file) continue;
      const file = normalize(join(dirname(inst.file), sub.file));
      const path = `${inst.path}/${sub.uuid}`;
      // Two sheet symbols sharing a uuid would collide on this path and silently overwrite each other's
      // references. That is a malformed file, not a cycle — a sheet that contained itself would generate
      // a *new* path at every level and be caught by MAX_DEPTH instead.
      if (seenPaths.has(path)) {
        problems.push(`duplicate sheet uuid ${sub.uuid} under ${inst.file}; "${sub.name}" skipped`);
        continue;
      }
      seenPaths.add(path);
      let sheet: Sheet;
      try {
        sheet = readSheet(read(file), { instancePath: path });
      } catch (err) {
        // One bad sub-sheet costs that sheet, not the whole design — but it is reported rather than
        // swallowed. A viewer that quietly drops a sheet shows a design that is wrong and looks complete.
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const child: SheetInstance = { path, file, name: sub.name, sheet };
      instances.push(child);
      queue.push({ inst: child, depth: depth + 1 });
    }
  }

  const ds = new DisjointSet();
  for (const inst of instances) unionSheet(ds, inst.path, inst.sheet);

  // Bind each sheet symbol's pins to the matching `hierarchical_label` inside the instance it names.
  // The pin lives in the parent's coordinate space and the label in the child's; the *name* is the join,
  // which is why this cannot fall out of geometry the way everything in `nets.ts` does.
  const byPath = new Map(instances.map((i) => [i.path, i]));
  for (const parent of instances) {
    for (const sub of parent.sheet.sheets) {
      const child = byPath.get(`${parent.path}/${sub.uuid}`);
      if (!child) continue;
      for (const pin of sub.pins) {
        // The pin's identity **on the parent** is its geometry; its name only says which of the child's
        // hierarchical labels it feeds. Binding the name into the parent's name scope instead was a real
        // bug: `video` places two sheets that each expose a pin named `BLUE`, wired to different nets, and
        // routing both through one parent-scope `BLUE` node shorted them together.
        ds.union(nodeKey(parent.path, pin.at.x, pin.at.y), nameKey(child.path, pin.name));
        // A bus pin also carries its members across. The child commonly refers to them by plain local
        // labels (`AN0`) and never mentions the bus, so without this the parent and child each keep a
        // disconnected `AN0` and every one of those nets splits. Members join scope-to-scope, not through
        // the pin's node — routing them through it would merge the whole bus into a single net.
        for (const m of busMembers(pin.name)) unionName(ds, parent.path, child.path, m);
      }
    }
  }

  aliasBusMembers(ds, instances);

  const groups = new Map<string, Group>();
  for (const inst of instances) collectSheet(ds, inst.path, inst.sheet, groups);
  return { instances, nets: nameGroups(groups), problems };
}

/**
 * Where two differently-named buses meet, pair their members up **by index**.
 *
 * `video`'s top sheet runs one physical bus past five sheet symbols that each name it differently —
 * `DQ[0..31]`, `DPC[0..31]`, `PC_D[0..7]`, `DQ[0..15]` — and each child then refers to its own members by
 * plain local labels. KiCad treats member *i* of one as member *i* of the other, so `DQ0`, `PC_D0` and
 * `DPC0` are one net. Matching members by name alone leaves that net in three pieces, which is 66 of
 * `video`'s 588 nets.
 *
 * Widths need not agree; the overlap is what is shared. Only members are aliased, never the buses
 * themselves — a bus is not a net, and joining the bus nodes would collapse every member into one.
 */
function aliasBusMembers(ds: DisjointSet, instances: SheetInstance[]): void {
  for (const inst of instances) {
    const ns = inst.path;
    const anchors: { name: string; at: { x: number; y: number } }[] = [];
    for (const l of inst.sheet.labels) {
      if (busMembers(l.text).length) anchors.push({ name: l.text, at: l.at });
    }
    for (const sub of inst.sheet.sheets) {
      for (const pin of sub.pins) {
        if (busMembers(pin.name).length) anchors.push({ name: pin.name, at: pin.at });
      }
    }
    if (anchors.length < 2) continue;

    // A **separate** union-find over bus geometry only. Bus segments must never touch the signal
    // union-find: a bus is a bundle, not a net, and a single accidental join between a bus node and a
    // signal node would merge every member of that bus into one net.
    const bus = new DisjointSet();
    const bk = (x: number, y: number) => pointKey(x, y);
    for (const b of inst.sheet.buses) {
      for (let i = 1; i < b.points.length; i++) {
        bus.union(bk(b.points[i - 1]!.x, b.points[i - 1]!.y), bk(b.points[i]!.x, b.points[i]!.y));
      }
    }
    // An anchor joins a bus segment it sits on, endpoint or mid-span — same contact rule as signals.
    for (const a of anchors) {
      for (const b of inst.sheet.buses) {
        for (let i = 1; i < b.points.length; i++) {
          if (onSegment(a.at, b.points[i - 1]!, b.points[i]!)) {
            bus.union(bk(a.at.x, a.at.y), bk(b.points[i - 1]!.x, b.points[i - 1]!.y));
          }
        }
      }
    }

    // Snapshot the grouping before unioning anything, so aliasing one pair cannot drag in a bus that
    // never touched it.
    const byRoot = new Map<string, Set<string>>();
    for (const a of anchors) {
      const root = bus.find(bk(a.at.x, a.at.y));
      let set = byRoot.get(root);
      if (!set) byRoot.set(root, (set = new Set()));
      set.add(a.name);
    }
    for (const names of byRoot.values()) {
      const list = [...names];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = busMembers(list[i]!);
          const b = busMembers(list[j]!);
          for (let k = 0; k < Math.min(a.length, b.length); k++) unionName(ds, ns, ns, a[k]!, b[k]!);
        }
      }
    }
  }
}


