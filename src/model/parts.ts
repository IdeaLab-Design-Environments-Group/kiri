/**
 * **Model** — what each library part's pads *are*, as opposed to where they sit.
 *
 * A footprint names its pads the way the datasheet does: "1", "2", "3". That is right for the file and
 * useless for the router, which needs to know which of those three a rail arrives at and which two it
 * chooses between. This is where a pad number becomes a role.
 *
 * It is also where the one deliberate departure from the manufacturer's footprint lives, so that the
 * parser stays a faithful reader and the fudge stays visible:
 *
 * The SPDT slide switch is a surface-mount part, so all three of its terminals sit in a single row on
 * one edge — you solder it to pads on a board and the traces approach from underneath. Copper tape on a
 * folded sheet has no underneath. A rail that arrives and leaves on the same edge has to double back
 * around the housing, which is what put all three terminals on one side and made the part unusable.
 *
 * So the common is reflected through the part's own origin — the line its two mounting pegs sit on — to
 * the opposite edge. The rail then runs straight through: in at the common, out at whichever throw is
 * selected, with the idle throw stranded in bare pattern. The pitch, the pad sizes and the peg positions
 * are all still the part's own; only that one reflection is ours.
 */
import { LED_1206, R_1206, SW_SPDT } from "./footprints.generated.js";
import {
  holes,
  padAt,
  padNamed,
  padSize,
  terminals,
  type Box,
  type Footprint,
  type Pad,
  type Vec2,
} from "./footprint.js";

/** A two-terminal part in line with the rail: the tape runs in one pad and out the other. */
export interface InlinePart {
  footprint: Footprint;
  /** Centre to centre between the terminals, in millimetres. */
  pitch: number;
  /** The bare pattern between them — the copper the part replaces. */
  gap: number;
  /** How big one terminal is. */
  pad: { w: number; h: number };
}

function inline(fp: Footprint, a: string, b: string): InlinePart {
  const [p, q] = [padNamed(fp, a), padNamed(fp, b)];
  const pad = padSize(p);
  const pitch = Math.abs(padAt(q).x - padAt(p).x);
  return { footprint: fp, pitch, gap: pitch - pad.w, pad };
}

/** The 1206 LED. Pad 1 is the anode, pad 2 the cathode. */
export const LED = inline(LED_1206, "1", "2");

/** The 1206 chip resistor. */
export const RESISTOR = inline(R_1206, "1", "2");

/** The SPDT slide switch, with the common moved across — see the note at the top of this file. */
export const SPDT = (() => {
  const throwA = padNamed(SW_SPDT, "1");
  const commonPad = padNamed(SW_SPDT, "2");
  const throwB = padNamed(SW_SPDT, "3");
  const pad = padSize(throwA);
  const row = padAt(throwA);
  /** The common, reflected to the far edge: same x, opposite y. */
  const common: Vec2 = { x: padAt(commonPad).x, y: -padAt(commonPad).y };
  return {
    footprint: SW_SPDT,
    /** Centre to centre along the row — one throw to the common's column. */
    pitch: Math.abs(padAt(throwB).x - padAt(commonPad).x),
    /** Across the part, common row to throw row. This is the reflection's doing. */
    rowSep: row.y - common.y,
    /** How far the throws stand off the part's origin. */
    offset: row.y,
    pad,
    common,
    throwA: padAt(throwA),
    throwB: padAt(throwB),
  };
})();

/**
 * How near two terminals must be across the part to count as sitting in the same row, in millimetres.
 *
 * Well under any real pad, so it separates rows rather than pads: the closest two rows in the library
 * are the switch's 5.5mm apart, and the closest two pads within a row 1mm.
 */
const ROW_TOL_MM = 0.05;

/** The part's terminals grouped into rows across it, near side first. */
function terminalRows(fp: Footprint): { y: number; pads: Pad[] }[] {
  const rows: { y: number; pads: Pad[] }[] = [];
  for (const [, pad] of terminals(fp)) {
    const y = padAt(pad).y;
    const row = rows.find((r) => Math.abs(r.y - y) <= ROW_TOL_MM);
    if (row) row.pads.push(pad);
    else rows.push({ y, pads: [pad] });
  }
  return rows.sort((a, b) => a.y - b.y);
}

/** A part the rail steps ACROSS: in at one row, out at the other. The switch, generalised. */
export interface AcrossPart {
  /** The terminals this reading picked, by their own names in the footprint. */
  names: { common: string; live: string; idle: string };
  /** Across the part, common row to throw row, in millimetres. */
  rowSep: number;
  /** Centre to centre along the throw row, the common's column to the throw the rail leaves by. */
  pitch: number;
  /** One terminal, as {@link padSize} gives it: `w` across the rail, `h` along it. */
  pad: Box;
}

/**
 * Whether a rail steps ACROSS this part, and if so with what geometry — read off the footprint alone.
 *
 * Two rows of terminals means the rail arrives at one and leaves at the other; that is the direct case.
 * The other is the surface-mount one described at the top of this file: all the terminals on one edge,
 * off the line the part's mounting pegs sit on, and the middle one reflected through that line to the
 * far edge so the rail runs straight through instead of doubling back round the housing.
 *
 * Fewer than three terminals is a part in line with the rail, not one it steps across; and with no pegs
 * there is no line to reflect through. Both stay one-row and are routed and drawn like a resistor.
 *
 * It lives here, alone, because it is one decision wearing two hats. The router breaks copper by it and
 * the export draws by it, and when the two briefly had a rule each they agreed on every part in the
 * library except the coin cell — three terminals but no pegs — which the router would have cut as an
 * in-line part while the export drew a housing across the rail. A cut file that disagrees with its own
 * drawing is the worst failure this code has, because it looks right until the copper is on the sheet.
 */
export function acrossPart(fp: Footprint): AcrossPart | null {
  const rows = terminalRows(fp);
  if (rows.length === 1) {
    const row = rows[0]!;
    if (row.pads.length < 3 || Math.abs(row.y) <= ROW_TOL_MM || holes(fp).length === 0) return null;
    const byX = [...row.pads].sort((a, b) => padAt(a).x - padAt(b).x);
    const common = byX[Math.floor(byX.length / 2)]!;
    const live = byX[byX.length - 1]!;
    const idle = byX[0]!;
    return {
      names: nameOf(fp, common, live, idle),
      // The reflection, and nothing else: same column, opposite side.
      rowSep: padAt(live).y - -padAt(common).y,
      pitch: Math.abs(padAt(live).x - padAt(common).x),
      pad: padSize(live),
    };
  }
  if (rows.length < 2) return null;
  // Genuinely two rows. The rail arrives at the sparser one — one common against several throws — and
  // leaves at the throw furthest from the common's column, which is the one the neck has to clear.
  const [near, far] = rows[0]!.pads.length <= rows[rows.length - 1]!.pads.length
    ? [rows[0]!, rows[rows.length - 1]!]
    : [rows[rows.length - 1]!, rows[0]!];
  const common = [...near.pads].sort((a, b) => padAt(a).x - padAt(b).x)[Math.floor(near.pads.length / 2)]!;
  const byReach = [...far.pads].sort(
    (a, b) => Math.abs(padAt(a).x - padAt(common).x) - Math.abs(padAt(b).x - padAt(common).x),
  );
  const live = byReach[byReach.length - 1]!;
  // The idle throw is whatever else that row holds; with only one throw there is nothing to switch to and
  // it stands in for itself, which keeps the naming total rather than optional.
  const idle = byReach.length > 1 ? byReach[0]! : live;
  return {
    names: nameOf(fp, common, live, idle),
    rowSep: Math.abs(padAt(live).y - padAt(common).y),
    pitch: Math.abs(padAt(live).x - padAt(common).x),
    pad: padSize(live),
  };
}

/** Look three chosen pads back up by the names the footprint gives them. */
function nameOf(
  fp: Footprint, common: Pad, live: Pad, idle: Pad,
): { common: string; live: string; idle: string } {
  const find = (target: Pad): string => terminals(fp).find(([, p]) => p === target)?.[0] ?? "";
  return { common: find(common), live: find(live), idle: find(idle) };
}

/** The terminals in line with the rail, outermost first — the one-row reading. */
export function inlineTerminals(fp: Footprint): Pad[] {
  return inlineNamedTerminals(fp).map(([, p]) => p);
}

/** The same, keeping each terminal's own name — what a drawing needs to label a pad. */
export function inlineNamedTerminals(fp: Footprint): [string, Pad][] {
  return terminals(fp).sort((a, b) => padAt(a[1]).x - padAt(b[1]).x);
}
