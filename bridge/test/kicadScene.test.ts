import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDesign } from "../src/kicad/design.js";
import { buildScene } from "../src/kicad/scene.js";
import { getScene, clearSceneCache, sceneCacheSize } from "../src/kicad/service.js";
import { parseSexpr } from "../src/kicad/sexpr.js";

/**
 * The tagged scene and how it is served (ADR-038, Phase 1).
 *
 * Several of these pin down defects that only showed up when the thing was *run* — rendered to a picture,
 * or curled against a live bridge. None of them would have been caught by counting primitives, which is
 * why they are worth keeping as tests rather than notes.
 */

const px = (n: number) => n.toFixed(2);
// Sentinel for "working tree". Written as an escape, not a literal NUL: a raw NUL makes git treat the
// whole file as binary, so it shows as `Bin 0 -> 9928 bytes` in a PR and cannot be reviewed at all.
const WORKTREE = "\u0000worktree";

const RES = `(symbol "t:R"
  (symbol "t:R_1_1"
    (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254)) (fill (type none)))
    (pin passive line (at 0 3.81 270) (length 1.27)
      (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 0 -3.81 90) (length 1.27)
      (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;

function sheetFile(body: string[], uuid = "root"): string {
  return `(kicad_sch (version 20250114) (generator "test") (uuid "${uuid}")
    (lib_symbols ${RES})
    ${body.join("\n")})`;
}

function resistor(ref: string, x: number, y: number, valueHidden = false) {
  return `(symbol (lib_id "t:R") (at ${px(x)} ${px(y)} 0) (unit 1)
    (property "Reference" "${ref}" (at ${px(x + 2)} ${px(y - 1)} 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at ${px(x + 2)} ${px(y + 1)} 0) (effects (font (size 1.27 1.27)) (justify left)${valueHidden ? " hide" : ""}))
    (property "Footprint" "" (at ${px(x)} ${px(y)} 0) (effects (font (size 1.27 1.27)) hide)))`;
}

async function scene(text: string) {
  const design = await loadDesign("/d/top.kicad_sch", () => text);
  return buildScene(design, design.instances[0]!.path, text);
}

test("symbol body graphics are placed by the same transform as the pins", async () => {
  // If graphics and pins used different transforms the sheet would still render — just wrong. Checked on
  // the real corpus too: 0 of 1585 components have a pin outside their own body.
  const s = await scene(sheetFile([resistor("R1", 100, 50), `(wire (pts (xy 100 46.19) (xy 120 46.19)))`]));
  const rect = s.primitives.find((p) => p.t === "rect" && p.ref === "R1");
  const pins = s.primitives.filter((p) => p.t === "pin" && p.ref === "R1") as Extract<typeof s.primitives[number], { t: "pin" }>[];
  assert.ok(rect && rect.t === "rect");
  assert.equal(pins.length, 2);
  const [x0, x1] = [Math.min(rect.a[0], rect.b[0]), Math.max(rect.a[0], rect.b[0])];
  for (const p of pins) assert.ok(p.at[0] >= x0 - 5 && p.at[0] <= x1 + 5, `pin ${p.pin} at ${p.at} vs body ${x0}..${x1}`);
});

test("instance properties are emitted, and hidden ones are not", async () => {
  // Found by rendering the scene and looking at it: the sheet drew perfectly and had no refdes or values
  // on it at all, because only the symbol's *body* text was being emitted.
  const s = await scene(sheetFile([resistor("R1", 100, 50)]));
  const texts = s.primitives.filter((p) => p.t === "text") as Extract<typeof s.primitives[number], { t: "text" }>[];
  assert.ok(texts.some((t) => t.s === "R1" && t.kind === "property:Reference"), "refdes drawn");
  assert.ok(texts.some((t) => t.s === "10k" && t.kind === "property:Value"), "value drawn");
  assert.ok(!texts.some((t) => t.kind === "property:Footprint"), "hidden properties are not drawn");

  const hidden = await scene(sheetFile([resistor("R2", 100, 50, true)]));
  const hTexts = hidden.primitives.filter((p) => p.t === "text") as Extract<typeof hidden.primitives[number], { t: "text" }>[];
  assert.ok(!hTexts.some((t) => t.s === "10k"), "a hidden Value stays hidden");
});

test("text carries its anchor, because the app cannot guess it", async () => {
  // Without justify, a PWR_FLAG beside a VDD symbol renders as one overlapping smear.
  const s = await scene(sheetFile([resistor("R1", 100, 50)]));
  const ref = s.primitives.find((p) => p.t === "text" && p.kind === "property:Reference");
  assert.ok(ref && ref.t === "text");
  assert.equal(ref.hjust, "left");
});

test("escaped newlines in text become real newlines", async () => {
  // The reader passed `\\n` through literally, so multi-line SPICE directives and text boxes rendered as
  // one run-together line. 497 occurrences across the two corpora.
  const parsed = parseSexpr('(kicad_sch (text "a\\nb"))');
  const node = (parsed as unknown[]).find((n) => Array.isArray(n) && n[0] === "text") as unknown[];
  assert.equal(node[1], "a\nb", "\\n is unescaped, not passed through");
  assert.equal(parseSexpr('(x (t "a\\\\b"))').toString().includes("a\\b"), true, "\\\\ still means one backslash");
});

test("wires are tagged with their net, and buses are not", async () => {
  // A bus is a bundle, not a net. Tagging one would claim a net that does not exist.
  const s = await scene(
    sheetFile([
      resistor("R1", 100, 50),
      resistor("R2", 120, 50),
      `(wire (pts (xy 100 46.19) (xy 120 46.19)))`,
      // The bus deliberately *starts on the wire's node*, which is the case that actually matters: the
      // point has a real net, so tagging buses would stamp `SIG` onto a bundle. A bus drawn off in empty
      // space cannot fail this assertion — the point has no net either way — and the test would be
      // decorative. Verified by tagging buses on purpose and watching this fail.
      `(bus (pts (xy 100 46.19) (xy 140 46.19)))`,
      `(label "SIG" (at 110 46.19 0) (effects (font (size 1.27 1.27))))`,
    ]),
  );
  const wire = s.primitives.find((p) => p.t === "wire");
  const bus = s.primitives.find((p) => p.t === "bus");
  assert.equal(wire && wire.t === "wire" ? wire.net : undefined, "SIG");
  assert.ok(bus && bus.t === "bus" && !("net" in bus && bus.net), "the bus carries no net");
});

test("the scene reports the design's sheet list and problems", async () => {
  const s = await scene(sheetFile([resistor("R1", 100, 50)]));
  assert.deepEqual(s.sheets.map((x) => x.name), ["/"]);
  assert.deepEqual(s.problems, []);
  assert.ok(s.bbox[2] > s.bbox[0] && s.bbox[3] > s.bbox[1], "bbox is non-degenerate");
});

test("an immutable ref is cached; the working tree never is", async () => {
  clearSceneCache();
  const text = sheetFile([resistor("R1", 100, 50)]);
  let reads = 0;
  const read = async (_f: string) => {
    reads++;
    return text;
  };

  await getScene({ resolved: "oid1", worktreeSentinel: WORKTREE, rootPath: "/d/top.kicad_sch", read });
  const afterFirst = reads;
  await getScene({ resolved: "oid1", worktreeSentinel: WORKTREE, rootPath: "/d/top.kicad_sch", read });
  assert.equal(reads, afterFirst, "a second request at the same oid reads nothing");
  assert.equal(sceneCacheSize(), 1);

  await getScene({ resolved: WORKTREE, worktreeSentinel: WORKTREE, rootPath: "/d/top.kicad_sch", read });
  const afterWorktree = reads;
  await getScene({ resolved: WORKTREE, worktreeSentinel: WORKTREE, rootPath: "/d/top.kicad_sch", read });
  assert.ok(reads > afterWorktree, "the working tree is re-read every time");
});

test("only the requested sheet is built, not every sheet in the design", async () => {
  // Building all of them inline made one request against a malformed schematic take 70 seconds. The solve
  // is bounded; rendering is what scales with placement count.
  const child = sheetFile([resistor("RC", 10, 10)], "c1");
  const top = `(kicad_sch (version 20250114) (generator "test") (uuid "root")
    (lib_symbols ${RES})
    ${resistor("R1", 100, 50)}
    ${Array.from({ length: 6 }, (_, i) => `(sheet (at 10 10) (uuid "S${i}")
      (property "Sheetname" "c${i}" (at 0 0 0)) (property "Sheetfile" "child.kicad_sch" (at 0 0 0)))`).join("\n")})`;
  clearSceneCache();
  const seen: string[] = [];
  const read = async (f: string) => {
    seen.push(f);
    return f.endsWith("child.kicad_sch") ? child : top;
  };
  const s = await getScene({ resolved: "oid2", worktreeSentinel: WORKTREE, rootPath: "/d/top.kicad_sch", read });
  assert.equal(s.sheets.length, 7, "the switcher still lists every sheet");
  // The child file is read once for the solve (memoised) and not again for six scenes nobody asked for.
  assert.equal(seen.filter((f) => f.endsWith("child.kicad_sch")).length, 1, `reads: ${seen.length}`);
});

test("a file read repeatedly during one solve is fetched once", async () => {
  // 2000 placements of one file meant 2000 `git show` spawns — 30 seconds of a single request.
  const self = `(kicad_sch (version 20250114) (generator "test") (uuid "r") (lib_symbols)
    (sheet (at 0 0) (uuid "A") (property "Sheetname" "a" (at 0 0 0)) (property "Sheetfile" "self.kicad_sch" (at 0 0 0)))
    (sheet (at 0 0) (uuid "B") (property "Sheetname" "b" (at 0 0 0)) (property "Sheetfile" "self.kicad_sch" (at 0 0 0))))`;
  let reads = 0;
  const design = await loadDesign("/d/self.kicad_sch", () => {
    reads++;
    return self;
  });
  assert.ok(design.instances.length > 1, "it did traverse");
  assert.equal(reads, 1, `one distinct file, one read (got ${reads})`);
});

test("symbol graphics go through placePoint, not raw library coordinates", async () => {
  // Graphics and pins must share one transform. Using raw library coordinates leaves the body at the
  // origin while the pins sit at the instance — the sheet renders, and every symbol is in the wrong place.
  const s = await scene(sheetFile([resistor("R1", 100, 50)]));
  const rect = s.primitives.find((p) => p.t === "rect" && p.ref === "R1");
  assert.ok(rect && rect.t === "rect");
  assert.ok(
    Math.abs(rect.a[0] - 100) < 3 && Math.abs(rect.a[1] - 50) < 4,
    `body should sit at the instance (100,50), got ${rect.a}`,
  );
});

test("a pin is drawn as a lead line from its connection point to the body", async () => {
  // A KiCad pin is not a point: `at` is the connection end and the body sits `length` away, with a line
  // between. Emitting only the connection dot left every wire visibly short of the part it landed on —
  // the schematic read as though nothing was wired up. 3536 of 3684 pins in the demos have a length.
  //
  // Connectivity was never affected (the solver only wants the connection point), which is exactly why
  // nothing caught it: the netlist oracle stayed at 1722/1722 throughout. Only the picture showed it.
  const sym = `(symbol "t:R"
    (symbol "t:R_1_1"
      (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254)) (fill (type none)))
      (pin passive line (at 0 3.81 270) (length 2.794)
        (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;
  const s = await scene(`(kicad_sch (version 20250114) (generator "test") (uuid "root")
    (lib_symbols ${sym})
    (symbol (lib_id "t:R") (at 100 50 0) (unit 1)
      (property "Reference" "R1" (at 0 0 0)) (property "Value" "1k" (at 0 0 0))))`);

  const leads = s.primitives.filter((p) => p.t === "poly" && p.ref === "R1" && p.pts?.length === 2);
  assert.equal(leads.length, 1, "one pin, one lead");
  const [tip, root] = (leads[0] as Extract<typeof s.primitives[number], { t: "poly" }>).pts;
  // Placement is (100, 50); the library Y axis flips. Tip is the connection point, root meets the body.
  assert.ok(Math.abs(tip![0] - 100) < 0.01 && Math.abs(tip![1] - (50 - 3.81)) < 0.01, `tip ${tip}`);
  assert.ok(Math.abs(root![0] - 100) < 0.01, `lead stays vertical, got ${root}`);
  // 3.81 - 2.794 = 1.016 from the origin, i.e. it reaches into the body rather than stopping short.
  assert.ok(Math.abs(root![1] - (50 - 1.016)) < 0.01, `root should meet the body, got ${root}`);
});

test("a pin lead carries the net its connection point sits on", async () => {
  // The lead is electrically a continuation of the wire, so it has to highlight with it — that is the
  // whole reason `poly` gained an optional `net`.
  //
  // This replaces an assertion that could not fail: `"net" in lead` tests for the *key*, and the emitter
  // always writes one (the value may be undefined). Mutating the emitter to `net: undefined` left the old
  // test green, so the headline behaviour of the change was unguarded.
  const sym = `(symbol "t:R"
    (symbol "t:R_1_1"
      (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254)) (fill (type none)))
      (pin passive line (at 0 3.81 270) (length 2.794)
        (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;
  // The pin's connection point lands at (100, 46.19); a wire runs to it and carries a label.
  const s = await scene(`(kicad_sch (version 20250114) (generator "test") (uuid "root")
    (lib_symbols ${sym})
    (symbol (lib_id "t:R") (at 100 50 0) (unit 1)
      (property "Reference" "R1" (at 0 0 0)) (property "Value" "1k" (at 0 0 0)))
    (wire (pts (xy 100 46.19) (xy 120 46.19)))
    (label "SIG" (at 120 46.19 0)))`);

  const lead = s.primitives.find((p) => p.t === "poly" && p.ref === "R1" && p.pts?.length === 2);
  assert.ok(lead, "the lead is emitted");
  assert.equal((lead as { net?: string }).net, "SIG", "lead takes the net at its connection point");
});

test("a hidden pin draws no lead", async () => {
  // A hidden power pin is drawn nowhere by definition; a lead for it would be a line to nothing.
  const sym = `(symbol "t:U"
    (symbol "t:U_1_1"
      (pin power_in line (at 0 3.81 270) (length 2.794) hide
        (name "VCC" (effects (font (size 1.27 1.27)))) (number "7" (effects (font (size 1.27 1.27)))))))`;
  const s = await scene(`(kicad_sch (version 20250114) (generator "test") (uuid "root")
    (lib_symbols ${sym})
    (symbol (lib_id "t:U") (at 100 50 0) (unit 1)
      (property "Reference" "U1" (at 0 0 0)) (property "Value" "x" (at 0 0 0))))`);
  assert.equal(s.primitives.filter((p) => p.t === "poly" && p.ref === "U1").length, 0);
});

test("a sub-sheet box is not offered as a component", async () => {
  // Sheet symbols are emitted with `ref` set to their sheet name so they highlight as a unit, but they
  // are not parts: `scene.components` has no entry, so a picker keyed on `ref` alone would show a card
  // with an empty value, empty lib_id and 0 pins. Measured on `video`'s root: 7 such rects.
  const child = `(kicad_sch (version 20250114) (generator "test") (uuid "c1") (lib_symbols))`;
  const top = `(kicad_sch (version 20250114) (generator "test") (uuid "root") (lib_symbols)
    (sheet (at 10 10) (size 40 30) (uuid "S1")
      (property "Sheetname" "child" (at 0 0 0))
      (property "Sheetfile" "child.kicad_sch" (at 0 0 0))))`;
  const design = await loadDesign("/d/top.kicad_sch", (f) => (f.endsWith("child.kicad_sch") ? child : top));
  const s = buildScene(design, design.instances[0]!.path, top);
  const boxes = s.primitives.filter((p) => p.t === "rect" && p.ref === "child");
  assert.equal(boxes.length, 1, "the sheet box is drawn");
  assert.ok(!s.components.some((c) => c.ref === "child"), "but it is not a component");
});
