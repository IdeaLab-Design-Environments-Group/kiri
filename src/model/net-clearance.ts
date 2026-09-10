/**
 * **Model** — the clearance gate: how near two pieces of copper, or copper and a pad, may come.
 *
 * ## Why this is its own file
 *
 * `net-routing.ts` says in its own header that every stranded terminal comes from {@link clearOf} — the
 * whole-path test after a route is chosen — and that this is the one thing standing between the router and
 * a short. That makes it the most read part of the router and the part least about routing: it is plane
 * geometry plus a rule about widths, and it plans nothing.
 *
 * Kept apart so the rule can be read, tested and changed without the tree search around it, and so the leg
 * layer (`net-legs.ts`) and the router itself ask the same question of exactly the same code.
 *
 * ## What is here
 *
 * {@link nearestOn} and {@link ptSegDist} are the plane geometry. {@link gapNeeded} is the rule — how far
 * apart two centrelines must be given each run's width where they meet — and {@link weedFloorFor} the
 * substrate floor under it. {@link hitBy} applies both to a leg against every run already laid, and
 * {@link clearOf} and {@link blamedFor} are its two readings: *whether* and *whose fault*.
 * {@link padHitBy} and {@link padCapAt} are the same question asked of pads rather than runs.
 *
 * Widths come from `tape-width.ts` and are never re-derived here.
 */
import type { Vec2 } from "./electronics.js";
import { MIN_LAND_FRAC, weedGapFor } from "./tape-width.js";
import { minWebMm, type SheetSpec } from "./fold-strain.js";
import type { PadObstacle } from "./netlist.js";

/** Distance between two segments, in the plane. */
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
function nearestOn(
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
    // Parallel or degenerate: no unique solution, so project each endpoint and keep the nearest pairing.
    t = 0;
    u = c > 1e-18 ? Math.max(0, Math.min(1, e / c)) : 0;
    const alt = a > 1e-18 ? Math.max(0, Math.min(1, -d / a)) : 0;
    const at = (tt: number, uu: number): number =>
      Math.hypot(p.x + dx * tt - (r.x + ex * uu), p.y + dy * tt - (r.y + ey * uu));
    if (at(alt, 0) < at(t, u)) { t = alt; u = 0; }
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
 * Is the leg `a`-`b` clear of every polyline in `lines`, by at least `min`?
 *
 * Clearance, not merely non-crossing, and the difference is the whole condition. Two runs can approach to
 * nothing and never *cross*: they meet at a point, or run alongside each other, and a segment-intersection
 * test reports both as fine. Laid as tape they are one piece of copper. Measured on the first version of
 * this router, two nets that crossed nowhere came to a centreline distance of 0.0000 against a 0.0997 tape
 * — a dead short that a crossing count could not see.
 *
 * `min` is a whole tape width: each strip reaches half a width either side of its centreline, so centres a
 * width apart are two strips just touching, and anything less is overlap.
 */
export function clearOf(
  a: Vec2, b: Vec2, lines: Laid[], weed: number, wa: number, wb: number, full: number,
): boolean {
  return hitBy(a, b, lines, weed, wa, wb, full) === null;
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
 * Whether this pad is, electrically, one of `mine` — its net, or a duplicate sitting on one of my own pads.
 *
 * The second case is not a nicety. `footprint.ts` measured it on `SeeedStudio_XIAO_ESP32C3`: 37 terminals
 * of which 14 pairs are coincident, so pad `1_1` is the same piece of metal as pad `1`. Treated as foreign
 * it refuses every leg to pad 1 — a net blocked from its own pad by a copy of it.
 */
function padIsMine(pad: PadObstacle, mine: string, own: Vec2[]): boolean {
  if (pad.net === mine) return true;
  return own.some((q) => segToPoly(q, q, pad.outline) < 1e-9);
}

/**
 * The pad this leg would run over, or `null` if it clears them all — KiCad's clearance, in one test.
 *
 * A net's own pads are let through: its legs land on them, so measured against them every leg is a
 * violation. Every other pad is metal that must not be touched — another net's, which shorts two nets
 * together, and an **unwired** one, which shorts into a part nobody wired and is the case that had nothing
 * at all refusing it.
 *
 * The margin is the copper's own half-width where it passes, plus {@link PAD_CLEARANCE_MM}. Widths are read
 * per segment because a leg squeezing between two pins is far narrower there than the tape — see
 * {@link padCapAt}, which is what makes that squeeze possible rather than merely permitted.
 */
export function padHitBy(
  a: Vec2, b: Vec2, pads: PadObstacle[], mine: string, gap: number, wa: number, wb: number,
  own: Vec2[] = [],
): PadObstacle | null {
  for (const pad of pads) {
    if (padIsMine(pad, mine, own)) continue;
    if (segToPoly(a, b, pad.outline) < Math.max(wa, wb) / 2 + gap) return pad;
  }
  return null;
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
export function padCapAt(
  p: Vec2, pads: PadObstacle[], mine: string, gap: number, tapeW: number, own: Vec2[],
): number {
  let room = Infinity;
  for (const pad of pads) {
    if (padIsMine(pad, mine, own)) continue;
    room = Math.min(room, segToPoly(p, p, pad.outline));
    if (room <= gap) break;
  }
  if (!Number.isFinite(room)) return tapeW;
  return Math.max(tapeW * MIN_LAND_FRAC, Math.min(tapeW, 2 * (room - gap)));
}

/** Copper already on the sheet, and whose it is. `null` for the bus and for hand-drawn wire — immovable,
 *  so there is nothing to blame and nothing that could be routed later instead. */
export interface Laid {
  net: string | null;
  pts: Vec2[];
  /**
   * This run's width at each of its points, index-aligned with `pts`.
   *
   * Absent means full tape width everywhere, which is what every run was assumed to be before the gate
   * could read a width at all.
   */
  widths?: number[];
  /**
   * The net this run is a bus rail for, when it is one.
   *
   * Separate from `net`, which is about blame: a rail cannot be routed later and so can never be blamed,
   * but a declared net that shares its id may TAP it — see {@link tapPoint}. So the id is carried here,
   * where the clearance gate reads it to know which run is the net's own copper, and `net` stays null.
   */
  rail?: string;
}

/**
 * Which net's copper the leg `a`-`b` comes too close to, or null when it is clear of all of them.
 *
 * The same test {@link clearOf} makes, reporting *who* rather than *whether*. Nothing used to record that,
 * and without it a stranded terminal is a dead end: the router knows a net could not be reached and has no
 * idea which net to route later so that it could be. See {@link planNets}.
 */
export function blamedFor(
  a: Vec2, b: Vec2, lines: Laid[], weed: number, wa: number, wb: number, full: number,
): string | null {
  return hitBy(a, b, lines, weed, wa, wb, full)?.net ?? null;
}

/**
 * The run the leg `a`-`b` comes too close to, or null when it is clear of all of them.
 *
 * **The one reading of the distance, and it has to be separate from {@link blamedFor}.** That function
 * used to be it, returning `line.net` on a hit and `null` when clear — and `null` is also what a hit on
 * immovable copper returns, because the bus and a hand-drawn wire have no net to blame. So `clearOf`,
 * defined as `blamedFor(...) === null`, read "blocked by something unblamable" as "clear" and let it
 * through. Measured: a wall laid exactly along a route the router had just chosen did not move it by a
 * millimetre — the obstacle list the header calls the no-overlap guarantee was inert for every entry that
 * had no net, which is every entry it is ever given.
 *
 * Whether a leg is clear and whose fault it is if not are two questions. They are answered here once, and
 * the two callers read the answer differently.
 */
function hitBy(
  a: Vec2, b: Vec2, lines: Laid[], weed: number,
  /** The probe leg's own widths, index-aligned with the leg it came from — see {@link widthAt}. */
  wa: number, wb: number,
  /** Full tape width, for a run that carries no widths of its own. */
  full: number,
): Laid | null {
  for (const line of lines) {
    for (let i = 1; i < line.pts.length; i++) {
      const near = nearestOn(a, b, line.pts[i - 1]!, line.pts[i]!);
      // Each run's width AT THE CLOSEST APPROACH, not the widest point of either segment. A leg out of a
      // chip's pin runs from pad width to tape width in a single segment, so the conservative reading takes
      // the tape width and refuses every such leg — which is the bug this whole change exists to fix.
      const mine = wa + (wb - wa) * near.t;
      const theirs = widthAt(line.widths, i, near.u, full);
      if (near.d < gapNeeded(mine, theirs, weed)) return line;
    }
  }
  return null;
}

/**
 * The narrowest web of bare substrate the sheet can be weeded to, in pattern units.
 *
 * What is left between two runs is a beam of substrate lifted out with tweezers, and its tear strength goes
 * with its cross-section: halve the thickness and the same web tears at half the pull. {@link minWebMm} is
 * that floor, and on a thin film — around 0.15mm, where the web wants more than 3.25mm — it is what holds
 * the nets apart.
 *
 * **This used to return `max(tapeW, webUnits)` and be the whole clearance rule.** That constant was the
 * bug: it held every pair of runs a full tape width apart no matter how narrow either of them actually
 * was, so two legs tapering onto adjacent pins of a 2.54mm-pitch part could never both be laid, whatever
 * their widths. The width half of the question now lives in {@link gapNeeded}, and this supplies only the
 * floor — which is why the `max(tapeW, ...)` is gone from here rather than merely moved: `gapNeeded`
 * contributes the tape width itself whenever the runs are that wide.
 */
/**
 * How much bare sheet to keep between a run's edge and a pad it is not landing on, in millimetres.
 *
 * **KiCad's own default clearance**, and here for the same reason KiCad has it: the requirement is not "do
 * not overlap" but "do not overlap once everything has moved a little" — the tape is cut on one machine,
 * laid by hand, and the part soldered by eye.
 *
 * Deliberately NOT the weed floor that separates two runs (`weedFloorFor`). That floor is what the cutter
 * can weed out between two CUTS, and a pad is drawn, never cut — there is no web to lift there. Used as the
 * pad margin it costs reach for nothing: measured over four patterns and five parts, a weed's worth of
 * margin stranded 32 terminals of 80 where zero margin stranded 28.
 */
const PAD_CLEARANCE_MM = 0.2;

/** That clearance in this pattern's units. */
export function padClearanceFor(tapeW: number, tapeMm: number): number {
  return tapeMm > 0 ? (PAD_CLEARANCE_MM * tapeW) / tapeMm : 0;
}

export function weedFloorFor(tapeW: number, tapeMm: number, sheet: SheetSpec): number {
  if (!(tapeW > 0)) return tapeW;
  return weedGapFor(tapeW, tapeMm, sheet);
}

/**
 * How far apart the CENTRELINES of two runs must be, given how wide each of them is where they meet.
 *
 * `max((wA + wB) / 2, weed)`. The first term is the two runs just touching; the second is the substrate
 * floor, for a sheet so thin that the web wants more room than the copper does.
 *
 * **Bit-identical to the old constant for two full-width runs** — `(tapeW + tapeW) / 2` is `tapeW` — which
 * is what makes this a generalisation rather than a re-plan: every recorded reach figure survives untouched
 * and the rule only relaxes where copper is genuinely narrower than the tape. That property is worth
 * protecting; there is a test for it.
 *
 * **Known conservatism.** The strictly-correct rule is `(wA + wB) / 2 + weed` — two runs just touching
 * leave no web at all, and this permits that, exactly as the constant always did. The additive form is
 * stricter for *every* pair and would re-baseline reach on every pattern, which would hide a bug fix inside
 * a behaviour change. It is a separate decision, to be made with its own measurement.
 */
export function gapNeeded(wA: number, wB: number, weed: number): number {
  return Math.max((wA + wB) / 2, weed);
}

/** A run's width a fraction `t` along the segment ending at `i`, or `full` when it never said. */
function widthAt(widths: number[] | undefined, i: number, t: number, full: number): number {
  if (!widths || !widths.length) return full;
  const a = widths[i - 1] ?? widths[widths.length - 1] ?? full;
  const b = widths[i] ?? a;
  return a + (b - a) * t;
}

/** Distance from a point to a segment. */
export function ptSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
  return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t));
}
