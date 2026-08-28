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
export { crossesAny, patternDiag, ptKey, segsCross } from "./trace-geometry.js";

/** One continuous strip of copper tape: a centreline polyline plus which net it carries. */
export interface Trace2D {
  pts: Vec2[];
  /**
   * Which net this run carries.
   *
   * `"pwr"` and `"gnd"` for the two-rail bus, and a {@link Net.id} for a run laid by {@link planNets}. Kept
   * as a plain string rather than a union so both routers emit the same kind of trace and everything
   * downstream — the strips file, the carrier, the canvas, the folded model — handles a run without
   * knowing which router laid it or how many nets there are.
   *
   * Anything that needs to *paint* a net has to map ids to colours rather than switching on two names.
   */
  net: string;
  /**
   * Width in pattern units, where this run is not ordinary tape.
   *
   * Land copper under a part's terminals: a switch's pads are `.047in` across and its pitch `.098in`, so a
   * stub reaching one at full tape width would touch the neighbouring terminal's and short the part. Left
   * unset — which is every routed run — the tape's own width is used.
   */
  width?: number;
  /**
   * Width at each point of `pts`, where it is not one flat number — index-aligned, same length as `pts`.
   *
   * `planNets` sets this on a leg that lands on a real part's pad rather than on a bus rail, tapering the
   * last stretch down to the pad's own width instead of running full tape onto a pad a fraction of that
   * size. Takes precedence over `width` wherever present, the same way `outlineStrip`'s own per-point
   * width array already works for the bus.
   */
  widths?: number[];
}

/**
 * Where an LED's two pads ended up, per net. Index-aligned with `circuit.leds`.
 *
 * These are the copper **ends**: the two points the tape stops at, {@link LedSeat.gap} apart along the
 * chip's axis. The part's own legs then sit outboard of them, at its `pitch`, each leg overlapping half
 * its own length of copper — the same relationship a resistor's cut ends have to its terminals, so an
 * LED and a resistor can be drawn by one code path.
 */
export interface PadPair {
  pwr: Vec2;
  gnd: Vec2;
  /**
   * The `Component.id` seated here, so whatever draws the part can look its footprint up without
   * re-deriving which LED this was. Absent on a zeroed (unseatable) entry.
   */
  component?: string;
}

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
export interface PartPlacement extends PartSpan {
  /** The `Component.id` it was placed from. */
  component: string;
  /**
   * Index into `circuit.parts` — the part the author placed, not its position within its component group.
   * The groups are broken one at a time, so the index a span comes back with is the group's; it is
   * translated here, because outside this file the only list anyone has is `circuit.parts`.
   */
  source: number;
}

/** The gap a part bridges — `a` and `b` are the cut ends of the run, where its contacts land. */
export interface PartSpan {
  a: Vec2;
  b: Vec2;
  /** Which net it was placed on, so land copper joins the right one — see {@link Trace2D.net}. */
  net: string;
  /**
   * Which way round a three-terminal part sits: which side of the rail the live throw takes, and so
   * which side the idle one is stranded on. Chosen when the part is placed — see {@link idleSide} —
   * and honoured by everything that draws or wires the part, so the two cannot disagree.
   */
  flip?: boolean;
  /**
   * Which drop this span came from: the index of the placed part in the list handed to {@link breakRuns}.
   *
   * The spans are NOT index-aligned with that list — a part whose run is too short to break is dropped —
   * so this is the only way back from a routed span to the component the author placed. The canvas needs
   * it to draw the selection round the right part, and the router itself to read that part's own `flip`.
   */
  source: number;
}

/** @deprecated the same thing; kept so existing callers read naturally. */
export type ResistorSpan = PartSpan;

export const EMPTY_ROUTE: RoutedCircuit = {
  traces: [], pads: [], unreachable: [], unseated: [], resistors: [], switches: [], parts: [], nets: [], netFaults: [],
};

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
 * crossings 13 -> 11.
 *
 * The penalty saturates: above some fraction every route is identical to the full-diagonal plan, so this
 * value only has to sit at or above that knee. **The knee was 0.15 and is 0.5 as of 2026-08-28**, when
 * `TAPE_MM` fell to 1.5 — narrower tape opens routes that a larger price is still needed to reject, so the
 * knee follows the tape down and now coincides exactly with this constant. There is no margin left: narrow
 * the tape again and this value may need raising. `crease-price.test.ts` pins the knee for that reason.
 */
export const FOLD_PENALTY_FRAC = 0.5;

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
 * **1.5mm since 2026-08-28**, down from 3.25 (which was itself half the 6.5mm this started at). Two reasons,
 * and the second is why it moved again. 3.25mm strips still crowd these patterns — they take most of a tile
 * and leave the router little room — and against SMD parts they are simply the wrong size: an LED_1206's pad
 * is 1.40mm across and a XIAO's pins sit on a 2.54mm pitch, so full-width tape arriving at a pin is wider
 * than the pin and its neighbour's gap together. Narrower tape is also less of the surface stiffened, which
 * matters on a sheet meant to fold.
 *
 * 1.5mm is a stocked width, which is the constraint that matters: this is a roll of copper tape, not a line
 * width, and the cut file has to be cuttable from something you can buy.
 *
 * Not to be confused with `fold-strain.ts › STOCK_TAPE_MM`, whose floor is 3.25. That ladder is consulted
 * only under the opt-in `tapeChoice === "area"`, where a width is chosen per tile from crowding; its floor is
 * a calibration of that rule and not a claim about what rolls exist. The default path returns this constant
 * and never looks at the ladder.
 */
export const TAPE_MM = 1.5;

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
 *
 * `circuit` is optional and is read only for how many runs it needs — see {@link widthMmFor}. **Every
 * caller that has a circuit should pass it**, because a site that omits it while another passes it gets a
 * different width for the same sheet, and the canvas, the folded preview and the cut file then disagree
 * silently, each internally consistent. Omitting it is right only where there is genuinely no circuit yet.
 */
export function tapeWidthFor(
  faces: FlatFace[],
  sheetMm: number = PRINT_SHEET_MM,
  sheet: SheetSpec = DEFAULT_SHEET,
  circuit?: Circuit,
): number {
  return tapeMmFor(faces, sheetMm, sheet, circuit) * unitsPerMm(faces, sheetMm);
}

/**
 * The tape's width in **millimetres** — the roll the cutter is actually asked for.
 *
 * The companion to {@link tapeWidthFor}, and the two must always be read together: every millimetre
 * figure in this codebase is converted to pattern units by the ratio between them. Using {@link TAPE_MM}
 * as that denominator while this returns something else is the one way to get a plan that looks right and
 * is the wrong size — the mistake this file's header warns about, made systematic.
 */
export function tapeMmFor(
  faces: FlatFace[],
  sheetMm: number = PRINT_SHEET_MM,
  sheet: SheetSpec = DEFAULT_SHEET,
  circuit?: Circuit,
): number {
  return widthMmFor(faces, unitsPerMm(faces, sheetMm), sheet, circuit);
}

/**
 * Pattern units per millimetre.
 *
 * A pattern at or above sheet size is taken at its word: the file says how big the model is, so a
 * millimetre is a unit. A pattern smaller than the sheet on BOTH axes carries no usable scale — it is
 * kirigamize output at unit scale, nominally "mm" — so it is read as though it will be cut at `sheetMm`.
 *
 * Floor, never a normalisation: a pattern larger than the sheet is left alone. Shrinking it to sheet size
 * would make the tape coarser than the file intends, which measurably degrades routing on the large
 * patterns (akde-decagon picks up crossing tabs, puffin picks up copper over a chip).
 *
 * **The longest axis, deliberately, because that is how the model is exported.** `buildStlExport` scales
 * the pattern so its longest XY dimension is the print size; deriving the router's scale any other way —
 * from area, say — would have the router and the cutter disagree about how big the model is.
 */
function unitsPerMm(faces: FlatFace[], sheetMm: number): number {
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
  const longest = Math.max(maxX - minX, maxY - minY);
  if (!(longest > 0)) return 1;
  return longest < sheetMm ? longest / sheetMm : 1;
}

/**
 * Which roll to plan for, in millimetres.
 *
 * Two ceilings, and the narrower wins.
 *
 * **The tile, and how much has to fit on it.** Under `tapeChoice: "area"` the model's own surface picks
 * the width: wider tape is better copper — less resistance, easier to lay, harder to lift — and what stops
 * it is crowding, which is relative to the tile it sits on rather than absolute. `sqrt(area / faces)` is
 * that tile, and it is where the total surface area of the model enters. Area alone would not do: the same
 * area cut into 96 tiles and into 10 are not the same sheet to lay tape on.
 *
 * The tile is only half the question, though, and `tape-demand.ts › tapeMmForDemand` is the other half:
 * a 40mm tile carrying one run and a 40mm tile carrying six are not the same tile either. `circuit` is how
 * the demand gets here, and it is **the circuit rather than a count** on purpose — a caller cannot pass a
 * stale demand, only a stale circuit, and a stale circuit is the thing every site that computes a width is
 * already written to avoid. Left out, the demand is `CALIBRATED_DEMAND`, which reproduces the tile-only
 * answer exactly.
 *
 * Under the default `"roll"` none of this is consulted and the answer is {@link TAPE_MM}, as it always was.
 *
 * **The hinge.** A strip splints the hinge it crosses, and the substrate's thickness bounds how much of
 * that it may add — {@link maxTraceWidthMm}, measured against the shortest crease, which is the one a
 * given width splints hardest. This does not bind on the sheets this system prints: 0.4mm of substrate
 * against 0.035mm of foil leaves it two orders of magnitude above any roll. It is computed anyway,
 * because "the roll governs" is only worth saying if something checked, and because a thin-film substrate
 * brings it down under the roll and this same code then routes differently with nobody editing it. The
 * bound goes as the cube of the substrate, so how thin that film has to be depends on the roll: at 3.25mm
 * tape 0.05mm of substrate was enough, and at 1.5mm it takes about 0.03mm. See `fold-strain.test.ts ›
 * narrows the tape itself when the sheet is too thin to carry it`.
 */
function widthMmFor(
  faces: FlatFace[],
  perMm: number,
  sheet: SheetSpec,
  circuit?: Circuit,
): number {
  let shortest = Infinity;
  let area2 = 0;
  for (const f of faces) {
    const n = f.poly.length;
    for (let i = 0; i < n; i++) {
      const a = f.poly[i]!, b = f.poly[(i + 1) % n]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > 0 && d < shortest) shortest = d;
      area2 += a.x * b.y - b.x * a.y; // shoelace, twice the signed area
    }
  }
  if (!Number.isFinite(shortest) || !(perMm > 0)) return TAPE_MM;
  const roll = sheet.tapeChoice === "area" && faces.length > 0
    ? tapeMmForDemand(
        Math.sqrt(Math.abs(area2) / 2 / faces.length) / perMm,
        circuit ? traceDemand(circuit) : CALIBRATED_DEMAND,
        sheet,
      )
    : TAPE_MM;
  return Math.min(roll, maxTraceWidthMm(shortest / perMm, sheet));
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


// ---- small vector helpers ---------------------------------------------------








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
export function landingWidth(pad: Vec2, mate: Vec2, tapeW: number, weed?: number): number {
  return landingWidthFor(Math.hypot(pad.x - mate.x, pad.y - mate.y), tapeW, weed);
}

/**
 * The weeding gap in a pattern's own units — {@link MIN_WEED_MM} converted by the tape's two widths.
 *
 * The one conversion, so that the floor a landing leaves and the floor a part is refused for are the same
 * physical strip of substrate. They were not: {@link MIN_WEED_MM} moved to the sheet on 2026-08-28 while
 * {@link padRoomFor} went on subtracting `tapeW * LED_GAP_FRAC`, and at 1.5mm tape that is 0.53mm against a
 * floor of 1.14mm — so a footprint could be refused as unweedable and, had it been accepted, given a landing
 * that left less than half the gap the refusal demanded.
 */
export function weedGapFor(tapeW: number, tapeMm: number, sheet: SheetSpec = DEFAULT_SHEET): number {
  if (!(tapeMm > 0) || !(tapeW > 0)) return tapeW * LED_GAP_FRAC;
  return (minWebMm(sheet) * tapeW) / tapeMm;
}

/**
 * The narrowest copper worth cutting, as a fraction of the tape width.
 *
 * Named rather than written as a bare `0.35` in two places. It is the same number as {@link LED_GAP_FRAC}
 * by coincidence of calibration, not by derivation — one is the bare gap to leave, the other the floor a
 * strip may be cut to — so they are separate constants and must stay separate.
 */
export const MIN_LAND_FRAC = 0.35;

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
 * A piece of a part's metal, and how wide copper may be near it.
 *
 * The general form of what an LED's two legs have always been to each other: a place on the sheet with
 * something soldered to it, which copper passing close by has to make room for.
 */
export interface PadField {
  /** Where the metal is, in pattern units. */
  at: Vec2;
  /** The widest copper may be at that point — {@link landingWidthFor} of the room around it. */
  safe: number;
  /** How near counts as near, in pattern units. Beyond this the field has no say. */
  reach: number;
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

/**
 * The narrowest strip of bare substrate this process can produce, in millimetres.
 *
 * The same 1.14mm this codebase has always cut to, said in millimetres rather than in tape widths, because a
 * footprint is in millimetres and the comparison has to happen in one unit or the other.
 *
 * **From the SHEET since 2026-08-28, not from the tape.** It used to read `TAPE_MM * LED_GAP_FRAC`, while
 * this docblock argued in the same breath that it "is not tape-relative in truth: a vinyl cutter's blade
 * does not know how wide the roll is". Both cannot be true, and the narrowing of `TAPE_MM` to 1.5mm is what
 * made the disagreement bite: the weeding floor followed the roll down to 0.53mm, which is a claim that a
 * thinner tape makes the substrate easier to weed.
 *
 * `fold-strain.ts › minWebMm` is the honest source — a web is a beam of substrate and what it can take goes
 * with its thickness — and it is anchored on `WEB_REF_MM = 1.1375`, recorded there as "= TAPE_MM *
 * LED_GAP_FRAC, the fixed figure this replaces". So the number is unchanged at the default sheet; only what
 * it depends on is.
 */
export const MIN_WEED_MM = minWebMm();

/** The part an LED is when its circuit does not say — every LED saved before they had a choice. */
export const DEFAULT_LED = "LED_1206";

/** What an LED's own footprint asks of the copper, in millimetres. */
export interface LedSeat {
  /** The `Component.id` this came from. */
  component: string;
  footprint: Footprint;
  /** Centre to centre between the two legs. */
  pitch: number;
  /** How much of that line one leg covers. */
  padW: number;
  /** The bare pattern between the legs: the copper the chip's own body bridges, and the strip the cutter
   *  has to weed. This, not `pitch`, is how far apart the two nets' copper ends go. */
  gap: number;
}

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
 * Zero-width cuts: two faces that touch along an edge which is **not** a shared hinge.
 *
 * A cut in these patterns is a lip — two boundary edges — and where the lip has opened it is a hole in the
 * silhouette, so {@link pointInFace} refuses copper there and nothing more is needed. A cut that has *not*
 * opened is the dangerous one: the two lips sit on the same line in the flat pattern, every point on both
 * sides is inside some face, and containment cannot see the join at all. The material is still severed.
 *
 * Measured on `kirigami-flap`, which carries three such edges: with the battery on face 2 the router laid
 * two runs straight across them. Every other bundled pattern has none, which is why this went unnoticed —
 * "no crossings" was measured on the seven patterns that cannot have any.
 *
 * Told apart by **vertex indices against coordinates**: a shared hinge is one edge, so both faces name the
 * same two vertices; a seam is two edges that happen to coincide, so the indices differ. That distinction
 * is the whole detection, and it needs nothing the router is not already given.
 */
function seamsOf(faces: FlatFace[]): [Vec2, Vec2][] {
  const hit = SEAM_CACHE.get(faces);
  if (hit) return hit;
  const at = (p: Vec2): string => `${Math.round(p.x * 1e6)}_${Math.round(p.y * 1e6)}`;
  const byLine = new Map<string, { idx: string; seg: [Vec2, Vec2] }[]>();
  for (const f of faces) {
    const n = f.poly.length;
    for (let i = 0; i < n; i++) {
      const pa = f.poly[i]!, pb = f.poly[(i + 1) % n]!;
      const va = f.verts[i], vb = f.verts[(i + 1) % n];
      const ka = at(pa), kb = at(pb);
      const line = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const idx = va == null || vb == null ? "?" : String(Math.min(va, vb)) + "_" + String(Math.max(va, vb));
      const list = byLine.get(line) ?? [];
      list.push({ idx, seg: [pa, pb] });
      byLine.set(line, list);
    }
  }
  const out: [Vec2, Vec2][] = [];
  for (const list of byLine.values()) {
    if (list.length < 2) continue;
    const names = new Set(list.map((e) => e.idx));
    if (names.size > 1) out.push(list[0]!.seg); // same line, different vertices: a cut, not a hinge
  }
  SEAM_CACHE.set(faces, out);
  return out;
}

/** One computation per pattern. `flatFaces` returns a fresh array, so identity is a safe key. */
const SEAM_CACHE = new WeakMap<FlatFace[], [Vec2, Vec2][]>();

/**
 * Where a strip from `a` to `b` would span a cut the material is severed along, or null if it does not.
 *
 * The point, not a boolean, because the point cannot be recovered afterwards. The usual way to report a
 * strip that has left the sheet is to sample along it for somewhere off the material — and on an unopened
 * cut **both sides are on material**, which is the entire property of the thing. A sampler finds nothing
 * to report and any point it named would be one it had not derived. So the crossing is handed back by
 * whatever found it.
 *
 * Exported for `wire-rules.ts`, which needs to tell a wire that spans a cut apart from a wire that runs
 * off the edge of the sheet. Deliberately one reading rather than two: this codebase has already paid for
 * two independent readings of one footprint, and "is this a cut" is the same kind of question.
 */
export function seamCrossing(faces: FlatFace[], a: Vec2, b: Vec2): Vec2 | null {
  for (const [p, q] of seamsOf(faces)) {
    if (!segsCross(a, b, p, q)) continue;
    // A proper crossing is never parallel, so `intersection` has an answer here. The seam's own midpoint
    // is the fallback rather than null, which would read as "no crossing" and quietly undo the refusal.
    return intersection(a, b, p, q) ?? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  }
  return null;
}

/** Whether a strip from `a` to `b` would cross a cut. {@link seamCrossing} is the one reading. */
function crossesSeam(faces: FlatFace[], a: Vec2, b: Vec2): boolean {
  return seamCrossing(faces, a, b) !== null;
}

export function tapeOnBody(faces: FlatFace[], tapeW: number, a: Vec2, b: Vec2): boolean {
  // Before the sampling, because it is the case sampling cannot see: a zero-width cut leaves material on
  // both sides and severed material in between. See {@link seamsOf}.
  if (crossesSeam(faces, a, b)) return false;
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
}

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
 * The placed parts by component id, each group in the order the parts were dropped.
 *
 * Each entry keeps `at`, its index in `circuit.parts`, because a group is broken on its own and the spans
 * come back numbered within the group — and every caller outside the router counts parts in the one list
 * the author placed them in.
 */
function byComponent(parts: PlacedPart[]): [string, { part: PlacedPart; at: number }[]][] {
  const by = new Map<string, { part: PlacedPart; at: number }[]>();
  parts.forEach((part, at) => {
    // A free part stands on the sheet and has no rail cut for it, so it is not grouped for breaking. It is
    // skipped HERE rather than filtered out by the caller, and that distinction is the whole point: `at` is
    // the index of the part in the AUTHOR'S list, it escapes as `PartPlacement.source`, and the canvas
    // matches that against its own selection index (`electronics-modal.ts:1503`, `:1616`). Filter the array
    // before this and every `at` after a free part is off by one — no crash and no red test, just the wrong
    // part's span and flip shown when you click one.
    if (part.free) return;
    const group = by.get(part.component);
    if (group) group.push({ part, at });
    else by.set(part.component, [{ part, at }]);
  });
  return [...by];
}

/**
 * The span a FREE part is drawn on: its own `partFit.gap` long, centred on the drop point, along `rot`.
 *
 * Lives here rather than in the editor because it has to obey the same in-line flip rule the seated path
 * obeys three lines below — `!across && flip ? turnRound(span) : span`. An in-line part expresses a flip as
 * its span running the other way; a two-row part expresses it through `acrossRun`, and swapping its ends
 * would move `rowShape`'s anchor instead. Getting that split wrong is what left every flipped in-line part
 * ROUTED flipped and DRAWN unflipped — on a symmetric two-terminal part that exchanges pads 1 and 2, so a
 * net wired to pad 1 had its copper laid where pad 2 was drawn. Measured on 24 of the library's 129 parts,
 * including `R_1206`, `C_1206`, `LED_1206` and `SW_PUSH`.
 *
 * Flat pattern units in and out.
 */
export function freeSpan(
  part: { x: number; y: number; rot?: number; flip?: boolean },
  fp: Footprint,
  tapeW: number,
  tapeMm: number,
): { a: Vec2; b: Vec2 } {
  const half = ((partFit(fp).gap * tapeW) / tapeMm) / 2;
  const th = ((part.rot ?? 0) * Math.PI) / 180;
  const ux = Math.cos(th), uy = Math.sin(th);
  const a = { x: part.x - ux * half, y: part.y - uy * half };
  const b = { x: part.x + ux * half, y: part.y + uy * half };
  return !acrossPart(fp) && part.flip ? { a: b, b: a } : { a, b };
}

/** The same part, end for end: its two terminals swap which cut end of the break they land on. */
function turnRound<T extends PartSpan>(span: T): T {
  return { ...span, a: span.b, b: span.a };
}

/**
 * The copper a 1206 resistor replaces, in millimetres: the bare span between its two pads.
 *
 * Read off the part's own KiCad footprint — see `parts.ts`. It was 6.5 once, a through-hole body I had
 * picked myself, which is exactly the sort of number this pipeline exists to stop us inventing.
 */
export const RESISTOR_MM = RESISTOR.gap;

/**
 * The switch's pad pitch, in millimetres — from the C&K AYZ0102AGRLC footprint, which says 2.5mm exactly.
 * Three pads, so twice this across the lot.
 *
 * The break is one pitch and falls between the second pad and the third, so two sit on one side of it and
 * one on the other.
 */
export const SWITCH_PITCH_MM = SPDT.pitch;

/**
 * The copper a switch takes out, in millimetres.
 *
 * The common is on one edge and the two throws on the other, so the rail runs straight through the part —
 * in at the common on one side, out at a throw on the other. The break is the separation between those
 * rows, plus a neck: the idle throw has to sit in clear pattern, and the outgoing tape is wide enough that
 * ending it level with the pad row left only a quarter of a millimetre between the two. Pulled back by the
 * neck, that becomes a millimetre — the sort of gap an LED's pads get.
 */
export const SWITCH_ROW_MM = SPDT.rowSep;

/**
 * How far the outgoing tape is pulled back beyond the pad row, in millimetres.
 *
 * The idle throw has to sit in clear pattern — that void is what opens the circuit — and "clear" has to
 * mean a keep-out, not merely "no copper exactly under the centre". With the tape ending level with the
 * pad row the two were 0.27mm apart, close enough for solder to bridge.
 *
 * So the pull-back is solved for rather than picked. The idle pad sits a pitch off the centreline, which
 * puts it {@link SWITCH_LATERAL_MM} clear of the tape's edge sideways; pulling the tape back by the neck
 * adds that much along the rail. The nearest copper is the tape's corner, so the two combine as the legs
 * of a right angle, and the neck is whatever makes the hypotenuse reach past the pad by the keep-out.
 *
 * It is derived because the pad is: this switch's terminals are 1.5mm wide against the 0.43mm ones the
 * part was first drawn with, and a hard-coded 1.4mm neck that used to leave a millimetre left 0.40mm.
 */
const SWITCH_KEEPOUT_MM = 1;

/**
 * The neck for any part the rail steps across, from its pitch and its pad — see {@link SWITCH_NECK_MM}.
 *
 * Written once and used for every part, so the switch's number and a new part's come out of the same
 * arithmetic rather than one being the constant and the other a re-derivation that drifts from it.
 */
function neckFor(part: { pitch: number; pad: Box }): number {
  const reach = part.pad.h / 2 + SWITCH_KEEPOUT_MM;
  // How far past the tape's edge the idle pad's column sits — sideways clearance we get for free.
  //
  // `TAPE_MM`, not the roll the router actually chose, and knowingly: this feeds module-level constants
  // (`SWITCH_NECK_MM` and friends) that are computed once at load, so it cannot see a per-pattern choice.
  // Under `tapeChoice: "area"` on a large-tiled model the tape is wider than this assumes and the neck
  // comes out slightly generous — the part gets a little more room than it strictly needs, which is the
  // safe direction to be wrong in. Making it exact means making those constants per-pattern.
  const lateral = Math.max(0, part.pitch - TAPE_MM / 2);
  // Sideways alone may already clear it, on a part whose pads are far enough out; then the neck is only
  // what keeps the tape from ending inside the housing.
  const along = reach * reach - lateral * lateral;
  return along > 0 ? Math.sqrt(along) : part.pad.h / 2;
}

export const SWITCH_NECK_MM = neckFor({ pitch: SWITCH_PITCH_MM, pad: SPDT.pad });

export const SWITCH_GAP_MM = SWITCH_ROW_MM + SWITCH_NECK_MM;

/**
 * How a part meets the rail, read off its own footprint — the generic form of `RESISTOR` and `SPDT`.
 *
 * One row of terminals and the rail runs ALONG them: the part replaces the bare span between the
 * outermost two, straddles it evenly, and needs no more copper than that either side. Two rows and the
 * rail steps ACROSS: the break is the row separation plus a neck, and the terminals run on past it, so
 * the part wants a pad's width of rail beyond its own half-gap at each end.
 *
 * This is what makes a new part need no new branch: `partFit(R_1206).gap` is `RESISTOR.gap` and
 * `partFit(SW_SPDT)` is the switch's two rows and {@link SWITCH_GAP_MM}, both out of the same reading.
 */
export interface PartFit {
  rows: 1 | 2;
  /** Copper it removes, in MILLIMETRES. */
  gap: number;
  /** Copper it needs either side of the break's centre to seat on, in MILLIMETRES. */
  before: number;
  after: number;
}

export function partFit(fp: Footprint): PartFit {
  const across = acrossPart(fp);
  if (!across) {
    const row = inlineTerminals(fp);
    // One terminal (or none) bridges nothing; it has no gap to break a rail for.
    if (row.length < 2) return { rows: 1, gap: 0, before: 0, after: 0 };
    const [first, last] = [row[0]!, row[row.length - 1]!];
    // Centre to centre, less half of each outermost pad: the bare pattern the body covers.
    //
    // Measured along the part's OWN axis, not along x. `inlineTerminals` picks the right two pads by that
    // axis, but measuring the distance between them on x reads zero for a footprint whose pads run down y
    // — and a negative gap is refused outright at the call site, so all ten of the library's y-oriented
    // in-line parts were undroppable at any run length. `PinHeader_01x03_P2_54mm_Horizontal_SMD` came out
    // at -2.500mm. The pad's extent has to follow the same axis: `padSize` gives `w` as the x-extent, so
    // along a y axis it is `h` that lies along the rail.
    const ax = padAxis(fp);
    const alongExt = (pad: Pad): number => (ax.alongIsY ? padSize(pad).h : padSize(pad).w);
    const gap = Math.abs(ax.along(last) - ax.along(first)) - (alongExt(first) + alongExt(last)) / 2;
    return { rows: 1, gap, before: gap, after: gap };
  }
  const gap = across.rowSep + neckFor(across);
  // As the switch pass has always reserved it: the part's own half-gap plus a pad, either side.
  //
  // `pad.h`, the ALONG-run extent, because that is the axis a reserve is measured in — `before`/`after` are
  // copper either side of the break's centre, along the rail. It used to read `pad.w`, and that was the bug
  // rather than drift: a two-row part is seated TURNED to the rail, so its along-run extent is the
  // footprint's across-axis one, which `padRunBox` now reports as `h`.
  //
  // Do NOT copy `alongExt` from the one-row branch above. A one-row part is not turned — the rail runs
  // along its terminals — so there the same question has the opposite answer. Same field, two branches,
  // three lines apart, and the working implementation next door is the wrong one to imitate.
  const reach = gap / 2 + across.pad.h;
  return { rows: 2, gap, before: reach, after: reach };
}

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
  /** The tape in mm — see {@link seatLed}. */
  tapeMm: number = TAPE_MM,
): { traces: Trace2D[]; placed: ResistorSpan[] } {
  // The body in the pattern's own units: the tape is `tapeMm` wide and `tapeW` units, so this follows it.
  return breakRuns(traces, resistors, (RESISTOR_MM * tapeW) / tapeMm);
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
  for (const [at, r] of parts.entries()) {
    let bestRun = -1, bestSeg = -1, bestT = 0, bestD = Infinity;
    out.forEach((t, ti) => {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        // The segment's squared length, computed here rather than with `dist2`, which despite its name
        // returns the distance. Divided by the length instead of its square, the projection came out `u`
        // times too large and clamped to 1 on all but the shortest segments: every part landed at the end
        // of a segment rather than where it was put.
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-18) continue;
        const u = Math.max(0, Math.min(1, ((r.x - a.x) * dx + (r.y - a.y) * dy) / l2));
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
      const span = split.span;
      placed.push(forward ? { ...span, source: at } : { a: span.b, b: span.a, net: span.net, source: at });
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
/** Across the run, towards the side the live throw takes. {@link PartSpan.flip} swaps it. */
export function acrossRun(u: Vec2, flip?: boolean): Vec2 {
  return flip ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
}

/**
 * Which way round to seat a three-terminal part, so its idle throw lands on bare pattern.
 *
 * The idle throw is only insulated by where it sits. That is fine in the middle of a long run and not
 * fine near anything else: the terminal reaches a pitch plus half a pad off the centreline, which on
 * this switch is 3.25mm — as far again as the tape is wide — and a neighbouring rail that close is
 * touched. The part is symmetric, so the fix is free: put the live throw on whichever side leaves the
 * idle one further from every other piece of copper.
 *
 * Measured over 84 placements spread along the longest rail of house, church, puffin and akde-hex,
 * sampling the idle pad on a 7x7 grid: 1120 of 4116 samples landed on copper with no choice made, and
 * 27 with. Puffin and akde-hex go to nil. Measuring from the pad's corners to the tape's edge rather
 * than centre to centreline was tried and picked the same side in all 84, so this stays the simpler one.
 *
 * What it cannot do is rescue a spot where both sides are bad — church still has one placement whose
 * idle throw clips a rail whichever way the part faces. Sliding the part along the run would, and does
 * not exist yet.
 *
 * Ties keep the unflipped orientation, so a part with room on both sides sits as it always did.
 */
function idleSide(span: PartSpan, traces: Trace2D[], pitch: number, over: number, rowSep: number): boolean {
  const d = sub(span.b, span.a);
  const L = len(d);
  if (L < 1e-12) return false;
  const u = { x: d.x / L, y: d.y / L };
  const row = { x: span.a.x + u.x * rowSep, y: span.a.y + u.y * rowSep };
  const clearance = (flip: boolean): number => {
    // The idle throw is opposite the live one.
    const p = acrossRun(u, !flip);
    const c = { x: row.x + p.x * (pitch + over), y: row.y + p.y * (pitch + over) };
    let nearest = Infinity;
    for (const t of traces) {
      for (let i = 1; i < t.pts.length; i++) {
        nearest = Math.min(nearest, distToSeg(c, t.pts[i - 1]!, t.pts[i]!));
      }
    }
    return nearest;
  };
  return clearance(true) > clearance(false) + 1e-9;
}

/**
 * Whether a three-terminal part seated here keeps every terminal off the OTHER net's copper.
 *
 * A switch reaches a pitch plus half a pad off the centreline — 3.25mm on the SPDT, wider than the tape
 * it sits on — so on a crowded pattern a throw can come down on the rail of the opposite net. That is
 * not a cosmetic overlap: it bridges power to ground through the part, and it is invisible on screen
 * because the terminal is drawn over the copper it is shorting to. Measured before this check existed,
 * 9 of 44 switch placements across the bundled patterns did exactly that.
 *
 * {@link idleSide} cannot prevent it. It picks the better of two sides, and when both sides are bad the
 * better one is still a short. So this is a veto rather than a preference: a part that cannot be seated
 * without touching the other net is not placed at all, and the caller reports it as not fitting — the
 * same answer a run too short to hold it gets, and an honest one.
 */
function clearOfOtherNet(
  span: PartSpan, traces: Trace2D[], tapeW: number,
  pitch: number, pad: { w: number; h: number }, rowSep: number,
): boolean {
  const d = sub(span.b, span.a);
  const L = len(d);
  if (L < 1e-12) return false;
  const u = { x: d.x / L, y: d.y / L };
  const p = acrossRun(u, span.flip);
  const row = { x: span.a.x + u.x * rowSep, y: span.a.y + u.y * rowSep };
  const centres = [
    span.a,                                                                        // common
    { x: row.x + p.x * pitch, y: row.y + p.y * pitch },                            // live throw
    { x: row.x - p.x * pitch, y: row.y - p.y * pitch },                            // idle throw
  ];
  const other = traces.filter((t) => t.net !== span.net);
  for (const c of centres) {
    // The pad's four corners, so a terminal that clips a rail with one corner is caught too.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const q = {
          x: c.x + (p.x * sx * pad.w + u.x * sy * pad.h) / 2,
          y: c.y + (p.y * sx * pad.w + u.y * sy * pad.h) / 2,
        };
        for (const t of other) {
          const half = (t.width ?? tapeW) / 2;
          for (let i = 1; i < t.pts.length; i++) {
            if (distToSeg(q, t.pts[i - 1]!, t.pts[i]!) < half) return false;
          }
        }
      }
    }
  }
  return true;
}


/**
 * The two pieces of pad-sized copper an across-the-rail part lands on: the common, and the live throw.
 *
 * `padW` is the pad's extent **across the run** and becomes each land's width; `padL` is its extent
 * **along the run** and is how far past the terminal the land reaches. The part is seated turned to the
 * rail — `acrossPart` is what turns it — so the footprint's own along-axis becomes the run's across-axis,
 * and a caller reading `pad.w`/`pad.h` off the footprint must cross that turn. `pad.w` is the across-run
 * extent as drawn: measured on a seated SPDT, each lead is 1.0mm across the run and 1.2mm along it, and
 * `pad.w` is 1.0. `clearOfOtherNet` takes the box the same way round.
 */
function switchLand(
  span: PartSpan,
  pitch: number,
  padW: number,
  padL: number,
  rowSep: number,
): Trace2D[] {
  const { a, b } = span;
  const d = sub(b, a);
  const L = len(d);
  if (L < 1e-12) return [];
  const u = { x: d.x / L, y: d.y / L };
  const p = acrossRun(u, span.flip);
  // The common is at the near cut end. The throws are a row's separation along from it — not at the far cut
  // end, which is pulled back a neck further so the idle throw sits in clear pattern. The outgoing tape
  // reaches neither throw on its own: one gets a land, the other is left bare, which opens the circuit.
  // Two half-pads, in two different axes, and they are not the same number.
  //
  // `over` is a half-length ALONG the run: how far past the terminal the common land reaches, so the whole
  // pad has copper under it. That is the pad's along-run extent, `padL`.
  //
  // `reach` is a positional offset ACROSS the run: how far past the throw the stub carries, for the same
  // reason in the other axis. That is the pad's across-run extent, `padW`. Sharing one `over` between them
  // read as a simplification and was a transpose — measured on a seated SPDT, the common land runs along
  // the run and the live stub leaves it at 67-89 degrees depending on the seating, so the two ends are in
  // different axes and no single half-pad is right for both.
  const over = padL / 2;
  const reach = padW / 2;
  const row = { x: a.x + u.x * rowSep, y: a.y + u.y * rowSep };
  const live = { x: row.x + p.x * (pitch + reach), y: row.y + p.y * (pitch + reach) };
  // Each land runs half a pad past its terminal, so the whole pad has copper under it. Stopped dead on the
  // centre, half of it sat over bare pattern and the terminal made contact along one edge if at all.
  // Centred on the terminal, not started at it: run from the cut end only forwards, the pad's centre sits on
  // the land's own end cap and half the pad has nothing under it.
  const commonStart = { x: a.x - u.x * over, y: a.y - u.y * over };
  const commonEnd = { x: a.x + u.x * over, y: a.y + u.y * over };
  return [
    { net: span.net, pts: [commonStart, commonEnd], width: padW },
    { net: span.net, pts: [b, live], width: padW },
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
): { traces: Trace2D[]; span: Omit<ResistorSpan, "source"> | null } {
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
  // A chord may not span a cut, even one whose two lips still sit on the same line — the tile looks whole
  // in the flat pattern and is not. See {@link seamsOf}.
  if (crossesSeam(faces, a, b)) return false;
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
export function reachableFaces(c: Corridor, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const m of c.mids.get(at) ?? []) {
      // Refused nodes are not a way through, so a tile behind one is genuinely out of reach. This has to
      // agree with `searchCorridor` or an LED is called reachable and then never routed — reported as
      // wired, drawn with no copper.
      if (c.refused.has(ptKey(m))) continue;
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
export interface Corridor {
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
  /**
   * Nodes copper may not use at all, because the crease there strains it past
   * {@link SheetSpec.strainLimit}.
   *
   * Empty unless a limit is set. Separate from {@link cost} because it is a different kind of statement: a
   * cost says "go round if you can", and this says "there is no route through here" — which is why a tile
   * behind one comes back from {@link reachableFaces} as unreachable rather than expensively reachable.
   */
  refused: Set<string>;
}

/** Unordered key for the edge between two vertex ids. */
const edgeKeyOf = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * What one crossing of this hinge costs, as a fraction of the full crease price.
 *
 * The strain the fold puts in the copper, where the pattern says how far the crease folds — see
 * {@link creaseCostFraction}. The hinge is a real width, not an assumption: `legA` and `legB` are the two
 * tiles' pinched edge midpoints, so the distance between them is the strip of bare substrate that takes
 * the bend, and {@link TAPE_MM} over `tapeW` is the pattern's own scale in millimetres.
 *
 * Two things are deliberately not strain questions.
 *
 * A **cut** pays the full price whatever the geometry says: the material is severed there, so tape over it
 * is bridging a hole rather than bending on a substrate, and there is no bending member to compute a
 * strain in. **This branch is currently unreachable and is kept on purpose.** A cut in these patterns is a
 * lip — two boundary edges, each belonging to one face — so it fails `isGapEdge`'s "exactly two faces
 * share it" and never becomes a `GapEdge`: all eight bundled patterns carry cut edges (12 in church, 98 in
 * puffin) and none of them arrive here. What actually keeps copper off a cut is containment, since a cut
 * that has opened is a hole in the silhouette and `chordInside` refuses it — measured at zero crossings
 * over six patterns. A cut shared by two faces is still conceivable, and a zero-width seam would be one,
 * so pricing it stays.
 *
 * A crease with **no recorded fold angle** falls back to the classification this replaces — a mountain
 * costs full price, anything else costs nothing. Two of the eight bundled patterns record no angles at
 * all, and inventing one for them would be worse than admitting the model cannot run: an assumed 180
 * degrees would put a full-price crease on every mountain that in fact barely folds, and an assumed
 * gentle fold would wave copper over one that folds flat. The fallback is stated here so that a result
 * from such a pattern can be reported as the classification it is.
 */
/**
 * Whether copper may not cross this hinge at all — see {@link SheetSpec.strainLimit}.
 *
 * A cut is refused whatever the limit says, since there is no material to carry the tape. A crease with no
 * recorded angle is never refused: the model cannot compute a strain for it, and refusing on a guess would
 * make a pattern unroutable because of what its file failed to record.
 */
function creaseRefused(g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec): boolean {
  if (sheet.strainLimit == null) return false;
  if (g.dihedral == null) return false;
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
  return overStrainLimit(hingeMm, g.dihedral, sheet);
}

function creaseFraction(g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec): number {
  if (g.assignment === "C") return 1;
  if (g.dihedral == null) return g.assignment === "M" ? 1 : 0;
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
  return creaseCostFraction(hingeMm, g.dihedral, sheet);
}

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
export function buildCorridor(
  faces: FlatFace[],
  gaps: GapEdge[],
  foldPenalty: number,
  tapeW: number,
  sheet: SheetSpec = DEFAULT_SHEET,
  /** The tape in mm — see {@link seatLed}. Only the crease strain needs it, and only to read the hinge
   *  width in millimetres; the graph itself is built in pattern units. */
  tapeMm: number = TAPE_MM,
): Corridor {
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
  const refusedEdges = new Set<string>();
  for (const g of gaps) {
    const price = foldPenalty * creaseFraction(g, tapeW, tapeMm, sheet);
    if (price > 0) penaltyOf.set(edgeKeyOf(g.verts[0], g.verts[1]), price);
    if (creaseRefused(g, tapeW, tapeMm, sheet)) refusedEdges.add(edgeKeyOf(g.verts[0], g.verts[1]));
  }
  const refused = new Set<string>();
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
        if (refusedEdges.has(edgeKeyOf(va, vb))) refused.add(key);
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
  return { mids, faceOf, point, chords, cost, refused };
}

/**
 * Waypoints carrying the bus from tile `from` to tile `to`, exclusive of the pads. Empty when they are the
 * same tile or nothing connects them (then the hop stays straight, and the LED is reported unreachable
 * upstream).
 *
 * `taken` makes a waypoint dearer each time the other net has already used it, which with chords available
 * actually buys a different route rather than the same one at a higher price.
 */
export function corridorPath(
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

export function searchCorridor(
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
  const starts = (c.mids.get(from) ?? []).filter((m) => !c.refused.has(ptKey(m)));
  const goal = new Set((c.mids.get(to) ?? []).map(ptKey).filter((k) => !c.refused.has(k)));
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
    // A binary heap, not a scan of every distance: this runs inside the polarity descent, once per net per
    // build, and the scan made a 12-LED puffin plan take two seconds -- far too slow to re-plan on every
    // click. (It said "rip-up loop" for a long time. There is no rip-up in this router and never has been:
    // a net that cannot be routed clear is reported, not torn up and retried. See `planNets`.)
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
        if (c.refused.has(k)) continue; // the crease there would crack the trace — see `strainLimit`
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


/**
 * How good a plan is, as a tuple ranked worst-fault-first — the router's objective.
 *
 * `[ chips, terminals, crossings, defects, length ]`, every entry a count or a length and all of them
 * "lower is better". Compared by {@link lexLess}: the first entry that differs decides, and nothing below
 * it is consulted. Tape under a chip destroys the part, tape over a battery terminal shorts the supply, a
 * PWR×GND crossing shorts the layout, a defect makes the sheet hard to weed, and length is only a
 * tie-breaker — so no amount of one may ever buy a unit of the one above it.
 *
 * **This used to be a weighted sum**, `chips·1e12 + terms·1e9 + crossings·1e6 + defects + length·1e-6`,
 * whose comments claimed exactly the ranking above. It behaved that way only because the constants were far
 * apart: nothing clamped a tier, so a large enough lower tier would have outranked a higher one and the
 * guarantee held by arithmetic accident rather than by construction. Measured before the change, the worst
 * defect tier on the bundled patterns was 214.5 against the 1e6 crossing weight — a margin of about 4,700×,
 * so the separation was in no danger here. That is why the change is output-identical, and it is also why
 * it was worth making: a property that is true by construction does not have to be re-measured whenever a
 * pattern gets bigger.
 *
 * **Index 3 is deliberately a sum, and it is the one place two measures are traded.** See {@link planRoutes}.
 */
export type PlanKey = readonly [
  chips: number,
  terminals: number,
  crossings: number,
  defects: number,
  length: number,
];

/**
 * Whether `a` is a strictly better plan than `b` — lexicographic, short-circuiting at the first difference.
 *
 * `upto` limits the comparison to the leading entries, which is how a caller asks "better on everything
 * except length": pass 4. That replaces subtracting the length term back out of a weighted sum, which was
 * itself a trick that depended on the scale separation holding.
 *
 * Equal keys give `false`, so this is a strict order and `!lexLess(b, a)` is "a is no worse than b".
 */
export function lexLess(a: PlanKey, b: PlanKey, upto: number = a.length): boolean {
  for (let i = 0; i < upto; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** A plan with no fault of any kind left to fix — every entry zero, so the search can stop. */
function flawless(k: PlanKey): boolean {
  return k.every((v) => v === 0);
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
      // The pad this run is allowed to land on — a rail's own. A declared net has none: it has no business
      // on either of the chip's legs, so nothing is exempt and any copper over the body counts.
      //
      // `t.net === "pwr" ? pad.pwr : pad.gnd` gave every non-rail net GND's pad as its own, which both
      // excused it from real copper over the chip and scored it against the wrong leg.
      const own: Vec2 | null =
        t.net === "pwr" ? pad.pwr : t.net === "gnd" ? pad.gnd : null;
      for (let i = 1; i < t.pts.length && !bad; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        const L = len(sub(b, a));
        const steps = Math.max(2, Math.ceil(L / (clear * 0.5)));
        for (let k = 0; k <= steps; k++) {
          const u = k / steps;
          const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
          if (own && len(sub(m, own)) <= padR) continue; // landing on its own pad is the point
          if (segPointDist(pad.pwr, pad.gnd, m) < clear) { bad = true; break; }
        }
      }
      if (bad) break;
    }
    if (bad) n++;
  }
  return n;
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
    // A rail must clear the OTHER rail's terminal; its own is where it starts. Anything else — a declared
    // net — has no terminal of its own here and must clear both.
    //
    // `t.net === "pwr" ? term.gnd : term.pwr` read every non-PWR net as GND, so a net called `sig` was
    // forbidden from the PWR terminal and free to sweep the GND one. Wrong in both directions at once.
    const forbidden =
      t.net === "pwr" ? [term.gnd] : t.net === "gnd" ? [term.pwr] : [term.pwr, term.gnd];
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      if (forbidden.some((f) => segPointDist(a, b, f) < clear)) {
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
  // Each unordered PAIR of distinct nets, once, rather than PWR against GND by name. With declared nets a
  // circuit has more than two, and naming the rails left every other pair unscored — two signal nets could
  // lie on each other for free.
  //
  // Pairs and not "each run against all the others", which is the same idea and is wrong: it charges a
  // PWR/GND overlap twice, once from each side, which is a different number from the one this function has
  // always returned. That number feeds the bus router's own scoring, so doubling it silently re-planned
  // every bundled circuit and cost two tests that had nothing to do with nets. The rails keep their exact
  // reading; the new pairs are additive.
  const nets = [...new Set(traces.map((t) => t.net))];
  const pairs: [string, string][] = [];
  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      // PWR first when this is the rail pair, so the sampled side is the one it has always been.
      const [a, b] = [nets[i]!, nets[j]!];
      pairs.push(b === "pwr" ? [b, a] : [a, b]);
    }
  }
  let shared = 0;
  for (const [from, to] of pairs) {
  const gnd = traces.filter((t) => t.net === to);
  for (const a of traces.filter((t) => t.net === from)) {
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
  }
  return shared;
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
  // Every net present, not the two rails by name. A circuit may now carry any number of declared nets, and
  // naming the rails made a routed declared net free to lie on top of itself and cost nothing.
  for (const net of new Set(traces.map((t) => t.net))) {
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


/**
 * Joins where two runs of one net leave the same point at a sharp angle.
 *
 * A cutter has to weed the substrate between them, and a narrow wedge tears or lifts instead of coming away —
 * so two strips doubling back alongside each other are a cutting defect, not just an untidy one.
 */
export function countAcuteJoins(traces: Trace2D[], minAngle = Math.PI / 6): number {
  let n = 0;
  // Every net present, not the two rails by name: a declared net's runs meet at sharp angles and tear the
  // substrate exactly as a rail's do. For a bus circuit the set is precisely {pwr, gnd}, so this reads the
  // same number it always has.
  for (const net of new Set(traces.map((t) => t.net))) {
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


/** Total copper length. */
export function totalLength(traces: Trace2D[]): number {
  let s = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) s += len(sub(t.pts[i]!, t.pts[i - 1]!));
  }
  return s;
}
