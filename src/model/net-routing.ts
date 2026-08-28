/**
 * **Model** — routing a netlist: N named nets, each joining its own terminals, no two ever touching.
 *
 * This is a different problem from the one {@link planRoutes} solves, and it is worth being plain about why
 * rather than presenting this as a generalisation of it. The bus router is structurally two-net: a tour
 * visits the LED hinges and the two rails run down opposite *banks* of one shared spine, so "the other net"
 * is always exactly one net and is always on the other side. Neither idea survives a third net, so this
 * routes each net independently and keeps them apart by exclusion instead of by geometry.
 *
 * ## How it works
 *
 * Each net becomes a tree over the same corridor graph the bus router uses — face centres joined through
 * the crossing points on their shared edges — so copper stays on the material and travels along the tiling
 * rather than cutting a straight line over whatever lies between two pads.
 *
 * Nets are routed **one at a time, hardest first**, and a net that cannot be routed clear is **reported
 * unroutable** rather than crossed, because copper tape has no second layer to escape into and no via to
 * get there with.
 *
 * ## What actually holds the no-overlap condition — read this before designing a fix
 *
 * This paragraph used to say that every corridor node a net uses is "struck out of the graph" for the nets
 * after it, and that the exclusion is what makes overlap impossible. **That is not what the code does.**
 * `blocked` reaches {@link searchCorridor} and is used in exactly one place: `blocked.has(key) ?
 * OCCUPIED_TOLL : 1`, a **finite 500x toll**. A used node is expensive, never forbidden.
 *
 * Measured rather than argued: across 396 legs on six patterns, `searchCorridor` returned empty **zero
 * times even with every node in the graph tolled**. The `!mid.length` branch below cannot fire for want of
 * room — only for two faces genuinely disconnected across the material.
 *
 * So **every stranded terminal comes from the {@link clearOf} gate**, the whole-path clearance test after
 * a route is chosen. That is the one thing standing between this router and a short, and anyone who reads
 * the old sentence goes looking for the guarantee in the wrong place — and would "fix" reach by weakening
 * an exclusion that does not exist.
 *
 * ## What has already been tried
 *
 * **Ordering is exhausted.** Blame-directed reordering — promote the loser in front of whatever blocked it
 * — explores genuinely distinct orders and strands identically: 146 of 210 terminals reached with it and
 * without it over five patterns at two-to-five nets. An exhaustive sweep of all N! orderings reaches 191
 * of 252 against 189 for the four rotations shipped here. **Two terminals in 252 is the entire prize left
 * in ordering**, so branch-and-bound over permutations is exact rather than useful.
 *
 * **A large share of the failures are not routing failures at all.** The leg that collides is often the
 * **pad-exit** segment — `pts[0]` to `mid[0]` — and that segment is not an edge of the corridor graph: it
 * is synthesised here as `[a, ...mid, b]` after the search has finished. No amount of freeing the corridor
 * gives a pad a different way out of its own tile. The lever with real reach on those is moving the part a
 * millimetre, which is placement's business and not this file's.
 *
 * ## What this cannot do, honestly
 *
 * Some netlists are simply not planar. Three nets fully joining three parts is the classic case: no
 * arrangement of it fits on one side of one sheet. Ordering and retry move *which* net loses, never whether
 * one does. So the order search below is worth having and is not a fix — when it reports a net unroutable,
 * the answer is a jumper, a different placement, or a different circuit, and saying so is more use than
 * quietly crossing two nets and letting the short be discovered after the copper is laid.
 */
import type { FlatFace, GapEdge, Vec2 } from "./electronics.js";
import { pointInFace } from "./electronics.js";
import {
  FOLD_PENALTY_FRAC,
  MIN_LAND_FRAC,
  TAPE_MM,
  buildCorridor,
  patternDiag,
  ptKey,
  searchCorridor,
  narrowedTo,
  weedGapFor,
  type Corridor,
  type PadField,
  type Trace2D,
} from "./electronics-routing.js";
import { DEFAULT_SHEET, minWebMm, type SheetSpec } from "./fold-strain.js";
import type { NetPoint, PadObstacle, ResolvedNet } from "./netlist.js";

/** How a net fared. */
export interface RoutedNet {
  id: string;
  name: string;
  /** The copper laid for it. Empty when it could not be routed at all. */
  traces: Trace2D[];
  /**
   * Terminals this net failed to reach, as indices into its own `points`.
   *
   * Partial rather than all-or-nothing on purpose: a net that reaches four of its five pads is worth laying
   * and worth telling the user about, and throwing away the four helps nobody.
   */
  stranded: number[];
  /** Why, when anything was stranded. Written for a user. */
  why?: string;
  /**
   * How this net met the bus rail of the same id: `"none"` when there is no such rail, `"laid"` when the
   * tap leg reached it, `"failed"` when it could not be laid clear.
   *
   * Reported rather than folded into `stranded`, which is indices into `points` and has to stay that. A
   * failed tap strands nothing — every pad may well be joined to every other — and is still the difference
   * between a part that is powered and one that is not, so it needs to be sayable on its own.
   */
  railTap: "none" | "laid" | "failed";
  /**
   * The connections this net was supposed to make and did not — each as the two points a line should join.
   *
   * A ratsnest, in the PCB sense: what the netlist asked for, drawn where the copper is missing. Absent
   * when the net came out whole, so a circuit that routed carries none of this.
   *
   * **Computed here rather than in the view**, because `stranded` is indices into `ResolvedNet.points` and
   * the view holds only a {@link RoutedNet}. Handing the view the points instead would be a second copy of
   * the netlist to drift from — see `parts.ts › padRunBox` for what that costs.
   *
   * svg-pcb has the same idea written and then disabled behind `if (state.pcb && false)`; what it ships
   * instead is a nearest-neighbour ratsnest drawn from the declared netlist alone, which ignores the copper
   * and so never disappears as you route. These lines disappear, because they are derived from what was
   * actually laid.
   */
  ratsnest?: [Vec2, Vec2][];
}

export interface NetRouting {
  nets: RoutedNet[];
  /** Every net's copper, flattened — what the cut files and the canvas take. */
  traces: Trace2D[];
  /**
   * How many orderings were tried before this plan was kept.
   *
   * Diagnostic, and reported rather than inferred because the rip-up search is otherwise invisible: it
   * changes the answer on nothing measured so far (see {@link RIPUP_TRIES}), which means its effect
   * cannot be observed through the routes. A count that stops rising is how anyone finds out the search
   * has stopped running.
   */
  orders: number;
}

/** How many blind rotations of the hardest-first order to try before keeping the best. */
const MAX_ORDERS = 4;

/**
 * How many further orders the failures themselves may ask for — rip-up and reroute, bounded.
 *
 * **Measured, and it buys nothing.** Over five patterns at two to five nets — 210 terminals — the router
 * reaches 146 with these orders and 146 without them, and the extra orders are genuinely explored: on
 * `house` with three nets it tries five distinct orderings and every one strands the same two terminals;
 * on `akde-hex` with four it tries nine and lands between four and five every time.
 *
 * That is the answer to "would rip-up and reroute help here", and it is a real answer rather than a
 * guess: the residual failures are not ordering failures. On a single-sided sheet with no vias many
 * netlists are simply not planar, and no order of any length fixes one of those — reordering moves which
 * net loses, never whether one does.
 *
 * It is kept anyway, at a small bound, for two reasons. The search costs nothing on a circuit that routes
 * (the loop stops the moment nothing is stranded), and the blame it computes is what lets a stranded net
 * name the net that is in its way instead of saying only that something was.
 */
const RIPUP_TRIES = 6;

/**
 * The face a terminal sits on, or -1.
 *
 * A pad just outside every face — a part nudged over a tile edge — has no way into the corridor graph, so
 * it is stranded rather than snapped to the nearest tile. Snapping would move the user's part without
 * saying so, and the copper would then be laid to somewhere the part is not.
 */
function faceOfPoint(faces: FlatFace[], p: Vec2): number {
  return pointInFace(faces, p);
}

/**
 * Join one net's points into a tree, nearest-first.
 *
 * A minimum spanning tree on straight-line distance, which is a deliberate approximation: the true cost is
 * the corridor path, but computing it for every pair before choosing any is quadratic in pads and the
 * corridor search is the expensive part. Straight-line ordering picks nearly the same tree on the patterns
 * this app produces, where pads that are close on the sheet are close through the tiling too.
 */
function spanningEdges(points: NetPoint[]): [number, number][] {
  const inTree = [0];
  const out: [number, number][] = [];
  const rest = points.map((_, i) => i).slice(1);
  while (rest.length) {
    let best = Infinity, bi = 0, bj = 0;
    for (const i of inTree) {
      for (let k = 0; k < rest.length; k++) {
        const j = rest[k]!;
        const d = Math.hypot(points[i]!.at.x - points[j]!.at.x, points[i]!.at.y - points[j]!.at.y);
        if (d < best) { best = d; bi = i; bj = k; }
      }
    }
    const j = rest.splice(bj, 1)[0]!;
    out.push([bi, j]);
    inTree.push(j);
  }
  return out;
}

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
function clearOf(
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
function padHitBy(
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
function padCapAt(
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
interface Laid {
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
function blamedFor(
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
function padClearanceFor(tapeW: number, tapeMm: number): number {
  return tapeMm > 0 ? (PAD_CLEARANCE_MM * tapeW) / tapeMm : 0;
}

function weedFloorFor(tapeW: number, tapeMm: number, sheet: SheetSpec): number {
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
function gapNeeded(wA: number, wB: number, weed: number): number {
  return Math.max((wA + wB) / 2, weed);
}

/** A run's width a fraction `t` along the segment ending at `i`, or `full` when it never said. */
function widthAt(widths: number[] | undefined, i: number, t: number, full: number): number {
  if (!widths || !widths.length) return full;
  const a = widths[i - 1] ?? widths[widths.length - 1] ?? full;
  const b = widths[i] ?? a;
  return a + (b - a) * t;
}

/**
 * Where a net could tap the bus, nearest first.
 *
 * A declared net named PWR and the bus's PWR rail were kept apart on purpose — the conservative reading,
 * and it can never short — but it meant a part wired to declared PWR was not thereby joined to the
 * battery, and a lone pad on PWR got no copper at all. The tap is the join, and it is one leg: the rail is
 * already one connected run, so touching it anywhere joins the whole of it.
 *
 * **Anywhere, which is why this is a list and not a point.** The nearest point on the rail is usually the
 * wrong one: the two rails run down opposite banks of one shared spine and the bus pinches them together
 * where they meet an LED — on `house`, to 0.61 of a tape width — so a tap onto the near stretch of PWR
 * cannot be laid without lying on GND. Handed only the nearest anchor the router reports the tap
 * impossible, when a stretch of the same rail a little further along is in clear air. So every projection
 * of every pad onto every rail segment is a candidate, ordered by how much copper it would cost, and the
 * caller takes the first that routes clear.
 *
 * The anchor is the closest point on the segment, not the segment's nearest end: a tap into the middle of
 * a run is an ordinary T-junction in copper tape, and refusing it would send the leg the long way round.
 */
function tapCandidates(points: NetPoint[], rails: Vec2[][]): { from: number; at: Vec2 }[] {
  const out: { from: number; at: Vec2; d: number }[] = [];
  points.forEach((p, i) => {
    for (const line of rails) {
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1]!, b = line[k]!;
        const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((p.at.x - a.x) * dx + (p.at.y - a.y) * dy) / L)) : 0;
        const at = { x: a.x + t * dx, y: a.y + t * dy };
        out.push({ from: i, at, d: Math.hypot(p.at.x - at.x, p.at.y - at.y) });
      }
    }
  });
  // Nearest first, and ties broken on position so the same rail plans the same tap every time — a bus
  // whose runs arrived in a different order must not move the tap.
  out.sort((x, y) => x.d - y.d || x.at.x - y.at.x || x.at.y - y.at.y || x.from - y.from);
  return out.slice(0, TAP_TRIES).map(({ from, at }) => ({ from, at }));
}

/**
 * How many anchors on the rail to try before reporting the tap impossible.
 *
 * Each one is a corridor search, so this is the whole cost of the feature on a circuit where the first
 * anchor works — one search — and its worst case on one where none of them does. Twelve covers the case
 * this exists for: the near stretch of the rail is pinched against the other one and the clear stretch is
 * a few segments along.
 */
const TAP_TRIES = 12;

/** Every corridor node a polyline passes through, so the next net can be kept off them. */
function claim(pts: Vec2[], into: Set<string>): void {
  for (const p of pts) into.add(ptKey(p));
}

/**
 * A leg's width at each of its points, narrowed at either end that lands on a real pad rather than on a
 * tap point out on the rail.
 *
 * One point narrows, not several: `outlineStrip` draws a straight taper across whatever segment separates
 * two differently-sized points on its own, the same way the bus already narrows onto an LED's legs, so
 * there is nothing to interpolate here — only which end, if either, gets its pad's own width instead of
 * the tape's.
 *
 * Returns `undefined` when neither end narrows, so a leg with two bare `NetPoint`s (`padWidth` unset — the
 * shape every hand-built test fixture is) comes out with no `widths` at all and renders exactly as before.
 */
/**
 * Split any stretch of a leg that passes near a part, so its width can follow the metal instead of being
 * interpolated across a whole corridor hop.
 *
 * {@link legWidths} gives a width per POINT and `outlineStrip` tapers linearly between them, so the width
 * profile is only as good as the point spacing. A leg out of a chip's pin runs pad → corridor node, and a
 * corridor node is a face centre — millimetres away. Measured on the reported circuit: three points over
 * 24.96mm carrying 1.20mm, 3.03mm and 1.00mm, which `outlineStrip` drew as a wedge some 3mm wide across four
 * neighbouring pins. That is what "the wire goes to the closest pin" looked like on screen.
 *
 * No new constant decides where the taper ends: {@link narrowedTo} already returns the full tape width once a
 * point is past a field's `reach`, so densifying and asking it per point makes the profile follow the part's
 * own pitch. Only stretches actually near a field are split, so an ordinary leg between two bare pads is
 * untouched and still comes back with no `widths` at all.
 */
function densifyNearFields(pts: Vec2[], tapeW: number, fields: PadField[]): Vec2[] {
  if (!fields.length || pts.length < 2) return pts;
  const step = tapeW / 2;
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1]!, b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Only where it can matter: a segment whose closest approach to some field is beyond that field's reach
    // has one width along its whole length and nothing to interpolate.
    const near = fields.some((f) => ptSegDist(f.at, a, b) <= f.reach + tapeW);
    if (near && len > step) {
      // Capped, so a long leg across a crowded board cannot turn into thousands of points.
      const n = Math.min(Math.ceil(len / step), 64);
      for (let k = 1; k < n; k++) {
        out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      }
    }
    out.push(b);
  }
  return out;
}

/** Distance from a point to a segment. */
function ptSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
  return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t));
}

function legWidths(
  pts: Vec2[], tapeW: number, startPad?: number, endPad?: number,
  /** The metal near this leg — see `electronics-routing.ts › PadField`. */
  fields: PadField[] = [],
  /** Every foreign pad this leg has to squeeze past — see {@link padCapAt}. */
  cap?: (p: Vec2) => number,
): number[] | undefined {
  const start = startPad !== undefined && startPad < tapeW ? startPad : null;
  const end = endPad !== undefined && endPad < tapeW ? endPad : null;
  // Every point, not only the two ends. A pad's own field is centred on the pad, so an endpoint narrows
  // because it stands at distance zero from its own field, and an interior point still over the part
  // narrows for the same reason by the same rule — which collapses the old endpoint special case and the
  // "stay narrow while crossing the part" requirement into one thing rather than adding a second.
  //
  // It had to stop being an endpoint rule. `pts[1]` is a corridor node — a face centre, typically
  // millimetres away — so copper reached full tape width within a millimetre of a 1.6mm pin and blanketed
  // its neighbours. That is what "the wire goes to the closest pin" looks like on screen.
  // Two narrowings, and they answer different questions. `fields` is the part's OWN pitch — how wide copper
  // may be while standing over the part it is reaching for. `cap` is the room left by every pad this leg is
  // not landing on, which is what lets it thread between two pins instead of being refused for touching one.
  const ws = pts.map((p) => Math.min(narrowedTo(tapeW, p, fields), cap ? cap(p) : tapeW));
  if (start !== null) ws[0] = Math.min(ws[0] ?? tapeW, start);
  if (end !== null) ws[ws.length - 1] = Math.min(ws[ws.length - 1] ?? tapeW, end);
  // Nothing narrowed anywhere: no `widths` at all, so a leg between two ordinary pads renders exactly as it
  // always has and every reader of `Trace2D` that has never heard of `widths` keeps working.
  return ws.some((w) => w < tapeW) ? ws : undefined;
}

/**
 * The lines a ratsnest should draw for one net: each stranded terminal joined to where it belongs.
 *
 * To the nearest point on the net's OWN copper where the net laid any, because that is the connection the
 * author actually asked for and the shortest honest statement of what is missing. Where the net laid
 * nothing at all, to its nearest reached terminal instead — and where nothing was reached, to the nearest
 * other terminal of the net, so a net that failed completely still shows what it was meant to be.
 */
function ratsnestFor(net: ResolvedNet, stranded: number[], laid: Trace2D[]): [Vec2, Vec2][] {
  if (!stranded.length) return [];
  const ptSeg = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
    return { x: a.x + ax * t, y: a.y + ay * t };
  };
  const out: [Vec2, Vec2][] = [];
  const isStranded = new Set(stranded);
  for (const i of stranded) {
    const from = net.points[i]?.at;
    if (!from) continue;
    let best: Vec2 | null = null;
    let bestD = Infinity;
    const offer = (q: Vec2): void => {
      const d = Math.hypot(q.x - from.x, q.y - from.y);
      if (d > 1e-12 && d < bestD) { bestD = d; best = q; }
    };
    for (const t of laid) for (let k = 1; k < t.pts.length; k++) offer(ptSeg(from, t.pts[k - 1]!, t.pts[k]!));
    if (!best) {
      // Nothing laid for this net: fall back to a terminal, preferring one that was actually reached.
      net.points.forEach((p, j) => { if (j !== i && !isStranded.has(j)) offer(p.at); });
      if (!best) net.points.forEach((p, j) => { if (j !== i) offer(p.at); });
    }
    if (best) out.push([from, best]);
  }
  return out;
}

/** Route one net against a corridor, kept clear of `theirs` — every other net's copper laid so far. */
/** Everything a leg is judged against, gathered so `layLeg` takes one argument rather than nine. */
interface LegRules {
  others: Laid[];
  clearance: number;
  tapeW: number;
  fields: PadField[];
  pads: PadObstacle[];
  padGap: number;
  netId: string;
  /** This net's own pad centres — see {@link padIsMine}. */
  own: Vec2[];
  faces: FlatFace[];
}

/**
 * How far to the side a refused leg will step, and in how many tries.
 *
 * The corridor's only nodes are the midpoints of a face's own edges — one per edge — so inside a tile a leg
 * is a straight chord and the search has no way to go round anything. A pad on that chord is therefore not
 * something the search can avoid, and without this the leg is simply refused and its terminal reported
 * stranded. One bend, at increasing offsets either side of the straight approach, is enough for the case
 * this exists for: a leg arriving across the pins either side of the one it lands on, which needs to come
 * in from a clear direction rather than to find a winding path.
 */
const DETOUR_STEPS = 6;
const DETOUR_STEP_TAPES = 0.6;

/** Whether a whole path clears every other net AND every pad that is not this net's. */
function pathOk(
  pts: Vec2[], widths: number[] | undefined, r: LegRules,
): { ok: true } | { ok: false; cuts: string | null } {
  const wAt = (k: number): number => widths?.[k] ?? r.tapeW;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!;
    const cuts = blamedFor(a, b, r.others, r.clearance, wAt(k - 1), wAt(k), r.tapeW);
    if (cuts !== null || !clearOf(a, b, r.others, r.clearance, wAt(k - 1), wAt(k), r.tapeW)) {
      return { ok: false, cuts };
    }
    // And the pads, which the check above cannot see: it measures against other nets' RUNS.
    const over = padHitBy(a, b, r.pads, r.netId, r.padGap, wAt(k - 1), wAt(k), r.own);
    // Blame the net that owns the pad where there is one. An unwired pin belongs to nobody, and saying so
    // is more honest than naming whatever else its part is wired to.
    if (over) return { ok: false, cuts: over.net };
  }
  return { ok: true };
}

/**
 * Lay one leg from `a` to `b` through `mid`, narrowed to fit past the pads and bent aside if it still will
 * not go.
 *
 * The straight approach is tried first, so a leg with room takes the path it always did. Only a refused one
 * pays for the detours.
 */
function layLeg(
  a: Vec2, b: Vec2, mid: Vec2[],
  padWidthA: number | undefined, padWidthB: number | undefined,
  r: LegRules,
): { ok: true; pts: Vec2[]; widths?: number[] } | { ok: false; cuts: string | null } {
  const cap = (p: Vec2): number => padCapAt(p, r.pads, r.netId, r.padGap, r.tapeW, r.own);
  const build = (way: Vec2[]): { pts: Vec2[]; widths?: number[] } => {
    // Densified first, so the width profile follows the part's own pitch rather than being smeared across a
    // corridor hop — and so the gate judges exactly the copper the blade will cut.
    const pts = densifyNearFields([a, ...way, b], r.tapeW, r.fields);
    const widths = legWidths(pts, r.tapeW, padWidthA, padWidthB, r.fields, cap);
    return { pts, ...(widths ? { widths } : {}) };
  };

  const straight = build(mid);
  const first = pathOk(straight.pts, straight.widths, r);
  if (first.ok) return { ok: true, ...straight };

  // The last hop is the one that lands on the pad, so that is the one to bend: a waypoint offset square to
  // it brings the leg in from the side instead of straight down the row.
  const from = mid.length ? mid[mid.length - 1]! : a;
  const dx = b.x - from.x, dy = b.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L > 1e-9) {
    const px = -dy / L, py = dx / L;
    for (let step = 1; step <= DETOUR_STEPS; step++) {
      const off = step * DETOUR_STEP_TAPES * r.tapeW;
      for (const sign of [1, -1]) {
        const w = { x: from.x + dx / 2 + px * sign * off, y: from.y + dy / 2 + py * sign * off };
        // A waypoint off the material is no waypoint: copper cannot be laid where there is no sheet.
        if (faceOfPoint(r.faces, w) < 0) continue;
        const bent = build([...mid, w]);
        if (pathOk(bent.pts, bent.widths, r).ok) return { ok: true, ...bent };
      }
    }
  }
  return { ok: false, cuts: first.cuts };
}

function routeOne(
  net: ResolvedNet,
  faces: FlatFace[],
  c: Corridor,
  blocked: Set<string>,
  theirs: Laid[],
  clearance: number,
  /** Which net owns each already-claimed corridor node, so a search that fails for want of room can say
   *  whose room it was. */
  owner: Map<string, string>,
  /** The tape's own width, in pattern units — a leg's width everywhere it is not tapering onto a pad. */
  tapeW: number,
  /** The metal near these legs, so a run stays narrow for as long as it is over a part. */
  fields: PadField[],
  /** Every pad on the sheet, so a leg is neither laid across one nor left wider than the room beside it. */
  pads: PadObstacle[],
  /** How near a run's edge may come to a pad that is not its own — see {@link PAD_CLEARANCE_MM}. */
  padGap: number,
): {
  traces: Trace2D[];
  stranded: number[];
  used: Set<string>;
  /** The copper laid, WITH its widths — the same objects as `traces`, so the two cannot drift apart. */
  lines: Trace2D[];
  /** Nets that stood in the way of something this net could not reach, in the order blame was assigned. */
  blame: string[];
  /** Whether this net had a bus rail to tap, and whether the tap leg reached it. */
  tapped: "none" | "laid" | "failed";
} {
  const traces: Trace2D[] = [];
  const stranded: number[] = [];
  const used = new Set<string>();
  const lines: Trace2D[] = [];
  const blame: string[] = [];
  const accuse = (who: string | null): void => {
    if (who && who !== net.id && !blame.includes(who)) blame.push(who);
  };
  const faceOf = net.points.map((p) => faceOfPoint(faces, p.at));
  const own = net.points.map((p) => p.at);

  // This net's own bus rail is not an obstacle to it: the tap leg ENDS on that copper, so measured against
  // it every tap is a violation and no net could ever reach its rail. Every other rail stays in — a PWR tap
  // that came within a tape width of the GND rail is the short this gate exists to refuse.
  const mine = theirs.filter((l) => l.rail === net.id).map((l) => l.pts);
  const others = theirs.filter((l) => l.rail !== net.id);
  const rules: LegRules = { others, clearance, tapeW, fields, pads, padGap, netId: net.id, own, faces };

  // A pad that is not on the material at all can never be reached, and says so once rather than once per
  // tree edge that happens to touch it.
  faceOf.forEach((f, i) => { if (f < 0) stranded.push(i); });

  for (const [i, j] of spanningEdges(net.points)) {
    if (faceOf[i]! < 0 || faceOf[j]! < 0) { if (!stranded.includes(j)) stranded.push(j); continue; }
    const a = net.points[i]!.at, b = net.points[j]!.at;
    // `searchCorridor` plain: no crossing exclusion, no per-leg clearance test.
    //
    // Every one of its exclusion levers was tried against the alternative of simply routing and then
    // checking, and none of them earned a place. `strict` and the `theirs` polyline list refuse a leg that
    // *crosses* another net, which is the wrong predicate once the condition is clearance — a leg can cross
    // nothing and still run alongside at zero distance, and can be refused for crossing when it had room to
    // spare. Across four patterns at four net counts: strict reached 123 terminals, `theirs` 124, a `legOk`
    // clearance test 128, and nothing at all 128. All four gave an identical worst-case clearance of 1.041
    // tape widths, so none of them was buying safety either. The `legOk` test was the last to go: it cost
    // time and changed no outcome anywhere.
    //
    // What actually holds the guarantee is the whole-path check below. The `blocked` set passed here is a
    // 500x toll and not an exclusion — see the header — so it buys separation by making a used node dear,
    // not by making it impossible.
    const mid =
      faceOf[i] === faceOf[j]
        ? []
        : searchCorridor(c, faceOf[i]!, faceOf[j]!, blocked, new Map(), null, false, a, null, used, null);
    if (faceOf[i] !== faceOf[j] && !mid.length) {
      if (!stranded.includes(j)) stranded.push(j);
      // No route at all — which, per the header, means the two faces are disconnected across the material
      // rather than that the corridor was full: a tolled node is dear, never impassable, and no search in
      // 396 legs came back empty for want of room. Blame is still collected here for the disconnected
      // case, where it will find nobody and correctly accuse no one.
      const free = searchCorridor(c, faceOf[i]!, faceOf[j]!, new Set(), new Map(), null, false, a, null, used, null);
      for (const p of free) accuse(owner.get(ptKey(p)) ?? null);
      continue;
    }
    // The corridor search checks the legs it chooses between nodes, and the leg out of `a` through
    // `origin`/`legOk` — but the last hop, from the final waypoint onto pad `b`, is appended afterwards and
    // belongs to nobody's search. Left unchecked it is a crossing the guarantee would not have caught.
    // Densified first, so the width profile follows the part's own pitch rather than being smeared across a
    // corridor hop — and so the clearance gate below judges exactly the copper the blade will cut.
    const leg = layLeg(a, b, mid, net.points[i]!.padWidth, net.points[j]!.padWidth, rules);
    if (!leg.ok) {
      if (!stranded.includes(j)) stranded.push(j);
      accuse(leg.cuts);
      continue;
    }
    claim(leg.pts, used);
    const trace: Trace2D = { net: net.id, pts: leg.pts, ...(leg.widths ? { widths: leg.widths } : {}) };
    lines.push(trace);
    traces.push(trace);
  }

  // The tap. One more leg, from a pad onto the net's own rail — routed through the same corridor and held
  // to the same clearance as any other leg, so it is copper on the material and clear of every other net
  // rather than a straight line drawn to the nearest rail. Anchors are tried nearest first and the first
  // that lays clear is kept; see {@link tapCandidates} for why the nearest is so often not the one.
  const candidates = tapCandidates(net.points, mine);
  let tapped: "none" | "laid" | "failed" = candidates.length ? "failed" : "none";
  for (const tap of candidates) {
    const from = faceOf[tap.from]!;
    const onto = faceOfPoint(faces, tap.at);
    if (from < 0 || onto < 0) continue;
    const a = net.points[tap.from]!.at;
    const mid =
      from === onto
        ? []
        : searchCorridor(c, from, onto, blocked, new Map(), null, false, a, null, used, null);
    if (from !== onto && !mid.length) continue;
    // Only the pad end tapers — `tap.at` lands on the rail itself, which is already the tape's own width.
    const tapLeg = layLeg(a, tap.at, mid, net.points[tap.from]!.padWidth, undefined, rules);
    if (!tapLeg.ok) {
      accuse(tapLeg.cuts);
      continue;
    }
    const pts = tapLeg.pts, widths = tapLeg.widths;
    claim(pts, used);
    const trace: Trace2D = { net: net.id, pts, ...(widths ? { widths } : {}) };
    lines.push(trace);
    traces.push(trace);
    tapped = "laid";
    break;
  }
  return { traces, stranded, used, lines, blame, tapped };
}

/**
 * Route every net, keeping them all off each other.
 *
 * Nets are tried hardest-first — most terminals, then longest span — then a few rotations of that order are
 * tried and the best kept, scored on terminals stranded first and copper second. Order is the only lever
 * available: with overlap forbidden outright, the only question left is which net gets the room, and the
 * rotations are worth real terminals (six patterns, six net counts: 215 reached against 209 with a single
 * ordering).
 *
 * The hardest-first sort itself is NOT worth reach, and the obvious rationale for it — that a net with many
 * pads has the least freedom — did not survive being measured: it reached 214 where plain declaration order
 * reached 215, which is noise either way. It stays for a different and real reason. It makes the order
 * canonical, so a circuit routes the same whatever sequence its author happened to declare the nets in;
 * without it, renaming or re-adding a net silently re-plans the board.
 */
export function planNets(
  nets: ResolvedNet[],
  faces: FlatFace[],
  gaps: GapEdge[],
  tapeW: number,
  /**
   * Copper already on the sheet that no net may touch — the bus's runs, and any wire the author drew.
   *
   * This was written as an unexercised guard: no net routed between face centres on any bundled pattern
   * came within a tape width of the bus, so removing it changed no outcome that could be found. Hand-drawn
   * copper is what exercises it, exactly as suspected, because the author can put a wire anywhere —
   * including across the only corridor a net had. Measured on house with a fixed wall over the spine:
   * withheld, the net lays copper 0.36 tape widths from the wall, which is through it; passed, the net
   * reports its far terminal stranded and lays nothing near it.
   *
   * Worth being exact about what "avoid" means here, since it is not what the word suggests: on that case
   * the net does not detour, it **strands**. The wall sits across the only route, so honouring the
   * obstacle resolves as reporting honestly rather than as finding a way round.
   */
  obstacles: Vec2[][] = [],
  sheet: SheetSpec = DEFAULT_SHEET,
  /** The tape's width in mm, from the same call that produced `tapeW` — see `seatLed`. */
  tapeMm: number = TAPE_MM,
  /**
   * The bus's runs, tagged with the net each is a rail for.
   *
   * A net whose id matches one of these taps it — one extra leg onto the rail, which is what joins a part
   * wired to declared PWR to the battery. Passed here as well as in `obstacles` and not instead of it: a
   * rail is still copper every OTHER net has to stay clear of, and only its own net is let through.
   */
  rails: { net: string; pts: Vec2[]; widths?: number[] }[] = [],
  /**
   * The metal every part on this circuit has on the sheet — see `electronics-routing.ts › PadField`.
   *
   * A leg stays narrow for as long as it is standing over a part, and the clearance gate reads that same
   * narrowness, which is what lets two nets reach adjacent pins of a fine-pitch part. Empty means no part
   * geometry is known and every leg is planned at full tape width, exactly as before this existed.
   *
   * Appended, never inserted — see `planRoutes`. Every parameter here has a default, so an inserted one
   * silently receives the wrong argument at every existing call site.
   */
  fields: PadField[] = [],
  /**
   * Every pad on the sheet, as copper no other net may be laid across — see `netlist.ts › PadObstacle`.
   *
   * `fields` narrows a leg near the part it is reaching for; this refuses one that would run over a pad and
   * narrows it to the room beside every pad it merely passes. Two different questions, and until this
   * existed only the first was asked: a leg tapered to a hair still shorted a chip if it crossed one of its
   * pins, because the clearance gate measures against other nets' runs and a pad is not a run.
   *
   * Empty means no pad geometry is known and nothing is refused or narrowed on this ground, exactly as
   * before. Appended, never inserted — see `planRoutes`.
   */
  pads: PadObstacle[] = [],
): NetRouting {
  if (!nets.length) return { nets: [], traces: [], orders: 0 };
  const c = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, sheet, tapeMm);
  const clearance = weedFloorFor(tapeW, tapeMm, sheet);
  const padGap = padClearanceFor(tapeW, tapeMm);

  const span = (n: ResolvedNet): number => {
    const xs = n.points.map((p) => p.at.x), ys = n.points.map((p) => p.at.y);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const hardest = nets
    .map((n, i) => i)
    .sort((a, b) => nets[b]!.points.length - nets[a]!.points.length || span(nets[b]!) - span(nets[a]!));

  /** Route every net in this order, and report how it went. */
  const attempt = (order: number[]): {
    nets: RoutedNet[];
    stranded: number;
    copper: number;
    /** Per net index, the nets that stood in the way of what it could not reach. */
    blame: Map<number, string[]>;
  } => {
    const blocked = new Set<string>();
    // Which net claimed each node, so a failure can name the net that has the room rather than merely
    // reporting that there was none.
    const owner = new Map<string, string>();
    // Seeded with the immovable copper: the nets route around it, never through it. `null` for its net
    // because there is nobody to blame — the bus and the author's own wire do not move for a netlist.
    const laid: Laid[] = [
      ...obstacles.map((pts) => ({ net: null, pts })),
      // Rails carry their widths. They used to be handed over as bare polylines, so a net was held a full
      // tape width from a rail that is 1.14mm wide where it pinches at an LED — room the gate could have
      // given it for nothing.
      ...rails.map((r) => ({
        net: null,
        pts: r.pts,
        rail: r.net,
        ...(r.widths ? { widths: r.widths } : {}),
      })),
    ];
    const out: RoutedNet[] = new Array(nets.length);
    const blame = new Map<number, string[]>();
    let stranded = 0, copper = 0;
    for (const idx of order) {
      const n = nets[idx]!;
      const r = routeOne(n, faces, c, blocked, laid, clearance, owner, tapeW, fields, pads, padGap);
      for (const k of r.used) {
        blocked.add(k);
        if (!owner.has(k)) owner.set(k, n.id);
      }
      // The traces themselves, widths and all — not a second array of the same polylines without them.
      laid.push(...r.lines.map((t) => ({ net: n.id, pts: t.pts, ...(t.widths ? { widths: t.widths } : {}) })));
      // A failed tap scores as a stranded terminal, so an ordering that reaches the rail is preferred over
      // one that only joins the pads to each other. It is not pushed into `stranded` itself — see
      // {@link RoutedNet.railTap}.
      stranded += r.stranded.length + (r.tapped === "failed" ? 1 : 0);
      if (r.blame.length) blame.set(idx, r.blame);
      for (const t of r.traces) {
        for (let k = 1; k < t.pts.length; k++) {
          copper += Math.hypot(t.pts[k]!.x - t.pts[k - 1]!.x, t.pts[k]!.y - t.pts[k - 1]!.y);
        }
      }
      // Naming the net that was in the way, where one can be named. "Could not be reached" tells the
      // author that something is wrong; "N2 is in the way" tells them what to move. The blame is already
      // computed for the reordering below, so this costs nothing.
      const inTheWay = r.blame
        .map((id) => nets.find((x) => x.id === id)?.name)
        .filter((x): x is string => !!x);
      const tapWhy =
        r.tapped === "failed"
          ? `"${n.name}" could not be joined to the ${n.name} rail without crossing other copper. ` +
            `The pads on it are wired to each other but not to the battery: move the part, or bridge it ` +
            `to the rail by hand.`
          : "";
      const rats = ratsnestFor(n, r.stranded, r.lines);
      out[idx] = {
        id: n.id,
        name: n.name,
        traces: r.traces,
        stranded: r.stranded,
        railTap: r.tapped,
        ...(rats.length ? { ratsnest: rats } : {}),
        ...(tapWhy && !r.stranded.length ? { why: tapWhy } : {}),
        ...(r.stranded.length
          ? {
              why:
                `${r.stranded.length} of ${n.points.length} terminals on "${n.name}" could not be reached ` +
                (inTheWay.length
                  ? `without crossing ${inTheWay.length === 1 ? inTheWay[0] : inTheWay.join(" or ")}. `
                  : `without crossing another net. `) +
                `Copper tape is single-sided, so there is no layer to cross on: move a part, or bridge ` +
                `this net by hand.` + (tapWhy ? ` ${tapWhy}` : ""),
            }
          : {}),
      };
    }
    return { nets: out, stranded, copper, blame };
  };

  const better = (
    a: { stranded: number; copper: number },
    b: { stranded: number; copper: number } | null,
  ): boolean => !b || a.stranded < b.stranded || (a.stranded === b.stranded && a.copper < b.copper);

  /**
   * Move `victim` in front of `blocker`, which is what ripping a net up amounts to here.
   *
   * Worth being exact, because it is the whole reason this router has no separate rip-up loop: a net's
   * route depends only on **which nets were routed before it**, since every earlier net's nodes are struck
   * out and its copper is an obstacle. So tearing out the blocker and laying it again after the victim
   * gives precisely the same result as routing the victim first — the two are the same operation, and the
   * ordering is the cheaper way to say it.
   */
  const promote = (order: number[], victim: number, blocker: number): number[] => {
    const rest = order.filter((i) => i !== victim);
    const at = rest.indexOf(blocker);
    return [...rest.slice(0, at), victim, ...rest.slice(at)];
  };

  const byId = new Map(nets.map((n, i) => [n.id, i]));
  const seen = new Set<string>();
  let best: { nets: RoutedNet[]; stranded: number; copper: number } | null = null;
  let queue: number[][] = [];
  for (let rot = 0; rot < Math.min(MAX_ORDERS, hardest.length); rot++) {
    queue.push([...hardest.slice(rot), ...hardest.slice(0, rot)]);
  }

  // The blind rotations first, then orders the failures themselves ask for. `RIPUP_TRIES` bounds the
  // second kind: each one is a full re-route of every net, and the measured return falls away quickly.
  for (let tries = 0; queue.length && tries < MAX_ORDERS + RIPUP_TRIES; tries++) {
    const order = queue.shift()!;
    const key = order.join(",");
    if (seen.has(key)) continue; // an order already tried cannot give a different answer — this is the
    seen.add(key);               // whole of the cycle prevention, and it is enough because the routing
                                 // is deterministic in the order alone.
    const got = attempt(order);
    if (better(got, best)) best = got;
    if (got.stranded === 0) break; // nothing left for another order to improve

    // Rip-up, as a reordering. Take the net that lost the most and put it in front of whatever was in its
    // way; if that net has several blockers, try each. Deterministic throughout — the victim is the
    // lowest-indexed of those that lost the most, and the blockers are tried in the order blame was
    // assigned — so the same circuit re-plans identically.
    let worst = -1, lost = 0;
    for (const [idx, list] of got.blame) {
      const n = got.nets[idx]?.stranded.length ?? 0;
      if (list.length && (n > lost || (n === lost && worst >= 0 && idx < worst))) { worst = idx; lost = n; }
    }
    if (worst < 0) continue;
    for (const who of got.blame.get(worst)!) {
      const blocker = byId.get(who);
      if (blocker === undefined || blocker === worst) continue;
      const next = promote(order, worst, blocker);
      if (!seen.has(next.join(","))) queue.push(next);
    }
  }
  const chosen = best!.nets;
  return { nets: chosen, traces: chosen.flatMap((n) => n.traces), orders: seen.size };
}
