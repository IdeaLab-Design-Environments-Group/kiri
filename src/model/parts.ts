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
import { padAt, padNamed, padSize, type Footprint, type Vec2 } from "./footprint.js";

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
