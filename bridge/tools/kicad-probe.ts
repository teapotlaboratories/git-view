/**
 * Score the pin transform against real KiCad output (ADR-038).
 *
 * The convention in `src/kicad/transform.ts` was chosen by measurement, and this is the measurement.
 * It exists as a committed tool rather than a throwaway script because the numbers quoted in ADR-038
 * are otherwise unreproducible — including by the person who wrote them, once the box reboots.
 *
 * **How it can tell right from wrong.** A `no_connect` marker is placed by KiCad exactly on an
 * unconnected pin, and a wire endpoint is where a connected pin must sit. Together they give a set of
 * points that a correct transform has to hit.
 *
 * **And where it is blind.** This is *necessary, not sufficient*, and the gap turned out to be real
 * rather than theoretical. The oracle constrains where pins land, not which pin landed there — swapping
 * pins 1 and 2 of a two-pin part leaves every coordinate untouched, and most mirrored parts in the corpus
 * are two-pin. A transform that applied the mirror before the rotation therefore scored ~91% here while
 * silently reversing every polarised two-pin part on the sheet. `tools/kicad-netlist-oracle.ts` compares
 * derived *nets* against `kicad-cli`, which names the pin on each net, and that is what caught it. Run
 * both: this one covers 115 KiCad 10 sheets, that one is limited to whatever KiCad the box can install.
 *
 * Usage:
 *   npx tsx tools/kicad-probe.ts <dir-of-kicad-projects> [more dirs…]
 *
 * Getting a corpus (no KiCad install needed, ~93 MB):
 *   curl -sL -o demos.tgz \
 *     'https://gitlab.com/api/v4/projects/kicad%2Fcode%2Fkicad/repository/archive.tar.gz?sha=10.0.5&path=demos'
 *   tar xzf demos.tgz
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSexpr, children, child, nums, descendants, type SNode } from "../src/kicad/sexpr.js";
import { placePoint, pointKey, type Placement } from "../src/kicad/transform.js";

/** Candidate transforms. The shipping one is first; the rest exist to show it is not arbitrary. */
const CANDIDATES: Record<string, (px: number, py: number, at: Placement) => [number, number]> = {
  "SHIPPING (Yflip, rotate -r, mirror)": placePoint,
  "Yflip, rotate +r, mirror": (px, py, at) => placePoint(px, py, { ...at, rotation: -at.rotation }),
  "no Yflip": (px, py, at) => {
    const [x, y] = placePoint(px, -py, { ...at, x: 0, y: 0 });
    return [at.x + x, at.y + y];
  },
  "mirror ignored": (px, py, at) => placePoint(px, py, { ...at, mirror: undefined }),
  // Kept as a standing reminder that this oracle scores it within ~1 point of the shipping transform
  // while getting every mirrored two-pin part's polarity backwards. See the header.
  "mirror BEFORE rotate (position-equivalent, connectivity-wrong)": (px, py, at) => {
    let x = px;
    let y = -py;
    if (at.mirror === "x") y = -y;
    else if (at.mirror === "y") x = -x;
    const r = (-at.rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [at.x + (x * c - y * s), at.y + (x * s + y * c)];
  },
};

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".kicad_sch")) yield p;
  }
}

/** Pins of a `lib_symbols` entry, grouped by unit. Unit 0 holds graphics shared by every unit. */
function libPinsByUnit(sym: SNode[]): Map<number, { x: number; y: number }[]> {
  const out = new Map<number, { x: number; y: number }[]>();
  for (const sub of children(sym, "symbol")) {
    // Sub-symbols are named "<symbol>_<unit>_<bodystyle>". Reading the unit from the name is a
    // convention, not a declared field — flagged rather than hidden, since it is the shakiest step here.
    const parts = String(sub[1]).split("_");
    const unit = Number(parts[parts.length - 2] ?? 0);
    if (!Number.isFinite(unit)) continue;
    const pins = descendants(sub, "pin")
      .map((p) => { const at = nums(p, "at"); return { x: at[0]!, y: at[1]! }; })
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pins.length) out.set(unit, [...(out.get(unit) ?? []), ...pins]);
  }
  return out;
}

async function main(): Promise<void> {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error("usage: tsx tools/kicad-probe.ts <dir-of-kicad-projects> [more dirs…]");
    process.exit(2);
  }

  for (const dir of dirs) {
    const score = new Map<string, [number, number]>();
    for (const n of Object.keys(CANDIDATES)) score.set(n, [0, 0]);
    let sheets = 0;
    let mirrored = 0;

    for await (const file of walk(dir)) {
      let root: SNode[];
      try { root = parseSexpr(readFileSync(file, "utf-8")); } catch { continue; }
      const libs = child(root, "lib_symbols");
      if (!libs) continue;
      sheets++;

      const oracle = new Set<string>();
      for (const nc of children(root, "no_connect")) {
        const a = nums(nc, "at");
        if (a.length >= 2) oracle.add(pointKey(a[0]!, a[1]!));
      }
      for (const w of children(root, "wire")) {
        const pts = child(w, "pts");
        if (pts) for (const p of children(pts, "xy")) oracle.add(pointKey(p[1] as number, p[2] as number));
      }

      const byName = new Map<string, Map<number, { x: number; y: number }[]>>();
      for (const sym of children(libs, "symbol")) byName.set(String(sym[1]), libPinsByUnit(sym));

      for (const inst of children(root, "symbol")) {
        const lib = child(inst, "lib_id");
        const at = nums(inst, "at");
        if (!lib || at.length < 2) continue;
        const units = byName.get(String(lib[1]));
        if (!units) continue;

        const mirrorNode = child(inst, "mirror");
        const mirror = mirrorNode ? (String(mirrorNode[1]) as "x" | "y") : undefined;
        if (mirror) mirrored++;
        const place: Placement = { x: at[0]!, y: at[1]!, rotation: at[2] ?? 0, mirror };

        const unit = nums(inst, "unit")[0] ?? 1;
        const pins = [...(units.get(unit) ?? []), ...(units.get(0) ?? [])];
        for (const p of pins) {
          for (const [name, fn] of Object.entries(CANDIDATES)) {
            const [x, y] = fn(p.x, p.y, place);
            const s = score.get(name)!;
            s[1]++;
            if (oracle.has(pointKey(x, y))) s[0]++;
          }
        }
      }
    }

    console.log(`\n${dir}\n  ${sheets} sheets, ${mirrored} mirrored instances (included)`);
    const rows = [...score.entries()].sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1]);
    for (const [name, [hit, total]] of rows) {
      const pct = total ? ((hit / total) * 100).toFixed(1) : "0.0";
      console.log(`  ${pct.padStart(6)}%  ${String(hit).padStart(6)}/${total}  ${name}`);
    }
  }
}

void main();
