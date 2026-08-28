/**
 * **Model** — the vocabulary of a copper plan: what a run, a pad, a seat and a corridor *are*.
 *
 * ## Why this is its own file
 *
 * These types are the contract between the router, the exporters, the canvas and the folded preview.
 * They lived in `electronics-routing.ts`, which meant every module that merely wanted to *name* a
 * {@link Trace2D} had to import the router — and the router imported those modules back for the work they
 * do. Holding the shared vocabulary in a leaf module ends that: types point down, never sideways.
 *
 * Deliberately types and nothing else. There is no behaviour here to disagree with, so a module can
 * depend on this without inheriting a routing policy. {@link RoutedCircuit}, the aggregate the router
 * hands back, stays with the router: it is that function's result, not shared vocabulary.
 *
 * All geometry is flat-pattern 2D in the pattern's own units.
 */
import type { Vec2 } from "./electronics.js";
import type { Box, Footprint } from "./footprint.js";

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


export interface Terminals {
  pwr: Vec2;
  gnd: Vec2;
  /** Half-width of each pad, after clamping to what the tile can hold. */
  half: number;
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
