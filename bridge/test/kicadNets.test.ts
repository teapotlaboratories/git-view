import { test } from "node:test";
import assert from "node:assert/strict";
import { readSheet } from "../src/kicad/schematic.js";
import { computeNets } from "../src/kicad/nets.js";

/**
 * Schematic connectivity (ADR-038).
 *
 * Every rule here was decided by measurement against `kicad-cli`'s own netlist — see
 * `tools/kicad-netlist-oracle.ts`, currently 582/582 nets on the 14 flat demo sheets. This file exists
 * because that tool cannot run in CI: it needs KiCad installed, and the corpus is separately licensed.
 * So the rules are re-stated here on hand-authored fixtures, small enough to reason about by eye.
 *
 * Three of these assertions encode rules the implementation originally got *backwards*. They are kept
 * pointed at those specific mistakes, because "a wire ending on another wire connects" is the kind of
 * plausible assumption that will be re-introduced by someone tidying up later.
 */

const px = (n: number) => n.toFixed(2);

/** One-pin test part, pin at the symbol origin, so placing it at (x, y) puts its pin exactly there. */
function libTestPoint(name: string, opts: { power?: boolean; pinName?: string; type?: string; hidden?: boolean } = {}) {
  return `(symbol "${name}" ${opts.power ? "(power)" : ""}
    (symbol "${name}_1_1"
      (pin ${opts.type ?? "passive"} line (at 0 0 0) (length 0) ${opts.hidden ? "hide" : ""}
        (name "${opts.pinName ?? "~"}" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))))`;
}

function instance(lib: string, ref: string, x: number, y: number, value = "V") {
  return `(symbol (lib_id "${lib}") (at ${px(x)} ${px(y)} 0) (unit 1)
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "${value}" (at 0 0 0)))`;
}

const wire = (x1: number, y1: number, x2: number, y2: number) =>
  `(wire (pts (xy ${px(x1)} ${px(y1)}) (xy ${px(x2)} ${px(y2)})))`;
const junction = (x: number, y: number) => `(junction (at ${px(x)} ${px(y)}) (diameter 0))`;
const label = (t: string, x: number, y: number, kind = "label") => `(${kind} "${t}" (at ${px(x)} ${px(y)} 0))`;

function sheet(libs: string[], body: string[]): string {
  return `(kicad_sch (version 20250114) (generator "test")
    (lib_symbols ${libs.join("\n")})
    ${body.join("\n")})`;
}

/** Nets carrying at least one pin, as sorted pin-sets, so assertions read like a netlist. */
function netsOf(src: string): string[][] {
  return computeNets(readSheet(src))
    .filter((n) => n.pins.length)
    .map((n) => n.pins)
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

const TP = libTestPoint("t:TP");

test("a wire connects the pins at its two ends", () => {
  const s = sheet([TP], [instance("t:TP", "R1", 0, 10), instance("t:TP", "R2", 20, 10), wire(0, 10, 20, 10)]);
  assert.deepEqual(netsOf(s), [["R1.1", "R2.1"]]);
});

test("two wires that merely cross are NOT connected", () => {
  // The rule that makes crossing signals legal on a schematic. Getting it wrong shorts unrelated nets,
  // and the sheet still draws perfectly, so nothing would look amiss.
  const s = sheet(
    [TP],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:TP", "R2", 20, 10),
      instance("t:TP", "R3", 10, 0),
      instance("t:TP", "R4", 10, 20),
      wire(0, 10, 20, 10),
      wire(10, 0, 10, 20),
    ],
  );
  assert.deepEqual(netsOf(s), [["R1.1", "R2.1"], ["R3.1", "R4.1"]]);
});

test("a wire ending mid-span of another does NOT connect without a junction", () => {
  // Measured, and initially implemented backwards. `electric.kicad_sch` has exactly this at
  // (115.57, 20.32) and KiCad keeps the nets apart; joining them merged two real nets into one.
  const body = [
    instance("t:TP", "R1", 0, 10),
    instance("t:TP", "R2", 20, 10),
    instance("t:TP", "R3", 10, 20),
    wire(0, 10, 20, 10),
    wire(10, 10, 10, 20), // ends dead on the middle of the first wire
  ];
  assert.deepEqual(netsOf(sheet([TP], body)), [["R1.1", "R2.1"], ["R3.1"]]);

  // …and the junction dot is what makes it a connection.
  assert.deepEqual(netsOf(sheet([TP], [...body, junction(10, 10)])), [["R1.1", "R2.1", "R3.1"]]);
});

test("a pin lying mid-span of a wire DOES connect, with no junction needed", () => {
  // The other half of the rule above, and the reason it cannot simply be "junctions only": requiring a
  // junction here split 59 of carte_test's 100 nets.
  const s = sheet(
    [TP],
    [instance("t:TP", "R1", 0, 10), instance("t:TP", "R2", 20, 10), instance("t:TP", "R3", 10, 10), wire(0, 10, 20, 10)],
  );
  assert.deepEqual(netsOf(s), [["R1.1", "R2.1", "R3.1"]]);
});

test("same-name labels join islands that share no wire", () => {
  const s = sheet(
    [TP],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:TP", "R2", 10, 10),
      instance("t:TP", "R3", 0, 30),
      instance("t:TP", "R4", 10, 30),
      wire(0, 10, 10, 10),
      wire(0, 30, 10, 30),
      label("SDA", 0, 10),
      label("SDA", 0, 30),
    ],
  );
  assert.deepEqual(netsOf(s), [["R1.1", "R2.1", "R3.1", "R4.1"]]);
  assert.equal(computeNets(readSheet(s))[0]!.name, "SDA", "and the net takes the label's name");
});

test("a power symbol names its net and is not a node on it", () => {
  // KiCad's netlist lists `GND` with the pins it reaches and no `#PWR0x` node of its own.
  //
  // The reference here is deliberately *not* `#`-prefixed. KiCad names real power symbols `#PWR0x`, so
  // the `#` rule would exclude this pin regardless and the assertion would hold even with the power rule
  // deleted — a test that cannot fail. Giving it an ordinary reference isolates the rule under test.
  const s = sheet(
    [TP, libTestPoint("t:GND", { power: true, pinName: "GND", type: "power_in" })],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:GND", "PWR1", 10, 10, "GND"),
      wire(0, 10, 10, 10),
    ],
  );
  const nets = computeNets(readSheet(s)).filter((n) => n.pins.length);
  assert.deepEqual(nets.map((n) => n.pins), [["R1.1"]], "the power symbol contributes no pin");
  assert.equal(nets[0]!.name, "GND", "but it does contribute the name");
});

test("two power symbols of the same name are one net, wired or not", () => {
  const s = sheet(
    [TP, libTestPoint("t:GND", { power: true, pinName: "GND", type: "power_in" })],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:GND", "#PWR01", 10, 10, "GND"),
      wire(0, 10, 10, 10),
      instance("t:TP", "R2", 0, 30),
      instance("t:GND", "#PWR02", 10, 30, "GND"),
      wire(0, 30, 10, 30),
    ],
  );
  assert.deepEqual(netsOf(s), [["R1.1", "R2.1"]]);
});

test("a hidden power_in pin connects by its own name, with no wire", () => {
  // The old 74xx convention: supply pins are drawn nowhere and join the matching global net. Without
  // this, every such pin becomes a one-pin net and the supplies quietly lose members.
  const s = sheet(
    [TP, libTestPoint("t:GND", { power: true, pinName: "GND", type: "power_in" }), libTestPoint("t:U", { pinName: "GND", type: "power_in", hidden: true })],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:GND", "#PWR01", 10, 10, "GND"),
      wire(0, 10, 10, 10),
      instance("t:U", "U1", 50, 50),
    ],
  );
  assert.deepEqual(netsOf(s), [["R1.1", "U1.1"]]);
});

test("PWR_FLAG names nothing — it is flagged power but its pin is power_out", () => {
  // `(power)` alone is not the test. Trusting it would name a net "PWR_FLAG".
  const s = sheet(
    [TP, libTestPoint("t:PWR_FLAG", { power: true, pinName: "pwr", type: "power_out" })],
    [instance("t:TP", "R1", 0, 10), instance("t:PWR_FLAG", "#FLG01", 10, 10, "PWR_FLAG"), wire(0, 10, 10, 10)],
  );
  const nets = computeNets(readSheet(s)).filter((n) => n.pins.length);
  assert.deepEqual(nets.map((n) => n.pins), [["R1.1"]], "a #-prefixed ref is never a node");
  assert.notEqual(nets[0]!.name, "PWR_FLAG", "and it must not name the net");
});

test("a global label outranks a local one naming the same net", () => {
  const s = sheet(
    [TP],
    [
      instance("t:TP", "R1", 0, 10),
      instance("t:TP", "R2", 20, 10),
      wire(0, 10, 20, 10),
      label("local_name", 0, 10),
      label("GLOBAL_NAME", 20, 10, "global_label"),
    ],
  );
  assert.equal(computeNets(readSheet(s))[0]!.name, "GLOBAL_NAME");
});

test("an unlabelled net gets KiCad's own auto-name", () => {
  // Reproduced exactly so derived netlists diff cleanly against kicad-cli output.
  const s = sheet([TP], [instance("t:TP", "R1", 0, 10), instance("t:TP", "R2", 20, 10), wire(0, 10, 20, 10)]);
  const net = computeNets(readSheet(s))[0]!;
  assert.equal(net.name, "Net-(R1-Pad1)");
  assert.ok(net.unnamed, "and it is flagged as invented rather than read");
});
