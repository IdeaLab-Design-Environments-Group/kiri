/**
 * **Model** — an experimental copper router built the way Ilic et al. route capacitive sensors on 3D
 * objects ("Retrofitting Existing 3D Objects with Surface-Conforming Capacitive Sensing", SIGGRAPH '26),
 * rather than the way {@link planRoutes} does.
 *
 * **What is borrowed.** That paper gets its no-crossing-within-a-layer property from *geometry, not from a
 * solver*: each conductor is an integral curve of a tangent direction field with prescribed singularities,
 * and integral curves of one field cannot cross except at a singularity. Constraints are then a
 * belt-and-braces integer program over an oversampled candidate pool.
 *
 * **What had to change, and why.** Two structural differences:
 *
 * 1. Their surface is *curved*, so a tangent field carries real information (trivial connections, Crane et
 *    al. 2010). A kirigami flat pattern is **planar**, where parallel transport is the identity — a field
 *    with a single sink at the battery degenerates to straight radial lines. So "trace the field" here
 *    means "run straight at the terminal", which is implemented as {@link RouteStyle} `"fan"`.
 * 2. Their drive/sense lines are **independent** conductors that each merely have to reach the base. PWR
 *    and GND here are **nets**: every pad must end up electrically common. A family of integral curves is
 *    not a connected tree, so the paper's construction cannot be used unmodified. `"mst"` instead takes the
 *    Euclidean minimum spanning tree over the net's pads plus its terminal — which keeps the property that
 *    actually matters (a Euclidean MST in the plane is planar, so a net never crosses *itself*) while
 *    costing far less copper than a fan.
 *
 * **What is deliberately dropped.** Every geometric restriction the production router enforces: copper is
 * free to leave the gray tiles, span the pinched-open gaps and run across the flexing membrane, and cross
 * a hinge anywhere rather than only at a contact corner. That is the point of the experiment — those
 * restrictions are where 89 % of the production router's PWR/GND crossings come from — but it means tape
 * laid to this plan crosses material that folds, and will crease there.
 */
import {
  type Circuit,
  type RoutedCircuit,
  type Trace2D,
  type Vec2,
  boundsDiagonal,
  dist2,
  flatFaces,
  gapForLed,
  gapGraph,
  tapeWidthForDiag,
} from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** How a net's copper is drawn once its pads are known. */
export type RouteStyle =
  /** The paper's construction on a planar domain: every pad runs straight at the terminal (a radial fan
   *  is the integral-curve family of a field whose only singularity is a sink at the terminal). */
  | "fan"
  /** Euclidean minimum spanning tree over terminal + pads. Also planar, so still no self-crossings, but
   *  a fraction of the copper. */
  | "mst";

export interface FieldRouteOptions {
  style?: RouteStyle;
  /**
   * Try every assignment of which leg of each LED carries PWR when there are at most this many LEDs, else
   * fall back to a greedy sweep. Routes are cheap to build here (no graph search), so unlike the
   * production router an exhaustive search is affordable at realistic sizes.
   */
  exhaustiveUpTo?: number;
}

/** Plan copper with no geometric restrictions at all. See the module note for what that costs. */
export function planRoutesFreeform(
  fold: FoldFile,
  circuit: Circuit,
  opts: FieldRouteOptions = {},
): RoutedCircuit {
  const style = opts.style ?? "mst";
  const exhaustiveUpTo = opts.exhaustiveUpTo ?? 14;

  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const ledPoints = circuit.leds.map((led) => gapForLed(gaps, led)?.point ?? { x: 0, y: 0 });

  const batteryFace = circuit.battery && circuit.battery.face >= 0 && circuit.battery.face < faces.length
    ? circuit.battery.face
    : null;
  const batteryPoint = batteryFace != null ? faces[batteryFace]?.centroid ?? { x: 0, y: 0 } : null;

  // Legs per LED, in authored order; LEDs whose gap is gone are unreachable exactly as before.
  const unreachable: number[] = [];
  const legs: { index: number; a: Vec2; b: Vec2 }[] = [];
  circuit.leds.forEach((led, index) => {
    const gap = gapForLed(gaps, led);
    if (!gap) { unreachable.push(index); return; }
    const aIsFaceA = gap.faceA === led.a;
    legs.push({ index, a: aIsFaceA ? gap.legA : gap.legB, b: aIsFaceA ? gap.legB : gap.legA });
  });

  const empty = (pads: { pwr: Vec2; gnd: Vec2 }[]): RoutedCircuit =>
    ({ ledPoints, ledPads: pads, batteryPoint, terminals: null, traces: [], unreachable });
  const padsFor = (rev: boolean[]): { pwr: Vec2; gnd: Vec2 }[] => {
    const out = circuit.leds.map(() => ({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } }));
    legs.forEach((l, s) => {
      out[l.index] = rev[s] ? { pwr: l.b, gnd: l.a } : { pwr: l.a, gnd: l.b };
    });
    return out;
  };
  if (batteryFace == null || legs.length === 0) return empty(padsFor(legs.map(() => false)));

  const diag = boundsDiagonal(faces.flatMap((f) => f.poly));
  const off = tapeWidthForDiag(diag) * 0.55;
  const terminals = terminalsFor(batteryPoint!, legs, diag);

  // Choose which leg of each LED carries PWR. The routes are straight-line constructions, so evaluating a
  // candidate is cheap enough to enumerate the whole space at realistic LED counts — the production
  // router can only afford a greedy sweep because every candidate there costs a re-route.
  const best = legs.length <= exhaustiveUpTo
    ? bestOf(enumerateAssignments(legs.length), (rev) => build(rev, legs, terminals, style, off))
    : bestOf(greedyAssignments(legs.length, (rev) => score(build(rev, legs, terminals, style, off))),
             (rev) => build(rev, legs, terminals, style, off));

  return {
    ledPoints,
    ledPads: padsFor(best.rev),
    batteryPoint,
    terminals,
    traces: best.traces,
    unreachable,
  };
}

/** Terminals straddling the perpendicular of the direction the pads lie in — same idea as production. */
function terminalsFor(centre: Vec2, legs: { a: Vec2; b: Vec2 }[], diag: number): { pwr: Vec2; gnd: Vec2 } {
  let mx = 0, my = 0;
  for (const l of legs) { mx += (l.a.x + l.b.x) / 2; my += (l.a.y + l.b.y) / 2; }
  mx = mx / legs.length - centre.x;
  my = my / legs.length - centre.y;
  let ax = -my, ay = mx;
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) { ax = 1; ay = 0; } else { ax /= al; ay /= al; }
  const half = Math.max(tapeWidthForDiag(diag) * 1.5, diag * 0.02);
  return {
    pwr: { x: centre.x + ax * half, y: centre.y + ay * half },
    gnd: { x: centre.x - ax * half, y: centre.y - ay * half },
  };
}

interface Built { rev: boolean[]; traces: Trace2D[] }

function build(
  rev: boolean[],
  legs: { a: Vec2; b: Vec2 }[],
  terminals: { pwr: Vec2; gnd: Vec2 },
  style: RouteStyle,
  off: number,
): Built {
  const pwrPads = legs.map((l, s) => (rev[s] ? l.b : l.a));
  const gndPads = legs.map((l, s) => (rev[s] ? l.a : l.b));
  const traces: Trace2D[] = [
    ...runsFor(terminals.pwr, pwrPads, style).map((points) => ({ net: "pwr" as const, points })),
    ...runsFor(terminals.gnd, gndPads, style).map((points) => ({ net: "gnd" as const, points })),
  ];
  void off;
  return { rev, traces };
}

/** One net's copper as polylines: either a radial fan or a Euclidean MST. Both are planar. */
function runsFor(terminal: Vec2, pads: Vec2[], style: RouteStyle): Vec2[][] {
  if (pads.length === 0) return [];
  if (style === "fan") return pads.map((p) => [terminal, p]);

  // Prim over terminal + pads. A Euclidean MST in the plane never has crossing edges, so the net cannot
  // cross itself — the property the paper gets from its integral curves, obtained here for free.
  const nodes = [terminal, ...pads];
  const inTree = new Array<boolean>(nodes.length).fill(false);
  const bestTo = new Array<number>(nodes.length).fill(Infinity);
  const parent = new Array<number>(nodes.length).fill(-1);
  bestTo[0] = 0;
  const edges: Vec2[][] = [];
  for (let k = 0; k < nodes.length; k++) {
    let u = -1, du = Infinity;
    for (let i = 0; i < nodes.length; i++) if (!inTree[i] && bestTo[i]! < du) { du = bestTo[i]!; u = i; }
    if (u < 0) break;
    inTree[u] = true;
    if (parent[u]! >= 0) edges.push([nodes[parent[u]!]!, nodes[u]!]);
    for (let v = 0; v < nodes.length; v++) {
      if (inTree[v]) continue;
      const w = dist2(nodes[u]!, nodes[v]!);
      if (w < bestTo[v]!) { bestTo[v] = w; parent[v] = u; }
    }
  }
  return edges;
}

/** PWR×GND proper crossings, then total copper — the objective, in that order. */
function score(b: Built): { cross: number; len: number } {
  const seg = (net: string) => {
    const out: [Vec2, Vec2][] = [];
    for (const t of b.traces) {
      if (t.net !== net) continue;
      for (let i = 1; i < t.points.length; i++) out.push([t.points[i - 1]!, t.points[i]!]);
    }
    return out;
  };
  const P = seg("pwr"), G = seg("gnd");
  let cross = 0;
  for (const [a, bb] of P) for (const [c, d] of G) if (properCross(a, bb, c, d)) cross++;
  let len = 0;
  for (const t of b.traces) {
    for (let i = 1; i < t.points.length; i++) len += dist2(t.points[i - 1]!, t.points[i]!);
  }
  return { cross, len };
}

function properCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const mag = Math.abs(a.x) + Math.abs(a.y) + Math.abs(b.x) + Math.abs(b.y) +
    Math.abs(c.x) + Math.abs(c.y) + Math.abs(d.x) + Math.abs(d.y);
  const eps = 1e-9 * Math.max(1, mag);
  const cr = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const s = (u: number, v: number) => (u > eps && v < -eps) || (u < -eps && v > eps);
  return s(cr(a, b, c), cr(a, b, d)) && s(cr(c, d, a), cr(c, d, b));
}

function bestOf(candidates: Iterable<boolean[]>, make: (rev: boolean[]) => Built): Built {
  let best: Built | null = null;
  let bestScore = { cross: Infinity, len: Infinity };
  for (const rev of candidates) {
    const b = make(rev);
    const s = score(b);
    if (s.cross < bestScore.cross || (s.cross === bestScore.cross && s.len < bestScore.len)) {
      best = b; bestScore = s;
    }
  }
  return best!;
}

function* enumerateAssignments(n: number): Generator<boolean[]> {
  const total = 1 << n;
  for (let m = 0; m < total; m++) {
    const rev = new Array<boolean>(n);
    for (let i = 0; i < n; i++) rev[i] = ((m >> i) & 1) === 1;
    yield rev;
  }
}

/** Greedy fallback for LED counts too large to enumerate: flip while it strictly helps. */
function* greedyAssignments(n: number, scoreOf: (rev: boolean[]) => { cross: number; len: number }) {
  const rev = new Array<boolean>(n).fill(false);
  yield rev.slice();
  let cur = scoreOf(rev);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      rev[i] = !rev[i];
      const s = scoreOf(rev);
      if (s.cross < cur.cross || (s.cross === cur.cross && s.len < cur.len)) { cur = s; yield rev.slice(); }
      else rev[i] = !rev[i];
    }
  }
}
