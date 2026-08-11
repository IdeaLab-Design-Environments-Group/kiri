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
  flatPoints,
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

/** A place copper must not run. */
interface KeepOut {
  /** Either a segment copper may not cross, or… */
  seg?: [Vec2, Vec2];
  /** …a point copper may not come within `clear` of. */
  at?: Vec2;
  clear?: number;
}

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
  const terminals = terminalsFor(batteryPoint!, legs, diag);
  const keepOuts = keepOutsFor(fold, legs);

  // Choose which leg of each LED carries PWR. The routes are straight-line constructions, so evaluating a
  // candidate is cheap enough to enumerate the whole space at realistic LED counts — the production
  // router can only afford a greedy sweep because every candidate there costs a re-route.
  const make = (rev: boolean[]) => build(rev, legs, terminals, style, keepOuts);
  const best = legs.length <= exhaustiveUpTo
    ? bestOf(enumerateAssignments(legs.length), make)
    : bestOf(greedyAssignments(legs.length, (rev) => score(make(rev))), make);

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

/**
 * Where copper may not go. Only three things, and none of them is about the tiles:
 *
 * - **Over an LED.** The chip bridges the two pads, so the body is the segment joining them and copper may
 *   not cross it. Stated as a crossing rather than a clearance disc deliberately: a disc wide enough to
 *   matter also forbids the stub that has to *land* on a pad, because a pad cannot be reached without
 *   passing close to the chip beside it. A crossing test ignores endpoint touches, so landing is legal and
 *   only genuinely passing over the component is refused.
 * - **Across a cut (`C`).** The cutter severs the sheet along its whole length; tape over one is cut
 *   through. That destroys the circuit, so it is not negotiable.
 * - **Across the silhouette (`B`).** Same cutter, and past it there is no sheet to stick to.
 *
 * Fold hinges (`M`/`V`) are deliberately absent: crossing one costs durability — the tape creases and can
 * crack — not continuity, and being free to cross them is the whole point of this router.
 */
function keepOutsFor(fold: FoldFile, legs: { a: Vec2; b: Vec2 }[]): KeepOut[] {
  const out: KeepOut[] = [];
  for (const l of legs) out.push({ seg: [l.a, l.b] });
  const pts = flatPoints(fold);
  const ev = fold.edges_vertices ?? [];
  const ea = (fold.edges_assignment as string[] | undefined) ?? [];
  for (let i = 0; i < ev.length; i++) {
    const role = ea[i] ?? "B";
    if (role !== "C" && role !== "B") continue;
    const a = pts[ev[i]?.[0] ?? -1], b = pts[ev[i]?.[1] ?? -1];
    if (a && b) out.push({ seg: [a, b] });
  }
  return out;
}

/** Does the straight run `a→b` violate any keep-out? */
function blocked(a: Vec2, b: Vec2, keepOuts: KeepOut[]): boolean {
  for (const k of keepOuts) {
    if (k.seg && properCross(a, b, k.seg[0], k.seg[1])) return true;
    if (k.at && k.clear != null && distToSeg(k.at, a, b) < k.clear) return true;
  }
  return false;
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** How much dearer a run that still violates a keep-out is, once even a detour has failed. */
const BLOCKED_PENALTY = 1000;

/**
 * A run from `a` to `b` that respects the keep-outs, bending around them if the straight line cannot.
 *
 * A straight line is often impossible rather than merely expensive: the pads along one hinge line are
 * collinear with the LED chips sitting *between* them, so every straight pad-to-pad run passes exactly
 * through an LED. Pricing such an edge out of the tree achieves nothing when all the alternatives are
 * blocked too — the run has to leave the line and come back. So: try straight, then try a single bend
 * offset perpendicular to the run, on either side and at increasing distance, and take the first that
 * clears. Falls back to the straight line, which the caller then prices at {@link BLOCKED_PENALTY} so it
 * is used only where nothing else connects.
 */
function runAround(a: Vec2, b: Vec2, keepOuts: KeepOut[]): Vec2[] | null {
  if (!blocked(a, b, keepOuts)) return [a, b];
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return null;
  const nx = -dy / l, ny = dx / l;
  // How far out we might need to go: the largest clearance any keep-out asks for.
  const reach = keepOuts.reduce((m, k) => Math.max(m, k.clear ?? 0), 0) || l * 0.1;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const mult of [1.3, 2, 3, 4.5]) {
    for (const side of [1, -1]) {
      const w = { x: mid.x + nx * reach * mult * side, y: mid.y + ny * reach * mult * side };
      if (!blocked(a, w, keepOuts) && !blocked(w, b, keepOuts)) return [a, w, b];
    }
  }
  return null;
}

/** Length of a polyline. */
function polyLen(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist2(pts[i - 1]!, pts[i]!);
  return l;
}

interface Built { rev: boolean[]; traces: Trace2D[] }

function build(
  rev: boolean[],
  legs: { a: Vec2; b: Vec2 }[],
  terminals: { pwr: Vec2; gnd: Vec2 },
  style: RouteStyle,
  keepOuts: KeepOut[],
): Built {
  const pwrPads = legs.map((l, s) => (rev[s] ? l.b : l.a));
  const gndPads = legs.map((l, s) => (rev[s] ? l.a : l.b));
  const traces: Trace2D[] = [
    ...runsFor(terminals.pwr, pwrPads, style, keepOuts).map((points) => ({ net: "pwr" as const, points })),
    ...runsFor(terminals.gnd, gndPads, style, keepOuts).map((points) => ({ net: "gnd" as const, points })),
  ];
  return { rev, traces };
}

/** One net's copper as polylines: either a radial fan or a Euclidean MST. Both are planar. */
function runsFor(terminal: Vec2, pads: Vec2[], style: RouteStyle, keepOuts: KeepOut[]): Vec2[][] {
  if (pads.length === 0) return [];
  if (style === "fan") return pads.map((p) => runAround(terminal, p, keepOuts) ?? [terminal, p]);

  // Prim over terminal + pads. A Euclidean MST in the plane never has crossing edges, so the net cannot
  // cross itself — the property the paper gets from its integral curves, obtained here for free.
  const nodes = [terminal, ...pads];
  const inTree = new Array<boolean>(nodes.length).fill(false);
  const bestTo = new Array<number>(nodes.length).fill(Infinity);
  const parent = new Array<number>(nodes.length).fill(-1);
  bestTo[0] = 0;
  const edges: Vec2[][] = [];
  const runOf = new Map<string, Vec2[]>();
  const runFor = (i: number, j: number): Vec2[] => {
    const key = `${i}_${j}`;
    const hit = runOf.get(key);
    if (hit) return hit;
    const r = runAround(nodes[i]!, nodes[j]!, keepOuts) ?? [nodes[i]!, nodes[j]!];
    runOf.set(key, r);
    return r;
  };
  for (let k = 0; k < nodes.length; k++) {
    let u = -1, du = Infinity;
    for (let i = 0; i < nodes.length; i++) if (!inTree[i] && bestTo[i]! < du) { du = bestTo[i]!; u = i; }
    if (u < 0) break;
    inTree[u] = true;
    if (parent[u]! >= 0) edges.push(runFor(parent[u]!, u));
    for (let v = 0; v < nodes.length; v++) {
      if (inTree[v]) continue;
      // Cost is the length of the run that actually respects the keep-outs — a bend where one is needed.
      // Only a run that could not be made to clear at all is priced out, so nothing is left unconnected.
      const run = runFor(u, v);
      const w = blocked(run[0]!, run[run.length - 1]!, keepOuts) && run.length === 2
        ? polyLen(run) * BLOCKED_PENALTY
        : polyLen(run);
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
