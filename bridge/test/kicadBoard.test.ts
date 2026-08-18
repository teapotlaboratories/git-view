import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBoard, readBoard, readBoardLayer, isStructuralLayer, capFor,
  MAX_LAYER_PRIMITIVES, MAX_STRUCTURAL_PRIMITIVES,
  counterpartPath, classifyModel,
} from "../src/kicad/board.js";

/**
 * Reading a `.kicad_pcb` (ADR-038, Phase 3).
 *
 * The board reader's rules are different from the schematic's in ways that are easy to get subtly wrong
 * and hard to see: an element can belong to *several* layers, nets arrive as integers that must be
 * resolved through the board's own table, and footprint children live in the footprint's frame rather
 * than the board's. Each of those is asserted here rather than trusted.
 *
 * Fixtures are hand-authored — the KiCad demos are separately licensed, and a test that needs an 81 MB
 * board is not a test anyone will run.
 */

const px = (n: number) => n.toFixed(3);

function board(body: string, layers = `(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user) (44 "Edge.Cuts" user) (55 "User.9" user "overlay"))`): string {
  return `(kicad_pcb (version 20241229) (generator "test")
    ${layers}
    (net 0 "")
    (net 1 "GND")
    (net 2 "VCC")
    ${body})`;
}

const track = (x1: number, y1: number, x2: number, y2: number, layer = "F.Cu", net = 1) =>
  `(segment (start ${px(x1)} ${px(y1)}) (end ${px(x2)} ${px(y2)}) (width 0.2) (layer "${layer}") (net ${net}))`;

test("the index reports layers with their populations, and no geometry", () => {
  const b = readBoard(parseBoard(board(`
    ${track(0, 0, 10, 0)}
    ${track(0, 1, 10, 1)}
    ${track(0, 2, 10, 2, "B.Cu")}
  `)));
  const byName = Object.fromEntries(b.layers.map((l) => [l.name, l.count]));
  assert.equal(byName["F.Cu"], 2);
  assert.equal(byName["B.Cu"], 1);
  assert.equal(byName["User.9"], 0, "a declared but empty layer is still listed, with zero");
  assert.deepEqual(b.nets, ["GND", "VCC"], "the empty net 0 is not a net anyone can select");
});

test("a track's net is resolved through the board's net table", () => {
  // A schematic wire carries its net *name*; a board track carries an integer and the name lives in a
  // table at the top of the file. Getting this wrong yields tracks that highlight under no net at all.
  const s = readBoardLayer(parseBoard(board(`${track(0, 0, 10, 0, "F.Cu", 2)}`)), "F.Cu");
  assert.equal(s.primitives.length, 1);
  assert.equal((s.primitives[0] as { net?: string }).net, "VCC");
});

test("a via belongs to every layer it spans, not one", () => {
  // `(layers "F.Cu" "B.Cu")` — asking for either must return it, or a via vanishes from the side you
  // are looking at while its tracks remain, which reads as a broken connection.
  const b = parseBoard(board(`(via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))`));
  for (const layer of ["F.Cu", "B.Cu"]) {
    const s = readBoardLayer(b, layer);
    assert.equal(s.primitives.length, 1, `via missing from ${layer}`);
    assert.equal(s.primitives[0]!.t, "via");
  }
  assert.equal(readBoardLayer(b, "B.SilkS").primitives.length, 0, "but not on a layer it does not span");
});

test("a pad belongs to all three of its layers and keeps its shape", () => {
  const b = parseBoard(board(`
    (footprint "R_0402" (layer "F.Cu") (at 100 50)
      (property "Reference" "R1" (at 0 0 0))
      (property "Value" "10k" (at 0 0 0))
      (pad "1" smd roundrect (at -0.5 0 90) (size 1.2 1.3) (layers "F.Cu" "F.Mask" "F.Paste") (net 1 "GND")))`));
  const s = readBoardLayer(b, "F.Cu");
  const pad = s.primitives.find((p) => p.t === "pad") as
    | { t: "pad"; size: [number, number]; shape: string; layers: string[]; net?: string }
    | undefined;
  assert.ok(pad, "pad present on F.Cu");
  assert.deepEqual(pad!.size, [1.2, 1.3], "size is XY, not a single dimension");
  assert.equal(pad!.shape, "roundrect");
  assert.equal(pad!.layers.length, 3);
  assert.equal(pad!.net, "GND", "a pad names its net inline rather than by id");
});

test("footprint children are placed in the board frame, not the footprint's", () => {
  // fp_line coordinates are relative to the footprint origin and rotate with it. Emitting them raw puts
  // every silkscreen outline at the board origin — the drawing renders, and every part is in the wrong
  // place, which is the same failure mode as the schematic's pin transform.
  const b = parseBoard(board(`
    (footprint "X" (layer "F.Cu") (at 100 50 90)
      (property "Reference" "U1" (at 0 0 0))
      (fp_line (start 1 0) (end 2 0) (width 0.1) (layer "B.SilkS")))`));
  const s = readBoardLayer(b, "B.SilkS");
  const line = s.primitives.find((p) => p.t === "line") as { a: [number, number]; b: [number, number] } | undefined;
  assert.ok(line, "line present");
  // 90° rotation maps local +X onto board +Y, then translates to the footprint origin.
  assert.ok(Math.abs(line!.a[0] - 100) < 0.01 && Math.abs(line!.a[1] - 51) < 0.01, `start ${line!.a}`);
  assert.ok(Math.abs(line!.b[0] - 100) < 0.01 && Math.abs(line!.b[1] - 52) < 0.01, `end ${line!.b}`);
});

test("zones ship KiCad's precomputed fill, and can be left out", () => {
  // Re-deriving a fill means clearances, thermals and island removal — a solver the size of Phase 0 that
  // would be wrong invisibly. But fills are also the bulk of a board (523k vertices on the big demo), so
  // a caller that only wants routing must be able to skip them.
  const b = parseBoard(board(`
    ${track(0, 0, 10, 0)}
    (zone (net 1) (layer "F.Cu")
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))))`));
  const withZones = readBoardLayer(b, "F.Cu");
  const without = readBoardLayer(b, "F.Cu", { includeZones: false });
  const zone = withZones.primitives.find((p) => p.t === "zone") as { pts: number[][]; net?: string } | undefined;
  assert.ok(zone, "fill present by default");
  assert.equal(zone!.pts.length, 4, "vertices come straight from the file");
  assert.equal(zone!.net, "GND");
  assert.ok(!without.primitives.some((p) => p.t === "zone"), "and are omitted on request");
  assert.equal(without.primitives.length, 1, "the track survives either way");
});

test("a copper layer larger than the annotation cap is NOT truncated", () => {
  // The regression this exists to stop. The cap was a flat 20,000, chosen from one board whose F.Cu sat
  // at 12,581. `vme-wren`'s F.Cu is 20,887 — so real routing was being silently shortened by 4% on the
  // one layer the feature exists to show. Copper is the drawing, not annotation on top of it.
  const n = MAX_LAYER_PRIMITIVES + 900; // ≈ vme-wren's overshoot
  const many = Array.from({ length: n }, (_, i) => track(i, 0, i + 1, 0, "F.Cu")).join("\n");
  const s = readBoardLayer(parseBoard(board(many)), "F.Cu");
  assert.equal(s.primitives.length, n, "every copper primitive survives");
  assert.equal(s.truncated, false);
  assert.deepEqual(s.problems, []);
});

test("structural layers are decided by name, not only KiCad's declared kind", () => {
  // KiCad marks copper `signal`, but files Edge.Cuts and B.SilkS as `user` — the same kind it gives a
  // scratch overlay. Trusting `kind` alone would cap a board outline like annotation.
  assert.equal(isStructuralLayer("F.Cu", "signal"), true);
  assert.equal(isStructuralLayer("In1.Cu", ""), true, "inner copper, whatever the kind says");
  assert.equal(isStructuralLayer("Edge.Cuts", "user"), true, "declared user, but it is the board outline");
  assert.equal(isStructuralLayer("B.SilkS", "user"), true);
  assert.equal(isStructuralLayer("User.9", "user"), false);
  assert.equal(isStructuralLayer("F.Fab", "user"), false);
  assert.equal(isStructuralLayer("F.Courtyard", "user"), false);
  assert.equal(capFor("F.Cu", "signal"), MAX_STRUCTURAL_PRIMITIVES);
  assert.equal(capFor("User.9", "user"), MAX_LAYER_PRIMITIVES);
});

test("a structural layer past even its own ceiling says the drawing is incomplete", () => {
  // The backstop still exists — it just sits 5× above the worst real layer, and when it does fire it must
  // not claim the loss was only annotation.
  const many = Array.from({ length: MAX_STRUCTURAL_PRIMITIVES + 50 }, (_, i) =>
    track(i, 0, i + 1, 0, "F.Cu")).join("\n");
  const s = readBoardLayer(parseBoard(board(many)), "F.Cu");
  assert.equal(s.primitives.length, MAX_STRUCTURAL_PRIMITIVES);
  assert.ok(s.truncated);
  assert.ok(s.problems.some((p) => p.includes("structural")), `problems: ${s.problems}`);
});

test("a pathological layer is truncated and says so", () => {
  // `User.9` on the largest demo carries 286,742 elements — a user overlay somebody filled with
  // annotation. Serving that to a phone is the failure this cap exists to prevent, and a partial layer
  // that looked complete would be the viewer-that-lies problem again.
  const many = Array.from({ length: MAX_LAYER_PRIMITIVES + 500 }, (_, i) => track(i, 0, i + 1, 0, "User.9")).join("\n");
  const s = readBoardLayer(parseBoard(board(many)), "User.9");
  assert.equal(s.primitives.length, MAX_LAYER_PRIMITIVES);
  assert.ok(s.truncated);
  assert.ok(s.problems.some((p) => p.includes("truncated")), `problems: ${s.problems}`);
});

test("a healthy layer is not marked truncated", () => {
  const s = readBoardLayer(parseBoard(board(track(0, 0, 1, 0))), "F.Cu");
  assert.equal(s.truncated, false);
  assert.deepEqual(s.problems, []);
});

test("extent comes from the board outline when there is one", () => {
  const b = readBoard(parseBoard(board(`
    ${track(1000, 1000, 1001, 1000)}
    (gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (width 0.1))
    (gr_line (start 50 0) (end 50 30) (layer "Edge.Cuts") (width 0.1))`)));
  // The stray track at (1000,1000) must not stretch the board: Edge.Cuts is what a person means by
  // "the board", and framing on copper would zoom out to nothing.
  assert.deepEqual(b.bbox, [0, 0, 50, 30]);
  assert.deepEqual(b.problems, []);
});

test("with no outline the extent falls back to copper, and says so", () => {
  const b = readBoard(parseBoard(board(track(0, 0, 20, 10))));
  assert.deepEqual(b.bbox, [0, 0, 20, 10]);
  assert.ok(b.problems.some((p) => p.includes("Edge.Cuts")), `problems: ${b.problems}`);
});

test("components carry refdes, value and side", () => {
  const b = readBoard(parseBoard(board(`
    (footprint "R_0402" (layer "B.Cu") (at 10 20 180)
      (property "Reference" "R7" (at 0 0 0))
      (property "Value" "4k7" (at 0 0 0)))`)));
  assert.equal(b.components.length, 1);
  assert.equal(b.components[0]!.ref, "R7");
  assert.equal(b.components[0]!.value, "4k7");
  assert.equal(b.components[0]!.layer, "B.Cu", "side matters — it decides which view shows the part");
  assert.equal(b.components[0]!.rot, 180);
});

test("a KiCad project's two halves pair by name, and nothing else pairs", () => {
  // The rule cross-probe rests on (ADR-038, Phase 3b). Existence is a separate question the route answers
  // with `blobExists` — this is only "what would it be called".
  assert.equal(counterpartPath("hw/video.kicad_sch"), "hw/video.kicad_pcb");
  assert.equal(counterpartPath("hw/video.kicad_pcb"), "hw/video.kicad_sch");
  assert.equal(counterpartPath("video.kicad_sch"), "video.kicad_pcb", "no directory is fine");

  // Everything else pairs with nothing. A project file is the tempting near-miss: it sits beside both
  // halves and shares their basename, and offering to "show it on the board" would be nonsense.
  for (const p of ["hw/video.kicad_pro", "hw/video.kicad_sym", "hw/video.kicad_prl", "README.md", "video", ""]) {
    assert.equal(counterpartPath(p), undefined, `${p} must not pair`);
  }

  // Only the suffix decides — a directory that merely contains the words is not a schematic.
  assert.equal(counterpartPath("kicad_sch/notes.txt"), undefined);
});

test("a text primitive carries fontSize, never a `size` that clashes with a pad's", () => {
  // One key, one type. `text` used to emit `size: number` while `pad` emits `size: [w, h]`. A strict client
  // cannot model both, so a single text primitive threw and took the whole layer with it — measured on
  // `vme-wren`, whose F.Cu has 3 text primitives and 20,887 pieces of copper that silently never drew.
  const b = parseBoard(board(`
    (gr_text "HELLO" (at 10 10 0) (layer "F.Cu") (effects (font (size 1.5 1.5))))
    (footprint "R" (layer "F.Cu") (at 50 50)
      (property "Reference" "R1" (at 0 0 0))
      (pad "1" smd rect (at 0 0) (size 1.2 1.3) (layers "F.Cu") (net 1 "GND")))`));
  const s = readBoardLayer(b, "F.Cu");

  const text = s.primitives.find((p) => p.t === "text") as { fontSize?: number; size?: unknown } | undefined;
  assert.ok(text, "text present");
  assert.equal(typeof text!.fontSize, "number", "text sizes itself with fontSize");
  assert.ok(!("size" in text!), "and must not use `size`, which pads own as a pair");

  const pad = s.primitives.find((p) => p.t === "pad") as { size: number[] } | undefined;
  assert.ok(Array.isArray(pad!.size), "a pad's size stays a pair");

  // The property that actually matters: no primitive may use `size` as anything but a pair.
  for (const p of s.primitives) {
    const v = (p as { size?: unknown }).size;
    if (v !== undefined) assert.ok(Array.isArray(v), `${p.t} uses a non-array size`);
  }
});

test("a component carries its own model references, not the library's", () => {
  // Coverage counts unique models across the board, which answers "can this board be shown" but not
  // "what does R12 look like" — and a tap on a component has nothing to open without that. Per
  // placement rather than per `libId`, because two instances of the same library part can override
  // their models separately; keying on the library would show one part's geometry for the other.
  const board = readBoard(parseBoard(`
    (kicad_pcb (version 20240108)
      (footprint "R_0402"
        (property "Reference" "R1")
        (model "\${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402.wrl")
      )
      (footprint "R_0402"
        (property "Reference" "R2")
        (model "\${KIPRJMOD}/custom/R2-special.step")
      )
      (footprint "TestPoint"
        (property "Reference" "TP1")
      )
    )`));
  const by = Object.fromEntries(board.components.map((c) => [c.ref, c.models]));
  assert.deepEqual(by["R1"], ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402.wrl"]);
  assert.deepEqual(by["R2"], ["${KIPRJMOD}/custom/R2-special.step"],
    "same libId as R1, different model — the override must survive");
  assert.equal(by["TP1"], undefined, "a component with no model carries no empty array");
  assert.equal(board.models.unique, 2, "and coverage still counts unique models, not placements");
});

test("embedded models are counted from payloads, never from declarations", () => {
  // A footprint *declares* the embedded file it uses; the bytes appear once, at board level. On
  // `vme-wren` that is 155 declarations against 33 payloads, so counting declarations would claim five
  // times the models the file actually carries — and each of those claims becomes a part we promise to
  // draw and then cannot.
  const board = readBoard(parseBoard(`
    (kicad_pcb (version 20240108)
      (embedded_files
        (file (name "carried.step") (type model) (data |KLUv/aDi1wYA|))
        (file (name "declared-only.step") (type model) (checksum "ABC"))
        (file (name "part-datasheet.pdf") (type datasheet) (data |KLUv/aDi1wYA|))
      )
      (footprint "F:1"
        (embedded_files (file (name "carried.step") (type model) (checksum "ABC")))
        (model "kicad-embed://carried.step")
        (model "kicad-embed://declared-only.step")
      )
    )`));
  assert.deepEqual(board.models.embedded, ["carried.step"],
    "only the one with bytes behind it, and not the datasheet — `vme-wren` carries 12 PDFs this way");
  assert.equal(board.models.byOrigin.embedded, 2, "both references are still embedded-addressed");
  assert.equal(board.models.byOrigin.project, 0, "and neither is mistaken for a relative path");
});

test("a model path is classified by how it is addressed, not by whether it exists", () => {
  // 13 different variables across the corpus. The bridge cannot know what most point at, so the operator
  // maps the ones they have and everything else is reported as unmapped rather than quietly skipped.
  const known = new Set(["KICAD9_3DMODEL_DIR"]);

  assert.equal(classifyModel("${KICAD9_3DMODEL_DIR}/R_0402.wrl", known).origin, "configured");
  assert.equal(classifyModel("${ANT3DMDL}/BM4B.step", known).origin, "unmapped",
    "somebody's private library, shipped nowhere — say so rather than skip it");
  assert.equal(classifyModel("${KIPRJMOD}/3d/part.step", known).origin, "project",
    "the project dir resolves from the repo alone, no configuration needed");
  assert.equal(classifyModel("3d_shapes/ecc83.wrl", known).origin, "project", "a relative path likewise");
  assert.equal(classifyModel("/home/someone/models/x.step", known).origin, "absolute",
    "an absolute path from another machine");

  // The variable is reported even when unmapped — that is what tells an operator what to map.
  assert.equal(classifyModel("${ANT3DMDL}/x.step", known).variable, "ANT3DMDL");
  // Windows separators appear in real boards.
  assert.equal(classifyModel("${KICAD9_3DMODEL_DIR}\\Resistor\\R.wrl", known).origin, "configured");
  // An unmapped variable must not fall through to configured — with one deliberate exception, since
  // measured: the official library's six names all denote the *same* library, so mapping any one of
  // them answers for the rest. The guard still holds for everything outside that family, which is what
  // the ${ANT3DMDL} assertion above pins.
  assert.equal(classifyModel("${KICAD6_3DMODEL_DIR}/x.wrl", known).origin, "configured",
    "an older name for the library the operator already mapped");
  assert.equal(classifyModel("${KISYS3DMOD}/x.wrl", known).origin, "configured",
    "and the pre-v6 name too");
  assert.equal(classifyModel("${KICAD6_3DMODEL_DIR}/x.wrl", new Set(["ANT3DMDL"])).origin, "unmapped",
    "but a private library is not a substitute for the official one");
});

test("coverage counts unique models, not references", () => {
  // Reuse is ~22x on a real board (vme-wren: 1,480 refs, 66 unique). Counting references would overstate
  // the work by more than an order of magnitude — it is the unique models that get fetched and converted.
  const b = readBoard(parseBoard(board(`
    (footprint "R" (layer "F.Cu") (at 0 0) (property "Reference" "R1" (at 0 0 0))
      (model "\${KICAD9_3DMODEL_DIR}/R_0402.wrl" (offset (xyz 0 0 0))))
    (footprint "R" (layer "F.Cu") (at 5 0) (property "Reference" "R2" (at 0 0 0))
      (model "\${KICAD9_3DMODEL_DIR}/R_0402.wrl" (offset (xyz 0 0 0))))
    (footprint "U" (layer "F.Cu") (at 9 0) (property "Reference" "U1" (at 0 0 0))
      (model "\${ANT3DMDL}/BGA.step" (offset (xyz 0 0 0))))
    (footprint "J" (layer "F.Cu") (at 20 0) (property "Reference" "J1" (at 0 0 0)))
  `)), new Set(["KICAD9_3DMODEL_DIR"]));

  assert.equal(b.models.refs, 3, "three references");
  assert.equal(b.models.unique, 2, "but two distinct models");
  assert.equal(b.models.footprintsWithModel, 3, "J1 has none");
  assert.equal(b.models.byOrigin.configured, 1);
  assert.equal(b.models.byOrigin.unmapped, 1);
  assert.equal(b.models.byVariable["ANT3DMDL"], 1, "names the variable an operator would need to map");
});

test("a board with no models reports zero rather than omitting coverage", () => {
  // "No models" and "we did not look" must not be the same answer.
  const b = readBoard(parseBoard(board(track(0, 0, 1, 0))));
  assert.equal(b.models.unique, 0);
  assert.equal(b.models.refs, 0);
  assert.deepEqual(b.models.byVariable, {});
});

test("a model's offset and rotation are carried, and the identity is not", () => {
  // An assembled board places each mesh by its footprint AND by the model's own transform. Measured over
  // the corpus, 962 of 3,611 model blocks carry a non-zero offset and 360 a non-zero rotate, so dropping
  // them misplaces roughly a quarter of the parts — which reads as a broken renderer, not missing data.
  // The identity is omitted because it is the overwhelming majority, on the largest response we send.
  const b = readBoard(parseBoard(board(`
    (footprint "L:placed" (layer "F.Cu") (at 10 20)
      (property "Reference" "J1") (property "Value" "conn")
      (model "\${KICAD9_3DMODEL_DIR}/a.step"
        (offset (xyz 0 1.325 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 -90))))
    (footprint "L:plain" (layer "F.Cu") (at 30 40)
      (property "Reference" "R1") (property "Value" "10k")
      (model "\${KICAD9_3DMODEL_DIR}/b.step"
        (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))
  `)));
  const by = Object.fromEntries(b.components.map((c) => [c.ref, c]));
  const placed = by["J1"]!.placements!;
  assert.deepEqual(placed[0]!.offset, [0, 1.325, 0]);
  assert.deepEqual(placed[0]!.rotate, [0, 0, -90]);
  assert.equal(placed[0]!.scale, undefined, "a 1,1,1 scale says nothing and is not sent");
  assert.equal(by["R1"]!.placements, undefined,
    "a footprint whose models are all at the identity carries no placements at all");
  assert.deepEqual(by["J1"]!.models, ["${KICAD9_3DMODEL_DIR}/a.step"],
    "and `models` still carries the plain lookup keys the mesh endpoint takes");
});

test("a model the board hides is not offered, in either spelling", () => {
  // Two *shapes*, not two spellings, which is the trap: KiCad 7 writes a bare `hide` atom on the model
  // list itself, KiCad 8+ writes a `(hide yes)` child. A `child(model,"hide")` lookup sees only the
  // second, so a v6-v8 board would draw every part its author had switched off. `(hide no)` is not
  // hiding, and must not be read as one by a mere existence check.
  const b = readBoard(parseBoard(board(`
    (footprint "L:old" (layer "F.Cu") (at 1 1)
      (property "Reference" "U1") (property "Value" "v7")
      (model "\${KICAD9_3DMODEL_DIR}/bare.step" hide (offset (xyz 0 0 0)))
      (model "\${KICAD9_3DMODEL_DIR}/shown.step" (offset (xyz 0 0 0))))
    (footprint "L:new" (layer "F.Cu") (at 2 2)
      (property "Reference" "U2") (property "Value" "v10")
      (model "\${KICAD9_3DMODEL_DIR}/child.step" (hide yes) (offset (xyz 0 0 0)))
      (model "\${KICAD9_3DMODEL_DIR}/explicit.step" (hide no) (offset (xyz 0 0 0))))
  `)));
  const by = Object.fromEntries(b.components.map((c) => [c.ref, c.models ?? []]));
  assert.deepEqual(by["U1"], ["${KICAD9_3DMODEL_DIR}/shown.step"], "the bare `hide` atom is honoured");
  assert.deepEqual(by["U2"], ["${KICAD9_3DMODEL_DIR}/explicit.step"], "`(hide yes)` is too, `(hide no)` is not");
  assert.equal(b.models.refs, 2, "and a hidden model is not a mesh anybody is missing, so coverage drops it");
  assert.equal(b.models.unique, 2);
});

test("a KiCad 6/7 board reports its components — the refdes is in fp_text, not a property", () => {
  // Not a partial result on an older board: a total one. The index ends with
  // `components.filter(c => c.ref)`, so reading only `(property "Reference")` dropped EVERY component.
  // Measured across the v7 corpus: 0 `(property "Reference")` against 94/189/68/... `fp_text reference`,
  // and with the components went cross-probe and every 3D part.
  const b = readBoard(parseBoard(board(`
    (footprint "Diode_SMD:1006_C" (layer "F.Cu") (at 5 6)
      (fp_text reference "D3" (at 0 0) (layer "F.SilkS"))
      (fp_text value "1N4148" (at 0 1) (layer "F.Fab"))
      (model "\${KICAD9_3DMODEL_DIR}/d.step" (offset (xyz 0 0 0))))
  `)));
  assert.equal(b.components.length, 1, "the component survives the ref filter");
  assert.equal(b.components[0]!.ref, "D3");
  assert.equal(b.components[0]!.value, "1N4148");
});
