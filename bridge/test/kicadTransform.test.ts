import { test } from "node:test";
import assert from "node:assert/strict";
import { placePoint, pointKey, type Placement } from "../src/kicad/transform.js";
import { parseSexpr, children, child, nums } from "../src/kicad/sexpr.js";

/**
 * The pin transform (ADR-038).
 *
 * **What this test is for, and what it is not.** It pins the *behaviour* so a refactor cannot silently
 * change where pins land — the failure mode that matters, because a wrong transform still renders a
 * perfect-looking sheet and only corrupts the derived connectivity.
 *
 * It does **not** independently prove the convention is right; the expected values were derived from the
 * same measurement that chose it. Proof that it matches reality comes from `tools/kicad-probe.ts`, which
 * scores it against real KiCad output (90.6% of ~20k pins landing on a `no_connect` or wire endpoint,
 * versus 57.7% without the Y-flip and 86.6% ignoring mirror). The two do different jobs: the tool says
 * "this matches KiCad", the test says "and it still does".
 *
 * Fixtures are hand-authored rather than vendored: KiCad's demo projects carry their own licences and
 * this repository is MIT.
 */

const at = (x: number, y: number, rotation = 0, mirror?: "x" | "y"): Placement => ({ x, y, rotation, mirror });

/** Coordinates are floats; comparing them exactly would fail on cos(90°) = 6.1e-17. */
function assertPoint(got: [number, number], want: [number, number], msg: string): void {
  assert.ok(
    Math.abs(got[0] - want[0]) < 1e-9 && Math.abs(got[1] - want[1]) < 1e-9,
    `${msg}: got (${got[0]}, ${got[1]}), want (${want[0]}, ${want[1]})`,
  );
}

test("the Y axis flips — library symbols are Y-up, sheets are Y-down", () => {
  // The single highest-impact rule: dropping it costs ~33 points against real KiCad output.
  assertPoint(placePoint(0, 2.54, at(0, 0)), [0, -2.54], "pin above origin lands below it on the sheet");
  assertPoint(placePoint(0, -2.54, at(0, 0)), [0, 2.54], "and vice versa");
  assertPoint(placePoint(2.54, 0, at(0, 0)), [2.54, 0], "X is untouched");
});

test("rotation is negative, which only a large corpus could show", () => {
  // 90° clockwise in sheet space. With the opposite sign this lands at (0, 2.54) — indistinguishable on
  // two-pin symmetric parts, which is exactly why it stayed ambiguous until 17k pins were measured.
  assertPoint(placePoint(2.54, 0, at(0, 0, 90)), [0, -2.54], "90°");
  assertPoint(placePoint(2.54, 0, at(0, 0, 180)), [-2.54, 0], "180°");
  assertPoint(placePoint(2.54, 0, at(0, 0, 270)), [0, 2.54], "270°");
});

test("mirror reflects in the symbol's own frame, before rotation", () => {
  assertPoint(placePoint(0, 2.54, at(0, 0, 0, "x")), [0, 2.54], "(mirror x) negates Y");
  assertPoint(placePoint(2.54, 0, at(0, 0, 0, "y")), [-2.54, 0], "(mirror y) negates X");
  // Order is the point: mirroring after a 90° rotation would reflect across the wrong axis and land
  // this pin at (0, 2.54) instead.
  assertPoint(placePoint(2.54, 0, at(0, 0, 90, "y")), [0, 2.54], "mirror then rotate, not the reverse");
});

test("placement translates last, so the instance position is just an offset", () => {
  assertPoint(placePoint(2.54, 0, at(100, 50)), [102.54, 50], "no rotation");
  assertPoint(placePoint(2.54, 0, at(100, 50, 180)), [97.46, 50], "with rotation");
});

test("pointKey collapses float noise and normalises -0", () => {
  // Connectivity is decided by exact coincidence of keys, so two spellings of one point would silently
  // split a net in two — a viewer that lies rather than one that breaks.
  assert.equal(pointKey(1.0000000001, 2), pointKey(1, 2), "noise below the nm grid is the same point");
  assert.equal(pointKey(-0, 5), pointKey(0, 5), "-0 and 0 are one node");
  assert.notEqual(pointKey(1.001, 2), pointKey(1, 2), "but a real 1 µm difference is not");
});

test("the reader survives KiCad 10's formatting, which is why it is a reader", () => {
  // KiCad 10 pretty-prints with tabs and puts `(symbol` and `(lib_id …)` on separate lines; KiCad 7 did
  // not. A regex-based reader would have broken silently on exactly this when the target version moved.
  const kicad10ish = `(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(symbol
\t\t(lib_id "Device:R")
\t\t(at 127 63.5 90)
\t\t(mirror y)
\t\t(unit 1)
\t)
)`;
  const root = parseSexpr(kicad10ish);
  const sym = child(children(root, "symbol")[0]!, "lib_id");
  assert.equal(sym?.[1], "Device:R", "lib_id survives being on its own line");

  const inst = children(root, "symbol")[0]!;
  const pos = nums(inst, "at");
  assert.deepEqual(pos, [127, 63.5, 90]);
  assert.equal(String(child(inst, "mirror")![1]), "y");
  assert.equal(nums(root, "version")[0], 20250114, "and the format version is readable for gating");
});
