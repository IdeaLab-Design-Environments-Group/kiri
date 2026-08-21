/**
 * **Model** — copper-tape auto-router for the electronics layer.
 *
 * ## Why this shape
 *
 * The tape is single-sided, so a trace may lie over a cut, over a hinge, over another trace of its **own**
 * net (same potential — a touch is harmless), and over bare cloth. Exactly two things are forbidden:
 *
 *  1. **No trace over an LED body** — it shorts the chip and sits under the component.
 *  2. **PWR should not cross GND** — that is a short in the layout.
 *
 * The topology is a **two-rail bus**: one tour runs from the battery past every LED, and the two nets are
 * its two *banks* — PWR taking the pad on one side of the direction of travel, GND the pad on the other.
 * That is how a person tapes this by hand, and it comes out at **exactly two strips** whatever the LED
 * count, rather than two per LED. The tour is 2-opted, which both shortens it and removes self-crossings
 * (a self-crossing path is always strictly longer than the same path with the crossing span reversed).
 *
 * ## What is and is not guaranteed
 *
 * **Over-LED is zero** on every bundled pattern: a rail only ever runs pad to pad, and such a span was not
 * observed to cross a third chip. Measured, not proved — see the test.
 *
 * **Crossings are reduced, not eliminated.** With 12 LEDs: akde-hex 13, akde-decagon 12, akde-square 7,
 * puffin 5, church 3, house 0. For comparison the previous graph-search router scored 78 / 31 / 13 / 36 / 5
 * / 2 on the same configurations *and* ran over chips on three models. So this is 3-8x better on the big
 * patterns, but it is not zero, and the honest reason is that the guarantee only holds where the two pads
 * of an LED flank the direction of travel. Where the tour meets a hinge end-on, both pads sit ahead of and
 * behind the path instead, one rail has to reach across, and that is a crossing no polarity flip can undo.
 * Fixing it properly means routing the tour *along* each hinge, which changes what the 2-opt has to
 * optimise; two attempts at that (offsetting the tour with pad stubs, and traversing hinges end-to-end)
 * each traded the crossings for over-LED violations or 6x the copper, so neither shipped.
 *
 * The router, not the author, picks each LED's polarity: whichever pad falls on the PWR bank becomes `+`.
 * That is reported in {@link RoutedCircuit.pads} so the preview can show which way round to fit the part.
 *
 * All geometry is flat-pattern 2D mm (the SVG export frame).
 */
import {
  type Battery,
  type Circuit,
  type FlatFace,
  type GapEdge,
  type Vec2,
  dist2,
  gapForLed,
  pointInFace,
} from "./electronics.js";
import { DEFAULT_PRINT_SIZE } from "./stl-export.js";
import { R_1206, slide_switch } from "./footprints.generated.js";

/** One continuous strip of copper tape: a centreline polyline plus which net it carries. */
export interface Trace2D {
  pts: Vec2[];
  net: "pwr" | "gnd";
  /**
   * Width in pattern units, where this run is not ordinary tape.
   *
   * Land copper under a part's terminals: a switch's pads are `.047in` across and its pitch `.098in`, so a
   * stub reaching one at full tape width would touch the neighbouring terminal's and short the part. Left
   * unset — which is every routed run — the tape's own width is used.
   */
  width?: number;
}

/** Where an LED's two pads ended up, per net. Index-aligned with `circuit.leds`. */
export interface PadPair {
  pwr: Vec2;
  gnd: Vec2;
}

export interface RoutedCircuit {
  traces: Trace2D[];
  /** Index-aligned with `circuit.leds` (including unroutable ones, which get zeroed pads). */
  pads: PadPair[];
  /** Indices of LEDs that could not be reached (no gap, or no battery). */
  unreachable: number[];
  /** Where each resistor ended up: the two ends of the break its leads bridge. */
  resistors: PartSpan[];
  /** Likewise each switch: the break between its second pin and its third. */
  switches: PartSpan[];
}

/** The gap a part bridges — `a` and `b` are the cut ends of the run, where its contacts land. */
export interface PartSpan {
  a: Vec2;
  b: Vec2;
  /** Which rail it was placed on, so land copper joins the right net. */
  net: "pwr" | "gnd";
}

/** @deprecated the same thing; kept so existing callers read naturally. */
export type ResistorSpan = PartSpan;

export const EMPTY_ROUTE: RoutedCircuit = { traces: [], pads: [], unreachable: [], resistors: [], switches: [] };

/** How much dearer it is to travel through a hinge that has an LED on it than an empty one. Large enough to
 *  route around whenever there is any alternative, finite so that a dead-end tile stays reachable. */
const OCCUPIED_TOLL = 500;

/** Where along a shared edge the bus may cross it. Symmetric about the middle so neither net is favoured,
 *  and away from the middle so a crossing does not land on a chip, which sits at the midpoint -- which is why
 *  this fixed copper-under-the-chip as well as overlap.
 *
 *  Measured: quarters beat thirds on overlap (akde-decagon 17% -> 8%) for about 25% more copper. Three or
 *  four crossings per edge is worse on both counts -- puffin reaches 13-15 PWR/GND crossings -- because the
 *  extra freedom lets the two nets interleave rather than separate. */
const EDGE_CROSSINGS = [1 / 4, 3 / 4];

/**
 * What crossing a mountain fold, a cut, or a valley folded past 170 degrees costs, as a fraction of the
 * pattern's bounding-box diagonal.
 *
 * Nakaya et al. use the whole diagonal, chosen to exceed any single step so a crease is crossed only when a
 * tile is reachable no other way. Their graph is one node per face; ours is many nodes per face, so the same
 * figure bites harder here.
 *
 * Swept: at the full diagonal, akde-decagon's mountain crossings fall 39 -> 23 but puffin gains a chip
 * violation, and a chip violation is destructive where a mountain crossing is only fragile. At half, nothing
 * regresses and most of the gain remains: akde-decagon 39 -> 25 with a third less copper, akde-hex's valley
 * crossings 13 -> 11. At 0.15 the penalty stops changing any route.
 */
const FOLD_PENALTY_FRAC = 0.5;

/** How much dearer each previous use of a waypoint by the other net makes it, so the two nets take genuinely
 *  different routes instead of one shadowing the other.
 *
 *  Swept: 2 is the best value measured (overlap 7/3/2/2/2/2/24% across the bundled patterns). Removing it
 *  entirely doubles overlap on akde-decagon (7% -> 17%) and puffin (24% -> 36%), while raising it to 20 buys
 *  nothing further. It only became effective once a face could be crossed by a chord: with every path forced
 *  through the face centre there was no second route to divert onto, and the toll did nothing at any value. */
const SHARED_TOLL = 2;

/**
 * Tape width in millimetres — the width of the copper tape actually being laid.
 *
 * The one definition. Every clearance in the router is derived from it, the preview draws it, and both export
 * files cut it — so widening the tape widens the keep-outs with it, instead of leaving the router planning for
 * a hairline while the cutter is asked for a real strip.
 *
 * Absolute, not a fraction of the pattern: a roll of copper tape is one width whatever it is stuck to, so the
 * strip the cutter is asked for has to be that width or it cannot be cut from the roll. The consequence is that
 * a pattern must be at a real physical scale for routing to mean anything — on a flat pattern only a few mm
 * across the tape is wider than the model and the keep-outs swallow it. Scale the pattern before routing.
 *
 * 3.25mm, half the 6.5mm this was set to. 6.5 was taken as the narrowest roll made, which is not so — 3mm and
 * 5mm copper tape are both stocked — and at 6.5 the strips crowd these patterns, taking up most of a tile and
 * leaving the router little room to work in. Narrower tape is also less of the surface stiffened, which matters
 * on a sheet meant to fold.
 */
export const TAPE_MM = 3.25;

/**
 * The sheet a scale-less pattern is assumed to be cut at. Shared with the STL export's
 * `DEFAULT_PRINT_SIZE`, so a pattern printed for folding and a pattern taped for wiring agree on how big
 * "the model" is.
 */
export const PRINT_SHEET_MM = DEFAULT_PRINT_SIZE;

/**
 * Tape width **in the pattern's own units**.
 *
 * A pattern at or above sheet size is taken at its word: the file says how big the model is, so the tape is
 * the literal {@link TAPE_MM}. A pattern smaller than the sheet on BOTH axes carries no usable scale — it is
 * kirigamize output at unit scale, nominally "mm" — so it is read as though it will be cut at
 * {@link PRINT_SHEET_MM}, and the tape takes the matching fraction of its coordinates.
 *
 * Floor, never a normalisation: a pattern larger than the sheet is left alone. Shrinking it to sheet size
 * would make the tape coarser than the file intends, which measurably degrades routing on the large
 * patterns (akde-decagon picks up crossing tabs, puffin picks up copper over a chip).
 */
export function tapeWidthFor(faces: FlatFace[], sheetMm: number = PRINT_SHEET_MM): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const p of f.poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return TAPE_MM;
  const longest = Math.max(maxX - minX, maxY - minY);
  if (!(longest > 0)) return TAPE_MM;
  // Both axes under the sheet ⇔ the longest is: scale-less, so the tape is a fraction of the assumed sheet.
  return longest < sheetMm ? (TAPE_MM * longest) / sheetMm : TAPE_MM;
}

/**
 * How far off a pad, as a fraction of the pad-to-pad gap, a rail steps before travelling on — and how far
 * past a pad a shortcut may reach toward that pad's partner before it is refused.
 *
 * The two work together: the step-off keeps the raw route from leaving across the chip, and the shortcut
 * bound keeps straightening from putting it back. Both are expressed against the LED's own pad gap so they
 * scale with the chip rather than the pattern.
 */
const PAD_STEP_OFF = 0.5;
const PAD_INTRUDE_MAX = 0.35;

/** What a step along tape this net already laid costs, as a fraction of its length. Cheap, so a branch merges
 *  into the trunk rather than running alongside it -- which is the doubling back. */
const OWN_TAPE_DISCOUNT = 0.2;

/** How much nearer an earlier pad must be, in squared distance, before a branch leaves it instead of carrying
 *  on from the last pad. Below 1 it means "clearly nearer". */
const BRANCH_GAIN = 0.25;

/** What it costs a net to route in the other net's lane, as a multiple of the raw distance.
 *
 *  Re-swept once the tape halved, which left more room to detour into: 3 now clears akde-decagon's overlap
 *  entirely (2% -> 0) and takes a crossing off puffin, where at 6.5mm anything above 1.5 put copper under a
 *  chip. Above 6 it turns bad again -- puffin 27% overlap at 12. */
const LANE_TOLL = 3;

/** What it costs to route through the other net's battery terminal. Large: that is a short at the source, so
 *  no detour is too long to avoid it -- but finite, so a terminal boxed in by geometry stays reachable. */
const TERMINAL_TOLL = 400;

/** Positional key, for marking a hinge as occupied. Rounded well below any real feature size. */
const ptKey = (p: Vec2): string => `${Math.round(p.x * 1e6)}_${Math.round(p.y * 1e6)}`;

// ---- small vector helpers ---------------------------------------------------

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const len = (a: Vec2): number => Math.hypot(a.x, a.y);

function unit(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Left normal of a direction (90 degrees CCW). */
const leftOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

/** Which side of the ray `origin + t·dir` the point `p` lies on: +1 left, -1 right. */
function sideOf(origin: Vec2, dir: Vec2, p: Vec2): number {
  const c = cross(dir, sub(p, origin));
  return c >= 0 ? 1 : -1;
}

/** Whether segment ab properly crosses any of the given polylines. */
function crossesAny(a: Vec2, b: Vec2, lines: Vec2[][]): boolean {
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      if (segsCross(a, b, line[i - 1]!, line[i]!)) return true;
    }
  }
  return false;
}

/** True when segments ab and cd properly cross (interiors meet; shared endpoints and collinear touching
 *  do not count — same-net tape is allowed to touch). */
export function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) return false;
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

/** True when the polyline `pts` properly crosses segment cd anywhere. */
function polyCrosses(pts: Vec2[], c: Vec2, d: Vec2): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (segsCross(pts[i - 1]!, pts[i]!, c, d)) return true;
  }
  return false;
}

// ---- battery ----------------------------------------------------------------

/** The battery's two terminals: side by side either side of its face centroid.
 *
 *  The preview and the router must agree on these to the last decimal or the copper lands off the pad, so
 *  this is the one definition and both import it. */
/** The battery's two terminals: where they sit, and how big each pad is. */
export interface Terminals {
  pwr: Vec2;
  gnd: Vec2;
  /** Half-width of each pad, after clamping to what the tile can hold. */
  half: number;
}

/**
 * Bare gap wanted between the two nets' copper under an LED, as a fraction of the tape width.
 *
 * A vinyl cutter has to be able to weed the strip between the pads, and the chip has to sit on bare substrate
 * rather than bridging its own two legs. Where the LED's legs are closer together than the tape is wide -- which
 * they are on the denser patterns, by up to 0.7mm -- the copper of the two nets would otherwise overlap under
 * the part and short it.
 */
export const LED_GAP_FRAC = 0.35;

/**
 * How wide the tape may be where it lands on `pad`, given the chip it shares with `mate`.
 *
 * Full width wherever there is room. Where there is not, it narrows to leave the gap, down to a floor: below
 * that the strip is too thin to cut, and the honest answer is that the pattern is too small for this tape
 * rather than a sliver that tears on weeding.
 */
export function landingWidth(pad: Vec2, mate: Vec2, tapeW: number): number {
  const sep = Math.hypot(pad.x - mate.x, pad.y - mate.y);
  const room = sep - tapeW * LED_GAP_FRAC;
  return Math.max(tapeW * 0.35, Math.min(tapeW, room));
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

/** Pattern diagonal — the scale every relative length here is expressed in. */
export function patternDiag(faces: FlatFace[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const p of f.poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return 1;
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}

// ---- the router -------------------------------------------------------------

/** A routed net: its walk, and the corridor waypoints it took. */
interface Rail {
  /** One polyline per branch: each starts at a point the net had already reached. */
  paths: Vec2[][];
  used: Map<string, number>;
}

/** One LED that will actually be wired. */
interface Target {
  /** Index into `circuit.leds`. */
  slot: number;
  /** Hinge midpoint — where the bus passes. */
  hinge: Vec2;
  /** The hinge's two end corners. The bus runs *along* this segment, which is what puts the LED's two pads
   *  on opposite banks: across the hinge they would be ahead-of and behind the path instead, and "which
   *  side" would be meaningless. */
  ends: [Vec2, Vec2];
  /** The two landing pads (the pinched tile legs). */
  legs: [Vec2, Vec2];
  /** The face each of `legs` sits on, so a pad can be joined to the corridor graph at its own tile. */
  legFaces: [number, number];
  /** Orientation the author fixed for this LED, if they did. The search may not change it. */
  pinned?: boolean;
}

/**
 * Plan copper for `circuit` on `fold`'s flat pattern.
 *
 * Deterministic: every decision is derived from geometry and index order, with no search and no
 * randomness, so two calls on the same input return identical traces (the preview and the SVG export
 * each route independently and must agree).
 */
export function planRoutes(
  faces: FlatFace[],
  gaps: GapEdge[],
  circuit: Circuit,
  /** The sheet a scale-less pattern is cut at. Every clearance the router works to is derived from the tape
   *  width, which is derived from this, so routing a pattern for a bigger sheet really does give it more
   *  room -- the tape is the same 3.25mm of copper on a larger piece of paper. */
  sheetMm: number = PRINT_SHEET_MM,
): RoutedCircuit {
  const pads: PadPair[] = circuit.leds.map(() => ({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } }));
  const unreachable: number[] = [];
  const battery: Battery | null = circuit.battery;
  if (!battery || !faces[battery.face]) {
    circuit.leds.forEach((_, i) => unreachable.push(i));
    return { traces: [], pads, unreachable, resistors: [], switches: [] };
  }

  const diag = patternDiag(faces);
  const tapeW = tapeWidthFor(faces, sheetMm); // the tape in THIS pattern's units — see tapeWidthFor
  const centre = faces[battery.face]!.centroid;
  const term = batteryTerminals(centre, diag, faces[battery.face]!.poly, tapeW);

  // Collect the LEDs we can wire. An LED whose gap has gone (the pattern changed under it) has no pads.
  const targets: Target[] = [];
  circuit.leds.forEach((led, slot) => {
    const gap = gapForLed(gaps, led);
    if (!gap) {
      unreachable.push(slot);
      return;
    }
    targets.push({
      pinned: led.flip,
      slot,
      hinge: gap.point,
      ends: gap.ends,
      legs: [gap.legA, gap.legB],
      legFaces: [gap.faceA, gap.faceB],
    });
  });
  if (!targets.length) return { traces: [], pads, unreachable, resistors: [], switches: [] };

  // Drop LEDs the battery cannot reach across the material. Their tiles sit on a separate island of the
  // pattern, and the only way to "reach" them would be a straight line through empty space -- which is what
  // used to happen, and is what put copper outside the body. Better to report them honestly.
  // The crossing penalty is the pattern's bounding-box diagonal, as in the paper: larger than any single step
  // in the graph, so a crease is crossed only when nothing else reaches the tile.
  const corridor = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW);
  const reach = reachableFaces(corridor, battery.face);
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (reach.has(t.legFaces[0]) || reach.has(t.legFaces[1])) continue;
    unreachable.push(t.slot);
    targets.splice(i, 1);
  }
  unreachable.sort((a, b) => a - b);
  if (!targets.length) return { traces: [], pads, unreachable, resistors: [], switches: [] };

  // The tour: the order the bus passes the LEDs. Nearest-neighbour from the battery, then 2-opt.
  // 2-opt is what earns the no-crossing guarantee: a self-crossing tour is always strictly longer than
  // the same tour with the crossing pair reversed, so a 2-opt local optimum has no self-crossings -- and
  // the two rails only cross each other where the tour crosses itself.
  const order = twoOpt(nearestTour(centre, targets), centre, targets);

  // Walk the tour and hand each net one pad per LED: the pad lying on that net's bank of the direction of
  // travel. Both rails are then simple chains that stay on opposite sides of the same path.
  const dirs: Vec2[] = [];
  for (let i = 0; i < order.length; i++) {
    const prev = i === 0 ? centre : targets[order[i - 1]!]!.hinge;
    const next = i === order.length - 1 ? null : targets[order[i + 1]!]!.hinge;
    const here = targets[order[i]!]!.hinge;
    dirs.push(unit(next ? sub(next, prev) : sub(here, prev)));
  }

  // Which bank is PWR: the side the + terminal already sits on as the bus leaves the battery.
  const bank = sideOf(centre, dirs[0]!, term.pwr) || 1;

  const spine: Vec2[] = [centre, ...order.map((oi) => targets[oi]!.hinge)];
  const laneOf = (p: Vec2): number => {
    let best = Infinity, side = 1;
    for (let i = 1; i < spine.length; i++) {
      const a = spine[i - 1]!, b = spine[i]!;
      const d = segPointDist(a, b, p);
      if (d < best) { best = d; side = sideOf(a, unit(sub(b, a)), p); }
    }
    return side;
  };
  const lanePref = new Map<string, { pwr: number; gnd: number }>();
  for (const [key, p] of corridor.point) {
    const lane = laneOf(p);
    lanePref.set(key, {
      pwr: lane === bank ? 0 : LANE_TOLL,
      gnd: lane === bank ? LANE_TOLL : 0,
    });
  }

  // `flip[i]` swaps LED i's two pads between the banks. The tour is a plain chain, so a flip is a
  // genuinely local change: a crossing it causes can be undone without disturbing the rest of the bus.
  /** Force every pinned LED to the orientation its author chose. */
  const pin = (f: boolean[]): boolean[] => {
    for (let i = 0; i < order.length; i++) {
      const p = targets[order[i]!]!.pinned;
      if (p !== undefined) f[i] = p;
    }
    return f;
  };

  const seeds: boolean[][] = [
    // Geometric: put each pad on the bank its own side of the travel direction already faces.
    order.map((oi, i) => sideOf(targets[oi]!.hinge, dirs[i]!, targets[oi]!.legs[0]!) !== bank),
    order.map(() => false),
    order.map(() => true),
  ];

  // Each net takes one pad per LED -- the one on its own bank of the direction of travel -- and its strip
  // runs pad to pad in tour order.
  //
  // The alternative was measured: offset the whole tour and reach each pad by a stub. That cuts crossings
  // further (akde-hex 13 -> 4) but lays copper over 1-5 chips on every model, because offsetting and the
  // stubs both move copper after the tour was planned clear of them. Tape over a chip shorts the part, so
  // this keeps that at zero and accepts the crossings instead.
  // Hops run through the corridor graph -- face centres joined to their hinge midpoints -- so copper stays
  // inside the pattern silhouette and travels along the tiling instead of cutting a straight diagonal over
  // whatever happens to lie between two pads (including bare space outside the body).
  // A hinge midpoint that has an LED on it is where that chip sits, so travelling through it is running
  // over the part. Those crossings are made expensive rather than impossible, so a tile that can only be
  // reached past an occupied hinge is still reachable.
  const occupied = new Set(targets.map((t) => ptKey(t.hinge)));
  let dirPwr = false, dirGnd = false;
  const padsFor = (f: boolean[]): PadPair[] => {
    const out = pads.map((p) => p);
    for (let i = 0; i < order.length; i++) {
      const t = targets[order[i]!]!;
      const [l0, l1] = t.legs;
      out[t.slot] = f[i] ? { pwr: l1, gnd: l0 } : { pwr: l0, gnd: l1 };
    }
    return out;
  };

  // Running over a chip is destructive -- it shorts the part -- while a PWR/GND crossing is a short in the
  // layout. Both must go, so score them lexicographically with over-LED dominant and never trade one for
  // the other.
  // Over-LED destroys the part, a crossing shorts the layout, and overlap only makes it hard to build, so
  // they rank in that order and overlap can never be bought with either of the others.
  const clearW = tapeW * 0.5; // half a tape width: closer than this and copper is under the chip
  // The pad's own half-width plus half a strip, so copper clears the pad itself rather than merely missing its
  // centre.
  const termClear = term.half + clearW;
  const overlapTol = tapeW * 0.75; // closer than this and the strips are on each other
  const score = (tr: Trace2D[], f: boolean[]): number =>
    // The width-aware measure, not countOverLed: that one tests zero-width centrelines for a crossing, so it
    // reads zero while tape is sitting on top of a chip. Scoring on it left the search blind to the very
    // constraint it was supposed to be enforcing first.
    // Both chip measures, because neither subsumes the other: the width-aware one exempts the pad the run
    // lands on (so it misses a run that clips the body right at the pad), and the zero-width one only sees a
    // proper crossing (so it misses tape lying alongside). Ranked together, above everything else.
    // Chips first, and separately: tape under a chip destroys the component, while tape across a battery pad
    // shorts the supply. Both are faults, but they are not the same fault, and weighing them equally let the
    // router swap one for the other -- puffin traded its terminal fault for a chip fault and called it even.
    (countUnderLed(tr, padsFor(f), clearW, clearW * 1.2) + countOverLed(tr, padsFor(f))) * 1e12 +
    countUnderTerminal(tr, term, termClear) * 1e9 +
    countNetCrossings(tr) * 1e6 +
    // Both kinds of overlap: the two nets shadowing each other, and a net laid twice over itself. Only the
    // first was scored, so nothing in the search had any reason to stop a net doubling back -- and it did,
    // over a fifth of its length on some patterns.
    // A sharp join is a cutting defect -- the wedge of substrate between two strips leaving a point at a narrow
    // angle tears rather than weeding -- so it ranks with the overlaps rather than below them.
    countAcuteJoins(tr) * overlapTol * 4 +
    overlapLength(tr, overlapTol) +
    selfOverlapLength(tr, overlapTol) +
    // Length ranks last: of two plans equal on everything that matters more, the shorter and straighter wins.
    totalLength(tr) * 1e-6;

  /** Whether a strip of tape laid from a to b stays on the material.
   *
   *  Both edges are checked, not just the centreline. Tape has width, so a run tracking the boundary keeps its
   *  centre on the material while half the strip hangs off it -- which is what put copper outside the shape. */
  const onBody = (a: Vec2, b: Vec2): boolean => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const half = tapeW * 0.5;
    const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
    const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
    const steps = Math.max(9, Math.ceil(L / half));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) return false;
      if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) return false;
    }
    return true;
  };

  // Tours are memoised on the pads they order. The descent flips one LED at a time and revisits the same
  // assignments repeatedly, and a 2-opt per net per build is what made a plan take 1.9s.
  const tourCache = new Map<string, number[]>();
  const cachedTour = (from: Vec2, pts: Vec2[]): number[] => {
    const key = `${ptKey(from)}|${pts.map(ptKey).join(",")}`;
    const hit = tourCache.get(key);
    if (hit) return hit;
    const made = tourOf(from, pts);
    tourCache.set(key, made);
    return made;
  };

  // Whether a net may branch off an earlier pad rather than chaining from the last one. Off while the polarity
  // is searched -- it is not a polarity question -- and tried once at the end, kept only if it scores better.
  let branching = false;
  // Whether a net may travel cheaply along tape it has already laid, so a branch merges into the trunk instead
  // of running beside it. Tried after the polarity search, like branching, and kept only if it scores better.
  let merging = false;
  const build = (f: boolean[], perNetOrder = false): Trace2D[] => {
    // What the first net routed. The second pays a toll to reuse it, which now buys a different chord rather
    // than the same one dearer, because a face has many ways through.
    /** Route one net, charging a toll for every waypoint in `avoid` (what the other net currently uses).
     *  Returns the route and the waypoints it took. */
    const railPts = (
      net: "pwr" | "gnd",
      rev: boolean,
      avoid: Map<string, number>,
      theirTape: Vec2[][] | null,
      perNet: boolean,
      mayBranch: boolean,
      merging: boolean,
    ): { paths: Vec2[][]; used: Map<string, number> } => {
      const lane = (key: string): number => (net === "pwr" ? lanePref.get(key)?.pwr : lanePref.get(key)?.gnd) ?? 0;
      // Never route through the other net's terminal: shorting the battery is not a trade worth any shortcut.
      const forbidden = net === "pwr" ? term.gnd : term.pwr;
      // This net's own visiting order over its own pads, not the shared hinge order — see tourOf.
      const mineFirst = net === "pwr" ? term.pwr : term.gnd;
      const myPads = order.map((oi, i) => {
        const t = targets[oi]!;
        const swap = net === "pwr" ? f[i]! : !f[i]!;
        return swap ? t.legs[1] : t.legs[0];
      });
      const own = perNet ? cachedTour(mineFirst, myPads) : order.map((_, k) => k);
      const seq = rev ? own.slice().reverse() : own;
      const pick = (i: number): { pad: Vec2; face: number } => {
        const t = targets[order[i]!]!;
        const swap = net === "pwr" ? f[i]! : !f[i]!;
        return swap
          ? { pad: t.legs[1], face: t.legFaces[1] }
          : { pad: t.legs[0], face: t.legFaces[0] };
      };
      const mine = net === "pwr" ? term.pwr : term.gnd;
      const paths: Vec2[][] = [];
      // Points this net has already reached: the terminal, then every pad it has landed on. A hop starts from
      // whichever is nearest, so an LED's own pad carries the connection on to the next LED instead of the run
      // going back for it. That is what stops the net doubling along itself to reach a neighbour it was already
      // beside -- and every branch starts somewhere already connected, so the net stays one piece.
      const reached: { pt: Vec2; face: number }[] = [{ pt: mine, face: battery.face }];
      // Step off the terminal heading directly away from the other one before going anywhere. The corridor
      // toll keeps the *nodes* clear of the other terminal, and straightening keeps shortcuts clear of it, but
      // neither governs the very first segment out of the pad -- which is free to sweep straight across its
      // neighbour, shorting the battery. Leaving on the far side removes that.
      // Held back until it is known to be needed: `escape` is spliced in below only if the run's first real
      // segment would otherwise sweep the other terminal. Pushing it unconditionally put a sideways stub on
      // every net -- GND's pointing away from PWR, which is a jog to the left for no reason -- and left a wedge
      // at the pad where the run should meet it square.
      const escape = add(mine, scale(unit(sub(mine, forbidden)), termClear * 0.9));
      const used = new Map<string, number>();
      for (const i of seq) {
        const { pad, face } = pick(i);
        // The LED being landed on is allowed: the rail approaches its pad, not through its chip.
        const t = targets[order[i]!]!;
        const blocked = new Set(occupied);
        blocked.delete(ptKey(t.hinge));
        // Charge against the other net's route and this net's own route so far, so neither the two nets nor a
        // single net doubles back along what is already laid.
        //
        // Making a net's own tape *free* to reuse was measured instead, on the theory that a hop would then
        // merge into the existing run rather than lay beside it. It cuts copper 23-32% but does not reduce
        // self-overlap at all (akde-decagon 15% -> 16%), and it costs 21 separate strips there against 2, plus
        // a PWR/GND crossing and an under-chip violation. Not worth it.
        const toll = new Map(avoid);
        for (const k of lanePref.keys()) toll.set(k, (toll.get(k) ?? 0) + lane(k));
        for (const [k, p] of corridor.point) {
          if (Math.sqrt(dist2(p, forbidden)) < termClear) toll.set(k, (toll.get(k) ?? 0) + TERMINAL_TOLL);
        }
        // Branch off an earlier pad only when it is clearly nearer than carrying on from the last one.
        //
        // Taking the nearest every time cuts cross-net overlap (puffin 16% -> 13%) and copper, but it breaks up
        // the chain that keeps the two nets running parallel: repeated tape rose on three patterns and house,
        // akde-decagon and puffin each picked up a PWR/GND crossing, which is a short. Requiring a clear
        // improvement keeps the chain unless branching genuinely pays.
        const last = reached[reached.length - 1]!;
        let from = last;
        if (mayBranch) {
          for (const r of reached) {
            if (dist2(r.pt, pad) < dist2(from.pt, pad) * BRANCH_GAIN) from = r;
          }
        }
        const branch: Vec2[] = [from.pt];
        for (const p of corridorPath(corridor, from.face, face, blocked, toll, {
          at: forbidden,
          r: termClear,
        }, from.pt, onBody, merging ? new Set(used.keys()) : null, theirTape)) {
          branch.push(p);
          used.set(ptKey(p), (used.get(ptKey(p)) ?? 0) + 1);
        }
        branch.push(pad);
        paths.push(branch);
        reached.push({ pt: pad, face });
      }
      // Does leaving the terminal actually cross the other one? Only the branch that starts there can.
      for (const b of paths) {
        if (b.length >= 2 && ptKey(b[0]!) === ptKey(mine) &&
            segPointDist(b[0]!, b[1]!, forbidden) < termClear && onBody(mine, escape)) {
          b.splice(1, 0, escape);
        }
      }
      if (!paths.length) paths.push([mine]);
      return { paths, used };
    };

    // PWR routes with a clear field; GND then pays a toll for every waypoint PWR took, so it goes round the
    // other way rather than shadowing it.
    //
    // Rip-up and reroute -- giving PWR later passes to move aside for GND too -- was implemented and measured
    // to change nothing at all: rerouting PWR against GND's route converges on the same PWR route. It only
    // appeared to help while it was also being run inside the polarity search, and that gain was the search
    // finding a different polarity, not the rerouting. Removed rather than left in as a costly no-op.
    /** Route both nets, PWR with a clear field and GND paying a toll for what PWR took. */
    const routeBoth = (perNet: boolean, mayBranch: boolean): { pwr: Rail; gnd: Rail } => {
      const a = railPts("pwr", dirPwr, new Map(), null, perNet, mayBranch, merging);
      // GND is routed knowing exactly where PWR's tape lies, so it can go round rather than across it.
      return { pwr: a, gnd: railPts("gnd", dirGnd, a.used, a.paths, perNet, mayBranch, merging) };
    };
    /** The pads this net must reach — the only points a branch may legitimately end at. */
    const padsOf = (fl: boolean[], net: "pwr" | "gnd"): Vec2[] =>
      order.map((oi, i) => {
        const t = targets[oi]!;
        const swap = net === "pwr" ? fl[i]! : !fl[i]!;
        return swap ? t.legs[1] : t.legs[0];
      });

    const finish = (r: { pwr: Rail; gnd: Rail }): Trace2D[] => {
      const bodies = targets.map((t) => [t.legs[0], t.legs[1]] as [Vec2, Vec2]);
      const keepPwr = [term.pwr, ...padsOf(f, "pwr")];
      const keepGnd = [term.gnd, ...padsOf(f, "gnd")];
      // Straighten each net in turn. PWR goes first with only the chips to avoid; GND is then straightened
      // against PWR's finished geometry, so a shortcut can never buy directness by crossing the other net.
      // PWR is straightened against GND's route as planned (before its own straightening), so its shortcuts
      // cannot buy directness by cutting across where GND is going to be. Passing nothing here let exactly
      // that happen.
      // Push any run that still passes too close to the other net's terminal out around it. The corridor governs
      // its chords and straightening governs its shortcuts, but the segments that land on a pad answer to
      // neither -- and those were the ones still sweeping the terminal on church.
      /** Push any span lying too close to a chip out around it, on the finished geometry.
       *
       *  The terminals already had this; the chips only had a waypoint slide before straightening, so a span
       *  that ended up beside a chip *after* offsetting and shortcutting had nothing left to move it. Its own
       *  pads are exempt: landing on them is the point. */
      const clearChips = (rail: Vec2[], net: "pwr" | "gnd", f: boolean[]): Vec2[] => {
        const pads = padsFor(f).filter((p) => !(isOrigin(p.pwr) && isOrigin(p.gnd)));
        const out: Vec2[] = [rail[0]!];
        for (let i = 1; i < rail.length; i++) {
          const a = out[out.length - 1]!;
          const b = rail[i]!;
          const hit = pads.find((p) => {
            const own = net === "pwr" ? p.pwr : p.gnd;
            if (len(sub(a, own)) < clearW * 1.2 || len(sub(b, own)) < clearW * 1.2) return false;
            return segNearSeg(a, b, p.pwr, p.gnd) < clearW;
          });
          if (hit) {
            const c = { x: (hit.pwr.x + hit.gnd.x) / 2, y: (hit.pwr.y + hit.gnd.y) / 2 };
            const d = unit(sub(b, a));
            const n = leftOf(d);
            const side = sideOf(a, d, c) > 0 ? -1 : 1;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const w = add(mid, scale(n, side * clearW * 1.6));
            const better =
              segNearSeg(a, w, hit.pwr, hit.gnd) >= clearW &&
              segNearSeg(w, b, hit.pwr, hit.gnd) >= clearW &&
              onBody(a, w) && onBody(w, b);
            if (better) out.push(w);
          }
          out.push(b);
        }
        return out;
      };

      const clearTerm = (rail: Vec2[], forbidden: Vec2): Vec2[] => {
        const out: Vec2[] = [rail[0]!];
        for (let i = 1; i < rail.length; i++) {
          const a = out[out.length - 1]!, b = rail[i]!;
          if (segPointDist(a, b, forbidden) >= termClear) {
            out.push(b);
            continue;
          }
          // Step aside, perpendicular to the run, on the far side from the terminal.
          const d = unit(sub(b, a));
          const n = leftOf(d);
          const side = sideOf(a, d, forbidden) > 0 ? -1 : 1;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const w = add(mid, scale(n, side * termClear * 1.2));
          const ok =
            segPointDist(a, w, forbidden) >= termClear &&
            segPointDist(w, b, forbidden) >= termClear &&
            onBody(a, w) && onBody(w, b);
          if (ok) out.push(w);
          out.push(b);
        }
        return out;
      };
      /**
       * Pull a run back out of the chip it has just landed on.
       *
       * Landing is not what puts copper on an LED; *leaving* is. The corridor governs the waypoints and
       * straightening governs the shortcuts, but the segment out of a pad answers to neither — so it was free
       * to set off straight across the body toward the other net's pad, and over the bundled patterns it
       * reached that far pad at 27 of 304 landings. Each one is the two rails meeting on the chip.
       *
       * Same shape as clearTerm: where a segment leaving a pad reaches more than PAD_INTRUDE_MAX of the way
       * across its own chip, step off the pad on the far side first, so the run departs away from the body
       * and comes back round. Additive, so it can only be applied where it is safe — if the detour would
       * leave the material or cross any chip, the run is left exactly as it was.
       */
      const padOf = new Map<string, { own: Vec2; mate: Vec2 }>();
      for (const t of targets) {
        padOf.set(ptKey(t.legs[0]), { own: t.legs[0], mate: t.legs[1] });
        padOf.set(ptKey(t.legs[1]), { own: t.legs[1], mate: t.legs[0] });
      }
      const hitsAnyBody = (a: Vec2, b: Vec2): boolean => bodies.some(([c, d]) => segsCross(a, b, c, d));
      const clearPads = (rail: Vec2[]): Vec2[] => {
        const out: Vec2[] = [rail[0]!];
        for (let i = 1; i < rail.length; i++) {
          const a = out[out.length - 1]!, b = rail[i]!;
          // Either end of the segment can be the pad: leaving one, or arriving at one from beyond it. Both
          // put copper across the body — the arrival case is a run that comes in over the chip to land.
          const pad = padOf.get(ptKey(a)) ?? padOf.get(ptKey(b));
          if (!pad) {
            out.push(b);
            continue;
          }
          const gap2 = dist2(pad.own, pad.mate);
          if (gap2 < 1e-18) {
            out.push(b);
            continue;
          }
          // How far along its own chip's axis does this departure reach?
          const ax = sub(pad.mate, pad.own);
          let reach = 0;
          for (let k = 0; k <= 12; k++) {
            const u = k / 12;
            const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
            reach = Math.max(reach, ((m.x - pad.own.x) * ax.x + (m.y - pad.own.y) * ax.y) / gap2);
          }
          if (reach <= PAD_INTRUDE_MAX) {
            out.push(b);
            continue;
          }
          const away = add(pad.own, scale(unit(sub(pad.own, pad.mate)), Math.sqrt(gap2) * PAD_STEP_OFF));
          if (onBody(a, away) && onBody(away, b) && !hitsAnyBody(a, away) && !hitsAnyBody(away, b)) out.push(away);
          out.push(b);
        }
        return out;
      };
      const padClear = (ts: Trace2D[]): Trace2D[] => ts.map((t) => ({ ...t, pts: clearPads(t.pts) }));


      const rawGnd = asTree(r.gnd.paths.map((b: Vec2[]) => dedupe(dodgeChips(b, targets, onBody))), "gnd", term.gnd, padsOf(f, "gnd"))
        .map((t) => ({ ...t, pts: clearChips(clearTerm(t.pts, term.pwr), "gnd", f) }));
      const rawPwr = asTree(r.pwr.paths.map((b: Vec2[]) => dedupe(dodgeChips(b, targets, onBody))), "pwr", term.pwr, padsOf(f, "pwr"))
        .map((t) => ({ ...t, pts: clearChips(clearTerm(t.pts, term.gnd), "pwr", f) }));
      const outPwr = straighten(
        rawPwr, [...keepPwr, ...junctions(rawPwr)], bodies, onBody, rawGnd, clearW, overlapTol,
        term.gnd, termClear, [term.pwr, term.gnd], termClear * 2.5,
      );
      const outGnd = straighten(
        rawGnd, [...keepGnd, ...junctions(rawGnd)], bodies, onBody, outPwr, clearW, overlapTol,
        term.pwr, termClear, [term.pwr, term.gnd], termClear * 2.5,
      );
      // Straightening is only worth having where it is free. It shortens runs a lot -- akde-decagon 2967 ->
      // 1948 -- but a direct route is direct for *both* nets, so taken unconditionally it drives them together
      // (puffin overlap 15% -> 26%) and can push copper under a chip. Both plans are built and the objective
      // decides: shorts first, then overlap, and only then length.
      // Both candidates get the pad clearance before the objective picks between them, so neither can win by
      // carrying an overshoot the other paid to avoid.
      const straightened = padClear([...outPwr, ...outGnd]);
      const asRouted = padClear([...rawPwr, ...rawGnd]);
      const keep = [...keepPwr, ...keepGnd];
      const a = trimAtOwnJoins(straightened, keep);
      const b = trimAtOwnJoins(asRouted, keep);
      return score(a, f) <= score(b, f) ? a : b;
    };
    // Two visiting orders, judged by the same objective. The shared one walks both nets through the hinges in
    // step, which keeps them parallel; the per-net one orders each net's own pads, which stops a net zigzagging
    // across itself to reach a pad it could have taken in sequence (akde-square's repeated tape 29% -> 21% of
    // its length, a third less copper) but lets the two wander apart -- akde-decagon's repeated tape goes the
    // other way, 5% -> 22%, and puffin picks up crossings. Neither wins everywhere, so the score decides.
    if (perNetOrder) return finish(routeBoth(true, branching));
    // Both visiting orders, judged by the same objective: shared walks the nets through the hinges in step and
    // keeps them parallel, per-net orders each net's own pads and stops it zigzagging across itself. Neither
    // wins everywhere -- akde-hex needs per-net (its repeated tape is 42% without it), akde-decagon needs
    // shared -- so the score decides.
    const shared = finish(routeBoth(false, branching));
    const perNet = finish(routeBoth(true, branching));
    return score(perNet, f) < score(shared, f) ? perNet : shared;
  };


  // Descend from each seed by single flips, first improvement, and keep the best arrangement found. No one
  // seed wins everywhere -- the geometric seed beats all-false on akde-decagon and loses on puffin -- and
  // three descents on a handful of LEDs is cheap enough to run on every edit.
  let flip = pin(seeds[0]!.slice());
  let best = build(flip);
  let bestS = score(best, flip);
  for (const seed of seeds) {
    const f = pin(seed.slice());
    let tr = build(f);
    let sc = score(tr, f);
    for (let sweep = 0; sweep < order.length && sc > 0; sweep++) {
      let moved = false;
      for (let i = 0; i < order.length && sc > 0; i++) {
        if (targets[order[i]!]!.pinned !== undefined) continue; // the author fixed this one
        f[i] = !f[i];
        const cand = build(f);
        const cs = score(cand, f);
        if (cs < sc) {
          tr = cand;
          sc = cs;
          moved = true;
        } else {
          f[i] = !f[i];
        }
      }
      if (!moved) break;
    }
    if (sc < bestS) {
      bestS = sc;
      best = tr;
      flip = f.slice();
    }
  }

  // An LED's own pad can carry the connection on to the next LED, instead of the run going back for it. Tried
  // once here rather than inside the search: it cuts cross-net overlap and copper (puffin 16% -> 13%, akde-hex
  // 1543 -> 1370) but breaks up the chain that keeps the two nets parallel, so on some patterns it adds a
  // PWR/GND crossing -- a short. The score ranks crossings above overlap, so it is kept only where it does not.
  merging = true;
  const merged = build(flip);
  if (score(merged, flip) < bestS) {
    best = merged;
    bestS = score(merged, flip);
  } else {
    merging = false;
  }

  branching = true;
  const branched = build(flip);
  if (score(branched, flip) < bestS) {
    best = branched;
    bestS = score(branched, flip);
  } else {
    branching = false;
  }

  // With polarity settled, try each net working the tour from either end and keep the best. Four builds.
  for (const [dp, dg] of [[false, false], [true, false], [false, true], [true, true]] as [boolean, boolean][]) {
    const keepP: boolean = dirPwr;
    const keepG: boolean = dirGnd;
    dirPwr = dp;
    dirGnd = dg;
    const cand = build(flip);
    const sc = score(cand, flip);
    if (sc < bestS) {
      bestS = sc;
      best = cand;
    } else {
      dirPwr = keepP;
      dirGnd = keepG;
    }
  }

  // Squaring runs last, on the finished plan, and only if it does not score worse. Kept out of the polarity
  // search deliberately: offered as a candidate inside it, the extra options changed the descent path and the
  // search settled in worse local optima on some patterns (over-LED 3 -> 5 across the bundled set) even though
  // no squared candidate ever outscored an unsquared one. As a post-step it can only improve or leave alone.
  for (let i = 0; i < order.length; i++) {
    const t = targets[order[i]!]!;
    const [l0, l1] = t.legs;
    pads[t.slot] = flip[i] ? { pwr: l1, gnd: l0 } : { pwr: l0, gnd: l1 };
  }

  const withRes = breakForResistors(best, circuit.resistors ?? [], tapeW);
  // Across the break the part needs only its own half-gap plus a pad either side: the terminals run square
  // to the rail now, not along it, so a much shorter run will take one.
  const toFlat = (mm: number): number => (mm * tapeW) / TAPE_MM;
  const swReach = toFlat(SWITCH_GAP_MM / 2 + slide_switch.pads[0]!.w);
  const withSw = breakRuns(withRes.traces, circuit.switches ?? [], toFlat(SWITCH_GAP_MM), {
    before: swReach,
    after: swReach,
  });
  const swTraces = [
    ...withSw.traces,
    ...withSw.placed.flatMap((span) =>
      switchLand(
        span,
        toFlat(SWITCH_PITCH_MM),
        toFlat(slide_switch.pads[0]!.h),
        toFlat(slide_switch.pads[0]!.w),
      ),
    ),
  ];
  return {
    traces: swTraces,
    pads,
    unreachable,
    resistors: withRes.placed,
    switches: withSw.placed,
  };
}

/**
 * The copper a 1206 resistor replaces, in millimetres: the bare span between its two pads.
 *
 * From fab-modules `pcb.py` (`class R_1206`) by way of `ocaml/footprints.ml` — pads .064 wide on .12
 * centres, so 1.42mm of pattern between them. It was 6.5 before, a through-hole body I had picked myself;
 * the part in the library is a 1206, and its gap is a quarter of that.
 */
export const RESISTOR_MM =
  R_1206.pads[1]!.cx - R_1206.pads[0]!.cx - R_1206.pads[0]!.w;

/**
 * The switch's pad pitch, in millimetres — from `pcb.py`'s `slide_switch` (C&K AYZ0102AGRLC) by way of
 * `ocaml/footprints.ml`. Three pads, so twice this across the lot.
 *
 * The break is one pitch and falls between the second pad and the third, so two sit on one side of it and
 * one on the other.
 */
export const SWITCH_PITCH_MM = slide_switch.pads[1]!.cx - slide_switch.pads[0]!.cx;

/**
 * The copper a switch takes out, in millimetres.
 *
 * The rail steps across the part, so the gap has to let the land reaching the live throw pass the
 * common's without touching it: a pad's width for each, plus a margin between them. Narrower and the two
 * lands meet beside the common, joining the incoming rail straight to the outgoing one and bypassing the
 * switch entirely.
 */
export const SWITCH_GAP_MM = 2 * slide_switch.pads[0]!.h + 0.6;

/**
 * Break the run each resistor sits on.
 *
 * Both of a resistor's ends land on the same rail, so copper running underneath it shorts it out and the LEDs
 * see the full battery — the run is genuinely cut in two rather than narrowed, which is all an LED needs.
 * Either rail will do: a resistor in series limits the current the same on the way out as on the way back.
 *
 * Each half comes back as an ordinary run, so everything downstream — the strips file, the carrier and its
 * tabs, the canvas, the folded model — handles it without knowing resistors exist. The resistor is snapped to
 * the nearest run: it is stored as a point in the pattern, and the routes under it are re-planned whenever
 * the circuit changes.
 */
export function breakForResistors(
  traces: Trace2D[],
  resistors: { x: number; y: number }[],
  tapeW: number,
): { traces: Trace2D[]; placed: ResistorSpan[] } {
  // The body in the pattern's own units: the tape is TAPE_MM wide and `tapeW` units, so this follows it.
  return breakRuns(traces, resistors, (RESISTOR_MM * tapeW) / TAPE_MM);
}

/**
 * Break each run where a part sits, leaving `gap` of bare pattern for it to bridge.
 *
 * Shared by resistors and switches, which differ only in how much copper they take out: a resistor's body,
 * or one pin pitch of a header. Each half comes back as an ordinary run, so nothing downstream needs to know
 * either exists.
 */
export function breakRuns(
  traces: Trace2D[],
  parts: { x: number; y: number }[],
  gap: number,
  /**
   * Copper the part needs either side of the break's centre, beyond the break itself.
   *
   * A resistor straddles its gap evenly and needs no more than it. A switch does not: its terminals run on
   * past the break, so it wants a half-pitch of copper behind the cut and three of them in front. Reserving
   * only the gap seated the part with a terminal hanging off the end of the run, on bare pattern, where it
   * connects to nothing.
   */
  reach: { before: number; after: number } = { before: gap, after: gap },
): { traces: Trace2D[]; placed: PartSpan[] } {
  const placed: PartSpan[] = [];
  if (!parts.length) return { traces, placed };
  const body = gap;
  let out = traces;
  for (const r of parts) {
    let bestRun = -1, bestSeg = -1, bestT = 0, bestD = Infinity;
    out.forEach((t, ti) => {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        const l2 = dist2(a, b);
        if (l2 < 1e-18) continue;
        const u = Math.max(0, Math.min(1, ((r.x - a.x) * (b.x - a.x) + (r.y - a.y) * (b.y - a.y)) / l2));
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const d = Math.hypot(r.x - p.x, r.y - p.y);
        if (d < bestD) { bestD = d; bestRun = ti; bestSeg = i; bestT = u; }
      }
    });
    if (bestRun < 0) continue; // no copper to sit on — nothing to break
    // Slide the part inboard if it was dropped near an end. A run has to keep a half-body either side or
    // the break takes one of its ends off entirely, and the part was simply not placed -- a click that did
    // nothing at all, with no way to tell why.
    // Facing the way it was dropped if the run allows it, and turned round if only the other way fits: a
    // part in series works the same either way about, and refusing to seat one on a short run helps nobody.
    const forward = fitWithin(out[bestRun]!, bestSeg, bestT, reach.before, reach.after);
    const moved = forward ?? fitWithin(out[bestRun]!, bestSeg, bestT, reach.after, reach.before);
    const split = moved
      ? splitRun(out, bestRun, moved.seg, moved.t, body)
      : { traces: out, span: null };
    out = split.traces;
    // Turned round, the span is reported end-for-end, which is how the part knows which way it faces.
    if (split.span) {
      placed.push(forward ? split.span : { a: split.span.b, b: split.span.a, net: split.span.net });
    }
  }
  return { traces: out, placed };
}

/**
 * The land copper under a switch: a stub to the common, and a stub across to one throw.
 *
 * The rail steps across the part rather than running under it. It arrives at the common, which sits in the
 * middle of the break; the outgoing run leaves from a throw one pitch to the side. The other throw is a
 * pitch the other way, off the copper entirely — which is what opens the circuit in that position, and it
 * needs no window cut to do it.
 *
 * Both stubs are a pad's width, not the tape's: at `.098in` centres, two full-width stubs would meet
 * between the terminals and short the part to itself.
 */
function switchLand(span: PartSpan, pitch: number, padW: number, padL: number): Trace2D[] {
  const { a, b } = span;
  const d = sub(b, a);
  const L = len(d);
  if (L < 1e-12) return [];
  const u = { x: d.x / L, y: d.y / L };
  const p = { x: -u.y, y: u.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; // the common, in the middle of the break
  const live = { x: mid.x + p.x * pitch, y: mid.y + p.y * pitch };
  // Each land runs half a pad past its terminal, so the whole pad has copper under it. Stopped dead on the
  // centre, half of each pad sat over bare pattern and the terminal made contact along one edge if at all.
  const over = padL / 2;
  const commonEnd = { x: mid.x + u.x * over, y: mid.y + u.y * over };
  const liveEnd = { x: live.x + p.x * over, y: live.y + p.y * over };
  // Out from the far cut end, across, then back: an L. Straight from `b` to the live throw the land would
  // cut the corner and pass within a pad's width of the common's, joining the two rails around the part.
  const corner = { x: b.x + p.x * pitch, y: b.y + p.y * pitch };
  return [
    { net: span.net, pts: [a, commonEnd], width: padW },
    { net: span.net, pts: [b, corner, liveEnd], width: padW },
  ];
}

/**
 * Move a break inboard until a half-body fits either side of it, or report that the run is too short.
 *
 * Measured along the run, so it stays on the copper as the run bends.
 */
function fitWithin(
  run: Trace2D,
  seg: number,
  t: number,
  before: number,
  after: number,
): { seg: number; t: number } | null {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < run.pts.length; i++) {
    const l = len(sub(run.pts[i]!, run.pts[i - 1]!));
    segs.push(l);
    total += l;
  }
  // Enough copper either side of the break's centre to seat the part.
  if (total <= before + after) return null;
  let at = 0;
  for (let i = 0; i < seg - 1; i++) at += segs[i]!;
  at += (segs[seg - 1] ?? 0) * t;
  const want = Math.min(Math.max(at, before), total - after);
  // Back to a segment and a fraction along it.
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    if (want <= acc + segs[i]! || i === segs.length - 1) {
      const f = segs[i]! > 0 ? Math.min(Math.max((want - acc) / segs[i]!, 0), 1) : 0;
      return { seg: i + 1, t: f };
    }
    acc += segs[i]!;
  }
  return null;
}

/** Split run `ri` at a point, leaving `body` of bare pattern between the two halves. */
function splitRun(
  traces: Trace2D[],
  ri: number,
  seg: number,
  t: number,
  body: number,
): { traces: Trace2D[]; span: ResistorSpan | null } {
  const run = traces[ri]!;
  const a = run.pts[seg - 1]!, b = run.pts[seg]!;
  const at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  // Walk back and forward along the run by half the body, so the gap is centred on the resistor.
  const head = [...run.pts.slice(0, seg), at];
  const tail = [at, ...run.pts.slice(seg)];
  const first = trimEnd(head, body / 2);
  const second = trimEnd([...tail].reverse(), body / 2).reverse();
  const kept: Trace2D[] = [];
  for (const pts of [first, second]) if (pts.length >= 2) kept.push({ net: run.net, pts });
  // A run too short to break either side keeps its copper rather than vanishing: better a resistor that
  // needs its leads bent than a branch that silently loses its supply.
  if (kept.length < 2) return { traces, span: null };
  const span = { a: first[first.length - 1]!, b: second[0]!, net: run.net };
  return { traces: [...traces.slice(0, ri), ...kept, ...traces.slice(ri + 1)], span };
}

/** Drop `back` of length from the end of a polyline. */
function trimEnd(pts: Vec2[], back: number): Vec2[] {
  let left = back;
  const out = [...pts];
  while (out.length >= 2) {
    const a = out[out.length - 2]!, b = out[out.length - 1]!;
    const l = len(sub(b, a));
    if (l > left) {
      const f = (l - left) / l;
      out[out.length - 1] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      return out;
    }
    left -= l;
    out.pop();
  }
  return out;
}

/**
 * Turn a net's walk into the tape you would actually lay for it.
 *
 * The walk is one path through every pad of the net, so wherever it has to come back the way it went it
 * retraces its own steps and the strip is laid twice over. That is electrically harmless -- one net, one
 * potential -- but it is wasted tape and it reads as a mistake. Since every segment belongs to the same net,
 * laying each *once* leaves exactly the same circuit: the walk becomes a tree.
 *
 * Duplicate segments are dropped, then what is left is broken into the longest chains that can be laid in one
 * pass, so this trades strip count for tape length and legibility.
 */
function asTree(branches: Vec2[][], net: "pwr" | "gnd", first: Vec2, required: Vec2[]): Trace2D[] {
  const flat = branches.filter((b) => b.length >= 2);
  if (!flat.length) return branches.length ? [{ pts: branches[0]!, net }] : [];

  const nodes = new Map<string, Vec2>();
  const edges = new Map<string, { a: string; b: string; w: number }>();
  for (const pts of flat) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const ka = ptKey(a), kb = ptKey(b);
      if (ka === kb) continue;
      nodes.set(ka, a);
      nodes.set(kb, b);
      // Keyed, so a segment walked twice is stored once.
      edges.set(chordKey(a, b), { a: ka, b: kb, w: Math.sqrt(dist2(a, b)) });
    }
  }
  if (!edges.size) return [{ pts: flat[0]!, net }];

  // Spanning tree, shortest edges first. Deduplicating segments was not enough: where the walk went out one
  // way and came back another, the union of the two contains a *cycle*, and every point on it is reached
  // twice over. One net needs exactly one path to each of its pads, so cycle-closing edges are dropped.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(k) !== r) { const nxt = parent.get(k)!; parent.set(k, r); k = nxt; }
    return r;
  };
  for (const k of nodes.keys()) parent.set(k, k);

  const adj = new Map<string, Set<string>>();
  for (const k of nodes.keys()) adj.set(k, new Set());
  const sorted = [...edges.values()].sort((x, y) => x.w - y.w || (x.a < y.a ? -1 : 1));
  for (const e of sorted) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) continue; // would close a loop: that is the double connection
    parent.set(ra, rb);
    adj.get(e.a)!.add(e.b);
    adj.get(e.b)!.add(e.a);
  }

  // Prune dead ends. The tree still holds waypoints the walk merely passed through on a detour it no longer
  // needs; a branch ending anywhere that is not a pad or a terminal carries no current.
  const keep = new Set(required.map(ptKey));
  keep.add(ptKey(first));
  for (;;) {
    const dead = [...adj.keys()].filter((k) => adj.get(k)!.size === 1 && !keep.has(k));
    if (!dead.length) break;
    for (const k of dead) {
      for (const n of adj.get(k)!) adj.get(n)!.delete(k);
      adj.get(k)!.clear();
    }
  }

  // Lay it out as the longest runs that can be taped in one pass, starting at this net's own terminal.
  const out: Trace2D[] = [];
  const firstKey = ptKey(first);
  const starts = [...adj.keys()].sort((a, b) => {
    if (a === firstKey) return -1;
    if (b === firstKey) return 1;
    return (adj.get(a)!.size - adj.get(b)!.size) || (a < b ? -1 : 1);
  });
  for (const from of starts) {
    while (adj.get(from)!.size) {
      const chain: Vec2[] = [nodes.get(from)!];
      let at = from;
      for (;;) {
        const options = [...adj.get(at)!];
        if (!options.length) break;
        // At a junction, carry straight on. Taking whichever branch came first made a strip turn a corner at
        // every fork, so one continuous piece of tape read as a handful of fragments; the count of pieces is
        // fixed by the tree's leaves, but which edges each piece is made of is not.
        let to = options[0]!;
        if (options.length > 1 && chain.length >= 2) {
          const came = unit(sub(nodes.get(at)!, chain[chain.length - 2]!));
          let bestDot = -Infinity;
          for (const cand of options) {
            const d = unit(sub(nodes.get(cand)!, nodes.get(at)!));
            const dot = came.x * d.x + came.y * d.y;
            if (dot > bestDot) { bestDot = dot; to = cand; }
          }
        }
        adj.get(at)!.delete(to);
        adj.get(to)!.delete(at);
        chain.push(nodes.get(to)!);
        at = to;
      }
      if (chain.length >= 2) out.push({ pts: chain, net });
    }
  }
  return out.length ? out : [{ pts: flat[0]!, net }];
}

/**
 * The points where one run of a net hangs off another.
 *
 * A net is laid as several runs that meet at shared points, and those meeting points hold the tree together.
 * Straightening must treat them as anchors: shortcutting one run past the vertex another attaches to silently
 * cuts that run -- and everything beyond it -- off from the battery. That is an open circuit, not a cosmetic
 * problem, so it outranks any length or overlap the shortcut would buy.
 */
function junctions(traces: Trace2D[]): Vec2[] {
  const count = new Map<string, { p: Vec2; n: number }>();
  for (const t of traces) {
    // Per run, count a point once: a run that revisits a point does not make it a junction.
    for (const key of new Set(t.pts.map(ptKey))) {
      const at = t.pts.find((p) => ptKey(p) === key)!;
      const rec = count.get(key);
      if (rec) rec.n++;
      else count.set(key, { p: at, n: 1 });
    }
  }
  return [...count.values()].filter((r) => r.n > 1).map((r) => r.p);
}

/**
 * Pull each run straight where it may be.
 *
 * The corridor is a graph, so a route is a sequence of hops between edge crossing points -- shortest *in the
 * graph*, which is not the same as shortest on the material. Two pads with clear material between them come
 * out as a dogleg via whatever crossing points lay on the way. Wherever the direct line between two points of
 * a run is legal, the vertices between them are dropped.
 *
 * A shortcut has to keep every promise the route already made, so it is taken only if it stays on the body,
 * clears every chip by a tape width, and does not cross the other net. Pads and terminals are anchors -- a
 * shortcut may never skip past one, or the tape would stop touching what it is there to connect.
 */
function straighten(
  traces: Trace2D[],
  keep: Vec2[],
  bodies: [Vec2, Vec2][],
  onBody: (a: Vec2, b: Vec2) => boolean,
  others: Trace2D[],
  clear: number,
  apart: number,
  forbidden: Vec2,
  forbiddenClear: number,
  terminals: [Vec2, Vec2],
  near: number,
): Trace2D[] {
  const anchors = new Set(keep.map(ptKey));
  const legal = (a: Vec2, b: Vec2): boolean => {
    if (!onBody(a, b)) return false;
    // A shortcut may not sweep across the other net's battery terminal.
    if (segPointDist(a, b, forbidden) < forbiddenClear) return false;
    const L = Math.sqrt(dist2(a, b));
    const steps = Math.max(2, Math.ceil(L / (clear * 0.5)));
    for (const [c, d] of bodies) {
      // No shortcut may pass through a chip, pad exemption or not. The exemption below is about *proximity*
      // near the pad the run lands on; a run that actually crosses the body is over the part either way.
      if (segsCross(a, b, c, d)) return false;
      // Exempting a whole chip because the shortcut *ends* on one of its pads is too generous: the run can
      // then lie alongside that chip's body all the way in. Only the pad's own neighbourhood is exempt, which
      // is the same rule the under-chip measure applies.
      const own = anchors.has(ptKey(c)) ? c : anchors.has(ptKey(d)) ? d : null;
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        if (own && Math.sqrt(dist2(m, own)) <= clear * 1.2) continue;
        if (segPointDist(c, d, m) < clear) return false;
      }
    }
    // Right at the battery the two nets are unavoidably close: their pads sit about a strip and a half apart, so
    // every departure fails the separation rule below and the run is left with a hard turn the moment it leaves
    // the pad. Near the terminals only crossing is forbidden, not proximity.
    const nearBattery =
      len(sub(a, terminals[0])) < near || len(sub(a, terminals[1])) < near ||
      len(sub(b, terminals[0])) < near || len(sub(b, terminals[1])) < near;

    // Keep clear of the other net, not merely uncrossed. Directness and separation pull against each other --
    // the shortest route between the same two regions is much the same for both nets, so straightening both
    // makes them parallel. A shortcut is therefore only taken where it does not come within a tape width of
    // the other net: the run stays bent exactly where being direct would mean shadowing.
    for (const o of others) {
      for (let i = 1; i < o.pts.length; i++) {
        const gap = segNearSeg(a, b, o.pts[i - 1]!, o.pts[i]!);
        if (nearBattery ? gap <= 0 : gap < apart) return false;
      }
    }
    return true;
  };

  return traces.map((t) => {
    const pts = t.pts;
    const out: Vec2[] = [pts[0]!];
    let i = 0;
    while (i < pts.length - 1) {
      // Reach as far ahead as the direct line allows, stopping at the first anchor on the way.
      let best = i + 1;
      for (let j = i + 2; j < pts.length; j++) {
        if (anchors.has(ptKey(pts[j - 1]!))) break; // cannot skip past a pad or a terminal
        if (!legal(pts[i]!, pts[j]!)) continue;
        best = j;
      }
      out.push(pts[best]!);
      i = best;
    }
    return { pts: out, net: t.net };
  });
}

/** Binary min-heap keyed by string, for the corridor search frontier. */
class MinHeap {
  private readonly keys: string[] = [];
  private readonly cost: number[] = [];

  push(key: string, c: number): void {
    this.keys.push(key);
    this.cost.push(c);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p]! <= this.cost[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): string | null {
    if (!this.keys.length) return null;
    const top = this.keys[0]!;
    const lastKey = this.keys.pop()!;
    const lastCost = this.cost.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.cost[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.cost[l]! < this.cost[m]!) m = l;
        if (r < this.keys.length && this.cost[r]! < this.cost[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.cost[a], this.cost[b]] = [this.cost[b]!, this.cost[a]!];
  }
}

/** Unordered key for a chord between two midpoints. */
function chordKey(a: Vec2, b: Vec2): string {
  const ka = ptKey(a), kb = ptKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Whether the straight line between two boundary points stays on the face. Sampled, so a chord that leaves
 *  and re-enters a concave face is rejected too. */
function chordInside(f: FlatFace, a: Vec2, b: Vec2, faces: FlatFace[], tapeW: number): boolean {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const half = tapeW * 0.5;
  const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
  const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
  // Sampled against the tape, not a fixed eight steps: a long chord checked at eight points can pass while a
  // stretch between two of them hangs off the material.
  const steps = Math.max(8, Math.ceil(L / half));
  for (let k = 1; k < steps; k++) {
    const u = k / steps;
    const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    if (!pointInPolyLocal(f.poly, m)) return false;
    // The strip's edges may leave this tile onto a neighbour -- that is just crossing a crease -- but they may
    // not leave the material altogether.
    if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) return false;
    if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) return false;
  }
  return true;
}

/** Even-odd point-in-polygon, local so this does not depend on face indices the way `pointInFace` does. */
function pointInPolyLocal(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Faces reachable from `start` by travelling over the material. */
function reachableFaces(c: Corridor, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const m of c.mids.get(at) ?? []) {
      for (const f of c.faceOf.get(ptKey(m)) ?? []) {
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(f);
      }
    }
  }
  return seen;
}

/** Slide any waypoint sitting on an occupied hinge to that hinge's nearer end corner, where doing so stops
 *  the rail from crossing the chip. Corners are pattern vertices, so this cannot push copper off the body. */
function dodgeChips(pts: Vec2[], targets: Target[], onBody: (a: Vec2, b: Vec2) => boolean): Vec2[] {
  const byHinge = new Map<string, Target>();
  for (const t of targets) byHinge.set(ptKey(t.hinge), t);
  const out = pts.slice();
  for (let i = 1; i < out.length - 1; i++) {
    const t = byHinge.get(ptKey(out[i]!));
    if (!t) continue;
    const a = out[i - 1]!, b = out[i + 1]!;
    const body: [Vec2, Vec2] = [t.legs[0], t.legs[1]];
    if (!segsCross(a, out[i]!, ...body) && !segsCross(out[i]!, b, ...body)) continue;
    // Try each end corner; take the first that clears the chip on both sides.
    for (const end of [t.ends[0], t.ends[1]].sort((x, y) => dist2(x, a) - dist2(y, a))) {
      // The corner can be a long way off, and a long jump to it can leave the material -- so the dodge only
      // counts if it clears the chip *and* stays on the body.
      if (
        !segsCross(a, end, ...body) &&
        !segsCross(end, b, ...body) &&
        onBody(a, end) &&
        onBody(end, b)
      ) {
        out[i] = end;
        break;
      }
    }
  }
  return out;
}

/**
 * The pattern's own travel network: every face centre, joined to the midpoint of each hinge it owns. Both
 * kinds of node lie inside the body and every edge runs from a face centre to a point on that same face's
 * boundary, so a path over this graph never leaves the silhouette -- which is what keeps copper on the
 * material, and what makes it follow the tiling instead of cutting across it.
 */
interface Corridor {
  /** Per face: the midpoints of its own edges — the ways in and out of that tile. */
  mids: Map<number, Vec2[]>;
  /** Faces owning each midpoint, by key. A midpoint on a shared edge belongs to both tiles, which is what
   *  makes it a crossing between them. */
  faceOf: Map<string, number[]>;
  point: Map<string, Vec2>;
  /** Per face: which midpoint pairs may be joined directly, i.e. whose chord stays on the tile. */
  chords: Map<number, Set<string>>;
  /** Extra cost for crossing at this node — a mountain fold, a steep valley or a cut. */
  cost: Map<string, number>;
}

/** Unordered key for the edge between two vertex ids. */
const edgeKeyOf = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * The pattern's travel network. Nodes are **edge midpoints**, and crossing a tile means taking a chord from
 * one of its edge midpoints to another — a straight line between two boundary points of a single face, so it
 * stays on the material.
 *
 * Routing through face *centres* instead, as this did before, forces every path between two tiles through a
 * single point, so both nets solve the same problem and get the same answer: that is why tolling a shared
 * waypoint diverted nothing even at 400x. Chords give a face many ways through, so the second net has
 * somewhere else to go.
 */
function buildCorridor(faces: FlatFace[], gaps: GapEdge[], foldPenalty: number, tapeW: number): Corridor {
  const mids = new Map<number, Vec2[]>();
  const faceOf = new Map<string, number[]>();
  const point = new Map<string, Vec2>();
  const cost = new Map<string, number>();

  // Crossing penalties, after Nakaya et al., "4D Leaf Circuits" (SCF '25), Algorithm 1.
  //
  // Their fatigue test is the reason: a trace carried over a *mountain* fold shows a sharp rise in resistance
  // and fractures within a hundred folding cycles, while the same trace on a valley fold stays flat. So a
  // mountain crossing is charged the pattern's bounding-box diagonal -- more than any single step in the graph,
  // which makes the router take any available detour, while still leaving a mountain crossable when the tile is
  // reachable no other way. They apply the same penalty to a valley folded past 170 degrees, as such a crease
  // closes on itself and can short across.
  //
  // Cuts are ours to add: the material is severed there, so tape spanning one is bridging a hole rather than
  // lying on a substrate.
  const penaltyOf = new Map<string, number>();
  for (const g of gaps) {
    const steepValley = g.dihedral != null && Math.abs(g.dihedral) > 170;
    const bad = g.assignment === "M" || g.assignment === "C" || (g.assignment === "V" && steepValley);
    if (bad) penaltyOf.set(edgeKeyOf(g.verts[0], g.verts[1]), foldPenalty);
  }
  const gapKeys = new Set(gaps.map((g) => ptKey(g.point)));

  faces.forEach((f, fi) => {
    const list: Vec2[] = [];
    const n = f.verts.length;
    for (let k = 0; k < n; k++) {
      // Canonical edge direction: always measure from the lower vertex id. Both faces sharing an edge must
      // compute bit-identical crossing points or the nodes fail to glue and the two tiles look disconnected
      // -- and "a quarter along" from one face is "three quarters along" from the other, which is not the
      // same arithmetic. (Midpoints hid this, being symmetric.)
      const va = f.verts[k]!, vb = f.verts[(k + 1) % n]!;
      const fwd = va <= vb;
      const pa = fwd ? f.poly[k]! : f.poly[(k + 1) % n]!;
      const pb = fwd ? f.poly[(k + 1) % n]! : f.poly[k]!;
      // Two crossing points per edge rather than one. With a single midpoint, both nets have to cross a
      // shared edge at the very same point, so they are forced together at every tile boundary -- the last
      // structural cause of overlap. Two lets PWR cross at one third and GND at two thirds.
      for (const u of EDGE_CROSSINGS) {
        const m = { x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u };
        const key = ptKey(m);
        list.push(m);
        point.set(key, m);
        const owners = faceOf.get(key) ?? [];
        if (!owners.includes(fi)) owners.push(fi);
        faceOf.set(key, owners);
        const pen = penaltyOf.get(edgeKeyOf(va, vb));
        if (pen) cost.set(key, pen);
      }
    }
    mids.set(fi, list);
  });

  // A chord is only a way through if it stays on the tile. Concave faces have pairs of edge midpoints whose
  // straight line leaves the material, and taking one would put copper off the body.
  const chords = new Map<number, Set<string>>();
  faces.forEach((f, fi) => {
    const list = mids.get(fi) ?? [];
    const ok = new Set<string>();
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (chordInside(f, list[a]!, list[b]!, faces, tapeW)) {
          ok.add(chordKey(list[a]!, list[b]!));
        }
      }
    }
    chords.set(fi, ok);
  });
  // Gap midpoints are authoritative crossings and are already edge midpoints, so they need no special node;
  // this only asserts that assumption holds, and drops any that somehow do not line up.
  for (const key of gapKeys) {
    if (!point.has(key)) continue;
  }
  return { mids, faceOf, point, chords, cost };
}

/**
 * Waypoints carrying the bus from tile `from` to tile `to`, exclusive of the pads. Empty when they are the
 * same tile or nothing connects them (then the hop stays straight, and the LED is reported unreachable
 * upstream).
 *
 * `taken` makes a waypoint dearer each time the other net has already used it, which with chords available
 * actually buys a different route rather than the same one at a higher price.
 */
function corridorPath(
  c: Corridor,
  from: number,
  to: number,
  blocked: Set<string>,
  taken: Map<string, number>,
  forbid: { at: Vec2; r: number } | null,
  origin: Vec2 | null,
  legOk: ((a: Vec2, b: Vec2) => boolean) | null,
  mine: Set<string> | null,
  theirs: Vec2[][] | null,
): Vec2[] {
  // Try first with every chord that sweeps the other net's terminal *forbidden*, not merely dear. Tolling it
  // was not enough: on church the route took a chord passing 0.090 from the terminal when 0.099 was required and
  // there was room to spare, because a large toll is still finite. If forbidding leaves no route at all, fall
  // back to the tolled search rather than dropping the LED.
  if (forbid || theirs?.length) {
    const strict = searchCorridor(c, from, to, blocked, taken, forbid, true, origin, legOk, mine, theirs);
    if (strict.length) return strict;
  }
  return searchCorridor(c, from, to, blocked, taken, forbid, false, origin, legOk, mine, theirs);
}

function searchCorridor(
  c: Corridor,
  from: number,
  to: number,
  blocked: Set<string>,
  taken: Map<string, number>,
  forbid: { at: Vec2; r: number } | null,
  strict: boolean,
  origin: Vec2 | null,
  legOk: ((a: Vec2, b: Vec2) => boolean) | null,
  mine: Set<string> | null,
  theirs: Vec2[][] | null,
): Vec2[] {
  if (from === to) return [];
  const starts = c.mids.get(from) ?? [];
  const goal = new Set((c.mids.get(to) ?? []).map(ptKey));
  if (!starts.length || !goal.size) return [];

  const cost = (key: string, step: number): number => {
    // Travelling along tape this net has already laid is cheap, so a branch *merges* into the trunk instead of
    // running beside it. Charging for it -- which this used to do -- is what made a net double back along
    // itself: the cheapest route became one that paralleled its own tape a hair away.
    //
    // A discount rather than a negative weight: a negative edge breaks Dijkstra outright, which is exactly what
    // happened the first time this was tried.
    const own = mine?.has(key) ? OWN_TAPE_DISCOUNT : 1;
    // The fold penalty is additive, not a multiplier: it is a fixed price for crossing that crease, and it must
    // not scale with how long the step happens to be.
    const fold = c.cost.get(key) ?? 0;
    const chip = blocked.has(key) ? OCCUPIED_TOLL : 1;
    const shared = 1 + (taken.get(key) ?? 0) * SHARED_TOLL;
    return step * chip * shared * own + fold;
  };

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const seen = new Set<string>();
  const heap = new MinHeap();
  for (const m of starts) {
    // The leg from the origin to this first waypoint is not a chord, so nothing else checks it stays on the
    // material. Pricing it without checking it let a run set off across a hole.
    if (origin && legOk && !legOk(origin, m)) continue;
    const k = ptKey(m);
    // Priced from where the run actually begins. Seeding every node of the starting tile at zero left the first
    // leg -- terminal to first waypoint -- costing nothing, so the search would happily set off from a node
    // behind the terminal and doubled back to get going.
    const d = cost(k, origin ? Math.sqrt(dist2(origin, m)) : 0);
    dist.set(k, d);
    heap.push(k, d);
  }

  let end: string | null = null;
  while (true) {
    // A binary heap, not a scan of every distance: this runs inside a rip-up loop inside a descent, and the
    // scan made a 12-LED puffin plan take two seconds -- far too slow to re-plan on every click.
    const top = heap.pop();
    if (!top) break;
    const at: string | null = top;
    if (seen.has(at)) continue;
    const best = dist.get(at)!;
    if (goal.has(at)) { end = at; break; }
    seen.add(at);
    const here = c.point.get(at)!;
    // Neighbours: every other midpoint of every face this midpoint belongs to. Staying inside one face means
    // the chord is on material; sharing a midpoint is how the path steps into the next tile.
    for (const f of c.faceOf.get(at) ?? []) {
      const ok = c.chords.get(f);
      for (const m of c.mids.get(f) ?? []) {
        const k = ptKey(m);
        if (k === at) continue;
        if (ok && !ok.has(chordKey(here, m))) continue; // that chord would leave the tile
        // A chord may pass close to the other net's terminal even when both its ends are clear of it: tolling
        // nodes cannot see that, so the chord itself is measured.
        const sweeps = forbid ? segPointDist(here, m, forbid.at) < forbid.r : false;
        if (sweeps && strict) continue;
        // Cutting across the other net's tape is a short, and until now the search could not see one: crossings
        // were only counted after a whole plan was built, so nothing could steer around them. A chord that
        // crosses the other net is refused outright on the strict pass -- which is what makes a run go the long
        // way round instead -- and merely very dear on the fallback, so a pad walled in by the other net stays
        // reachable.
        const cuts = theirs ? crossesAny(here, m, theirs) : false;
        if (cuts && strict) continue;
        const w = best + cost(k, Math.sqrt(dist2(here, m))) * (sweeps || cuts ? TERMINAL_TOLL : 1);
        if (w < (dist.get(k) ?? Infinity)) {
          dist.set(k, w);
          prev.set(k, at);
          heap.push(k, w);
        }
      }
    }
  }
  if (!end) return [];
  const out: Vec2[] = [];
  let cur: string | undefined = end;
  while (cur) {
    out.push(c.point.get(cur)!);
    cur = prev.get(cur);
  }
  out.reverse();
  return out;
}

/** Greedy nearest-neighbour visiting order, starting from the battery. */
/**
 * Visiting order for a set of points, starting from `from`: nearest-neighbour, then 2-opt.
 *
 * Each net orders its *own* pads with this. The shared order is built from the hinge midpoints, but a net's
 * pads sit to one side of those hinges, so an order that is short hinge-to-hinge can zigzag pad-to-pad -- the
 * net then runs out and back across itself to reach pads it could have taken in sequence.
 */
function tourOf(from: Vec2, pts: Vec2[]): number[] {
  const left = pts.map((_, i) => i);
  const order: number[] = [];
  let at = from;
  while (left.length) {
    let best = 0;
    for (let k = 1; k < left.length; k++) {
      if (dist2(pts[left[k]!]!, at) < dist2(pts[left[best]!]!, at)) best = k;
    }
    const pick = left.splice(best, 1)[0]!;
    order.push(pick);
    at = pts[pick]!;
  }
  // 2-opt: reverse any span that shortens the walk. Removes the crossings a greedy nearest-neighbour leaves.
  const at2 = (i: number): Vec2 => (i < 0 ? from : pts[order[i]!]!);
  const walk = (): number => {
    let sum = 0;
    for (let i = 0; i < order.length; i++) sum += len(sub(at2(i), at2(i - 1)));
    return sum;
  };
  for (let guard = 0, moved = true; moved && guard < 32; guard++) {
    moved = false;
    for (let i = 0; i < order.length - 1 && !moved; i++) {
      for (let j = i + 1; j < order.length && !moved; j++) {
        const before = walk();
        const span = order.slice(i, j + 1).reverse();
        const trial = [...order.slice(0, i), ...span, ...order.slice(j + 1)];
        const keep = order.slice();
        order.splice(0, order.length, ...trial);
        if (walk() < before - 1e-12) moved = true;
        else order.splice(0, order.length, ...keep);
      }
    }
  }
  return order;
}

function nearestTour(centre: Vec2, targets: Target[]): number[] {
  const left = targets.map((_, i) => i);
  const order: number[] = [];
  let at = centre;
  while (left.length) {
    let best = 0;
    for (let k = 1; k < left.length; k++) {
      if (dist2(targets[left[k]!]!.hinge, at) < dist2(targets[left[best]!]!.hinge, at)) best = k;
    }
    const pick = left.splice(best, 1)[0]!;
    order.push(pick);
    at = targets[pick]!.hinge;
  }
  return order;
}

/** 2-opt on the open path rooted at the battery: repeatedly reverse a span when that shortens the tour.
 *  Runs to a local optimum, which is what removes the self-crossings. */
function twoOpt(order: number[], centre: Vec2, targets: Target[]): number[] {
  const pos = (i: number): Vec2 => (i < 0 ? centre : targets[order[i]!]!.hinge);
  const tourLen = (): number => {
    let s = 0;
    for (let i = 0; i < order.length; i++) s += len(sub(pos(i), pos(i - 1)));
    return s;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 64) {
    improved = false;
    for (let i = 0; i < order.length - 1 && !improved; i++) {
      for (let j = i + 1; j < order.length && !improved; j++) {
        const before = tourLen();
        const span = order.slice(i, j + 1).reverse();
        const trial = [...order.slice(0, i), ...span, ...order.slice(j + 1)];
        const kept = order;
        order = trial;
        if (tourLen() < before - 1e-12) improved = true;
        else order = kept;
      }
    }
  }
  return order;
}

/** Drop consecutive duplicate points, so a pad that coincides with the previous one cannot create a
 *  zero-length segment. */
function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && dist2(last, p) < 1e-18) continue;
    out.push(p);
  }
  return out;
}

/** Count PWR×GND proper crossings in `traces` — the property this router exists to keep at zero. */
export function countNetCrossings(traces: Trace2D[]): number {
  let n = 0;
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const A = traces[i]!, B = traces[j]!;
      if (A.net === B.net) continue; // same net may overlap freely: single-sided tape, one potential
      for (let a = 1; a < A.pts.length; a++) {
        for (let b = 1; b < B.pts.length; b++) {
          if (segsCross(A.pts[a - 1]!, A.pts[a]!, B.pts[b - 1]!, B.pts[b]!)) n++;
        }
      }
    }
  }
  return n;
}

/** Count traces running over an LED chip body — the other thing that must stay at zero. */
export function countOverLed(traces: Trace2D[], pads: PadPair[]): number {
  let n = 0;
  for (const t of traces) {
    for (const p of pads) {
      if (p.pwr.x === 0 && p.pwr.y === 0 && p.gnd.x === 0 && p.gnd.y === 0) continue;
      // A rail legitimately *lands* on its own pad, so an endpoint touch is not a violation.
      if (polyCrosses(t.pts, p.pwr, p.gnd)) n++;
    }
  }
  return n;
}

/**
 * Chips with copper physically under them.
 *
 * {@link countOverLed} tests zero-width centrelines for a *proper crossing*, which real tape does not
 * honour: a strip whose centreline merely passes close to a chip still sits under it, because the tape is
 * wide. This measures what actually matters -- centreline within `clear` of the chip body -- while allowing
 * the one contact that must exist, the tape landing on its own pad.
 *
 * **This is currently violated: 6-12 chips per model.** `countOverLed` reads zero throughout, which is why
 * it went unnoticed; the zero was an artefact of ignoring tape width. Routing around it is unsolved. One
 * attempt is recorded: approach each pad from beyond it along the chip's own axis, with a width-aware
 * dodge. That measured *worse* (akde-square 0 -> 15 zero-width crossings) because the stand-off point falls
 * outside the tile and its approach segment clips the body. The fix wants the spine to run *along* each
 * hinge so both pads flank the direction of travel -- the same missing property that blocks zero crossings
 * and the lane-sharing that would cut overlap.
 */
export function countUnderLed(
  traces: Trace2D[],
  pads: PadPair[],
  clear: number,
  padR: number,
): number {
  let n = 0;
  for (const pad of pads) {
    if (isOrigin(pad.pwr) && isOrigin(pad.gnd)) continue;
    let bad = false;
    for (const t of traces) {
      const own = t.net === "pwr" ? pad.pwr : pad.gnd;
      for (let i = 1; i < t.pts.length && !bad; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        const L = len(sub(b, a));
        const steps = Math.max(2, Math.ceil(L / (clear * 0.5)));
        for (let k = 0; k <= steps; k++) {
          const u = k / steps;
          const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
          if (len(sub(m, own)) <= padR) continue; // landing on its own pad is the point
          if (segPointDist(pad.pwr, pad.gnd, m) < clear) { bad = true; break; }
        }
      }
      if (bad) break;
    }
    if (bad) n++;
  }
  return n;
}

const isOrigin = (p: Vec2): boolean => p.x === 0 && p.y === 0;

/** Closest approach between segments ab and cd (0 when they intersect). */
function segNearSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(
    segPointDist(a, b, c), segPointDist(a, b, d),
    segPointDist(c, d, a), segPointDist(c, d, b),
  );
}

/** Distance from point `p` to segment ab. */
function segPointDist(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const L2 = ab.x * ab.x + ab.y * ab.y;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

/**
 * Runs passing under the *other* net's battery terminal.
 *
 * The two terminals sit a couple of millimetres apart, so a run leaving one can sweep straight across the
 * other -- shorting the battery, which is the one short that cannot be fixed with a bit of tape afterwards.
 * A net touching its own terminal is the point; touching the other one is a fault.
 */
export function countUnderTerminal(
  traces: Trace2D[],
  term: PadPair,
  clear: number,
): number {
  let n = 0;
  for (const t of traces) {
    const forbidden = t.net === "pwr" ? term.gnd : term.pwr;
    for (let i = 1; i < t.pts.length; i++) {
      if (segPointDist(t.pts[i - 1]!, t.pts[i]!, forbidden) < clear) {
        n++;
        break; // one fault per run is enough to report
      }
    }
  }
  return n;
}

/** Length over which PWR and GND run on top of each other. Same-net overlap is free -- one potential, and
 *  single-sided tape may touch itself -- but the two nets shadowing each other is unbuildable: you cannot
 *  lay the second strip where the first already is. Sampled, so partial overlap counts too.
 *
 *  Currently 11-41% of copper length. It is NOT solved: both nets have to traverse the same spine of the
 *  pattern, and there is no second way through -- tolling a waypoint the other net already used diverts
 *  almost nothing even at 400x. Shifting each net sideways into its own half of the lane cuts overlap
 *  (akde-hex 17% -> 4%) but needs a *shared* centreline to offset from; offsetting each net's own path
 *  instead lets the two lanes swap sides, which measured 5 -> 44 crossings on puffin and put copper back
 *  over chips, so it is not shipped. */
export function overlapLength(traces: Trace2D[], tol: number): number {
  const pwr = traces.filter((t) => t.net === "pwr");
  const gnd = traces.filter((t) => t.net === "gnd");
  let shared = 0;
  for (const a of pwr) {
    for (let i = 1; i < a.pts.length; i++) {
      const p = a.pts[i - 1]!, q = a.pts[i]!;
      const L = len(sub(q, p));
      if (L < 1e-12) continue;
      const steps = Math.max(2, Math.ceil(L / tol));
      let hits = 0;
      for (let k = 0; k < steps; k++) {
        const u = (k + 0.5) / steps;
        const m = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
        if (gnd.some((b) => nearPolyline(b.pts, m) <= tol)) hits++;
      }
      shared += (L * hits) / steps;
    }
  }
  return shared;
}

/** Distance from `p` to the nearest point of polyline `pts`. */
function nearPolyline(pts: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const ab = sub(b, a);
    const L2 = ab.x * ab.x + ab.y * ab.y;
    const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2));
    const d = len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Length a net lays within `tol` of a non-adjacent part of *itself* — tape laid twice over.
 *
 * Electrically free, since it is one net at one potential, but it is wasted copper and it reads as a mistake:
 * the strip runs out and comes back alongside where it has already been. Segments that share an endpoint are
 * skipped, or every corner would count as its own overlap.
 */
export function selfOverlapLength(traces: Trace2D[], tol: number): number {
  let sum = 0;
  for (const net of ["pwr", "gnd"] as const) {
    const mine = traces.filter((t) => t.net === net);
    for (let ti = 0; ti < mine.length; ti++) {
      const a = mine[ti]!;
      for (let i = 1; i < a.pts.length; i++) {
        const p = a.pts[i - 1]!, q = a.pts[i]!;
        const L = len(sub(q, p));
        if (L < 1e-12) continue;
        const steps = Math.max(2, Math.ceil(L / tol));
        let hits = 0;
        for (let k = 0; k < steps; k++) {
          const u = (k + 0.5) / steps;
          const m = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u };
          let near = false;
          for (let tj = 0; tj < mine.length && !near; tj++) {
            const b = mine[tj]!;
            for (let j = 1; j < b.pts.length && !near; j++) {
              if (tj === ti && Math.abs(j - i) <= 1) continue;
              const c = b.pts[j - 1]!, d = b.pts[j]!;
              // Cheap rejection first: most segment pairs are nowhere near each other, and the distance test
              // is what made scoring every candidate cost seconds.
              if (m.x < Math.min(c.x, d.x) - tol || m.x > Math.max(c.x, d.x) + tol) continue;
              if (m.y < Math.min(c.y, d.y) - tol || m.y > Math.max(c.y, d.y) + tol) continue;
              if (sharesEnd(p, q, c, d)) continue;
              if (segPointDist(c, d, m) <= tol) near = true;
            }
          }
          if (near) hits++;
        }
        sum += (L * hits) / steps;
      }
    }
  }
  return sum;
}

function sharesEnd(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const same = (p: Vec2, q: Vec2): boolean => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
  return same(a, c) || same(a, d) || same(b, c) || same(b, d);
}

/**
 * Joins where two runs of one net leave the same point at a sharp angle.
 *
 * A cutter has to weed the substrate between them, and a narrow wedge tears or lifts instead of coming away —
 * so two strips doubling back alongside each other are a cutting defect, not just an untidy one.
 */
export function countAcuteJoins(traces: Trace2D[], minAngle = Math.PI / 6): number {
  let n = 0;
  for (const net of ["pwr", "gnd"] as const) {
    const mine = traces.filter((t) => t.net === net);
    const at = new Map<string, Vec2[]>();
    for (const t of mine) {
      for (let i = 0; i < t.pts.length; i++) {
        const here = t.pts[i]!;
        const away = t.pts[i === 0 ? 1 : i - 1];
        if (!away) continue;
        const k = ptKey(here);
        at.set(k, [...(at.get(k) ?? []), { x: away.x - here.x, y: away.y - here.y }]);
      }
    }
    for (const dirs of at.values()) {
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          const a = Math.atan2(dirs[i]!.y, dirs[i]!.x);
          const b = Math.atan2(dirs[j]!.y, dirs[j]!.x);
          let d = Math.abs(a - b);
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (d < minAngle) n++;
        }
      }
    }
  }
  return n;
}

/**
 * Where two runs of one net meet, stop the redundant one at the meeting point.
 *
 * The connection is made where they touch — everything past that is copper laid for nothing, and on a cut sheet
 * it is a second strip to weed and stick down alongside the first. So the run is truncated at the crossing,
 * keeping its shape and simply ending earlier.
 *
 * Only a tail that reaches nothing is removed: if the part beyond the crossing carries a pad or a terminal, it
 * is the reason that run exists and it stays.
 *
 * This handles runs that *cross*. Runs that merely lie alongside each other were tried too -- dropping a tail
 * already covered by another run of its own net -- and were not worth it: repeated tape stayed at the same 26%
 * across the bundled patterns, because what is left is mid-run parallelism rather than redundant ends, and it
 * split church's copper from four strips into eight. Mid-run doubling cannot be trimmed without cutting the
 * connection; it has to not be routed that way in the first place.
 */
export function trimAtOwnJoins(traces: Trace2D[], required: Vec2[]): Trace2D[] {
  const needed = new Set(required.map(ptKey));
  const out = traces.map((t) => ({ ...t, pts: t.pts.slice() }));

  // Junctions count as required too. A tail past a crossing may be where another run of this net attaches, and
  // cutting it strands that run and everything beyond it -- an open circuit, not a saving. Pads and terminals
  // alone were not enough: this orphaned a pad on puffin.
  const seen = new Map<string, number>();
  for (const t of out) {
    for (const k of new Set(t.pts.map(ptKey))) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) needed.add(k);

  // Longest redundant tail first, and re-checked each round: which run gives way should be the one with more
  // copper to save, not whichever happens to come first in the list.
  for (;;) {
    let best: { i: number; fromEnd: boolean; cut: { index: number; at: Vec2 }; saved: number } | null = null;
    for (let i = 0; i < out.length; i++) {
      const t = out[i]!;
      const others = out.filter((o, k) => k !== i && o.net === t.net);
      if (!others.length) continue;
      for (const fromEnd of [true, false]) {
        const cut = firstJoin(t.pts, others, fromEnd);
        if (!cut) continue;
        const tail = fromEnd ? t.pts.slice(cut.index + 1) : t.pts.slice(0, cut.index + 1);
        if (!tail.length || tail.some((p) => needed.has(ptKey(p)))) continue;
        const from = fromEnd ? cut.at : cut.at;
        let saved = len(sub(tail[fromEnd ? 0 : tail.length - 1]!, from));
        for (let k = 1; k < tail.length; k++) saved += len(sub(tail[k]!, tail[k - 1]!));
        if (!best || saved > best.saved) best = { i, fromEnd, cut, saved };
      }
    }
    if (!best) break;
    const t = out[best.i]!;
    t.pts = best.fromEnd
      ? [...t.pts.slice(0, best.cut.index + 1), best.cut.at]
      : [best.cut.at, ...t.pts.slice(best.cut.index + 1)];
    // Junctions can appear or vanish as runs shorten, so the protected set is rebuilt before the next round.
    const again = new Map<string, number>();
    for (const o of out) for (const k of new Set(o.pts.map(ptKey))) again.set(k, (again.get(k) ?? 0) + 1);
    for (const [k, n] of again) if (n > 1) needed.add(k);
  }

  return out.filter((t) => t.pts.length >= 2);
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Whether `p` lies on `pts` within `tol`. */
function onRun(p: Vec2, pts: Vec2[], tol: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (segPointDist(pts[i - 1]!, pts[i]!, p) <= tol) return true;
  }
  return false;
}

/** The crossing nearest the chosen end of `pts`, as the index of the segment before it and the point itself. */
function firstJoin(
  pts: Vec2[],
  others: Trace2D[],
  fromEnd: boolean,
): { index: number; at: Vec2 } | null {
  const order = fromEnd
    ? [...Array(pts.length - 1).keys()].reverse()
    : [...Array(pts.length - 1).keys()];
  for (const i of order) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const o of others) {
      for (let j = 1; j < o.pts.length; j++) {
        const c = o.pts[j - 1]!, d = o.pts[j]!;
        if (!segsCross(a, b, c, d)) continue;
        const at = intersection(a, b, c, d);
        if (at) return { index: i, at };
      }
    }
  }
  return null;
}

/** Where two crossing segments meet. */
function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a), sVec = sub(d, c);
  const den = cross(r, sVec);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), sVec) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/** Total copper length. */
export function totalLength(traces: Trace2D[]): number {
  let s = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) s += len(sub(t.pts[i]!, t.pts[i - 1]!));
  }
  return s;
}
