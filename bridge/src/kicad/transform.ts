/**
 * Placing a symbol's pins on the sheet (ADR-038).
 *
 * A symbol *instance* in a `.kicad_sch` lists its pins by number and uuid and gives **no coordinates**.
 * The coordinates live in the `lib_symbols` definition, in the symbol's own frame, and have to be
 * transformed by the instance's placement. Getting this wrong is the worst kind of bug available here:
 * the sheet still renders correctly, and only the derived connectivity is quietly garbage.
 *
 * The convention below was **measured, not remembered** — see `tools/kicad-probe.ts`, which scores
 * candidate transforms against real KiCad output using `no_connect` markers as an oracle (KiCad places
 * one exactly on an unconnected pin, so a correct transform must land a pin there).
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
 * Order is **flip → mirror → rotate → translate**, and each step is there for a measured reason:
 *
 *  - **Y flip.** Library symbols are drawn Y-up; sheets are Y-down. Without it the transform scores 54%
 *    against the oracle instead of 91%, so this is not a stylistic choice.
 *  - **Rotation is negative.** `rotate(-r)` beats `rotate(+r)` 91.2% to 84.6% over 17k pins. The two are
 *    indistinguishable on small corpora because most rotated parts are two-pin and symmetric about their
 *    origin — both signs then produce the same *set* of positions, which is how this stayed ambiguous.
 *  - **Mirror before rotation.** KiCad stores the mirror as a property of the symbol, applied in its own
 *    frame; rotating first would reflect across the wrong axis for anything not at 0°.
 */
export function placePoint(px: number, py: number, at: Placement): [number, number] {
  let x = px;
  let y = -py; // library frame is Y-up, sheet frame is Y-down

  if (at.mirror === "x") y = -y;
  else if (at.mirror === "y") x = -x;

  const r = (-at.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const rx = x * c - y * s;
  const ry = x * s + y * c;

  return [at.x + rx, at.y + ry];
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
