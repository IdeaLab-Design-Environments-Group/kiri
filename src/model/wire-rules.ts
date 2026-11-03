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
  tapeOffBodyAt,
  type PadPair,
  type RoutedCircuit,
  type Trace2D,
} from "./electronics-routing.js";
import { DEFAULT_SHEET, closureFraction, foldStrain } from "./fold-strain.js";
import { toFlat, type WireContext } from "./manual-wire.js";
import { padPin, resolveNetlist } from "./netlist.js";
import { segNearSeg } from "./trace-geometry.js";
import { TAPE_MM, bridgeSpanFor } from "./tape-width.js";

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
  padShorts(t, ctx, faults);
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
 * The point comes from `seamCrossing` and not from {@link tapeOffBodyAt} for a reason worth keeping: on an
 * unopened cut there is material on BOTH sides, so a sampler looking for somewhere off the sheet finds
 * nothing, and any point it named would be one it had not derived.
 *
 * An opened cut narrower than `tape-width.ts › BRIDGE_MM` is not a fault at all: the router bridges such an
 * opening itself, and the author's wire is held to the same allowance. Only a wider hole, or one the wire
 * ends in, is off the body.
 */
function offBody(t: Trace2D, ctx: WireContext, tapeW: number, out: WireFault[]): void {
  const bridgeW = bridgeSpanFor(tapeW, ctx.tapeMm);
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1]!, b = t.pts[i]!;
    // Ahead of the boundary reading, because a wire can do both at once and the cut is the more specific
    // statement: a strip that spans a slit AND runs off the far edge is still, first, spanning a slit.
    const seam = seamCrossing(ctx.faces, a, b);
    if (seam) {
      out.push({
        kind: "spans-cut",
        at: seam,
        why: "the wire spans a cut — the material is severed along this line, so the tape is bridging a hole",
      });
      continue;
    }
    const off = tapeOffBodyAt(ctx.faces, tapeW, a, b, bridgeW);
    if (off) {
      out.push({
        kind: "off-body",
        at: off,
        why: "the wire runs off the edge of the sheet — at this width part of the tape has no material under it",
      });
    }
  }
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
 * Part pads this wire shorts: a pad wired to another net, or two pins of one part joined together.
 *
 * Read off the netlist's own pad obstacles — every pad of every placed part, with the net wired to it — so
 * this and the router agree on where the metal is. Routed copper does not stand in for it: a pad on a net
 * with no copper yet, or a part nobody has wired, is still metal the tape is lying on.
 *
 * Joining two pins is a short only when one of them is not on the wire's own net. Both pins on that net is
 * an ordinary netlist the router would lay itself; an unwired pin joined to anything shorts the part out.
 */
function padShorts(t: Trace2D, ctx: WireContext, out: WireFault[]): void {
  if (!ctx.circuit.parts?.length) return;
  const { pads } = resolveNetlist(ctx.circuit, ctx.tapeW, ctx.tapeMm ?? TAPE_MM);
  const half = (t.width ?? ctx.tapeW) / 2;
  const touched = pads.filter((p) => onPolygon(t.pts, p.outline, half));
  for (const part of new Set(touched.map((p) => p.part))) {
    const here = touched.filter((p) => p.part === part);
    const foreign = here.find((p) => p.net !== null && p.net !== t.net);
    if (foreign) {
      out.push({
        kind: "crosses-net",
        at: foreign.at,
        why: `the wire lands on a pad wired to ${foreign.net} — this shorts the two nets together`,
        net: foreign.net!,
      });
      continue;
    }
    if (new Set(here.map((p) => padPin(p.pad))).size < 2 || here.every((p) => p.net === t.net)) continue;
    out.push({
      kind: "crosses-net",
      at: here[0]!.at,
      why: "the wire joins two pins of one part — this shorts the part out",
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
 * The same strain reading {@link buildCorridor} prices creases with (see {@link badHinge}): copper over a
 * fold strained past the routing threshold cracks within the design life of a hundred folding cycles, and
 * a fold that has closed on itself can short across. Cuts are worse than either — the material is severed,
 * so the tape is bridging a hole.
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
      if (!badHinge(g, ctx)) continue;
      if (seen.has(g.mid)) continue;
      seen.add(g.mid);
      out.push({
        kind: "fold-fatigue",
        at: g.point,
        why: g.assignment === "C"
          ? "the wire spans a cut — there is no material under the tape here"
          : "the wire crosses a fold steep enough to crack copper within about a hundred folding cycles",
      });
    }
  }
}

/**
 * Whether copper over this hinge is a fatigue risk — the router's own reading, so the two cannot disagree.
 *
 * The strain model `corridor.ts › creaseFraction` prices a crossing with: a crease is fatiguing when its
 * outer-fibre strain reaches {@link SheetSpec.routingThresholdStrain}, or when it has folded shut. Below that
 * the router calls the copper survivable and crosses freely, so warning there would contradict the plan.
 * This used to classify by assignment letter — every `M` warned — and disagreed with the router on 343 of
 * 1,464 hinges across the corpus, warning of cracks over a 1.4-degree mountain.
 *
 * The two fallbacks are the router's too. A cut is severed material, always the worst thing to cross. A
 * crease with no recorded fold angle, or no measurable hinge width (a vinyl score, where the legs coincide),
 * leaves the strain model nothing to run on, and falls back to the letter: a mountain is a risk.
 */
function badHinge(g: GapEdge, ctx: WireContext): boolean {
  if (g.assignment === "C") return true;
  const tapeMm = ctx.tapeMm ?? TAPE_MM;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * (ctx.tapeW > 0 ? tapeMm / ctx.tapeW : 0);
  if (g.dihedral == null || !(hingeMm > 0)) return g.assignment === "M";
  const sheet = ctx.sheet ?? DEFAULT_SHEET;
  return foldStrain(hingeMm, g.dihedral, sheet) >= sheet.routingThresholdStrain || closureFraction(g.dihedral) >= 1;
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

/** Whether a strip of half-width `half` along `pts` overlaps the closed polygon `poly`. */
function onPolygon(pts: Vec2[], poly: Vec2[], half: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    for (let k = 0; k < poly.length; k++) {
      if (segNearSeg(pts[i - 1]!, pts[i]!, poly[k]!, poly[(k + 1) % poly.length]!) < half) return true;
    }
  }
  // A vertex inside the pad touches none of its edges; the crossing rule catches it.
  return pts.some((p) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  });
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

const isOrigin = (p: Vec2): boolean => p.x === 0 && p.y === 0;
