import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDesign } from "../src/kicad/design.js";
import { busMembers } from "../src/kicad/nets.js";

/**
 * Connectivity across a hierarchy (ADR-038).
 *
 * Companion to `kicadNets.test.ts`, which covers one sheet. Everything here was settled by measurement
 * against `kicad-cli` (`tools/kicad-netlist-oracle.ts`, 1722/1722 nets over all 19 demo projects), and
 * re-stated on hand-authored fixtures because that tool needs KiCad installed and a separately-licensed
 * corpus, so it cannot run in CI.
 *
 * Two of these pin down bugs that scored *well* before they were caught: same-named sheet pins on
 * different child sheets used to be shorted together, and bus members used to be matched by name only.
 */

const px = (n: number) => n.toFixed(2);

const TP = `(symbol "t:TP"
  (symbol "t:TP_1_1"
    (pin passive line (at 0 0 0) (length 0)
      (name "~" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27)))))))`;

function power(name: string, pinName: string) {
  return `(symbol "t:${name}" (power)
    (symbol "t:${name}_1_1"
      (pin power_in line (at 0 0 0) (length 0)
        (name "${pinName}" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))))`;
}

const wire = (x1: number, y1: number, x2: number, y2: number) =>
  `(wire (pts (xy ${px(x1)} ${px(y1)}) (xy ${px(x2)} ${px(y2)})))`;
const bus = (x1: number, y1: number, x2: number, y2: number) =>
  `(bus (pts (xy ${px(x1)} ${px(y1)}) (xy ${px(x2)} ${px(y2)})))`;
const label = (t: string, x: number, y: number, kind = "label") => `(${kind} "${t}" (at ${px(x)} ${px(y)} 0))`;

/** A symbol instance. `instances` maps sheet path -> reference, which is what a reused sheet needs. */
function inst(lib: string, ref: string, x: number, y: number, value = "V", paths: Record<string, string> = {}) {
  const block = Object.entries(paths).length
    ? `(instances (project "p" ${Object.entries(paths)
        .map(([path, r]) => `(path "${path}" (reference "${r}") (unit 1))`)
        .join(" ")}))`
    : "";
  return `(symbol (lib_id "${lib}") (at ${px(x)} ${px(y)} 0) (unit 1)
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "${value}" (at 0 0 0)) ${block})`;
}

/** A sheet symbol pointing at another file. */
function subsheet(name: string, file: string, uuid: string, pins: { name: string; x: number; y: number }[]) {
  return `(sheet (at 10 10) (uuid "${uuid}")
    (property "Sheetname" "${name}" (at 0 0 0))
    (property "Sheetfile" "${file}" (at 0 0 0))
    ${pins.map((p) => `(pin "${p.name}" input (at ${px(p.x)} ${px(p.y)} 0))`).join("\n")})`;
}

function sheetFile(uuid: string, libs: string[], body: string[]): string {
  return `(kicad_sch (version 20250114) (generator "test") (uuid "${uuid}")
    (lib_symbols ${libs.join("\n")})
    ${body.join("\n")})`;
}

/** Solve a design from an in-memory file map. Keys are the paths `Sheetfile` resolves to. */
async function solve(files: Record<string, string>, top = "/d/top.kicad_sch") {
  const design = await loadDesign(top, (f) => {
    const hit = files[f];
    if (hit === undefined) throw new Error(`no such file ${f}`);
    return hit;
  });
  return design.nets
    .filter((n) => n.pins.length)
    .map((n) => ({ name: n.name, pins: n.pins }))
    .sort((a, b) => a.pins[0]!.localeCompare(b.pins[0]!));
}

test("busMembers expands vectors and groups, and leaves plain names alone", async () => {
  assert.deepEqual(busMembers("AN[0..3]"), ["AN0", "AN1", "AN2", "AN3"]);
  assert.deepEqual(busMembers("D[3..0]"), ["D0", "D1", "D2", "D3"], "reversed ranges normalise");
  assert.deepEqual(busMembers("{SDA SCL}"), ["SDA", "SCL"]);
  assert.deepEqual(busMembers("PLAIN"), [], "a plain name has no members");
});

test("a sheet pin binds to the child's hierarchical label of the same name", async () => {
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      inst("t:TP", "R1", 0, 10),
      wire(0, 10, 50, 10),
      subsheet("child", "child.kicad_sch", "S1", [{ name: "SIG", x: 50, y: 10 }]),
    ]),
    "/d/child.kicad_sch": sheetFile("c1", [TP], [
      inst("t:TP", "R2", 0, 30),
      wire(0, 30, 20, 30),
      label("SIG", 20, 30, "hierarchical_label"),
    ]),
  };
  assert.deepEqual(await solve(files), [{ name: "SIG", pins: ["R1.1", "R2.1"] }]);
});

test("same-named sheet pins on different children are NOT shorted together", async () => {
  // Regression. Binding a sheet pin through the *parent's* name scope merged these: `video` places two
  // sheets that each expose a pin named `BLUE`, wired to different parent nets, and they became one net.
  // A sheet pin's identity on the parent is its geometry; its name only selects the child's label.
  const child = (ref: string) =>
    sheetFile(`c-${ref}`, [TP], [inst("t:TP", ref, 0, 30), wire(0, 30, 20, 30), label("BLUE", 20, 30, "hierarchical_label")]);
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      inst("t:TP", "R1", 0, 10),
      wire(0, 10, 50, 10),
      subsheet("a", "a.kicad_sch", "S1", [{ name: "BLUE", x: 50, y: 10 }]),
      inst("t:TP", "R2", 0, 60),
      wire(0, 60, 50, 60),
      subsheet("b", "b.kicad_sch", "S2", [{ name: "BLUE", x: 50, y: 60 }]),
    ]),
    "/d/a.kicad_sch": child("RA"),
    "/d/b.kicad_sch": child("RB"),
  };
  assert.deepEqual(await solve(files), [
    { name: "BLUE", pins: ["R1.1", "RA.1"] },
    { name: "BLUE", pins: ["R2.1", "RB.1"] },
  ]);
});

test("a reused sheet takes its references from the instance path, not the Reference property", async () => {
  // `complex_hierarchy` places one file twice; the same part is `RV1` in one and `RV2` in the other.
  // Trusting the property reports one reference twice — two components silently collapsed into one.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      subsheet("first", "amp.kicad_sch", "S1", []),
      subsheet("second", "amp.kicad_sch", "S2", []),
    ]),
    "/d/amp.kicad_sch": sheetFile("amp", [TP], [
      inst("t:TP", "R1", 0, 10, "V", { "/root/S1": "R1", "/root/S2": "R2" }),
      inst("t:TP", "R9", 20, 10, "V", { "/root/S1": "R9", "/root/S2": "R10" }),
      wire(0, 10, 20, 10),
    ]),
  };
  const nets = await solve(files);
  const pins = nets.flatMap((n) => n.pins).sort();
  assert.deepEqual(pins, ["R1.1", "R10.1", "R2.1", "R9.1"], "four distinct pins, not two reported twice");
  assert.equal(nets.length, 2, "and the two placements are separate nets");
});

test("a global label crosses sheets; a local label of the same name does not", async () => {
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      inst("t:TP", "R1", 0, 10),
      wire(0, 10, 20, 10),
      label("SHARED", 20, 10, "global_label"),
      inst("t:TP", "R3", 0, 60),
      wire(0, 60, 20, 60),
      label("PRIVATE", 20, 60),
      subsheet("child", "child.kicad_sch", "S1", []),
    ]),
    "/d/child.kicad_sch": sheetFile("c1", [TP], [
      inst("t:TP", "R2", 0, 30),
      wire(0, 30, 20, 30),
      label("SHARED", 20, 30, "global_label"),
      inst("t:TP", "R4", 0, 80),
      wire(0, 80, 20, 80),
      label("PRIVATE", 20, 80),
    ]),
  };
  const nets = await solve(files);
  assert.deepEqual(
    nets.find((n) => n.pins.includes("R1.1"))!.pins,
    ["R1.1", "R2.1"],
    "the global label joins the two sheets",
  );
  assert.deepEqual(nets.find((n) => n.pins.includes("R3.1"))!.pins, ["R3.1"], "the local label stays home");
  assert.deepEqual(nets.find((n) => n.pins.includes("R4.1"))!.pins, ["R4.1"]);
});

test("a power symbol's net name comes from its pin, not its Value", async () => {
  // `kit-dev-coldfire` has a supply whose Value is `+3,3V` (comma) and whose pin is `+3.3V`. KiCad puts
  // every such pin on `+3.3V`; trusting Value split that supply into two nets differing by one character.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP, power("P", "+3.3V")], [
      inst("t:TP", "R1", 0, 10),
      inst("t:P", "PWR1", 20, 10, "+3,3V"),
      wire(0, 10, 20, 10),
      inst("t:TP", "R2", 0, 40),
      inst("t:P", "PWR2", 20, 40, "+3.3V"),
      wire(0, 40, 20, 40),
    ]),
  };
  const nets = await solve(files);
  assert.equal(nets.length, 1, "both supplies are one net despite the Value spelling");
  assert.deepEqual(nets[0]!.pins, ["R1.1", "R2.1"]);
  assert.equal(nets[0]!.name, "+3.3V");
});

test("a bus sheet pin carries its members into a child that names them plainly", async () => {
  // The child says `AN0`; the boundary says `AN[0..1]`. Matching only whole names splits every member.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      inst("t:TP", "R1", 0, 10),
      wire(0, 10, 20, 10),
      label("AN0", 20, 10),
      subsheet("child", "child.kicad_sch", "S1", [{ name: "AN[0..1]", x: 50, y: 10 }]),
    ]),
    "/d/child.kicad_sch": sheetFile("c1", [TP], [
      inst("t:TP", "R2", 0, 30),
      wire(0, 30, 20, 30),
      label("AN0", 20, 30),
    ]),
  };
  assert.deepEqual(await solve(files), [{ name: "AN0", pins: ["R1.1", "R2.1"] }]);
});

test("two differently-named buses that meet pair their members up by index", async () => {
  // `video` runs one physical bus past sheets calling it `DQ[0..15]`, `PC_D[0..7]` and `DPC[0..31]`.
  // Member i of one is member i of the other; matching by name alone left 66 of 588 nets in pieces.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      bus(0, 100, 100, 100),
      label("DQ[0..1]", 0, 100),
      label("PC_D[0..1]", 100, 100),
      inst("t:TP", "R1", 0, 10),
      wire(0, 10, 20, 10),
      label("DQ0", 20, 10),
      inst("t:TP", "R2", 0, 40),
      wire(0, 40, 20, 40),
      label("PC_D0", 20, 40),
      inst("t:TP", "R3", 0, 70),
      wire(0, 70, 20, 70),
      label("PC_D1", 20, 70),
    ]),
  };
  const nets = await solve(files);
  assert.deepEqual(nets.find((n) => n.pins.includes("R1.1"))!.pins, ["R1.1", "R2.1"], "DQ0 and PC_D0 are one net");
  assert.deepEqual(nets.find((n) => n.pins.includes("R3.1"))!.pins, ["R3.1"], "but DQ0 is not PC_D1");
});

test("bus geometry never leaks into signal connectivity", async () => {
  // A bus is a bundle, not a net. If bus segments joined the signal union-find, every member of the bus
  // would collapse into a single net — the worst possible failure, and an easy one to introduce.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      bus(0, 100, 100, 100),
      label("DQ[0..1]", 0, 100),
      inst("t:TP", "R1", 0, 100), // sits directly on the bus line
      inst("t:TP", "R2", 100, 100),
    ]),
  };
  const nets = await solve(files);
  assert.equal(nets.length, 2, "two pins on a bus line are two nets, not one");
});

test("an unreadable sub-sheet is reported, not silently dropped", async () => {
  // Availability first: one bad sheet must not cost the whole design. But it has to be *reported* — a
  // viewer that quietly drops a sheet renders something wrong that looks complete, which is the same
  // failure mode as a merged net, just at a larger scale.
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [
      inst("t:TP", "R1", 0, 10),
      subsheet("ok", "child.kicad_sch", "S1", []),
      subsheet("gone", "missing.kicad_sch", "S2", []),
    ]),
    "/d/child.kicad_sch": sheetFile("c1", [TP], [inst("t:TP", "R2", 0, 30)]),
  };
  const design = await loadDesign("/d/top.kicad_sch", (f) => {
    const hit = (files as Record<string, string>)[f];
    if (hit === undefined) throw new Error(`no such file ${f}`);
    return hit;
  });
  assert.equal(design.instances.length, 2, "the readable sheets still load");
  assert.equal(design.problems.length, 1, "and the unreadable one is reported");
  assert.match(design.problems[0]!, /missing\.kicad_sch/, "naming the file that failed");
  assert.deepEqual(design.nets.flatMap((n) => n.pins).sort(), ["R1.1", "R2.1"]);
});

test("a healthy design reports no problems", async () => {
  const files = {
    "/d/top.kicad_sch": sheetFile("root", [TP], [inst("t:TP", "R1", 0, 10)]),
  };
  assert.deepEqual((await loadDesign("/d/top.kicad_sch", (f) => (files as Record<string, string>)[f]!)).problems, []);
});

test("a self-referencing sheet tree is bounded, not followed to exhaustion", async () => {
  // Depth and breadth are different limits. A sheet holding two sheet symbols that each point back at
  // itself branches twice per level, so bounding depth alone allows 2^32 placements — measured at 200,000
  // placements and 400,001 reads in 43s before the cap existed. Parsing runs on demand against user
  // repositories, so this is an availability bug, not a curiosity.
  const self = `(kicad_sch (version 20250114) (uuid "r") (lib_symbols)
    ${subsheet("a", "self.kicad_sch", "A", [])}
    ${subsheet("b", "self.kicad_sch", "B", [])})`;
  let reads = 0;
  const design = await loadDesign("/d/self.kicad_sch", () => {
    if (++reads > 50_000) throw new Error("runaway traversal");
    return self;
  });
  assert.ok(design.instances.length <= 2000, `bounded, got ${design.instances.length}`);
  assert.ok(
    design.problems.some((p) => /cap/.test(p)),
    "and the truncation is reported rather than passed off as a complete design",
  );
});

test("a Sheetfile pointing outside the design is refused", async () => {
  // `Sheetfile` is attacker-controlled text inside a repository, joined onto a directory path. Left
  // alone it resolves straight out of the repo — an arbitrary-file read through a schematic.
  const top = `(kicad_sch (version 20250114) (uuid "r") (lib_symbols)
    ${subsheet("escape", "../../../../etc/passwd", "A", [])})`;
  const asked: string[] = [];
  const design = await loadDesign("/repo/proj/top.kicad_sch", (f) => {
    asked.push(f);
    if (f.endsWith("top.kicad_sch")) return top;
    throw new Error("should never be read");
  });
  assert.deepEqual(asked, ["/repo/proj/top.kicad_sch"], "nothing outside the design is even requested");
  assert.equal(design.instances.length, 1);
  assert.ok(design.problems.some((p) => /outside the design/.test(p)), "and it is reported");
});

test("a sub-sheet in a subdirectory of the design is still allowed", async () => {
  // The confinement must not be so blunt that it breaks legitimate layouts.
  const files: Record<string, string> = {
    "/d/top.kicad_sch": `(kicad_sch (version 20250114) (uuid "r") (lib_symbols)
      ${subsheet("child", "sub/child.kicad_sch", "A", [])})`,
    "/d/sub/child.kicad_sch": sheetFile("c1", [TP], [inst("t:TP", "R1", 0, 10)]),
  };
  const design = await loadDesign("/d/top.kicad_sch", (f) => {
    const hit = files[f];
    if (hit === undefined) throw new Error(`no such file ${f}`);
    return hit;
  });
  assert.deepEqual(design.problems, []);
  assert.equal(design.instances.length, 2);
});
