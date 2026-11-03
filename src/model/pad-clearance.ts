/**
 * **Model** — how near a net's copper comes to metal it must not touch: the segment geometry the declared-net
 * router measures with, and the pads it keeps every net off unless it is landing on them.
 *
 * Split out of `net-routing.ts`, which reads all of this and owns none of the rules about which net goes
 * where. Pure functions of their arguments, no state.
 */
import type { Vec2 } from "./electronics.js";
import { MIN_LAND_FRAC } from "./tape-width.js";
import type { NetPoint, PadObstacle } from "./netlist.js";
import type { PadField } from "./trace-types.js";

/**
 * Where two segments come closest, and how close — the distance plus both parameters.
 *
 * **Replaces a `min` over four point-to-segment projections, which was wrong for segments that cross.**
 * That identity holds only for *disjoint* segments: measured, `(-10,0)-(10,0)` against `(0,-10)-(0,10)`
 * came back as **10** where the true distance is **0**. So the clearance gate this module's header calls
 * the one thing standing between the router and a short could pass a genuine crossing whenever both
 * segments were long relative to the crossing angle.
 *
 * `t` and `u` are what let the caller read each run's width *at the closest approach* rather than taking
 * the widest point of a whole segment — which matters: a leg out of a chip's pin runs from pad width to
 * tape width in one segment, and the conservative reading would refuse every such leg on the tape width it
 * only reaches once it is clear of the part.
 */
export function nearestOn(
  p: Vec2, q: Vec2, r: Vec2, s: Vec2,
): { d: number; t: number; u: number } {
  const dx = q.x - p.x, dy = q.y - p.y;
  const ex = s.x - r.x, ey = s.y - r.y;
  const fx = p.x - r.x, fy = p.y - r.y;
  const a = dx * dx + dy * dy, b = dx * ex + dy * ey, c = ex * ex + ey * ey;
  const d = dx * fx + dy * fy, e = ex * fx + ey * fy;
  const den = a * c - b * b;

  let t: number, u: number;
  if (den > 1e-18) {
    // Not parallel: the unconstrained closest approach, then clamped back onto both segments.
    t = Math.max(0, Math.min(1, (b * e - c * d) / den));
    u = Math.max(0, Math.min(1, (a * e - b * d) / den));
    // Clamping `t` can move the true closest point on the other segment, so `u` is re-solved against the
    // clamped `t` and re-clamped. Without this a near-parallel pair reads its distance at the wrong place.
    u = c > 1e-18 ? Math.max(0, Math.min(1, (b * t + e) / c)) : 0;
    t = a > 1e-18 ? Math.max(0, Math.min(1, (b * u - d) / a)) : 0;
  } else {
    // Parallel or degenerate: no unique solution, so project all four endpoints and keep the nearest
    // pairing. All four, because the facing ends can be either segment's first or last point.
    const at = (tt: number, uu: number): number =>
      Math.hypot(p.x + dx * tt - (r.x + ex * uu), p.y + dy * tt - (r.y + ey * uu));
    const onRs = (tt: number): number => (c > 1e-18 ? Math.max(0, Math.min(1, (e + b * tt) / c)) : 0);
    const onPq = (uu: number): number => (a > 1e-18 ? Math.max(0, Math.min(1, (b * uu - d) / a)) : 0);
    t = 0;
    u = onRs(0);
    for (const [tt, uu] of [[1, onRs(1)], [onPq(0), 0], [onPq(1), 1]] as [number, number][]) {
      if (at(tt, uu) < at(t, u)) { t = tt; u = uu; }
    }
  }
  return {
    d: Math.hypot(p.x + dx * t - (r.x + ex * u), p.y + dy * t - (r.y + ey * u)),
    t,
    u,
  };
}

/** The distance alone — {@link nearestOn} for callers that do not care where. */
function segSegDist(p: Vec2, q: Vec2, r: Vec2, s: Vec2): number {
  return nearestOn(p, q, r, s).d;
}

/**
 * The nearest distance from the segment `a`-`b` to a closed polygon; 0 if the segment is inside it.
 *
 * Edge to edge, not centre to centre: a pad is a rectangle with a long axis, and a circle round its centre
 * either lets copper onto the ends of it or refuses copper that had room beside it, depending on which
 * radius you pick. Pads here run from a 0603's 0.8mm to a terminal block's 4mm, so that choice is worth up
 * to a pad's own length.
 */
function segToPoly(a: Vec2, b: Vec2, poly: Vec2[]): number {
  if (poly.length < 2) return Infinity;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    d = Math.min(d, segSegDist(a, b, p, q));
    if (d === 0) return 0;
  }
  // A segment lying wholly inside the pad touches none of its edges, and every distance above is to the
  // rim. Winding on either endpoint catches it.
  return inPoly(a, poly) || inPoly(b, poly) ? 0 : d;
}

/** Whether a point is inside a closed polygon, by the crossing rule. */
function inPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether this pad is, electrically, one of `mine` — its net, or a duplicate on the same part sitting on one
 * of my own pads.
 *
 * The second case is not a nicety. `footprint.ts` measured it on `SeeedStudio_XIAO_ESP32C3`: 37 terminals
 * of which 14 pairs are coincident, so pad `1_1` is the same piece of metal as pad `1`. Treated as foreign
 * it refuses every leg to pad 1 — a net blocked from its own pad by a copy of it.
 */
function padIsMine(pad: PadObstacle, mine: string, own: NetPoint[]): boolean {
  if (pad.net === mine) return true;
  // Same part only. Another part's pad over one of mine is a different piece of metal on another net, and
  // letting it through shorts two overlapping parts without a word.
  return own.some((q) => q.part === pad.part && segToPoly(q.at, q.at, pad.outline) < 1e-9);
}

/**
 * The pad this leg would run over, or `null` if it clears them all — KiCad's clearance, in one test.
 *
 * A net's own pads are let through: its legs land on them, so measured against them every leg is a
 * violation. Every other pad is metal that must not be touched — another net's, which shorts two nets
 * together, and an **unwired** one, which shorts into a part nobody wired and is the case that had nothing
 * at all refusing it.
 *
 * The margin is the copper's own half-width where it passes, plus `net-routing.ts › PAD_CLEARANCE_MM`. Widths
 * are read per segment because a leg squeezing between two pins is far narrower there than the tape — see
 * {@link padCapAt}, which is what makes that squeeze possible rather than merely permitted.
 */
export function padHitBy(
  a: Vec2, b: Vec2, pads: ForeignPad[], gap: number, wa: number, wb: number,
): PadObstacle | null {
  const reach = Math.max(wa, wb) / 2 + gap;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  for (const f of pads) {
    if (Math.max(f.x0 - x1, x0 - f.x1, f.y0 - y1, y0 - f.y1) >= reach) continue;
    if (segToPoly(a, b, f.pad.outline) < reach) return f.pad;
  }
  return null;
}

/**
 * A pad that is not this net's, with its bounding box.
 *
 * Both pad tests run per densified point against every pad, and most pads are nowhere near. The box gap
 * never exceeds the outline distance, so a pad whose box is out of reach is skipped without changing the
 * answer. Filtering out the net's own pads once per net, rather than per point, saves the rest.
 */
export interface ForeignPad { pad: PadObstacle; x0: number; y0: number; x1: number; y1: number }

export function foreignPads(pads: PadObstacle[], mine: string, own: NetPoint[]): ForeignPad[] {
  return pads.filter((pad) => !padIsMine(pad, mine, own)).map((pad) => {
    const xs = pad.outline.map((q) => q.x), ys = pad.outline.map((q) => q.y);
    return { pad, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
}

/**
 * The widest copper may be at `p` before it touches a pad that is not this net's.
 *
 * **This is what makes pad clearance affordable.** The gate above refuses a leg whose copper overlaps a
 * foreign pad; on its own that is expensive, because the tape is 3.25mm and an SMD part's pads are 2mm
 * apart — a leg reaching one pin of a chip is wider than the room beside its neighbour, so it is refused
 * and the terminal is reported stranded. Measured over four patterns and five parts before this existed:
 * 29 terminals of 80 stranded, against 21 with no pad gate at all.
 *
 * So the leg is narrowed to fit instead. `2 · (room − clearance)` is the width whose edge lands exactly a
 * clearance short of the nearest foreign pad, which is the same shape of rule `landingWidthFor` already
 * applies for a part's own pitch — and the floor is that function's floor, so copper never pinches to
 * something too thin to carry or to cut. Below the floor there is genuinely no room and the gate refuses.
 */
export function padCapAt(p: Vec2, pads: ForeignPad[], gap: number, tapeW: number): number {
  // Room past half a tape beyond the clearance leaves the copper at full width, so nothing farther counts.
  const far = gap + tapeW / 2;
  let room = Infinity;
  for (const f of pads) {
    if (Math.max(f.x0 - p.x, p.x - f.x1, f.y0 - p.y, p.y - f.y1) >= Math.min(room, far)) continue;
    room = Math.min(room, segToPoly(p, p, f.pad.outline));
    if (room <= gap) break;
  }
  if (!Number.isFinite(room)) return tapeW;
  return Math.max(tapeW * MIN_LAND_FRAC, Math.min(tapeW, 2 * (room - gap)));
}

/**
 * The fields and foreign pads that can reach any of `pts`: a field within its `reach` of the points' box, a
 * pad whose box is nearer than `far`.
 *
 * Exact, not an approximation. A point's distance is never less than its box's, so whatever is dropped here
 * is something `narrowedTo` or {@link padCapAt} would skip at every point anyway. The comparisons are
 * negated so that a NaN keeps an entry, as those two would. Order is kept, so `padCapAt` still meets the
 * pads in the order it breaks on.
 */
export function nearLeg(
  pts: Vec2[], fields: PadField[], pads: ForeignPad[], far: number,
): { fields: PadField[]; pads: ForeignPad[] } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const boxGap = (fx0: number, fy0: number, fx1: number, fy1: number): number =>
    Math.max(fx0 - x1, x0 - fx1, fy0 - y1, y0 - fy1, 0);
  return {
    fields: fields.filter((f) => !(boxGap(f.at.x, f.at.y, f.at.x, f.at.y) > f.reach)),
    pads: pads.filter((f) => !(boxGap(f.x0, f.y0, f.x1, f.y1) >= far)),
  };
}
