import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBoard, readBoard, readBoardLayer, isStructuralLayer, capFor,
  MAX_LAYER_PRIMITIVES, MAX_STRUCTURAL_PRIMITIVES,
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
