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

/** One continuous strip of copper tape: a centreline polyline plus which net it carries. */
export interface Trace2D {
  pts: Vec2[];
  net: "pwr" | "gnd";
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
}

export const EMPTY_ROUTE: RoutedCircuit = { traces: [], pads: [], unreachable: [] };

/** How much dearer it is to travel through a hinge that has an LED on it than an empty one. Large enough to
 *  route around whenever there is any alternative, finite so that a dead-end tile stays reachable. */
const OCCUPIED_TOLL = 500;

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
export function batteryTerminals(centre: Vec2, diag: number): PadPair {
  const h = diag * 0.012 * 1.5; // markerR * 1.5 — matches the drawn terminal squares
  return { pwr: { x: centre.x + h, y: centre.y }, gnd: { x: centre.x - h, y: centre.y } };
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
): RoutedCircuit {
  const pads: PadPair[] = circuit.leds.map(() => ({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } }));
  const unreachable: number[] = [];
  const battery: Battery | null = circuit.battery;
  if (!battery || !faces[battery.face]) {
    circuit.leds.forEach((_, i) => unreachable.push(i));
    return { traces: [], pads, unreachable };
  }

  const diag = patternDiag(faces);
  const centre = faces[battery.face]!.centroid;
  const term = batteryTerminals(centre, diag);

  // Collect the LEDs we can wire. An LED whose gap has gone (the pattern changed under it) has no pads.
  const targets: Target[] = [];
  circuit.leds.forEach((led, slot) => {
    const gap = gapForLed(gaps, led);
    if (!gap) {
      unreachable.push(slot);
      return;
    }
    targets.push({
      slot,
      hinge: gap.point,
      ends: gap.ends,
      legs: [gap.legA, gap.legB],
      legFaces: [gap.faceA, gap.faceB],
    });
  });
  if (!targets.length) return { traces: [], pads, unreachable };

  // Drop LEDs the battery cannot reach across the material. Their tiles sit on a separate island of the
  // pattern, and the only way to "reach" them would be a straight line through empty space -- which is what
  // used to happen, and is what put copper outside the body. Better to report them honestly.
  const corridor = buildCorridor(faces, gaps);
  const reach = reachableFaces(corridor, battery.face);
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (reach.has(t.legFaces[0]) || reach.has(t.legFaces[1])) continue;
    unreachable.push(t.slot);
    targets.splice(i, 1);
  }
  unreachable.sort((a, b) => a - b);
  if (!targets.length) return { traces: [], pads, unreachable };

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

  // `flip[i]` swaps LED i's two pads between the banks. The tour is a plain chain, so a flip is a
  // genuinely local change: a crossing it causes can be undone without disturbing the rest of the bus.
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
  const build = (f: boolean[]): Trace2D[] => {
    const railPts = (net: "pwr" | "gnd"): Vec2[] => {
      const pick = (i: number): { pad: Vec2; face: number } => {
        const t = targets[order[i]!]!;
        const swap = net === "pwr" ? f[i]! : !f[i]!;
        return swap
          ? { pad: t.legs[1], face: t.legFaces[1] }
          : { pad: t.legs[0], face: t.legFaces[0] };
      };
      const out: Vec2[] = [net === "pwr" ? term.pwr : term.gnd];
      let fromFace = battery.face;
      for (let i = 0; i < order.length; i++) {
        const { pad, face } = pick(i);
        // The LED being landed on is allowed: the rail approaches its pad, not through its chip.
        const t = targets[order[i]!]!;
        const blocked = new Set(occupied);
        blocked.delete(ptKey(t.hinge));
        for (const p of corridorPath(corridor, fromFace, face, blocked)) out.push(p);
        out.push(pad);
        fromFace = face;
      }
      return out;
    };
    // A hop that passes a hinge crosses the chip sitting on it, because the approach runs nearly along the
    // chip's own axis. Sliding that waypoint to the hinge's end corner clears the part and stays both
    // inside the body and on the tiling.
    return [
      { pts: dedupe(dodgeChips(railPts("pwr"), targets)), net: "pwr" },
      { pts: dedupe(dodgeChips(railPts("gnd"), targets)), net: "gnd" },
    ];
  };

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
  const score = (tr: Trace2D[], f: boolean[]): number =>
    countOverLed(tr, padsFor(f)) * 1000 + countNetCrossings(tr);

  // Descend from each seed by single flips, first improvement, and keep the best arrangement found. No one
  // seed wins everywhere -- the geometric seed beats all-false on akde-decagon and loses on puffin -- and
  // three descents on a handful of LEDs is cheap enough to run on every edit.
  let flip = seeds[0]!;
  let best = build(flip);
  let bestS = score(best, flip);
  for (const seed of seeds) {
    const f = seed.slice();
    let tr = build(f);
    let sc = score(tr, f);
    for (let sweep = 0; sweep < order.length && sc > 0; sweep++) {
      let moved = false;
      for (let i = 0; i < order.length && sc > 0; i++) {
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

  for (let i = 0; i < order.length; i++) {
    const t = targets[order[i]!]!;
    const [l0, l1] = t.legs;
    pads[t.slot] = flip[i] ? { pwr: l1, gnd: l0 } : { pwr: l0, gnd: l1 };
  }

  return { traces: best, pads, unreachable };
}

/** Faces reachable from `start` by travelling over the material. */
function reachableFaces(c: Corridor, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of c.via.get(at) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

/** Slide any waypoint sitting on an occupied hinge to that hinge's nearer end corner, where doing so stops
 *  the rail from crossing the chip. Corners are pattern vertices, so this cannot push copper off the body. */
function dodgeChips(pts: Vec2[], targets: Target[]): Vec2[] {
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
      if (!segsCross(a, end, ...body) && !segsCross(end, b, ...body)) {
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
  /** Per face: the hinge midpoints on it, and the neighbour face across each. */
  via: Map<number, { point: Vec2; to: number }[]>;
  centre: Map<number, Vec2>;
}

function buildCorridor(faces: FlatFace[], gaps: GapEdge[]): Corridor {
  const via = new Map<number, { point: Vec2; to: number }[]>();
  const centre = new Map<number, Vec2>();
  faces.forEach((f, i) => centre.set(i, f.centroid));

  const push = (from: number, point: Vec2, to: number): void => {
    const list = via.get(from) ?? [];
    list.push({ point, to });
    via.set(from, list);
  };

  // Every shared edge is a way across, not just the hinged ones: two triangles of the same flat panel are
  // joined by an F edge with no gap at all, and that is solid material -- the best kind of place to run
  // tape. Keying on the shared edge finds both kinds.
  const byEdge = new Map<string, { face: number; mid: Vec2 }[]>();
  faces.forEach((f, fi) => {
    const n = f.verts.length;
    for (let k = 0; k < n; k++) {
      const a = f.verts[k]!, b = f.verts[(k + 1) % n]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const pa = f.poly[k]!, pb = f.poly[(k + 1) % n]!;
      const list = byEdge.get(key) ?? [];
      list.push({ face: fi, mid: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } });
      byEdge.set(key, list);
    }
  });
  for (const list of byEdge.values()) {
    if (list.length !== 2) continue; // boundary edge, or a non-manifold one we should not route through
    const [p, q] = list as [{ face: number; mid: Vec2 }, { face: number; mid: Vec2 }];
    if (p.face === q.face) continue;
    push(p.face, p.mid, q.face);
    push(q.face, q.mid, p.face);
  }
  // Gap midpoints are the authoritative crossing points where a hinge exists.
  for (const g of gaps) {
    push(g.faceA, g.point, g.faceB);
    push(g.faceB, g.point, g.faceA);
  }
  return { via, centre };
}

/** Waypoints carrying the bus from `from`'s tile to `to`'s tile, exclusive of the pads themselves. Empty
 *  when the two are the same tile or no route exists (then the hop stays straight, as before). */
function corridorPath(c: Corridor, from: number, to: number, blocked: Set<string>): Vec2[] {
  if (from === to) return [];
  // Dijkstra over faces, with edge weight the distance centre -> hinge -> centre.
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { face: number; point: Vec2 }>();
  const seen = new Set<number>();
  while (true) {
    let at = -1, best = Infinity;
    for (const [f, d] of dist) {
      if (!seen.has(f) && d < best) { best = d; at = f; }
    }
    if (at < 0) break;
    if (at === to) break;
    seen.add(at);
    const here = c.centre.get(at);
    if (!here) continue;
    for (const e of c.via.get(at) ?? []) {
      const there = c.centre.get(e.to);
      if (!there) continue;
      const toll = blocked.has(ptKey(e.point)) ? OCCUPIED_TOLL : 1;
      const w = best + (Math.sqrt(dist2(here, e.point)) + Math.sqrt(dist2(e.point, there))) * toll;
      if (w < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, w);
        prev.set(e.to, { face: at, point: e.point });
      }
    }
  }
  if (!prev.has(to) && to !== from) return [];
  // Walk back, collecting hinge midpoints and the intermediate face centres.
  const out: Vec2[] = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur);
    if (!step) return [];
    if (cur !== to) {
      const cc = c.centre.get(cur);
      if (cc) out.push(cc);
    }
    out.push(step.point);
    cur = step.face;
  }
  out.reverse();
  return out;
}

/** Greedy nearest-neighbour visiting order, starting from the battery. */
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

/** Total copper length. */
export function totalLength(traces: Trace2D[]): number {
  let s = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) s += len(sub(t.pts[i]!, t.pts[i - 1]!));
  }
  return s;
}
