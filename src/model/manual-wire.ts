/**
 * **Model** — hand-drawn wires, and where their ends actually land.
 *
 * The router plans copper for the author. This is the other half: copper the author plans themselves, a
 * polyline they draw and the router must then treat as immovable. Everything here is the *resolution* step
 * — turning a wire's stored endpoints into points on the flat pattern — and nothing here routes, plans or
 * decides anything the router decides.
 *
 * A vertex is stored by **what it is attached to**, not by where that thing currently is: a pad of a part,
 * a leg of an LED, a terminal of the battery, or a free point the author put down. So moving a part drags
 * the wire with it, and a wire outlives every re-plan the router does underneath it. The cost is that a
 * vertex can stop resolving — the part was deleted, the pattern changed under the LED — and the rule for
 * that is stated once and obeyed everywhere: **a dangling vertex is dropped, never thrown on.** The wire
 * stays in the circuit with its dangling end intact so the author can re-attach it. Deleting their work
 * because a lookup failed is the one outcome that cannot be undone.
 *
 * Units are **flat pattern units** throughout — the same space as `PlacedPart.x/y` and {@link Trace2D.pts},
 * never millimetres. A footprint's pads are in millimetres about the part's own origin, so that boundary is
 * crossed by {@link toFlat} and by {@link padPosition}, which already does it. Getting this wrong yields
 * geometry that looks plausible and is the wrong size, which has caught this codebase out before.
 */
import {
  gapForLed,
  type Circuit,
  type FlatFace,
  type GapEdge,
  type Vec2,
} from "./electronics.js";
import {
  TAPE_MM,
  batteryTerminals,
  ledSeat,
  patternDiag,
  seatLed,
  type Trace2D,
} from "./electronics-routing.js";
import { padPosition } from "./netlist.js";
import { footprintById } from "./library.js";

/**
 * One end of a hand-drawn wire.
 *
 * The three attached kinds name a thing in the circuit, which is what makes a wire survive the thing
 * moving. `free` is a bare point, for the stretches of a wire that are not anchored to anything.
 *
 * An LED's leg is `0` or `1`, and deliberately not `"pwr"`/`"gnd"`: which leg carries which rail is
 * something the *router* works out — it flips LEDs to clear crossings — so naming a side here would make
 * the wire depend on the plan that the wire is supposed to constrain. `0` is the leg on the LED's own face
 * `a`, `1` the leg on face `b`, and those two are fixed by the circuit alone.
 */
export type WireVertex =
  /** A point the author placed, in flat pattern units. */
  | { kind: "free"; x: number; y: number }
  /** A pad of a placed part: an index into {@link Circuit.parts} and the pad's own name. */
  | { kind: "pad"; part: number; pad: string }
  /** A leg of an LED: an index into {@link Circuit.leds}, and which of its two legs. */
  | { kind: "led"; led: number; leg: 0 | 1 }
  /** One of the battery's two terminals. */
  | { kind: "battery"; side: "pwr" | "gnd" };

/** One wire the author drew: an ordered run of vertices, and what it is to be made of. */
export interface ManualWire {
  /** Stable for the life of the wire — the canvas selects by it, and it is this wire's net when it has no other. */
  id: string;
  pts: WireVertex[];
  /**
   * Which net this wire carries, where the author has said.
   *
   * Left unset the wire's own {@link id} is used, so an unnamed wire is a net of its own. That is what an
   * unnamed hand wire *is* — it joins the things it touches and nothing else — and it keeps two unrelated
   * unnamed wires from reading as one net downstream, which a shared placeholder name would do.
   *
   * **The fallback is a floor, not a default to lean on.** `countNetCrossings` skips a pair of runs only
   * when `A.net === B.net`, so a wire carrying its own id differs from *everything* — every routed rail,
   * every other wire, including a second unnamed one drawn on the same conductor. Every crossing it makes
   * is then counted as a net violation, and the rules that read those counts treat a net crossing as an
   * error rather than a warning. So the wire tool should set `net` to the net the author is drawing on;
   * the fallback exists so a wire mid-draw is never silently merged into someone else's net, not so the
   * tool can skip asking.
   */
  net?: string;
  /** Width in pattern units, where this wire is not ordinary tape. See {@link Trace2D.width}. */
  width?: number;
}

/** Everything resolving a vertex needs: the pattern, the circuit on it, and this pattern's tape width. */
export interface WireContext {
  faces: FlatFace[];
  gaps: GapEdge[];
  circuit: Circuit;
  /**
   * The tape in THIS pattern's units — `tapeWidthFor(faces, sheetMm, sheet, circuit)`.
   *
   * Supplied rather than computed here, and the caller must derive it from the **same circuit** it is
   * putting in {@link WireContext.circuit}: the width now depends on how many runs have to fit, so a
   * caller that computes it without the circuit draws wires at a width the router never planned to.
   */
  tapeW: number;
  /**
   * The same tape in millimetres — `tapeMmFor(faces, sheetMm)`. Optional, and {@link TAPE_MM} when it is
   * left out, which is right for every caller that has not asked the router to choose a roll by area.
   *
   * `tapeW / tapeMm` is this pattern's scale. Supplying one without the other converts every footprint
   * dimension by the ratio of two different tapes, which is the failure this codebase names in
   * `netlist.ts`: pad positions that look plausible and are the wrong size.
   */
  tapeMm?: number;
}

/**
 * Millimetres on a footprint to this pattern's units.
 *
 * The router's own conversion, which it keeps private, and the netlist's. Exported here because a caller
 * placing a wire vertex against a footprint dimension has to cross the same boundary and there is no
 * reason for a third copy of it.
 */
export function toFlat(mm: number, tapeW: number, tapeMm: number = TAPE_MM): number {
  return (mm * tapeW) / tapeMm;
}

/** Where one end of a wire sits on the flat pattern, or null when it no longer attaches to anything. */
export function resolveVertex(v: WireVertex, ctx: WireContext): Vec2 | null {
  switch (v.kind) {
    case "free":
      // Already in pattern units; copied rather than aliased so a caller cannot move a stored vertex.
      return { x: v.x, y: v.y };
    case "pad":
      return padVertex(v.part, v.pad, ctx);
    case "led":
      return ledVertex(v.led, v.leg, ctx);
    case "battery":
      return batteryVertex(v.side, ctx);
  }
}

function padVertex(index: number, pad: string, ctx: WireContext): Vec2 | null {
  const part = (ctx.circuit.parts ?? [])[index];
  if (!part) return null;
  const fp = footprintById(part.component);
  if (!fp) return null;
  // `padPosition` refuses a pad that is not a terminal — a footprint's mounting pegs are pads in the file
  // and carry no signal, so a wire to one would be copper run to a hole. It also does the mm→flat bridge
  // and the `flip` half-turn, which is the whole reason this does not compute the offset itself.
  return padPosition(part, fp, pad, ctx.tapeW, ctx.tapeMm ?? TAPE_MM);
}

/**
 * Where one leg of an LED lands, read off the LED's own footprint and the hinge it straddles.
 *
 * Independent of routing, and that is the point: {@link seatLed} takes the gap, the faces and the part,
 * and never looks at `led.flip` or at any plan. Leg `0` is the pad on face `a` and leg `1` the pad on face
 * `b` — which requires checking the gap's own A/B order, because a gap knows its two faces in its own
 * order and that is not the LED's.
 */
function ledVertex(index: number, leg: 0 | 1, ctx: WireContext): Vec2 | null {
  const led = ctx.circuit.leds[index];
  if (!led) return null;
  const gap = gapForLed(ctx.gaps, led);
  if (!gap) return null; // the pattern changed and this hinge is gone
  const seat = ledSeat(led.component);
  if (!seat) return null;
  const pads = seatLed(gap, ctx.faces, seat, ctx.tapeW);
  if (!pads) return null; // this part cannot be seated on this hinge — see `seatLed`
  const [onFaceA, onFaceB] = pads;
  const wantFaceA = gap.faceA === led.a;
  const onLedA = wantFaceA ? onFaceA : onFaceB;
  const onLedB = wantFaceA ? onFaceB : onFaceA;
  return leg === 0 ? onLedA : onLedB;
}

function batteryVertex(side: "pwr" | "gnd", ctx: WireContext): Vec2 | null {
  const battery = ctx.circuit.battery;
  if (!battery) return null;
  const face = ctx.faces[battery.face];
  if (!face || face.poly.length < 3) return null;
  // The same call the router makes, with the same arguments, because the pads have to agree to the last
  // decimal: a wire drawn to a terminal the router places elsewhere lands off the copper.
  const term = batteryTerminals(face.centroid, patternDiag(ctx.faces), face.poly, ctx.tapeW);
  return side === "pwr" ? term.pwr : term.gnd;
}

/**
 * One wire as a run of copper, or null when too little of it is left to be one.
 *
 * Dangling vertices are dropped and the rest is kept, so a wire with one end on a deleted part still draws
 * as the stretch that remains. Below two surviving vertices there is no polyline to draw and this returns
 * null — the wire itself is untouched in the circuit either way.
 */
export function resolveWire(w: ManualWire, ctx: WireContext): Trace2D | null {
  const pts: Vec2[] = [];
  for (const v of w.pts) {
    const at = resolveVertex(v, ctx);
    if (at) pts.push(at);
  }
  if (pts.length < 2) return null;
  const trace: Trace2D = { pts, net: w.net ?? w.id };
  if (w.width !== undefined) trace.width = w.width;
  return trace;
}

/**
 * Every hand-drawn wire on this circuit, as copper.
 *
 * Bit-identical across calls on identical input, which the canvas and the export both rely on: they
 * resolve independently and have to agree, and a wire that moved by a rounding step between the two would
 * print somewhere the author never saw it.
 */
export function manualTraces(ctx: WireContext): Trace2D[] {
  const out: Trace2D[] = [];
  for (const w of ctx.circuit.wires ?? []) {
    const t = resolveWire(w, ctx);
    if (t) out.push(t);
  }
  return out;
}
