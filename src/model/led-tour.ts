/**
 * **Model** — which LEDs the bus visits, and in what order.
 *
 * ## Why this is its own file
 *
 * The two-rail bus is one tour from the battery past every LED, and the order it visits them in is an
 * ordinary travelling-salesman problem: nearest-neighbour for a first guess, then 2-opt to shorten it.
 * The 2-opt does double duty — a self-crossing path is always strictly longer than the same path with
 * the crossing span reversed, so shortening the tour removes self-crossings for free.
 *
 * None of that is about copper. It is ordering points, and it is testable as such.
 *
 * {@link Target} lives here because it is what the tour is over: one LED the router has decided it can
 * actually wire, already seated, with the hinge it straddles and the two copper ends it will land on.
 */
import { type Vec2, dist2 } from "./electronics.js";
import { len, sub } from "./trace-geometry.js";

/** One LED that will actually be wired. */
export interface Target {
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
 * Visiting order for a set of points, starting from `from`: nearest-neighbour, then 2-opt.
 *
 * Each net orders its *own* pads with this. The shared order is built from the hinge midpoints, but a net's
 * pads sit to one side of those hinges, so an order that is short hinge-to-hinge can zigzag pad-to-pad -- the
 * net then runs out and back across itself to reach pads it could have taken in sequence.
 */
export function tourOf(from: Vec2, pts: Vec2[]): number[] {
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

export function nearestTour(centre: Vec2, targets: Target[]): number[] {
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
export function twoOpt(order: number[], centre: Vec2, targets: Target[]): number[] {
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


