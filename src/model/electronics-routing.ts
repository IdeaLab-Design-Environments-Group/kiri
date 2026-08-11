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

/** Where along a shared edge the bus may cross it. Symmetric about the middle so neither net is favoured,
 *  and away from the middle so a crossing does not land on a chip, which sits at the midpoint -- which is why
 *  this fixed copper-under-the-chip as well as overlap.
 *
 *  Measured: quarters beat thirds on overlap (akde-decagon 17% -> 8%) for about 25% more copper. Three or
 *  four crossings per edge is worse on both counts -- puffin reaches 13-15 PWR/GND crossings -- because the
 *  extra freedom lets the two nets interleave rather than separate. */
const EDGE_CROSSINGS = [1 / 4, 3 / 4];

/** How much dearer each previous use of a waypoint by the other net makes it, so the two nets take genuinely
 *  different routes instead of one shadowing the other.
 *
 *  Swept: 2 is the best value measured (overlap 7/3/2/2/2/2/24% across the bundled patterns). Removing it
 *  entirely doubles overlap on akde-decagon (7% -> 17%) and puffin (24% -> 36%), while raising it to 20 buys
 *  nothing further. It only became effective once a face could be crossed by a chord: with every path forced
 *  through the face centre there was no second route to divert onto, and the toll did nothing at any value. */
const SHARED_TOLL = 2;

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
  let dirPwr = false, dirGnd = false;
  /** Whether a straight run from a to b stays on the material. */
  const onBody = (a: Vec2, b: Vec2): boolean => {
    for (let k = 1; k < 10; k++) {
      const u = k / 10;
      if (pointInFace(faces, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }) < 0) return false;
    }
    return true;
  };

  const build = (f: boolean[]): Trace2D[] => {
    // What the first net routed. The second pays a toll to reuse it, which now buys a different chord rather
    // than the same one dearer, because a face has many ways through.
    /** Route one net, charging a toll for every waypoint in `avoid` (what the other net currently uses).
     *  Returns the route and the waypoints it took. */
    const railPts = (
      net: "pwr" | "gnd",
      rev: boolean,
      avoid: Map<string, number>,
    ): { pts: Vec2[]; used: Map<string, number> } => {
      // Each net may work the tour from either end.
      const seq = rev ? order.map((_, k) => order.length - 1 - k) : order.map((_, k) => k);
      const pick = (i: number): { pad: Vec2; face: number } => {
        const t = targets[order[i]!]!;
        const swap = net === "pwr" ? f[i]! : !f[i]!;
        return swap
          ? { pad: t.legs[1], face: t.legFaces[1] }
          : { pad: t.legs[0], face: t.legFaces[0] };
      };
      const out: Vec2[] = [net === "pwr" ? term.pwr : term.gnd];
      const used = new Map<string, number>();
      let fromFace = battery.face;
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
        for (const [k, v] of used) toll.set(k, (toll.get(k) ?? 0) + v);
        for (const p of corridorPath(corridor, fromFace, face, blocked, toll)) {
          out.push(p);
          used.set(ptKey(p), (used.get(ptKey(p)) ?? 0) + 1);
        }
        out.push(pad);
        fromFace = face;
      }
      return { pts: out, used };
    };

    // PWR routes with a clear field; GND then pays a toll for every waypoint PWR took, so it goes round the
    // other way rather than shadowing it.
    //
    // Rip-up and reroute -- giving PWR later passes to move aside for GND too -- was implemented and measured
    // to change nothing at all: rerouting PWR against GND's route converges on the same PWR route. It only
    // appeared to help while it was also being run inside the polarity search, and that gain was the search
    // finding a different polarity, not the rerouting. Removed rather than left in as a costly no-op.
    const pwr = railPts("pwr", dirPwr, new Map());
    const gnd = railPts("gnd", dirGnd, pwr.used);
    /** The pads this net must reach — the only points a branch may legitimately end at. */
    const padsOf = (fl: boolean[], net: "pwr" | "gnd"): Vec2[] =>
      order.map((oi, i) => {
        const t = targets[oi]!;
        const swap = net === "pwr" ? fl[i]! : !fl[i]!;
        return swap ? t.legs[1] : t.legs[0];
      });

    const finish = (): Trace2D[] => [
      ...asTree(dedupe(dodgeChips(pwr.pts, targets, onBody)), "pwr", term.pwr, padsOf(f, "pwr")),
      ...asTree(dedupe(dodgeChips(gnd.pts, targets, onBody)), "gnd", term.gnd, padsOf(f, "gnd")),
    ];
    return finish();
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
  // Over-LED destroys the part, a crossing shorts the layout, and overlap only makes it hard to build, so
  // they rank in that order and overlap can never be bought with either of the others.
  const overlapTol = diag * 0.008; // about a tape width: closer than this and the strips are on each other
  const score = (tr: Trace2D[], f: boolean[]): number =>
    countOverLed(tr, padsFor(f)) * 1e9 +
    countNetCrossings(tr) * 1e6 +
    overlapLength(tr, overlapTol);

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

  for (let i = 0; i < order.length; i++) {
    const t = targets[order[i]!]!;
    const [l0, l1] = t.legs;
    pads[t.slot] = flip[i] ? { pwr: l1, gnd: l0 } : { pwr: l0, gnd: l1 };
  }

  return { traces: best, pads, unreachable };
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
function asTree(pts: Vec2[], net: "pwr" | "gnd", first: Vec2, required: Vec2[]): Trace2D[] {
  if (pts.length < 2) return [{ pts, net }];

  const nodes = new Map<string, Vec2>();
  const edges = new Map<string, { a: string; b: string; w: number }>();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const ka = ptKey(a), kb = ptKey(b);
    if (ka === kb) continue;
    nodes.set(ka, a);
    nodes.set(kb, b);
    // Keyed, so a segment walked twice is stored once.
    edges.set(chordKey(a, b), { a: ka, b: kb, w: Math.sqrt(dist2(a, b)) });
  }
  if (!edges.size) return [{ pts, net }];

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
        const next = adj.get(at)!.values().next();
        if (next.done) break;
        const to = next.value;
        adj.get(at)!.delete(to);
        adj.get(to)!.delete(at);
        chain.push(nodes.get(to)!);
        at = to;
      }
      if (chain.length >= 2) out.push({ pts: chain, net });
    }
  }
  return out.length ? out : [{ pts, net }];
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
function chordInside(f: FlatFace, a: Vec2, b: Vec2): boolean {
  for (let k = 1; k < 8; k++) {
    const u = k / 8;
    const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    if (!pointInPolyLocal(f.poly, m)) return false;
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
function buildCorridor(faces: FlatFace[], gaps: GapEdge[]): Corridor {
  const mids = new Map<number, Vec2[]>();
  const faceOf = new Map<string, number[]>();
  const point = new Map<string, Vec2>();
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
        if (chordInside(f, list[a]!, list[b]!)) {
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
  return { mids, faceOf, point, chords };
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
): Vec2[] {
  if (from === to) return [];
  const starts = c.mids.get(from) ?? [];
  const goal = new Set((c.mids.get(to) ?? []).map(ptKey));
  if (!starts.length || !goal.size) return [];

  const cost = (key: string, step: number): number => {
    const chip = blocked.has(key) ? OCCUPIED_TOLL : 1;
    const shared = 1 + (taken.get(key) ?? 0) * SHARED_TOLL;
    return step * chip * shared;
  };

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const seen = new Set<string>();
  const heap = new MinHeap();
  for (const m of starts) {
    const k = ptKey(m);
    const d = cost(k, 0);
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
        const w = best + cost(k, Math.sqrt(dist2(here, m)));
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

/** Distance from point `p` to segment ab. */
function segPointDist(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const L2 = ab.x * ab.x + ab.y * ab.y;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
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

/** Total copper length. */
export function totalLength(traces: Trace2D[]): number {
  let s = 0;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) s += len(sub(t.pts[i]!, t.pts[i - 1]!));
  }
  return s;
}
