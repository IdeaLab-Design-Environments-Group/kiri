/**
 * **View** — what the electronics editor tells someone who has not placed anything yet (issue #57).
 *
 * The default tool places an LED across the nearest fold, and nothing on an empty page said so: the only
 * text was a status line of zero counts. The first step is written on the canvas, where the eye already
 * is, and it names the Parts go control (once captioned Seat) because it is what decides where an LED can go. It comes down as
 * soon as anything is on the sheet.
 *
 * Kept out of `electronics-modal.ts`, which holds the listeners: this is a sentence and a toggle.
 */
import { type Circuit, type GapEdge, type Vec2, nearestGap } from "../model/electronics.js";

/** Where a tap seats an LED or a part: across the nearest fold, or on the tile under it. */
export type PlaceMode = "gap" | "free";

/** The first step, for the Parts go setting in force. */
export function firstStep(mode: PlaceMode): string {
  return mode === "free"
    ? "Tap a tile to place an LED, then pick battery and tap a tile. " +
      "Parts go › across a fold puts an LED across a hinge instead."
    : "Tap near a fold to place an LED, then pick battery and tap a tile. " +
      "Parts go › on a tile puts an LED anywhere on a tile instead.";
}

/** Whether the sheet is still empty: no LED, battery, part or hand-drawn wire of any kind. */
export function nothingPlaced(circuit: Circuit): boolean {
  return !circuit.leds.length && !circuit.battery && !(circuit.parts ?? []).length &&
    !(circuit.resistors ?? []).length && !(circuit.switches ?? []).length && !(circuit.wires ?? []).length;
}

/** Show the first step on an empty sheet, in the words for the Parts go setting in force, and hide it otherwise. */
export function syncFirstStep(
  el: { hidden: boolean; textContent: string | null } | null | undefined,
  circuit: Circuit,
  mode: PlaceMode,
): void {
  if (!el) return;
  el.hidden = !nothingPlaced(circuit);
  if (!el.hidden) el.textContent = firstStep(mode);
}

/**
 * The fold a tap at `at` seats on: the nearest hinge, if it is within `reach`.
 *
 * The one rule for both the tap and the highlight that previews it (issue #58), so the fold lit under the
 * pointer is always the fold the tap would use, and a tap with nothing lit always misses.
 */
export function foldInReach(gaps: GapEdge[], at: Vec2, reach: number): GapEdge | null {
  const hit = nearestGap(gaps, at);
  return hit && hit.dist <= reach ? hit.gap : null;
}

/**
 * The hinge a tap at `at` would place on, lit, with a ghost of the LED's two pads across its middle — or
 * nothing when no fold is in reach. `tp` takes a flat-pattern point to the canvas.
 */
export function foldHover(gaps: GapEdge[], at: Vec2, reach: number, tp: (p: Vec2) => Vec2): string {
  const gap = foldInReach(gaps, at, reach);
  if (!gap) return "";
  const [p, q] = gap.ends.map(tp) as [Vec2, Vec2];
  const m = tp(gap.point);
  // A pad either side of the hinge, so the ghost reads as an LED crossing it rather than lying along it.
  // Each is a zero-length line with a round cap and a non-scaling stroke: a dot the stylesheet sizes in
  // screen pixels, which a circle's radius — in pattern units — cannot be.
  // Set off across the hinge by a twentieth of its length.
  const pad = (s: number) => {
    const x = m.x - (q.y - p.y) * 0.05 * s, y = m.y + (q.x - p.x) * 0.05 * s;
    return `<line class="el-fold-hover-pad" x1="${x}" y1="${y}" x2="${x}" y2="${y}" vector-effect="non-scaling-stroke" />`;
  };
  return `<g class="el-fold-hover">` +
    `<line class="el-fold-hover-hinge" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" ` +
    `vector-effect="non-scaling-stroke" />${pad(1)}${pad(-1)}</g>`;
}

/** What a tap that seats nothing on a fold says, and the control that would have placed it (#58). */
export function missedFold(what: string): string {
  return `Tap closer to a fold to place ${what}, or set Parts go to 'on a tile'.`;
}
