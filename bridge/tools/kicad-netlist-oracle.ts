/**
 * Scoring our derived connectivity against KiCad's own netlist (ADR-038).
 *
 * `nets.ts` infers connectivity from geometry. There is no way to eyeball whether it is right: a wrong
 * answer renders a perfect sheet and only shows up later as a highlight that lights the wrong wires. So
 * it is measured against ground truth produced by KiCad itself:
 *
 *     kicad-cli sch export netlist --format kicadsexpr
 *
 * **`kicad-cli` is a development-time oracle and must never become a runtime dependency.** The bridge
 * parses schematics itself; this tool exists to prove that parsing is faithful. Only the KiCad 7 CLI is
 * packaged for this distro, but the connectivity *rules* are not version-specific, so the 7.x demo corpus
 * is what gets scored. Run it after touching `nets.ts`, `schematic.ts` or `transform.ts`.
 *
 *     npx tsx tools/kicad-netlist-oracle.ts <dir-of-kicad-projects>
 *
 * The metric is agreement between **partitions of pins**, not net names: names are cosmetic, but a wrong
 * partition is a wrong circuit. Merges are reported separately from splits because they are the dangerous
 * direction — a merge silently shorts two unrelated nets, while a split only fails to highlight.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSexpr, children, child } from "../src/kicad/sexpr.js";
import { readSheet, type PlaceFn } from "../src/kicad/schematic.js";
import { computeNets, type Net } from "../src/kicad/nets.js";
import { loadDesign } from "../src/kicad/design.js";

/** Ground-truth nets from kicad-cli, as `name -> sorted ["REF.PIN", …]`. */
function oracleNets(sheet: string, out: string): Map<string, string[]> {
  execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sheet], {
    stdio: "pipe",
    timeout: 120_000,
  });
  const root = parseSexpr(readFileSync(out, "utf-8"));
  const nets = new Map<string, string[]>();
  const section = child(root, "nets");
  if (!section) return nets;
  for (const n of children(section, "net")) {
    const name = String(child(n, "name")?.[1] ?? "");
    const pins = children(n, "node")
      .map((nd) => `${child(nd, "ref")?.[1]}.${child(nd, "pin")?.[1]}`)
      .sort();
    if (pins.length) nets.set(name, pins);
  }
  return nets;
}

const key = (pins: string[]) => pins.join(" ");

interface Score {
  project: string;
  hierarchical: boolean;
  buses: number;
  oracleNets: number;
  exact: number;
  merged: number;
  split: number;
  namesMatched: number;
  missingPins: string[];
  extraPins: string[];
}

async function scoreSheet(sheet: string, tmp: string): Promise<Score | undefined> {
  let truth: Map<string, string[]>;
  try {
    truth = oracleNets(sheet, join(tmp, "n.net"));
  } catch {
    return undefined; // kicad-cli refused the file — reported by the caller as skipped, never as a pass
  }
  const src = readFileSync(sheet, "utf-8");
  const parsed = readSheet(src);
  // Whole-design solve. The oracle always netlists every sheet, so scoring a hierarchical project against
  // one sheet was never a fair comparison — it measured the missing feature, not the solver.
  const mine = (await loadDesign(sheet, (f) => readFileSync(f, "utf-8"))).nets.filter((n) => n.pins.length);

  // Which of our nets each pin landed on, so a mismatch can be classified rather than merely counted.
  const ourNetOf = new Map<string, number>();
  mine.forEach((n, i) => n.pins.forEach((p) => ourNetOf.set(p, i)));
  const truthPins = new Set([...truth.values()].flat());
  const ourPins = new Set(mine.flatMap((n) => n.pins));

  const bySet = new Map(mine.map((n) => [key(n.pins), n]));
  let exact = 0;
  let merged = 0;
  let split = 0;
  let namesMatched = 0;
  for (const [name, pins] of truth) {
    const hit = bySet.get(key(pins));
    if (hit) {
      exact++;
      if (hit.name === name || hit.name === name.replace(/^\/+/, "")) namesMatched++;
      continue;
    }
    // Where did this net's pins actually go? One of ours holding pins from >1 oracle net is a merge.
    const landed = new Set(pins.map((p) => ourNetOf.get(p)).filter((i) => i !== undefined));
    if (landed.size > 1) split++;
    else merged++;
  }
  return {
    project: sheet.split("/").slice(-2).join("/"),
    // Scope markers. The oracle always netlists the whole design, so a sheet carrying sub-sheets or buses
    // is being scored against features this solver does not implement yet — kept visible rather than
    // quietly averaged into the headline number.
    hierarchical: /^\s*\(sheet[\s(]/m.test(src),
    buses: (src.match(/^\s*\(bus[\s(]/gm) ?? []).length,
    oracleNets: truth.size,
    exact,
    merged,
    split,
    namesMatched,
    missingPins: [...truthPins].filter((p) => !ourPins.has(p)),
    extraPins: [...ourPins].filter((p) => !truthPins.has(p)),
  };
}

const rootDir = process.argv[2];
/** `--explain <substring>` dumps every disagreeing net for the matching project, rather than a count. */
const explain = process.argv.includes("--explain") ? process.argv[process.argv.indexOf("--explain") + 1] : undefined;
if (!rootDir) {
  console.error("usage: kicad-netlist-oracle.ts <dir-of-kicad-projects> [--explain <project-substring>]");
  process.exit(2);
}

// Only top sheets — a project's top sheet is the one named like its `.kicad_pro`.
const sheets: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith(".kicad_pro")) {
      const top = p.replace(/\.kicad_pro$/, ".kicad_sch");
      try {
        statSync(top);
        sheets.push(top);
      } catch {
        /* project without a matching top sheet */
      }
    }
  }
};
walk(rootDir);

/**
 * `--sweep` scores candidate pin transforms against the oracle.
 *
 * The earlier `kicad-probe.ts` used `no_connect` markers, which pin down *positions* but not *identities*:
 * a two-pin symbol produces the same set of coordinates whether or not pin 1 and pin 2 are swapped, and
 * most mirrored parts in the corpus are two-pin. A netlist knows which pin is which, so it can settle the
 * question the marker oracle left open.
 */
if (process.argv.includes("--sweep")) {
  const candidates: { name: string; fn: PlaceFn }[] = [];
  for (const rotSign of [-1, 1]) {
    for (const mirrorAfter of [false, true]) {
      for (const xNegatesY of [true, false]) {
        candidates.push({
          name: `rot${rotSign > 0 ? "+" : "-"}r ${mirrorAfter ? "mirror-after " : "mirror-before"} ${xNegatesY ? "x:negY" : "x:negX"}`,
          fn: (px, py, at) => {
            let x = px;
            let y = -py;
            const mirror = () => {
              if (at.mirror === "x") xNegatesY ? (y = -y) : (x = -x);
              else if (at.mirror === "y") xNegatesY ? (x = -x) : (y = -y);
            };
            if (!mirrorAfter) mirror();
            const r = (rotSign * at.rotation * Math.PI) / 180;
            const c = Math.cos(r);
            const s = Math.sin(r);
            [x, y] = [x * c - y * s, x * s + y * c];
            if (mirrorAfter) mirror();
            return [at.x + x, at.y + y];
          },
        });
      }
    }
  }
  const flatSheets: { sheet: string; truth: Map<string, string[]> }[] = [];
  for (const s of sheets.sort()) {
    const src = readFileSync(s, "utf-8");
    if (/^\s*\(sheet[\s(]/m.test(src)) continue; // hierarchy would dominate the score with noise
    try {
      flatSheets.push({ sheet: s, truth: oracleNets(s, join(mkdtempSync(join(tmpdir(), "kicad-oracle-")), "n.net")) });
    } catch {
      /* skipped */
    }
  }
  console.log(`sweeping ${candidates.length} transforms over ${flatSheets.length} flat sheets\n`);
  for (const cand of candidates) {
    let exact = 0;
    let total = 0;
    for (const { sheet, truth } of flatSheets) {
      const mine = computeNets(readSheet(readFileSync(sheet, "utf-8"), cand.fn)).filter((n) => n.pins.length);
      const bySet = new Set(mine.map((n) => key(n.pins)));
      for (const pins of truth.values()) {
        total++;
        if (bySet.has(key(pins))) exact++;
      }
    }
    console.log(`  ${cand.name.padEnd(40)} ${String(exact).padStart(5)}/${total}  ${((exact / total) * 100).toFixed(1)}%`);
  }
  process.exit(0);
}

if (explain) {
  const sheet = sheets.find((s) => s.includes(explain));
  if (!sheet) {
    console.error(`no project matching ${explain}`);
    process.exit(2);
  }
  const truth = oracleNets(sheet, join(mkdtempSync(join(tmpdir(), "kicad-oracle-")), "n.net"));
  // Must solve exactly the way `scoreSheet` does. It didn't, once: explain used single-sheet solving
  // while the score used the whole design, so every sub-sheet pin printed as "(nowhere)" and sent me
  // chasing a bug that was in the diagnostic, not the solver.
  const design = await loadDesign(sheet, (f) => readFileSync(f, "utf-8"));
  const parsed = design.instances[0]!.sheet;
  const mine = design.nets.filter((n) => n.pins.length);
  const bySet = new Map(mine.map((n) => [key(n.pins), n]));
  // Keyed by index, not name: two of our nets can carry the same auto-name, and grouping by name would
  // print a split as though it were a match.
  const ourNetOf = new Map<string, number>();
  mine.forEach((n, i) => n.pins.forEach((p) => ourNetOf.set(p, i)));
  console.log(`${sheet}\n  ${parsed.wires.length} wires, ${parsed.junctions.length} junctions, ${parsed.labels.length} labels, ${parsed.pins.length} pins\n`);
  for (const [name, pins] of truth) {
    if (bySet.has(key(pins))) continue;
    console.log(`  oracle ${name}  [${pins.join(" ")}]`);
    const landed = new Map<number, string[]>();
    for (const p of pins) {
      const i = ourNetOf.get(p) ?? -1;
      landed.set(i, [...(landed.get(i) ?? []), p]);
    }
    for (const [i, ps] of landed) {
      console.log(`      ours #${i} ${i < 0 ? "(nowhere)" : mine[i]!.name}  [${ps.join(" ")}]`);
      // The pins we put on that net which the oracle did NOT — this is what makes a merge a merge, and
      // without printing it a merge is indistinguishable from an exact match.
      const extra = i < 0 ? [] : mine[i]!.pins.filter((p) => !pins.includes(p));
      if (extra.length) console.log(`        + also carries [${extra.join(" ")}]`);
    }
  }
  process.exit(0);
}

const scores: Score[] = [];
let skipped = 0;
for (const s of sheets.sort()) {
  const r = await scoreSheet(s, mkdtempSync(join(tmpdir(), "kicad-oracle-")));
  if (!r) {
    skipped++;
    continue;
  }
  scores.push(r);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const tot = (rows: Score[], f: (s: Score) => number) => rows.reduce((a, s) => a + f(s), 0);

function report(title: string, rows: Score[]) {
  if (!rows.length) return;
  console.log(`\n=== ${title} (${rows.length} sheets) ===`);
  console.log(`${pad("project", 46)} ${pad("nets", 6)} ${pad("exact", 10)} ${pad("merge", 6)} ${pad("split", 6)} names`);
  for (const s of rows) {
    const pct = s.oracleNets ? ((s.exact / s.oracleNets) * 100).toFixed(0) : "—";
    console.log(
      `${pad(s.project, 46)} ${pad(s.oracleNets, 6)} ${pad(`${s.exact} (${pct}%)`, 10)} ${pad(s.merged, 6)} ${pad(s.split, 6)} ${s.namesMatched}`,
    );
  }
  const n = tot(rows, (s) => s.oracleNets);
  console.log(
    `${pad("SUBTOTAL", 46)} ${pad(n, 6)} ${pad(`${tot(rows, (s) => s.exact)} (${((tot(rows, (s) => s.exact) / n) * 100).toFixed(1)}%)`, 10)} ` +
      `${pad(tot(rows, (s) => s.merged), 6)} ${pad(tot(rows, (s) => s.split), 6)} ${tot(rows, (s) => s.namesMatched)}`,
  );
}

// Split by feature so a regression shows up where it happened rather than as one blended percentage.
// All three are in scope now; the headings stay because they are the shape of the risk.
const flat = scores.filter((s) => !s.hierarchical && !s.buses);
report("flat, no buses", flat);
report("buses", scores.filter((s) => !s.hierarchical && s.buses));
report("hierarchical (whole design: every sheet, per-instance references)", scores.filter((s) => s.hierarchical));
const all = scores.reduce((a, s) => a + s.oracleNets, 0);
const hit = scores.reduce((a, s) => a + s.exact, 0);
console.log(`\nTOTAL  ${scores.length} projects  nets=${all}  exact=${hit} (${((hit / all) * 100).toFixed(1)}%)  ` +
  `merged=${scores.reduce((a, s) => a + s.merged, 0)}  split=${scores.reduce((a, s) => a + s.split, 0)}`);
if (skipped) console.log(`\n${skipped} sheets skipped: kicad-cli refused them`);

for (const w of scores.filter((s) => s.exact < s.oracleNets)) {
  if (w.missingPins.length) console.log(`  ${w.project}: ${w.missingPins.length} pins we never placed, e.g. ${w.missingPins.slice(0, 8).join(", ")}`);
  if (w.extraPins.length) console.log(`  ${w.project}: ${w.extraPins.length} pins the oracle has no node for, e.g. ${w.extraPins.slice(0, 8).join(", ")}`);
}
