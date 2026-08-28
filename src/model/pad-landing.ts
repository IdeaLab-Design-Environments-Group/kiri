/**
 * **Model** — where copper is allowed to stop: landings, LED seats and battery terminals.
 *
 * ## Why this is its own file
 *
 * A run has to end somewhere, and the end is the delicate part. It must be narrow enough that the two
 * nets under a chip can still be weeded apart, wide enough to actually solder to, centred on the part's
 * own pad spacing rather than on the hinge it straddles, and identical in the preview and in the cut file
 * or the copper lands off the pad.
 *
 * That is one body of rules, and it was scattered through the router. Pulling it out means the seating
 * question — *does this part fit here at all?* — can be asked without planning a route, which is exactly
 * what `netlist.ts` wants when it reports a footprint as unseatable.
 *
 * Widths come from `tape-width.ts` and are never re-derived here.
 */
import { type FlatFace, type GapEdge, type Vec2, pointInFace } from "./electronics.js";
import type { LedSeat, PadField, Terminals } from "./trace-types.js";
import { footprintById } from "./library.js";
import { type Pad, padAt, padSize } from "./footprint.js";
import { LED_GAP_FRAC, MIN_LAND_FRAC, MIN_WEED_MM, TAPE_MM, weedGapFor } from "./tape-width.js";
import { add, leftOf, len, scale, segPointDist, sub, unit } from "./trace-geometry.js";
import { inlineTerminals } from "./parts.js";

/**
 * How wide the tape may be where it lands on `pad`, given the chip it shares with `mate`.
 *
 * Full width wherever there is room. Where there is not, it narrows to leave the gap, down to a floor: below
 * that the strip is too thin to cut, and the honest answer is that the pattern is too small for this tape
 * rather than a sliver that tears on weeding.
 */
export function landingWidth(pad: Vec2, mate: Vec2, tapeW: number, weed?: number): number {
  return landingWidthFor(Math.hypot(pad.x - mate.x, pad.y - mate.y), tapeW, weed);
}

/**
 * {@link landingWidth}, given the separation directly rather than two points.
 *
 * The one definition of the formula. Terminals of a multi-pin part are neighbours in exactly the way an
 * LED's two legs are, and the width copper may land at is the same question with the same answer; what
 * differs is only how the separation was found. See `footprint.ts › nearestTerminalMm`.
 */
export function landingWidthFor(sep: number, tapeW: number, weed?: number): number {
  return Math.max(tapeW * MIN_LAND_FRAC, Math.min(tapeW, padRoomFor(sep, tapeW, weed)));
}

/**
 * How wide copper may be at `p`: the tape's width, narrowed by every field it is standing in.
 *
 * **The one definition of "how wide may copper be here, given the metal near it".** `copper-svg-export.ts
 * › widthsFor` asks it of an LED's two legs and `net-routing.ts › legWidths` asks it of a multi-pin part's
 * pads; those two build their fields differently — an LED's mate is one named pad on the other net and the
 * run *ends* there, while a pin's neighbours are every other pad on the part and the run *passes* them —
 * but the narrowing itself is one rule and lives here. Two readings of one geometric question is the
 * mistake `parts.ts › padRunBox` was written to undo.
 */
export function narrowedTo(base: number, p: Vec2, fields: PadField[]): number {
  let w = base;
  for (const f of fields) {
    if (Math.hypot(p.x - f.at.x, p.y - f.at.y) > f.reach) continue;
    w = Math.min(w, f.safe);
  }
  return w;
}

/**
 * The room a landing has before clamping — how wide copper *could* be, which may be zero or negative.
 *
 * {@link landingWidthFor} floors this, and a floored number cannot say that it ran out of room: at a pitch
 * of 2.1mm and a 1.14mm floor the answer is 1.14mm whether the room was 0.96mm or 1.14mm, and only one of
 * those can actually be weeded. Anything that has to *report* impossibility rather than merely cut as close
 * as it can reads this instead.
 */
export function padRoomFor(sep: number, tapeW: number, weed = tapeW * LED_GAP_FRAC): number {
  return sep - weed;
}

export const DEFAULT_LED = "LED_1206";

/** What an LED's own footprint asks of the copper, in millimetres. */
/**
 * Read an LED's seating off its own footprint, or null when the library has no such part.
 *
 * The same reading `parts.ts` gives a resistor — outermost terminal to outermost terminal — done per
 * placed LED rather than once for the 1206, because two LEDs of different types on one circuit each get
 * their own copper.
 */
export function ledSeat(component: string = DEFAULT_LED): LedSeat | null {
  const footprint = footprintById(component);
  if (!footprint) return null;
  const ends = inlineTerminals(footprint);
  if (ends.length !== 2) return null;
  const [p, q] = ends as [Pad, Pad];
  const padW = padSize(p).w;
  const pitch = Math.abs(padAt(q).x - padAt(p).x);
  if (!(pitch > 0) || !(padW > 0)) return null;
  return { component, footprint, pitch, padW, gap: pitch - padW };
}

/**
 * Whether this part can be cut on this hinge at all, and if so where its two copper ends go.
 *
 * The copper stops `gap` apart, straddling the hinge midpoint along the hinge's own normal, so the chip's
 * legs land at its `pitch` with each leg half on copper. That means the tape reaches **in over the tile
 * gap**: the pads are no longer the tile dents (`pinchMid`) they used to be, because the dents are the
 * printed joinery and sit wherever the tiling puts them — 5.81mm apart on `house.fkld`, where a 1206's
 * legs are 3.40mm apart and could not reach their own copper. The joinery does not move; the pad does.
 *
 * Two ways a part is refused rather than drawn wrong:
 *
 *  - **Weeding.** The bare strip between the two nets is the footprint's own `gap`, and below
 *    {@link MIN_WEED_MM} it tears instead of lifting. `LED_1206` asks 2.00mm and clears it with 0.86mm to
 *    spare; `LED_0603` asks 0.70mm and does not, at any pattern size — both numbers are physical
 *    millimetres, so scaling the pattern scales the tape with it and never changes the verdict. There is
 *    no landing width that rescues it either: to hold copper at its own {@link landingWidth} floor on both
 *    legs *and* leave a weedable strip between them needs `pitch >= 2 * MIN_WEED_MM` = 2.28mm, and the
 *    0603's pitch is 1.50mm. So it is reported, not shrunk to fit.
 *  - **Room.** A part longer than the tile it half sits on would put its copper end off the material.
 */
export function seatLed(
  gap: GapEdge,
  faces: FlatFace[],
  seat: LedSeat,
  tapeW: number,
  /** The tape's width in mm — {@link tapeMmFor}. Together with `tapeW` this is the pattern's scale, and
   *  the two must come from the same call or every millimetre here converts to the wrong length. */
  tapeMm: number = TAPE_MM,
): [Vec2, Vec2] | null {
  if (seat.gap < MIN_WEED_MM) return null;
  const half = (seat.gap * tapeW) / tapeMm / 2; // millimetres into this pattern's units
  const [pa, pb] = gap.ends;
  const n = leftOf(unit(sub(pb, pa))); // unit normal to the hinge; sign settled per face below
  const toward = (face: number): Vec2 => {
    const c = faces[face]?.centroid;
    const s = c && (n.x * (c.x - gap.point.x) + n.y * (c.y - gap.point.y)) < 0 ? -1 : 1;
    return add(gap.point, scale(n, s * half));
  };
  const padA = toward(gap.faceA);
  const padB = toward(gap.faceB);
  if (pointInFace(faces, padA) !== gap.faceA || pointInFace(faces, padB) !== gap.faceB) return null;
  return [padA, padB];
}

/** Half-width a battery pad wants: a bit over a trace, enough of a landing to fix a cell to while still
 *  reading as part of the wiring. {@link batteryTerminals} shrinks it where the tile cannot hold it. */
export function terminalHalfWidth(tapeW: number): number {
  return tapeW * 0.6;
}

export function batteryTerminals(centre: Vec2, diag: number, poly?: Vec2[], tapeW: number = TAPE_MM): Terminals {
  // Two pads either side of the battery's centre, just far enough apart for a strip to pass between them.
  //
  // Everything is measured in tape widths rather than fractions of the pattern, which is what fixed the
  // original fault: pads of a fixed size at a fixed spacing left a gap narrower than the strip that had to pass
  // through it, so each net's keep-out reached across its neighbour and neither could leave its own pad toward
  // the other side -- geometry with no solution rather than a routing failure.
  //
  // Both the size and the spacing are clamped to the tile. A pad hanging off its tile is copper outside the
  // shape, which is the one thing the containment rule does not allow, so on a tile too small to hold the pads
  // at their wanted size they shrink rather than overhang.
  let half = terminalHalfWidth(tapeW);
  let h = half + tapeW * 0.7; // leaves a strip and 40% clearance between the two pads
  if (poly && poly.length >= 3) {
    let room = Infinity;
    for (let n = 0; n < poly.length; n++) {
      const d = segPointDist(poly[n]!, poly[(n + 1) % poly.length]!, centre);
      if (d < room) room = d;
    }
    // The far corner of a pad sits at (h + half) across and half up, so keep that inside the tile.
    // Shrink the *pad* until it fits, never the spacing: the gap between the pads has to stay a full strip and
    // a bit, or the router cannot get a trace out from between them -- the fault this geometry exists to avoid.
    // Squeezing the spacing instead left puffin with a gap of 0.58 of a strip and a terminal short.
    const fit = (hh: number): boolean => Math.hypot(2 * hh + tapeW * 0.7, hh) <= room;
    while (half > tapeW * 0.2 && !fit(half)) half *= 0.85;
    h = half + tapeW * 0.7;
  }
  return { pwr: { x: centre.x + h, y: centre.y }, gnd: { x: centre.x - h, y: centre.y }, half };
}


// ---- the router -------------------------------------------------------------

/** A routed net: its walk, and the corridor waypoints it took. */
