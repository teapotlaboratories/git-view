/**
 * Placing a symbol's pins on the sheet (ADR-038).
 *
 * A symbol *instance* in a `.kicad_sch` lists its pins by number and uuid and gives **no coordinates**.
 * The coordinates live in the `lib_symbols` definition, in the symbol's own frame, and have to be
 * transformed by the instance's placement. Getting this wrong is the worst kind of bug available here:
 * the sheet still renders correctly, and only the derived connectivity is quietly garbage.
 *
 * The convention below was **measured, not remembered**, against two oracles:
 *
 *  - `tools/kicad-probe.ts` — scores candidates on `no_connect` markers, which KiCad places exactly on an
 *    unconnected pin, so a correct transform must land a pin there.
 *  - `tools/kicad-netlist-oracle.ts` — scores derived nets against `kicad-cli`'s own netlist.
 *
 * The second exists because the first has a blind spot worth stating plainly: markers constrain *where*
 * pins land, not *which* pin landed there. Swapping pins 1 and 2 of a two-pin part produces an identical
 * set of coordinates, and most mirrored parts in the corpus are two-pin — so the marker oracle scored a
 * pin-swapping transform as perfect. A netlist names the pin on each net, which settles it.
 */

/** Instance placement as it appears in `(symbol (at x y rot) (mirror x|y) …)`. */
export interface Placement {
  x: number;
  y: number;
  /** Degrees, from `(at … … rot)`. KiCad writes 0 / 90 / 180 / 270. */
  rotation: number;
  /** `(mirror x)` reflects across the X axis, `(mirror y)` across the Y axis. Absent for most parts. */
  mirror?: "x" | "y";
}

/** A pin as declared in `lib_symbols`, in the symbol's local frame. */
export interface LibPin {
  x: number;
  y: number;
  number: string;
  name?: string;
}

export interface PlacedPin extends LibPin {
  /** Sheet coordinates, millimetres. */
  sheetX: number;
  sheetY: number;
}

/**
 * Map a library-frame point onto the sheet.
 *
 * Order is **flip → rotate → mirror → translate**, and each step is there for a measured reason:
 *
 * Scores below are: **markers** = `tools/kicad-probe.ts`, 19,978 pins over 115 KiCad 10 sheets;
 * **netlist** = `tools/kicad-netlist-oracle.ts`, 582 nets over 14 flat KiCad 7 sheets.
 *
 *  - **Y flip.** Library symbols are drawn Y-up; sheets are Y-down. Without it the transform scores
 *    57.8% on markers instead of 91.8%, so this is not a stylistic choice.
 *  - **Rotation is negative.** `rotate(-r)` beats `rotate(+r)` 91.8% to 85.0% on markers, and the netlist
 *    agrees emphatically: 100% against 78.2%.
 *  - **`(mirror x)` negates Y**, not X — 100% against 80.6% on the netlist.
 *  - **Mirror comes *after* rotation.** This one was wrong here for a while, and the story is the reason
 *    the second oracle exists. The code applied the mirror first, reasoning that KiCad stores it as a
 *    property of the symbol in its own frame — a tidy argument for a false conclusion. Both orders place
 *    the same *coordinates* for a two-pin part and merely exchange which pin sits at which end, so the
 *    marker oracle ranked the wrong order 90.6% against 91.8% and could not settle it. The netlist knows
 *    which pin is on which net: mirror-after 100%, mirror-before 95.4%. On StickHub the old order put
 *    every ESD diode's pin 2 on GND and its pin 1 on the signal — an exactly-backwards circuit that still
 *    drew a flawless-looking sheet.
 */
export function placePoint(px: number, py: number, at: Placement): [number, number] {
  const x0 = px;
  const y0 = -py; // library frame is Y-up, sheet frame is Y-down

  const r = (-at.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  let x = x0 * c - y0 * s;
  let y = x0 * s + y0 * c;

  if (at.mirror === "x") y = -y;
  else if (at.mirror === "y") x = -x;

  return [at.x + x, at.y + y];
}

/** Place every pin of a symbol instance. */
export function placePins(pins: readonly LibPin[], at: Placement): PlacedPin[] {
  return pins.map((p) => {
    const [sheetX, sheetY] = placePoint(p.x, p.y, at);
    return { ...p, sheetX, sheetY };
  });
}

/**
 * Connectivity is decided by exact coincidence, so coordinates need a canonical form: KiCad writes
 * millimetres with up to 6 decimals, and two points that differ in the last bit of a float are the same
 * node as far as the schematic is concerned. Rounding to 3 decimals (1 nm) is far below any real grid and
 * well above float noise.
 */
export function pointKey(x: number, y: number): string {
  // `+0` normalises -0 to 0, which would otherwise produce two keys for one point.
  return `${(Math.round(x * 1000) / 1000 + 0).toFixed(3)},${(Math.round(y * 1000) / 1000 + 0).toFixed(3)}`;
}
