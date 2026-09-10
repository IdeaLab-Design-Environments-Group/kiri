/**
 * **Model** — what a routing run produced, as a plain record.
 *
 * `planRoutes` is 1,200 lines of search; the shape of its *answer* is this file, and separating the two is
 * what lets the canvas, the exporters and the rules name a plan without importing the router that made
 * one. The same move `trace-types.ts` already made for {@link Trace2D} and the part spans, one level up:
 * those are pieces of a plan, this is the plan.
 *
 * Not in `trace-types.ts` itself because a plan names two things that are *outcomes* rather than
 * geometry — {@link RoutedNet} from `net-routing.ts` and {@link NetlistFault} from `netlist.ts` — and both
 * of those modules read `trace-types.ts`, so putting this there would close a cycle (R11).
 */
import type { Jump, PadPair, PartPlacement, PartSpan, Trace2D } from "./trace-types.js";
import type { RoutedNet } from "./net-routing.js";
import type { NetlistFault } from "./netlist.js";

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
   * Whether the circuit this plan was made for had a battery on it.
   *
   * The only thing on the sheet whose net membership is not a routing outcome: a battery's two terminals
   * ARE PWR and GND, drawn as such, whatever the router does with them. It is recorded here rather than
   * read off the live circuit because that is the question anything reporting on the copper is actually
   * asking — *was there a battery in the plan I am looking at* — and the live circuit answers a different
   * one whenever the plan is out of date. A battery alone routes to no traces at all, so `traces` cannot
   * stand in for it. Optional: a plan object from before this field reads as no battery, the safe way.
   */
  battery?: boolean;
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
  /** Seam rejoins the router made, to be soldered once folded. Author-drawn ones reach the canvas and the
   *  export from the circuit through the service instead, exactly as drawn wires do. */
  jumps?: Jump[];
}

/** A plan for a circuit with nothing on it: every list empty, no battery. Shared, so never mutated. */
export const EMPTY_ROUTE: RoutedCircuit = {
  traces: [], pads: [], unreachable: [], unseated: [], resistors: [], switches: [], parts: [], nets: [], netFaults: [],
};
