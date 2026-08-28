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
  type PlacedPart,
  type Vec2,
  dist2,
  gapForLed,
  pointInFace,
} from "./electronics.js";
import { DEFAULT_PRINT_SIZE } from "./stl-export.js";
import { RESISTOR, SPDT, acrossPart, inlineTerminals, padAxis } from "./parts.js";
import { footprintById } from "./library.js";
import {
  DEFAULT_SHEET,
  creaseCostFraction,
  maxTraceWidthMm,
  minWebMm,
  overStrainLimit,
  type SheetSpec,
} from "./fold-strain.js";
import { CALIBRATED_DEMAND, tapeMmForDemand, traceDemand } from "./tape-demand.js";
import { resolveNetlist, type NetlistFault } from "./netlist.js";
import { planNets, type RoutedNet } from "./net-routing.js";
import { type Box, type Footprint, type Pad, padAt, padSize } from "./footprint.js";
import {
  add,
  cross,
  crossesAny,
  dedupe,
  distToSeg,
  intersection,
  isOrigin,
  leftOf,
  len,
  mid,
  near,
  nearPolyline,
  patternDiag,
  polyCrosses,
  ptKey,
  scale,
  segNearSeg,
  segPointDist,
  segsCross,
  sharesEnd,
  sideOf,
  sub,
  trimEnd,
  unit,
} from "./trace-geometry.js";

/**
 * Re-exported so this module stays the one public face of copper routing.
 *
 * The segment math moved to `trace-geometry.ts` to break the import cycles it sat in the middle of, but
 * callers that already import {@link segsCross} or {@link patternDiag} from here keep reading unchanged —
 * and the split stays free to move again without touching them.
 */
import type {
  Corridor,
  ResistorSpan,
  LedSeat,
  PadField,
  PadPair,
  PartFit,
  PartPlacement,
  PartSpan,
  Terminals,
  Trace2D,
} from "./trace-types.js";

/**
 * Likewise the plan vocabulary, which moved to `trace-types.ts` so that naming a {@link Trace2D} no longer
 * means importing the router. Re-exported for the same reason as the geometry above.
 */
export type {
  Corridor,
  LedSeat,
  PadField,
  PadPair,
  PartFit,
  PartPlacement,
  PartSpan,
  ResistorSpan,
  Terminals,
  Trace2D,
} from "./trace-types.js";

export { crossesAny, patternDiag, ptKey, segsCross } from "./trace-geometry.js";
import {
  SWITCH_GAP_MM,
  SWITCH_PITCH_MM,
  SWITCH_ROW_MM,
  breakForResistors,
  breakRuns,
  byComponent,
  clearOfOtherNet,
  idleSide,
  partFit,
  splitRun,
  switchLand,
  turnRound,
} from "./part-fit.js";

/** Likewise seating a physical part into a break in a run, which moved to `part-fit.ts`. */
export {
  RESISTOR_MM,
  SWITCH_GAP_MM,
  SWITCH_NECK_MM,
  SWITCH_PITCH_MM,
  SWITCH_ROW_MM,
  acrossRun,
  breakForResistors,
  breakRuns,
  freeSpan,
  partFit,
} from "./part-fit.js";
import {
  TERMINAL_TOLL,
  buildCorridor,
  chordKey,
  corridorPath,
  crossesSeam,
  reachableFaces,
  seamsOf,
  tapeOnBody,
} from "./corridor.js";

/** Likewise the travel graph and the search over it, which moved to `corridor.ts`. */
export {
  buildCorridor,
  corridorPath,
  reachableFaces,
  searchCorridor,
  seamCrossing,
  tapeOnBody,
} from "./corridor.js";
import { batteryTerminals, ledSeat, seatLed } from "./pad-landing.js";

/** Likewise the landings, LED seats and battery terminals, which moved to `pad-landing.ts`. */
export {
  DEFAULT_LED,
  batteryTerminals,
  landingWidth,
  landingWidthFor,
  ledSeat,
  narrowedTo,
  padRoomFor,
  seatLed,
  terminalHalfWidth,
} from "./pad-landing.js";
import {
  FOLD_PENALTY_FRAC,
  LED_GAP_FRAC,
  MIN_LAND_FRAC,
  MIN_WEED_MM,
  PRINT_SHEET_MM,
  TAPE_MM,
  tapeMmFor,
  tapeWidthFor,
  weedGapFor,
} from "./tape-width.js";

/** Likewise the tape's width and the weeding floor, which moved to `tape-width.ts`. */
export {
  FOLD_PENALTY_FRAC,
  LED_GAP_FRAC,
  MIN_LAND_FRAC,
  MIN_WEED_MM,
  PRINT_SHEET_MM,
  TAPE_MM,
  tapeMmFor,
  tapeWidthFor,
  weedGapFor,
} from "./tape-width.js";
import {
  countAcuteJoins,
  countNetCrossings,
  countOverLed,
  countUnderLed,
  countUnderTerminal,
  flawless,
  lexLess,
  overlapLength,
  selfOverlapLength,
  totalLength,
  trimAtOwnJoins,
  type PlanKey,
} from "./route-metrics.js";

/** Likewise the plan scoring, which moved to `route-metrics.ts`. */
export {
  countAcuteJoins,
  countNetCrossings,
  countOverLed,
  countUnderLed,
  countUnderTerminal,
  lexLess,
  overlapLength,
  selfOverlapLength,
  totalLength,
  trimAtOwnJoins,
  type PlanKey,
} from "./route-metrics.js";

/** One continuous strip of copper tape: a centreline polyline plus which net it carries. */
export interface RoutedCircuit {
  traces: Trace2D[];
  /** Index-aligned with `circuit.leds` (including unroutable ones, which get zeroed pads). */
  pads: PadPair[];
  /**
   * Indices of LEDs that got no copper: no battery, no gap left under them, no path across the material
   * to their tiles — or a part that cannot be seated on the hinge they sit on (see {@link seatLed}).
   * Their entry in {@link pads} is zeroed. Reported rather than drawn wrong, like any other part that
   * does not fit.
   */
  unreachable: number[];
  /** Where each resistor ended up: the two ends of the break its leads bridge. */
  resistors: PartSpan[];
  /** Likewise each switch: the break between its second pin and its third. */
  switches: PartSpan[];
  /**
   * Likewise every other library part, each carrying the id it was placed from so whatever draws it can
   * look its footprint up. Always an array — `[]` when the circuit has none.
   */
  parts: PartPlacement[];
  /**
   * How each declared net fared — the copper laid for it and any terminals it could not reach.
   *
   * Empty on a circuit with no `nets`, which is every file saved before the netlist existed.
   */
  nets: RoutedNet[];
  /** Everything wrong with the netlist itself, as opposed to the routing of it. Always an array. */
  netFaults: NetlistFault[];
  /**
   * LEDs that could not be **seated** on their hinge, as indices into `circuit.leds`.
   *
   * A subset of {@link unreachable}, separated because the two are different faults with different fixes
   * and were indistinguishable to the author. An unreachable LED sits on a tile the copper cannot get to:
   * the answer is to move it, or to bridge by hand. An unseated one is on a hinge its own package does not
   * fit — its two pads, stepped off the hinge by the tape's width, do not land on their own tiles — and the
   * answer is a smaller package or a coarser sheet. Measured on `akde-square-pyramid`, where 8 of 12 LEDs
   * fail this way and none fail the other; reported as "unreachable" it reads as a routing failure and
   * sends the author looking in the wrong place entirely.
   */
  unseated: number[];
}

/** Where a placed library part ended up. */
export const EMPTY_ROUTE: RoutedCircuit = {
  traces: [], pads: [], unreachable: [], unseated: [], resistors: [], switches: [], parts: [], nets: [], netFaults: [],
};

/** How much dearer it is to travel through a hinge that has an LED on it than an empty one. Large enough to
 *  route around whenever there is any alternative, finite so that a dead-end tile stays reachable. */
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

/**
 * How much of a fold a landing may make to come in along the chip's axis: the cosine of the angle between
 * the two arms meeting at the bend, measured from the bend outward. Straight through is -1; a complete
 * doubling-back is +1.
 *
 * Only genuine folds are refused, and nothing in between matters: 0.3, 0.6 and 0.9 give byte-identical
 * geometry on all six bundled patterns, while 0 (refusing anything sharper than a right angle) throws away
 * most of the landings and takes house's worst-covered leg back from 42% of its area on copper to 20%.
 */
const LANDING_FOLD_MAX = 0.3;

/** What a step along tape this net already laid costs, as a fraction of its length. Cheap, so a branch merges
 *  into the trunk rather than running alongside it -- which is the doubling back. */
const BRANCH_GAIN = 0.25;

/** What it costs a net to route in the other net's lane, as a multiple of the raw distance.
 *
 *  Re-swept once the tape halved, which left more room to detour into: 3 now clears akde-decagon's overlap
 *  entirely (2% -> 0) and takes a crossing off puffin, where at 6.5mm anything above 1.5 put copper under a
 *  chip. Above 6 it turns bad again -- puffin 27% overlap at 12. */
const LANE_TOLL = 3;

/** What it costs to route through the other net's battery terminal. Large: that is a short at the source, so
 *  no detour is too long to avoid it -- but finite, so a terminal boxed in by geometry stays reachable. */
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
  /** The two copper ends, seated at this part's own pad spacing — see {@link seatLed}. */
  legs: [Vec2, Vec2];
  /** The `Component.id` seated here, so the pads can report what was placed on them. */
  component: string;
  /** How far outboard of each copper end this part's own leg reaches, in flat pattern units — its `padW`.
   *  {@link Rail} landings are brought in along the chip axis over exactly this length; see `landPads`. */
  reach: number;
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
  /** The sheet the copper is stuck to. Sets the crease price through the strain it puts in the copper,
   *  and bounds the tape width and the net clearance — see {@link creaseFraction} and `fold-strain.ts`. */
  sheet: SheetSpec = DEFAULT_SHEET,
  /**
   * The crease price, as a fraction of the pattern's bounding-box diagonal — {@link FOLD_PENALTY_FRAC} by
   * default, which is what every shipped call gets.
   *
   * Here so the router can be run **length-only**: at `0` a crease costs nothing and the search minimises
   * copper alone, which is the baseline the strain-aware price has to be compared against. It is a
   * parameter rather than a test-local fork of `planRoutes` because a baseline routed by different code
   * from the thing it is a baseline for measures the fork as much as the price.
   */
  creasePenaltyFrac: number = FOLD_PENALTY_FRAC,
): RoutedCircuit {
  // **New parameters APPEND. Never insert one.** Every optional parameter here has a default, so an
  // inserted one leaves every existing call compiling while it silently receives the wrong argument —
  // a sheet size read as a trace list, or a `SheetSpec` where a number was meant. Some of those are type
  // errors and some are not, and the ones that are not are the reason this rule is written down.
  const pads: PadPair[] = circuit.leds.map(() => ({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } }));
  const unreachable: number[] = [];
  const battery: Battery | null = circuit.battery;
  if (!battery || !faces[battery.face]) {
    circuit.leds.forEach((_, i) => unreachable.push(i));
    // Still route the netlist: it does not need a battery, and a circuit may be nothing but nets.
    const only = routeDeclaredNets(
      circuit, faces, gaps, tapeWidthFor(faces, sheetMm, sheet, circuit), [], sheet,
      tapeMmFor(faces, sheetMm, sheet, circuit),
    );
    return {
      traces: only.traces, pads, unreachable, unseated: [], resistors: [], switches: [], parts: [],
      nets: only.nets, netFaults: only.faults,
    };
  }

  const diag = patternDiag(faces);
  const tapeW = tapeWidthFor(faces, sheetMm, sheet, circuit); // the tape in THIS pattern's units — see tapeWidthFor
  // Its width in millimetres, from the same call. `tapeW / tapeMm` is this pattern's scale, and every
  // millimetre figure below is converted by that ratio — so the two have to be derived together. Reading
  // one from `TAPE_MM` while the other came from `tapeWidthFor` is how a plan comes out plausible and the
  // wrong size, which is the mistake this file's header opens with.
  const tapeMm = tapeMmFor(faces, sheetMm, sheet, circuit);
  const centre = faces[battery.face]!.centroid;
  const term = batteryTerminals(centre, diag, faces[battery.face]!.poly, tapeW);

  // Collect the LEDs we can wire. An LED whose gap has gone (the pattern changed under it) has no pads,
  // and neither has one whose part cannot be seated on the hinge it sits on -- see `seatLed`.
  const targets: Target[] = [];
  const unseated: number[] = [];
  circuit.leds.forEach((led, slot) => {
    const gap = gapForLed(gaps, led);
    const seat = ledSeat(led.component);
    const legs = gap && seat ? seatLed(gap, faces, seat, tapeW, tapeMm) : null;
    if (!gap || !seat || !legs) {
      unreachable.push(slot);
      // The hinge and the part both exist and the part still will not sit on it — that is the package
      // against the tile, not the copper against the pattern. Kept apart so the author is told which.
      if (gap && seat && !legs) unseated.push(slot);
      return;
    }
    targets.push({
      pinned: led.flip,
      slot,
      hinge: gap.point,
      ends: gap.ends,
      legs,
      legFaces: [gap.faceA, gap.faceB],
      component: seat.component,
      reach: (seat.padW * tapeW) / tapeMm,
    });
  });
  if (!targets.length) {
    // No LEDs to bus, which does not mean nothing to route: with nets declared, a circuit of parts and no
    // LEDs is an ordinary circuit and the whole point of not needing a rail. Returning early here left a
    // netlist-only circuit with no copper at all.
    const only = routeDeclaredNets(circuit, faces, gaps, tapeW, [], sheet, tapeMm);
    return {
      traces: only.traces, pads, unreachable, unseated: [], resistors: [], switches: [], parts: [],
      nets: only.nets, netFaults: only.faults,
    };
  }

  // Drop LEDs the battery cannot reach across the material. Their tiles sit on a separate island of the
  // pattern, and the only way to "reach" them would be a straight line through empty space -- which is what
  // used to happen, and is what put copper outside the body. Better to report them honestly.
  // The crossing penalty is the pattern's bounding-box diagonal, as in the paper: larger than any single step
  // in the graph, so a crease is crossed only when nothing else reaches the tile.
  const corridor = buildCorridor(faces, gaps, patternDiag(faces) * creasePenaltyFrac, tapeW, sheet, tapeMm);
  const reach = reachableFaces(corridor, battery.face);
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (reach.has(t.legFaces[0]) || reach.has(t.legFaces[1])) continue;
    unreachable.push(t.slot);
    targets.splice(i, 1);
  }
  unreachable.sort((a, b) => a - b);
  if (!targets.length) {
    // No LEDs to bus, which does not mean nothing to route: with nets declared, a circuit of parts and no
    // LEDs is an ordinary circuit and the whole point of not needing a rail. Returning early here left a
    // netlist-only circuit with no copper at all.
    const only = routeDeclaredNets(circuit, faces, gaps, tapeW, [], sheet, tapeMm);
    return {
      traces: only.traces, pads, unreachable, unseated: [], resistors: [], switches: [], parts: [],
      nets: only.nets, netFaults: only.faults,
    };
  }

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
      out[t.slot] = f[i]
        ? { pwr: l1, gnd: l0, component: t.component }
        : { pwr: l0, gnd: l1, component: t.component };
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
  const score = (tr: Trace2D[], f: boolean[]): PlanKey => [
    // The width-aware measure, not countOverLed: that one tests zero-width centrelines for a crossing, so it
    // reads zero while tape is sitting on top of a chip. Scoring on it left the search blind to the very
    // constraint it was supposed to be enforcing first.
    // Both chip measures, because neither subsumes the other: the width-aware one exempts the pad the run
    // lands on (so it misses a run that clips the body right at the pad), and the zero-width one only sees a
    // proper crossing (so it misses tape lying alongside). Ranked together, above everything else.
    // Chips first, and separately: tape under a chip destroys the component, while tape across a battery pad
    // shorts the supply. Both are faults, but they are not the same fault, and weighing them equally let the
    // router swap one for the other -- puffin traded its terminal fault for a chip fault and called it even.
    countUnderLed(tr, padsFor(f), clearW, clearW * 1.2) + countOverLed(tr, padsFor(f)),
    countUnderTerminal(tr, term, termClear),
    countNetCrossings(tr),
    // ONE tier, summed on purpose, and this is the only place in the key where two measures are traded.
    //
    // Both kinds of overlap: the two nets shadowing each other, and a net laid twice over itself. Only the
    // first was scored, so nothing in the search had any reason to stop a net doubling back -- and it did,
    // over a fifth of its length on some patterns.
    // A sharp join is a cutting defect -- the wedge of substrate between two strips leaving a point at a narrow
    // angle tears rather than weeding -- so it ranks with the overlaps rather than below them. The `overlapTol
    // * 4` converts a join into a LENGTH so the two can be weighed in the same currency: four sharp joins
    // against three tape widths of overlap is a trade the router is meant to be able to make. Splitting this
    // into two components of the tuple would make one of them absolute and silently change the objective.
    countAcuteJoins(tr) * overlapTol * 4 + overlapLength(tr, overlapTol) + selfOverlapLength(tr, overlapTol),
    // Length ranks last: of two plans equal on everything that matters more, the shorter and straighter wins.
    totalLength(tr),
  ];

  const onBody = (a: Vec2, b: Vec2): boolean => tapeOnBody(faces, tapeW, a, b);

  /** Each LED's body as a segment between its two copper ends, and each pad with the mate it faces. */
  const bodies = targets.map((t) => [t.legs[0], t.legs[1]] as [Vec2, Vec2]);
  const padOf = new Map<string, { own: Vec2; mate: Vec2; reach: number }>();
  for (const t of targets) {
    padOf.set(ptKey(t.legs[0]), { own: t.legs[0], mate: t.legs[1], reach: t.reach });
    padOf.set(ptKey(t.legs[1]), { own: t.legs[1], mate: t.legs[0], reach: t.reach });
  }
  const hitsAnyBody = (a: Vec2, b: Vec2): boolean => bodies.some(([c, d]) => segsCross(a, b, c, d));

  /**
   * Bring each landing in along the chip's own axis, over the length of the leg it is landing.
   *
   * The copper now stops at the part's own bare gap, which puts the leg OUTBOARD of the point the run
   * ends at -- it has to be, or the two nets would meet under the chip. So the leg is on copper only if
   * the tape arrives from outboard: a run that comes in sideways ends in a cap lying ACROSS the leg
   * rather than under it, and on house.fkld that left half of every anode off its own copper even
   * though the two ends were the right distance apart. Rendered and looked at; a number would not have
   * shown it.
   *
   * So the last `padW` of a landing is the leg itself, laid straight along the axis, and the run makes
   * its turn at the far end of the leg instead of at the pad. That is very nearly where the pad used to
   * be -- 2.40mm off the hinge against the old dent's 2.9mm on house -- so the route as a whole barely
   * moves; only its last millimetre and a half becomes the part's own.
   *
   * Additive and conditional like every other correction here: where the straight run in would leave
   * the material or cross a chip, the landing is left exactly as it was.
   */
  /** Whether a bend at `c` has material all the way round it out to `r` — the mitre's worst reach. */
  const clearAround = (c: Vec2, r: number): boolean => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (pointInFace(faces, { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }) < 0) return false;
    }
    return true;
  };

  const landPads = (t: Trace2D): Trace2D => {
    if (t.pts.length < 2) return t;
    const pts = t.pts.slice();
    // Last end first: splicing at the front would shift the back one's index.
    for (const end of [pts.length - 1, 0]) {
      if (pts.length < 2) break;
      const pad = padOf.get(ptKey(pts[end]!));
      if (!pad) continue;
      const anchor = add(pad.own, scale(unit(sub(pad.own, pad.mate)), pad.reach));
      const nb = pts[end === 0 ? 1 : pts.length - 2]!;
      if (dist2(nb, anchor) < pad.reach * 0.05) continue; // the run already comes in along the axis
      // The bend at the anchor must be a corner, not a fold. A run that has to double back on itself to come
      // in square leaves a wedge of substrate at the bend that tears rather than weeding, and the mitre on
      // the inside of the fold reaches outside the shape: unguarded, this put copper off akde-hex and gave
      // it a sharp join. Where the approach cannot be squared off cleanly the run lands as it was, and that
      // LED's leg is the one that ends up only partly on copper.
      const toNb = unit(sub(nb, anchor));
      const toPad = unit(sub(pad.own, anchor));
      if (toNb.x * toPad.x + toNb.y * toPad.y > LANDING_FOLD_MAX) continue;
      if (!onBody(nb, anchor) || !onBody(anchor, pad.own) || hitsAnyBody(nb, anchor)) continue;
      // `onBody` walks the two straight stretches; the mitre at the bend between them sticks out past both,
      // and on akde-hex that was enough to put copper off the shape. So the bend itself has to stand clear
      // of the boundary on every side, not merely have its two arms on the material.
      if (!clearAround(anchor, tapeW * 0.75)) continue;
      pts.splice(end === 0 ? 1 : pts.length - 1, 0, anchor);
    }
    return { ...t, pts };
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
      return lexLess(score(b, f), score(a, f)) ? b : a;
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
    return lexLess(score(perNet, f), score(shared, f)) ? perNet : shared;
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
    for (let sweep = 0; sweep < order.length && !flawless(sc); sweep++) {
      let moved = false;
      for (let i = 0; i < order.length && !flawless(sc); i++) {
        if (targets[order[i]!]!.pinned !== undefined) continue; // the author fixed this one
        f[i] = !f[i];
        const cand = build(f);
        const cs = score(cand, f);
        if (lexLess(cs, sc)) {
          tr = cand;
          sc = cs;
          moved = true;
        } else {
          f[i] = !f[i];
        }
      }
      if (!moved) break;
    }
    if (lexLess(sc, bestS)) {
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
  if (lexLess(score(merged, flip), bestS)) {
    best = merged;
    bestS = score(merged, flip);
  } else {
    merging = false;
  }

  branching = true;
  const branched = build(flip);
  if (lexLess(score(branched, flip), bestS)) {
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
    if (lexLess(sc, bestS)) {
      bestS = sc;
      best = cand;
    } else {
      dirPwr = keepP;
      dirGnd = keepG;
    }
  }

  // Landing runs last, on the finished plan.
  //
  // Unconditional, unlike squaring below, and not inside the descent either. It is not a candidate: the
  // last stretch of a run has to lie along the chip's axis or the part is not soldered to anything, so
  // there is nothing for the objective to weigh. `landPads` refuses itself where the straight run in would
  // leave the material or cross a chip, and that is the whole of the judgement.
  //
  // Measured three ways over the six bundled patterns, worst-covered pad per pattern: inside the descent
  // 27-51% and four times as slow; scored as one all-or-nothing edit at the end 20-34%, because one costly
  // landing took every other pattern's with it; run by run with the same gate 20-42%. Unconditional gives
  // 27-51% -- the in-descent result at the end-of-plan cost.
  // Run by run, and only where the objective does not object. The fold guard inside `landPads` catches the
  // bends that tear or reach off the shape; this catches what is only visible in the plan as a whole -- a
  // squared-off landing that now sweeps the other net's battery terminal, or doubles back along tape its own
  // net already laid. akde-hex needed both: with the guard alone it kept a landing that took its repeated
  // tape from 13% to 15% of its length and gave it a sharp join.
  for (let i = 0; i < best.length; i++) {
    const landed = landPads(best[i]!);
    if (landed === best[i]) continue;
    const cand = best.slice();
    cand[i] = landed;
    // Length is deliberately taken back out of the comparison. A squared-off landing is always a little
    // longer than a diagonal one -- that is what it is for -- and the objective's length tie-breaker was
    // enough to refuse every single landing on every pattern when the gate first went in.
    // `upto: 4` is that exclusion said exactly, rather than subtracting the length term back out of a
    // weighted sum — which was itself a trick that depended on the scale separation holding.
    if (!lexLess(score(best, flip), score(cand, flip), 4)) best = cand;
  }

  // Squaring runs last, on the finished plan, and only if it does not score worse. Kept out of the polarity
  // search deliberately: offered as a candidate inside it, the extra options changed the descent path and the
  // search settled in worse local optima on some patterns (over-LED 3 -> 5 across the bundled set) even though
  // no squared candidate ever outscored an unsquared one. As a post-step it can only improve or leave alone.
  for (let i = 0; i < order.length; i++) {
    const t = targets[order[i]!]!;
    const [l0, l1] = t.legs;
    pads[t.slot] = flip[i]
      ? { pwr: l1, gnd: l0, component: t.component }
      : { pwr: l0, gnd: l1, component: t.component };
  }

  const withRes = breakForResistors(best, circuit.resistors ?? [], tapeW, tapeMm);
  // A resistor is in line with the rail, so turning one round swaps which of its terminals lands on which
  // cut end. Indifferent on a resistor itself, and the whole point on anything polarised.
  const resistorFlips = circuit.resistors ?? [];
  withRes.placed = withRes.placed.map((s) => (resistorFlips[s.source]?.flip ? turnRound(s) : s));
  // Across the break the part needs only its own half-gap plus a pad either side: the terminals run square
  // to the rail now, not along it, so a much shorter run will take one.
  const toFlat = (mm: number): number => (mm * tapeW) / tapeMm;
  const swPad = SPDT.pad;
  const swReach = toFlat(SWITCH_GAP_MM / 2 + swPad.w);
  const withSw = breakRuns(withRes.traces, circuit.switches ?? [], toFlat(SWITCH_GAP_MM), {
    before: swReach,
    after: swReach,
  });
  // Which way each switch faces is decided against the copper as it now stands, before any land is laid:
  // the lands themselves belong to the part and would otherwise vote for its own orientation.
  const switchFlips = circuit.switches ?? [];
  for (const span of withSw.placed) {
    // The author's choice where there is one; otherwise the side the copper leaves free.
    span.flip = switchFlips[span.source]?.flip ?? idleSide(
      span,
      withSw.traces,
      toFlat(SWITCH_PITCH_MM),
      toFlat(swPad.w) / 2,
      toFlat(SWITCH_ROW_MM),
    );
  }
  // A seat that shorts the two nets through the part is no seat at all — drop it and let it be reported.
  withSw.placed = withSw.placed.filter((span) =>
    clearOfOtherNet(span, withSw.traces, tapeW, toFlat(SWITCH_PITCH_MM),
      { w: toFlat(swPad.w), h: toFlat(swPad.h) }, toFlat(SWITCH_ROW_MM)),
  );
  const swLands = withSw.placed.flatMap((span) =>
    switchLand(
      span,
      toFlat(SWITCH_PITCH_MM),
      toFlat(swPad.w),
      toFlat(swPad.h),
      toFlat(SWITCH_ROW_MM),
    ),
  );

  // Everything else from the library, on the copper the two passes above have left. Grouped by component
  // so a group is broken once with that part's own fit — the whole point being that a new part adds a
  // group, not a branch. Groups run in the order their first part was dropped, so the plan stays
  // deterministic, and each group sees the breaks the ones before it made.
  const placedParts: PartPlacement[] = [];
  const partLands: Trace2D[] = [];
  let partTraces = withSw.traces;
  for (const [id, group] of byComponent(circuit.parts ?? [])) {
    const fp = footprintById(id);
    // A part the library no longer has is left unplaced rather than guessed at — same as one that
    // does not fit, and the status line reports it the same way.
    if (!fp) continue;
    const fit = partFit(fp);
    if (!(fit.gap > 0)) continue; // nothing to break a rail for
    const drops = group.map((g) => g.part);
    const broke = breakRuns(partTraces, drops, toFlat(fit.gap), {
      before: toFlat(fit.before),
      after: toFlat(fit.after),
    });
    partTraces = broke.traces;
    const across = fit.rows === 2 ? acrossPart(fp) : null;
    if (across) {
      // Against the copper as it now stands, its own lands excluded for the reason the switch pass
      // gives — but every other part's land included, since that is real copper an idle throw can touch.
      const laid = [...partTraces, ...swLands, ...partLands];
      for (const span of broke.placed) {
        // The author's choice where there is one, as with the switch above.
        span.flip = drops[span.source]?.flip ?? idleSide(
          span,
          laid,
          toFlat(across.pitch),
          toFlat(across.pad.w) / 2,
          toFlat(across.rowSep),
        );
      }
      broke.placed = broke.placed.filter((span) =>
        clearOfOtherNet(span, laid, tapeW, toFlat(across.pitch),
          { w: toFlat(across.pad.w), h: toFlat(across.pad.h) }, toFlat(across.rowSep)),
      );
      for (const span of broke.placed) {
        partLands.push(
          ...switchLand(
            span,
            toFlat(across.pitch),
            toFlat(across.pad.w),
            toFlat(across.pad.h),
            toFlat(across.rowSep),
          ),
        );
      }
    }
    for (const span of broke.placed) {
      // In line with the rail there is no idle terminal to strand, so turning the part round is the swap
      // of its two ends — the same thing a resistor's authored turn does above.
      const turned = !across && drops[span.source]?.flip ? turnRound(span) : span;
      placedParts.push({ ...turned, component: id, source: group[span.source]!.at });
    }
  }

  const busTraces = [...seatLedLegs(partTraces, targets, pads), ...swLands, ...partLands];
  // The declared netlist, routed on top of the bus and kept clear of it.
  //
  // The bus goes first and the nets route around it, rather than the other way round: the bus carries the
  // LEDs and the battery, which are pinned to hinges and faces and have nowhere else to go, while a net is
  // free to take any path across the material. Handing the nets the immovable copper as an obstacle is the
  // only ordering that can honour the no-overlap condition for both at once.
  const netted = routeDeclaredNets(circuit, faces, gaps, tapeW, busTraces, sheet, tapeMm);

  return {
    traces: [...busTraces, ...netted.traces],
    pads,
    unreachable,
    unseated,
    resistors: withRes.placed,
    switches: withSw.placed,
    parts: placedParts,
    nets: netted.nets,
    netFaults: netted.faults,
  };
}

/**
 * Whether a strip of tape laid from `a` to `b` stays on the material.
 *
 * Both edges are checked, not just the centreline. Tape has width, so a run tracking the boundary keeps its
 * centre on the material while half the strip hangs off it — which is what put copper outside the shape.
 *
 * Top-level and exported rather than a closure in the router, so that anything else needing to know
 * whether copper fits on the sheet — a hand-drawn wire, for one — asks this rather than growing a second
 * reading of the same question. Two readings of one footprint have already disagreed in this codebase
 * once, over the coin cell, and the cost was a cut file that contradicted its own drawing.
 */
/**
 * Route the nets the author declared, keeping them clear of the bus and of each other.
 *
 * Separated from {@link planRoutes} so the netlist path can be read on its own, and so a circuit with no
 * nets pays nothing for it beyond one length check.
 *
 * The bus copper is handed over as a set of already-laid polylines, which {@link planNets} treats exactly
 * as it treats an earlier net's copper: nothing may come within a tape width of it. That is what keeps the
 * no-overlap guarantee true of the whole sheet rather than only of the netlist.
 *
 * It is also handed over **tagged with the net each run is a rail for**, which is a different claim and the
 * one that joins a netlist to a battery. A declared net sharing an id with a rail — `pwr`, `gnd` — taps
 * that rail rather than avoiding it, so a pad wired to PWR is wired to the battery's positive terminal and
 * not merely to the other pads that happen to be on PWR. Every other rail stays an obstacle to it. Until
 * this existed a lone pad on PWR was reported a `single-terminal-net` fault and got no copper at all.
 */
function routeDeclaredNets(
  circuit: Circuit,
  faces: FlatFace[],
  gaps: GapEdge[],
  tapeW: number,
  bus: Trace2D[],
  sheet: SheetSpec = DEFAULT_SHEET,
  tapeMm: number = TAPE_MM,
): { traces: Trace2D[]; nets: RoutedNet[]; faults: NetlistFault[] } {
  if (!circuit.nets?.length) return { traces: [], nets: [], faults: [] };
  // Widths carried over, not dropped. A rail pinches to about a third of the tape where it passes an LED,
  // and handing the clearance gate a bare polyline made every net keep a full tape width from copper that
  // narrow — room given away for nothing.
  const rails = bus.map((t) => ({
    net: t.net,
    pts: t.pts,
    ...(t.widths ? { widths: t.widths } : t.width !== undefined ? { widths: t.pts.map(() => t.width!) } : {}),
  }));
  const { nets, faults, fields, pads } = resolveNetlist(circuit, tapeW, tapeMm, new Set(rails.map((r) => r.net)));
  if (!nets.length) return { traces: [], nets: [], faults };
  // The bus goes over as `rails` and NOT also as `obstacles`. Passed twice it arrives twice — once tagged
  // with the net it is a rail for and once anonymously — and the anonymous copy is not excluded from a
  // net's own clearance test, so every tap is refused by the very rail it is trying to reach.
  const routed = planNets(nets, faces, gaps, tapeW, [], sheet, tapeMm, rails, fields, pads);
  return { traces: routed.traces, nets: routed.nets, faults };
}

/**
 * The copper under each LED leg.
 *
 * Laid as an extension of the run that already ends on the pad, not as a strip of its own. As its own
 * run it doubled the strip count — one LED came out as four runs rather than two — and a second strip
 * lying against the first is also what produced the self-overlap and the acute joins the router is
 * measured on. A leg is the last inch of the rail, so it is the same piece of tape.
 *
 * A leg is `padW` long and sits **outboard** of the copper end the rail arrives at: the two nets stop
 * `gap` apart so the chip's body has bare pattern under it, which puts every millimetre of both legs
 * past where the rail stops. So the leg's own copper is not something routing produces — it is part of
 * seating the part, like the switch's lands, and it is laid whether or not the route happened to arrive
 * in a shape that covers it.
 *
 * It had to become unconditional. `landPads` squares an approach into the axis where it can, and where it
 * can it lays exactly this rectangle as part of the rail, so nothing is added; but it only ever sees a pad
 * a run *ends* at, and it refuses a bend that would fold back or reach off the shape. Over the six bundled
 * patterns that left most legs partly or wholly off their own copper — measured on a 19x19 grid over each
 * leg, the worst leg on a pattern held 24-42% of its area, and the best 91%, scattered by which landings
 * happened to square rather than by anything about the part. With the land laid every leg sits on copper
 * along its whole length, and what is left uncovered is only the overhang across the axis that
 * {@link landingWidth} deliberately leaves (see its floor).
 *
 * Skipped where the rail already runs down the leg — that is `landPads` having done it — so a squared
 * landing stays one continuous strip of tape rather than gaining a second one lying exactly on top.
 */
function seatLedLegs(laid: Trace2D[], targets: Target[], pads: PadPair[]): Trace2D[] {
  // Worked on a copy: `laid` is the routed set and the caller still holds it.
  const runs: Trace2D[] = laid.map((t) => ({ ...t, pts: [...t.pts] }));
  for (const t of targets) {
    const pair = pads[t.slot];
    if (!pair?.component) continue;
    for (const net of ["pwr", "gnd"] as const) {
      const own = net === "pwr" ? pair.pwr : pair.gnd;
      const mate = net === "pwr" ? pair.gnd : pair.pwr;
      const axis = unit(sub(own, mate));
      const anchor = add(own, scale(axis, t.reach));
      const already = runs.some(
        (r) =>
          r.net === net &&
          r.pts.some(
            (p, i) =>
              i > 0 &&
              ((near(p, own) && near(r.pts[i - 1]!, anchor)) ||
                (near(p, anchor) && near(r.pts[i - 1]!, own))),
          ),
      );
      if (already) continue;
      // Extend the run that already ends on this pad rather than laying a second strip beside it — but
      // only where the leg carries on the way the run was already going.
      //
      // The leg points outboard, away from the other pad. A run that arrived at the pad FROM outboard has
      // already laid that copper, and appending the leg folds it back along itself: the strip doubles up,
      // and the outline's miter at a 180-degree reversal throws a long spike out past the pad and into the
      // bare gap the chip body has to sit on. That spike was copper across the LED's own terminals —
      // measured before this guard, every LED on house, church and puffin had copper in its body gap,
      // covering up to 12 of 19 samples across it.
      const host = runs.find((r) => r.net === net && (near(r.pts[0]!, own) || near(r.pts[r.pts.length - 1]!, own)));
      if (host) {
        const atEnd = near(host.pts[host.pts.length - 1]!, own);
        const prev = atEnd ? host.pts[host.pts.length - 2] : host.pts[1];
        // Which way the run was travelling as it arrived, against the way the leg goes.
        const came = prev ? unit(sub(own, prev)) : axis;
        const carriesOn = came.x * axis.x + came.y * axis.y > 0;
        if (carriesOn) {
          if (atEnd) host.pts.push(anchor);
          else host.pts.unshift(anchor);
          continue;
        }
        // The run already covers the leg, but it arrives at an ANGLE to the LED's axis, and a strip's end
        // is squared off across its own direction — so one corner of that cap swings round and pokes into
        // the bare gap the chip body sits on. Measured on house: the gnd run reached about a third of the
        // way across five of the six gaps. Bringing the last stretch onto the axis turns the cap square to
        // the gap instead, and squares the pad onto the tape at the same time.
        if (prev && Math.abs(came.x * axis.x + came.y * axis.y) < 0.999) {
          // Outboard of the pad, the side the run is already coming from — inboard would lay copper
          // straight across the gap, which is the very thing this is here to stop.
          const along = anchor;
          if (atEnd) host.pts.splice(host.pts.length - 1, 0, along);
          else host.pts.splice(1, 0, along);
        }
      } else {
        // A separate strip from the pad outboard along the leg, where no run ENDS on this pad.
        //
        // It looks redundant when a run already passes through the pad, and guarding on that does cut the
        // strip count hard — puffin at twelve LEDs goes 25 runs to 14. But it is not redundant, and the
        // measurement says so: a run that merely passes the pad is narrowed by {@link landingWidth} to
        // keep the two nets apart under the chip, which caps it at 1.14mm beneath a 1.70mm pad. Guarding
        // the stub took GND coverage from 96-100% down to 30-99%, LEDs at 42%, 50%, 30%. The stub lands
        // END-ON, which is exempt from that narrowing, and full-width copper under the leg is the whole
        // reason the chip lights.
        //
        // So the extra strips are bought, not accidental: strip count against pad coverage, and coverage
        // is the one that decides whether the circuit works.
        runs.push({ net, pts: [own, anchor] });
      }
    }
  }
  return runs;
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

