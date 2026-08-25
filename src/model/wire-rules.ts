/**
 * **Model** — whether a hand-drawn wire can actually be built.
 *
 * The router plans copper it knows is buildable, because it only ever lays copper its own scoring accepts.
 * A hand-drawn wire has no such guarantee: the author drew it, and it may run off the sheet, across a chip,
 * over the other rail, or through a mountain fold. This is the reading that says so, and says *where*.
 *
 * Every check here is a **delta**. The routed circuit already carries faults of its own — over a fifth of
 * copper length overlapping on some patterns, six to twelve chips with copper under them (see
 * {@link countUnderLed}) — and none of that is the author's wire's doing. So each predicate is computed on
 * the circuit as routed and again with the wire added, and only the difference is reported. A wire drawn
 * across a chip that already had copper under it adds nothing and is not blamed for it.
 *
 * Faults split into two severities and the split is **total**: every {@link WireFaultKind} is in exactly one
 * of {@link ERRORS} and {@link WARNINGS}, which a test asserts over the whole union so that adding a kind
 * without a severity fails rather than defaulting to harmless.
 *
 * Units are **flat pattern units** throughout, like {@link Trace2D.pts} — never millimetres. The one
 * physical constant used here, {@link MIN_WEED_MM}, is in millimetres by its own explicit statement, and is
 * converted on the way in by {@link toFlat}. Mixing the two yields a tolerance wrong by the pattern's scale
 * factor, which on these patterns is a factor of thirty.
 */
import { pointInFace, type FlatFace, type GapEdge, type Vec2 } from "./electronics.js";
import {
  MIN_WEED_MM,
  batteryTerminals,
  countAcuteJoins,
  countNetCrossings,
  countOverLed,
  countUnderLed,
  countUnderTerminal,
  overlapLength,
  patternDiag,
  segsCross,
  seamCrossing,
  tapeOnBody,
  type PadPair,
  type RoutedCircuit,
  type Trace2D,
} from "./electronics-routing.js";
import { toFlat, type WireContext } from "./manual-wire.js";

/**
 * What can be wrong with a hand-drawn wire.
 *
 * The first four are errors — the wire cannot be made, or makes something else not work. The last four are
 * warnings: the wire can be built, and building it costs something the author should know about.
 */
export type WireFaultKind =
  | "off-body" | "spans-cut" | "over-led" | "crosses-net" | "too-close"  // errors: not buildable
  | "unweedable" | "fold-fatigue" | "acute-join" | "dangling";           // warnings: allowed, costly

/** One thing wrong with one wire, and the point on the pattern to show the author. */
export interface WireFault {
  kind: WireFaultKind;
  /** Where on the flat pattern, in pattern units. */
  at: Vec2;
  /** One sentence, in the author's terms, saying what is wrong. */
  why: string;
  /** The other net involved, where the fault is a fault about two nets meeting. */
  net?: string;
  /** Index into `circuit.leds`, where the fault is about one chip. */
  led?: number;
}

/** Faults that make the wire unbuildable. A circuit carrying one of these must not be cut. */
export const ERRORS: ReadonlySet<WireFaultKind> = new Set<WireFaultKind>([
  "off-body", "spans-cut", "over-led", "crosses-net", "too-close",
]);

/** Faults that are buildable but cost something — a weaker sheet, a harder weed, a shorter fold life. */
export const WARNINGS: ReadonlySet<WireFaultKind> = new Set<WireFaultKind>([
  "unweedable", "fold-fatigue", "acute-join", "dangling",
]);

/**
 * Every kind there is, so the severity split can be checked for being total rather than assumed.
 *
 * Written out rather than derived from the two sets, which would make the check circular: a kind missing
 * from both sets has to be missing from the union too, or the test proves nothing.
 */
export const ALL_WIRE_FAULT_KINDS: readonly WireFaultKind[] = [
  "off-body", "spans-cut", "over-led", "crosses-net", "too-close",
  "unweedable", "fold-fatigue", "acute-join", "dangling",
];

/** Whether this wire can be built: no {@link ERRORS} among its faults. Warnings do not block. */
export function isBuildable(faults: WireFault[]): boolean {
  return !faults.some((f) => ERRORS.has(f.kind));
}

/** A valley folded past this many degrees closes on itself and can short across — `buildCorridor`'s test. */
const STEEP_VALLEY_DEG = 170;

/** Below this angle between two strips leaving a point, the wedge of substrate between them tears. */
const MIN_JOIN_ANGLE = Math.PI / 6;

/**
 * Everything wrong with `t`, laid on the pattern `ctx` describes alongside the copper in `routed`.
 *
 * `t` is the wire already resolved to copper — {@link resolveWire} has run, dangling vertices are gone, and
 * what arrives here is a polyline in pattern units carrying a net name. An unnamed wire arrives carrying
 * its own id as its net, which makes it distinct from every other net, so every predicate keyed on net
 * inequality — crossings and overlap both — treats it as copper that must not touch anything. That is what
 * an unnamed hand wire is, and it is the reason the same geometry can be clean as `pwr` and faulty unnamed.
 */
export function checkWire(t: Trace2D, ctx: WireContext, routed: RoutedCircuit): WireFault[] {
  const faults: WireFault[] = [];
  if (t.pts.length < 2) return faults;

  const tapeW = t.width ?? ctx.tapeW;
  const before = routed.traces;
  const after = [...routed.traces, t];

  offBody(t, ctx, tapeW, faults);
  overLed(t, ctx, routed, before, after, faults);
  crossesNet(t, ctx, before, faults);
  proximity(t, ctx, before, after, faults);
  foldFatigue(t, ctx, faults);
  acuteJoins(t, before, after, faults);
  dangling(t, ctx, routed, faults);

  return faults;
}

/**
 * Copper with nothing under it: off the edge of the sheet, or across a cut.
 *
 * {@link tapeOnBody} and not a centreline test, which is the whole point: tape has width, so a wire tracking
 * a boundary keeps its centre on the material while half the strip hangs off it. A centreline reading passes
 * that wire, and the copper is off the sheet regardless of what the reading said.
 *
 * **Two faults, because they are two different things to go and look at.** `tapeOnBody` refuses both, so
 * this reported `off-body` for both until an unopened cut turned up on a real pattern. Sending an author to
 * hunt along the boundary for a wire lying well inside the sheet, across a slit, is worse than saying
 * nothing: the message names a place the problem is not. {@link seamCrossing} separates them.
 *
 * The point comes from `seamCrossing` and not from {@link firstOffBody} for a reason worth keeping: on an
 * unopened cut there is material on BOTH sides, so a sampler looking for somewhere off the sheet finds
 * nothing, and any point it named would be one it had not derived.
 */
function offBody(t: Trace2D, ctx: WireContext, tapeW: number, out: WireFault[]): void {
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1]!, b = t.pts[i]!;
    if (tapeOnBody(ctx.faces, tapeW, a, b)) continue;
    // Ahead of the boundary reading, because a wire can do both at once and the cut is the more specific
    // statement: a strip that spans a slit AND runs off the far edge is still, first, spanning a slit.
    const seam = seamCrossing(ctx.faces, a, b);
    out.push(seam
      ? {
        kind: "spans-cut",
        at: seam,
        why: "the wire spans a cut — the material is severed along this line, so the tape is bridging a hole",
      }
      : {
        kind: "off-body",
        at: firstOffBody(ctx.faces, tapeW, a, b),
        why: "the wire runs off the edge of the sheet — at this width part of the tape has no material under it",
      });
  }
}

/**
 * The point on `ab` where the strip first leaves the material.
 *
 * Sampled the same way {@link tapeOnBody} samples, so the point reported is one the check itself rejected
 * rather than a nearby guess. Falls back to the midpoint if nothing is found, which cannot happen while this
 * is only called on a segment that already failed, but leaving it to `undefined` would put a hole in a type.
 */
function firstOffBody(faces: FlatFace[], tapeW: number, a: Vec2, b: Vec2): Vec2 {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const half = tapeW * 0.5;
  const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
  const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
  const steps = Math.max(9, Math.ceil(L / half));
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    if (pointOff(faces, m.x + nx, m.y + ny) || pointOff(faces, m.x - nx, m.y - ny)) return m;
  }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Chips this wire puts copper under, that did not have copper under them already.
 *
 * Both readings, because neither subsumes the other and the router scores them together for that reason:
 * {@link countOverLed} catches a proper crossing of the chip's axis, {@link countUnderLed} catches tape
 * merely lying alongside close enough to sit under the body. Taken one pad at a time, so the delta says
 * *which* chip rather than how many — and so that a chip the router already spoiled is not charged to the
 * author, which is exactly what the whole-circuit count would do.
 *
 * The per-pad reading is a **boolean**, not a count, and that is what makes the delta mean anything.
 * `countOverLed` counts trace-pad *pairs*, so a second run across a chip that already has one raises it
 * from one to two — a positive delta on a chip the wire did not spoil. Spoiled is not a quantity: the part
 * cannot sit flat, and it cannot do so twice over. So the question asked of each pad is whether it was
 * clear before and is not now.
 */
function overLed(
  t: Trace2D,
  ctx: WireContext,
  routed: RoutedCircuit,
  before: Trace2D[],
  after: Trace2D[],
  out: WireFault[],
): void {
  const clear = ctx.tapeW * 0.5;
  const padR = clear * 1.2;
  routed.pads.forEach((pad, i) => {
    if (isOrigin(pad.pwr) && isOrigin(pad.gnd)) return; // an LED that got no copper at all
    const one: PadPair[] = [pad];
    const spoiled = (tr: Trace2D[]): boolean =>
      countOverLed(tr, one) > 0 || countUnderLed(tr, one, clear, padR) > 0;
    if (spoiled(before) || !spoiled(after)) return;
    out.push({
      kind: "over-led",
      at: { x: (pad.pwr.x + pad.gnd.x) / 2, y: (pad.pwr.y + pad.gnd.y) / 2 },
      why: "the wire passes under this chip's body — the part cannot sit flat and its two legs are bridged",
      led: i,
    });
  });
}

/**
 * Where this wire shorts another net: a crossing, or a run across the battery's other terminal.
 *
 * Located directly rather than counted, because the author needs the point. The count is what makes it a
 * delta — but adding a trace can only *add* crossings, never remove one, so the wire's own crossings against
 * other nets are exactly the delta, and a test asserts the two agree.
 *
 * The battery terminal is folded in here rather than given a kind of its own: a run of copper across the
 * other pole is a short like any other, and it is the one short that cannot be fixed with tape afterwards.
 */
function crossesNet(t: Trace2D, ctx: WireContext, before: Trace2D[], out: WireFault[]): void {
  for (const other of before) {
    if (other.net === t.net) continue; // one net may cross itself freely: single-sided tape, one potential
    for (let i = 1; i < t.pts.length; i++) {
      for (let j = 1; j < other.pts.length; j++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!, c = other.pts[j - 1]!, d = other.pts[j]!;
        if (!segsCross(a, b, c, d)) continue;
        out.push({
          kind: "crosses-net",
          at: crossPoint(a, b, c, d),
          why: `the wire crosses the ${other.net} run — single-sided tape cannot pass over another net`,
          net: other.net,
        });
      }
    }
  }

  const term = terminalsOf(ctx);
  if (!term) return;
  // The pad's own half-width plus half a strip, so the wire clears the pad itself rather than its centre —
  // the router's own `termClear`, because the two have to agree on what "across a terminal" means.
  const clear = term.half + ctx.tapeW * 0.5;
  if (countUnderTerminal([...before, t], term, clear) <= countUnderTerminal(before, term, clear)) return;
  // `countUnderTerminal` charges a run against the OTHER net's pole only, so an unnamed wire — whose net is
  // neither rail — is measured against `pwr`. Both poles are located here regardless: an unnamed wire owns
  // neither, so lying across either one shorts the cell through whatever else the wire joins.
  const forbidden = t.net === "pwr" ? [term.gnd] : t.net === "gnd" ? [term.pwr] : [term.pwr, term.gnd];
  for (const pole of forbidden) {
    if (nearPolyline(t.pts, pole) >= clear) continue;
    out.push({
      kind: "crosses-net",
      at: pole,
      why: "the wire runs across a battery terminal it does not belong to — this shorts the cell",
      net: pole === term.pwr ? "pwr" : "gnd",
    });
  }
}

/**
 * Copper this wire lays too near another net's copper.
 *
 * {@link overlapLength} and never `selfOverlapLength`: the first measures across *different* nets, the second
 * groups BY net and measures within one. A wire named `pwr` running along the `pwr` rail — a stub joining its
 * own rail, which is a perfectly ordinary thing to draw — raises the second and is not a fault. Deriving
 * proximity from it would have this checker contradict the router that laid the copper it is checking, which
 * permits same-net overlap explicitly (see {@link countNetCrossings}).
 *
 * Two distances, and the closer one wins: within three quarters of a tape width the strips are on each other
 * and the second cannot be laid at all, which is an error. Beyond that but still close enough that the
 * ribbon of substrate between them tears instead of lifting when the sheet is weeded — buildable, and worth
 * saying.
 *
 * Both tolerances are **centreline separations**, because that is what {@link overlapLength} measures.
 * {@link MIN_WEED_MM} is not one: it is the width of bare substrate between two strips' *edges*. Passing it
 * straight in reads 1.14 against a touching tolerance of 2.44 — a tighter test than the error it is meant to
 * sit outside, so the warning could never fire at all. The centreline distance at which the backing narrows
 * to `MIN_WEED_MM` is a whole tape width more than that, so a tape width is what gets added.
 */
function proximity(
  t: Trace2D,
  ctx: WireContext,
  before: Trace2D[],
  after: Trace2D[],
  out: WireFault[],
): void {
  // Both tolerances below are CENTRELINE separations, so this one is geometry, not judgement: two strips of
  // width `w` share copper whenever their centrelines are closer than `w`. It was `tapeW * 0.75` — the
  // router's own `overlapTol` — which is a SCORING weight the router may pay to buy a better route. Borrowed
  // here as a hard legality bound it left the band `0.75w <= sep < w` reported as the warning `unweedable`:
  // up to a quarter tape width of one net laid on another, called cuttable, on a sheet about to be cut.
  const touching = ctx.tapeW;
  const weed = ctx.tapeW + toFlat(MIN_WEED_MM, ctx.tapeW);
  const added = (tol: number): number => overlapLength(after, tol) - overlapLength(before, tol);

  if (added(touching) > 1e-9) {
    const near = nearestForeign(t, before);
    out.push({
      kind: "too-close",
      at: near?.at ?? t.pts[0]!,
      why: "the wire lies on top of another net's copper — there is no room to lay the second strip",
      ...(near ? { net: near.net } : {}),
    });
    return; // the weeding fault is the same copper seen at a looser tolerance, not a second one
  }
  if (added(weed) > 1e-9) {
    const near = nearestForeign(t, before);
    out.push({
      kind: "unweedable",
      at: near?.at ?? t.pts[0]!,
      why: "the wire runs close alongside another net — the strip of backing between them will tear when weeded",
      ...(near ? { net: near.net } : {}),
    });
  }
}

/**
 * Hinges this wire crosses that shorten the sheet's folding life, or that it has to bridge.
 *
 * The same test {@link buildCorridor} charges the pattern diagonal for, after Nakaya et al., "4D Leaf
 * Circuits" (SCF '25), Algorithm 1: a trace over a mountain fold fractures within a hundred folding cycles
 * while the same trace on a valley stays flat, and a valley folded past 170 degrees closes on itself and
 * counts as a mountain. Cuts are worse than either — the material is severed, so the tape is bridging a hole.
 *
 * The router routes around these where it can, and takes them where a tile is reachable no other way. The
 * author's wire gets the same reading and the same verdict: allowed, and costly.
 */
function foldFatigue(t: Trace2D, ctx: WireContext, out: WireFault[]): void {
  const seen = new Set<number>();
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1]!, b = t.pts[i]!;
    for (const g of ctx.gaps) {
      if (!segsCross(a, b, g.ends[0], g.ends[1])) continue;
      if (!badHinge(g)) continue;
      if (seen.has(g.mid)) continue;
      seen.add(g.mid);
      out.push({
        kind: "fold-fatigue",
        at: g.point,
        why: g.assignment === "C"
          ? "the wire spans a cut — there is no material under the tape here"
          : "the wire crosses a hard fold — copper here cracks after about a hundred folding cycles",
      });
    }
  }
}

/**
 * Whether copper over this hinge is a fatigue risk — `buildCorridor`'s own test, stated once.
 *
 * **Two of its three terms are unreachable on every pattern we ship, and both are kept deliberately.**
 * Measured across all eight bundled patterns, reading `gapGraph`'s own output:
 *
 * - `assignment === "C"` never fires. Each pattern carries cut edges in the file — 12 in church, 96 in
 *   bistable-star-tiling, 98 in puffin — and not one becomes a `GapEdge`, because a cut here is a *lip*:
 *   two boundary edges, one per face, so it fails "exactly two faces share this edge". Copper is kept off
 *   a cut by two other mechanisms, not by this price. An OPENED cut is a hole in the silhouette, and
 *   containment refuses a route for leaving the body. An UNOPENED one — a zero-width seam, where the two
 *   lips coincide in the flat pattern — is invisible to containment, because there is material on both
 *   sides and severed material in between; `electronics-routing.ts › seamsOf` derives those from the faces
 *   and {@link tapeOnBody} refuses to span one. Measured: `kirigami-flap` has three such seams and every
 *   other bundled pattern has none, which is why an earlier reading of this comment called the case
 *   hypothetical. It was measured on the seven patterns that cannot have one.
 * - `steepValley` never fires either. The largest valley in the corpus is akde-square-pyramid's −162.8°,
 *   under {@link STEEP_VALLEY_DEG}. The threshold is not wrong — a valley folded past 170° really has
 *   closed on itself — it is simply past anything we ship.
 *
 * So the behaviour here is carried entirely by `assignment === "M"`. Both other terms are correct rules
 * about hinges that could exist, and dropping them would silently stop pricing a pattern that had one.
 * They are documented rather than deleted so the next reader does not take their silence for coverage.
 *
 * `Math.abs` is right on the dihedral despite the sign now being meaningful: the term is inside the `V`
 * branch, and a valley's angle is negative by construction. Note that a `V` edge is not a promise of a
 * fold — 16 of the 22 in the corpus carry a target of exactly 0 — so this reads the angle, never the letter.
 */
function badHinge(g: GapEdge): boolean {
  const steepValley = g.dihedral != null && Math.abs(g.dihedral) > STEEP_VALLEY_DEG;
  return g.assignment === "M" || g.assignment === "C" || (g.assignment === "V" && steepValley);
}

/**
 * Bends sharp enough to tear when the sheet is weeded.
 *
 * The wire's own interior angles, and not only {@link countAcuteJoins}'s delta, because that function
 * iterates `["pwr", "gnd"]` and is blind to every other net — so on an unnamed wire, whose net is its own
 * id, its delta is identically zero however sharply the wire doubles back. Its delta is still taken, since
 * it sees a join this cannot: two runs meeting at a *shared point*, which catches a `pwr` wire landing on
 * the `pwr` rail at a sliver of an angle. The two readings are unioned and deduplicated by point.
 */
function acuteJoins(t: Trace2D, before: Trace2D[], after: Trace2D[], out: WireFault[]): void {
  const at: Vec2[] = [];
  for (let i = 1; i < t.pts.length - 1; i++) {
    const here = t.pts[i]!, prev = t.pts[i - 1]!, next = t.pts[i + 1]!;
    const a = Math.atan2(prev.y - here.y, prev.x - here.x);
    const b = Math.atan2(next.y - here.y, next.x - here.x);
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < MIN_JOIN_ANGLE) at.push(here);
  }
  // A join against copper already on the sheet has no vertex of the wire's own to report, so it is charged
  // to whichever end of the wire made it — the only two points it can have come from.
  if (countAcuteJoins(after) > countAcuteJoins(before) && at.length === 0) {
    at.push(t.pts[0]!);
  }
  const seen = new Set<string>();
  for (const p of at) {
    const k = `${p.x.toFixed(9)}_${p.y.toFixed(9)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      kind: "acute-join",
      at: p,
      why: "the wire doubles back on itself at a sharp angle — the wedge of backing inside the bend will tear",
    });
  }
}

/**
 * Ends that join nothing.
 *
 * {@link resolveWire} has already dropped the vertices that stopped resolving, so a wire arriving here with
 * a loose end is one the author drew loose, or one whose anchor went away. Either way the copper carries no
 * signal past that point. A warning and not an error: an unfinished wire is a normal thing to have on a
 * canvas mid-edit, and refusing to cut the sheet over one would be the checker overreaching.
 */
function dangling(t: Trace2D, ctx: WireContext, routed: RoutedCircuit, out: WireFault[]): void {
  const reach = ctx.tapeW;
  const anchors: Vec2[] = [];
  for (const p of routed.pads) {
    if (isOrigin(p.pwr) && isOrigin(p.gnd)) continue;
    anchors.push(p.pwr, p.gnd);
  }
  const term = terminalsOf(ctx);
  if (term) anchors.push(term.pwr, term.gnd);

  for (const end of [t.pts[0]!, t.pts[t.pts.length - 1]!]) {
    const onCopper = routed.traces.some((o) => nearPolyline(o.pts, end) <= reach);
    const onAnchor = anchors.some((a) => Math.hypot(a.x - end.x, a.y - end.y) <= reach);
    if (onCopper || onAnchor) continue;
    out.push({
      kind: "dangling",
      at: end,
      why: "this end of the wire does not reach any copper, pad or terminal — nothing is connected to it",
    });
  }
}

/** The battery's two pads, placed exactly as the router places them, or null when there is no battery. */
function terminalsOf(ctx: WireContext): { pwr: Vec2; gnd: Vec2; half: number } | null {
  const battery = ctx.circuit.battery;
  if (!battery) return null;
  const face = ctx.faces[battery.face];
  if (!face || face.poly.length < 3) return null;
  return batteryTerminals(face.centroid, patternDiag(ctx.faces), face.poly, ctx.tapeW);
}

/** The different-net copper this wire comes closest to, and where — for pointing at a proximity fault. */
function nearestForeign(t: Trace2D, others: Trace2D[]): { at: Vec2; net: string } | null {
  let best: { at: Vec2; net: string } | null = null;
  let bestD = Infinity;
  for (const o of others) {
    if (o.net === t.net) continue;
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      const steps = 16;
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const d = nearPolyline(o.pts, m);
        if (d < bestD) { bestD = d; best = { at: m, net: o.net }; }
      }
    }
  }
  return best;
}

/** Where segments `ab` and `cd` meet. Only called where {@link segsCross} already said they do. */
function crossPoint(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const u = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  return { x: a.x + rx * u, y: a.y + ry * u };
}

/** Distance from `p` to the nearest point of polyline `pts`. */
function nearPolyline(pts: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const abx = b.x - a.x, aby = b.y - a.y;
    const L2 = abx * abx + aby * aby;
    const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2));
    const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
    if (d < best) best = d;
  }
  return best;
}

/** Whether this point has no material under it — {@link pointInFace} returns -1 off the sheet. */
const pointOff = (faces: FlatFace[], x: number, y: number): boolean => pointInFace(faces, { x, y }) < 0;

const isOrigin = (p: Vec2): boolean => p.x === 0 && p.y === 0;
