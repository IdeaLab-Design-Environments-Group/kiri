/**
 * **Model** — the auto-router/planner for the LED electronics tool. Pure: it takes
 * a flat FKLD/FOLD pattern + a {@link Circuit} and returns the routed copper traces
 * ({@link RoutedCircuit}), all in flat millimetres.
 *
 * Two nets only — **PWR** and **GND**. Each LED bridges a gap: one leg on face `a` (the `pwr`
 * side), the other on face `b` (the `gnd` side); copper terminates on the gray tile at the LED's
 * pinched leg pad.
 *
 * **Corner-hugging bus routing (LED keep-out).** Routes run on the {@link cornerRouteGraph}: copper
 * waypoints inset onto each gray tile near its corners, linked around every tile and crossing each
 * hinge **at its corner ends**. So the bus (a) stays strictly inside the body, (b) runs along panel
 * corners/edges rather than through tile centres, and (c) crosses every gap at its *ends*, leaving the
 * hinge midpoint — where the LED body and legs sit — clear. From the battery we grow a shortest-path
 * **tree** per net (PWR to every `a` leg, GND to every `b` leg) so branches share common trunks; the
 * only copper near a hinge is the one short stub onto each LED's leg pad. The two nets are offset to
 * opposite sides of each shared run so they read as parallel strips. Crossings between the two nets
 * are still allowed (insulated tape underside); the enforced rule is the LED keep-out, not net-vs-net.
 */
import {
  type Circuit,
  type CornerRouteGraph,
  type GapEdge,
  type GapGraph,
  type Led,
  type RoutedCircuit,
  type Trace2D,
  type Vec2,
  cornerRouteGraph,
  dist2,
  flatFaces,
  gapForLed,
  gapGraph,
} from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** One placed LED resolved to its gap + the two tiles/legs its copper must reach. */
interface PlacedLed {
  index: number; // index into circuit.leds (for unreachable reporting)
  gap: GapEdge;
  /** Face carrying the `pwr` leg, and its leg pad (flat mm). */
  aFace: number;
  aLeg: Vec2;
  /** Face carrying the `gnd` leg, and its leg pad (flat mm). */
  bFace: number;
  bLeg: Vec2;
}

/** Resolve each authored LED to its gap; LEDs whose gap no longer exists are reported unreachable. */
function placeLeds(graph: GapGraph, leds: Led[], faceCount: number, unreachable: number[]): PlacedLed[] {
  const placed: PlacedLed[] = [];
  leds.forEach((led, index) => {
    const inRange = led.a >= 0 && led.a < faceCount && led.b >= 0 && led.b < faceCount;
    const gap = inRange ? gapForLed(graph.gaps, led) : null;
    if (!gap) {
      unreachable.push(index);
      return;
    }
    // Orient: leg `a` follows the LED's own `a` face so the +/− assignment stays stable.
    const aIsFaceA = gap.faceA === led.a;
    placed.push({
      index,
      gap,
      aFace: led.a,
      aLeg: aIsFaceA ? gap.legA : gap.legB,
      bFace: led.b,
      bLeg: aIsFaceA ? gap.legB : gap.legA,
    });
  });
  return placed;
}

/** Plan the copper routes for `circuit` over the flat pattern in `fold`. */
export function planRoutes(fold: FoldFile, circuit: Circuit): RoutedCircuit {
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces);
  const graph = cornerRouteGraph(fold, faces);
  const centroid = (face: number): Vec2 => faces[face]?.centroid ?? { x: 0, y: 0 };

  const ledPoints = circuit.leds.map((led) => {
    const gap = gapForLed(gaps.gaps, led);
    return gap ? gap.point : { x: 0, y: 0 };
  });
  const batteryFace = circuit.battery && circuit.battery.face >= 0 && circuit.battery.face < faces.length
    ? circuit.battery.face
    : null;
  const batteryPoint = batteryFace != null ? centroid(batteryFace) : null;

  const traces: Trace2D[] = [];
  const unreachable: number[] = [];
  const placed = placeLeds(gaps, circuit.leds, faces.length, unreachable);
  if (batteryFace == null || placed.length === 0) {
    return { ledPoints, batteryPoint, terminals: null, traces, unreachable };
  }

  // A virtual battery source wired to the battery tile's corners — the bus leaves the pack along
  // panel corners just like every other tile.
  const batteryNode = graph.pos.length;
  graph.pos.push(batteryPoint!);
  graph.adj.push([]);
  for (const cn of graph.cornerNodes[batteryFace] ?? []) {
    const w = dist2(batteryPoint!, graph.pos[cn]!);
    graph.adj[batteryNode]!.push({ to: cn, w });
    graph.adj[cn]!.push({ to: batteryNode, w });
  }

  const terminals = batteryTerminals(batteryPoint!, placed, graph);
  planTwoNet(graph, batteryNode, terminals, placed, traces, unreachable);
  return { ledPoints, batteryPoint, terminals, traces, unreachable };
}

/**
 * The battery's two terminal pads: offset to either side of the battery centre, perpendicular to the
 * direction the wiring heads (toward the LEDs), so PWR (+) and GND (−) leave from distinct squares.
 */
function batteryTerminals(
  batteryCentre: Vec2,
  placed: PlacedLed[],
  graph: CornerRouteGraph,
): { pwr: Vec2; gnd: Vec2 } {
  // Mean LED leg direction → the "out" direction; the terminals straddle its perpendicular.
  let mx = 0, my = 0;
  for (const p of placed) { mx += (p.aLeg.x + p.bLeg.x) / 2; my += (p.aLeg.y + p.bLeg.y) / 2; }
  mx = mx / placed.length - batteryCentre.x;
  my = my / placed.length - batteryCentre.y;
  let ax = -my, ay = mx; // perpendicular to the out-direction
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) { ax = 1; ay = 0; } else { ax /= al; ay /= al; }
  const half = railOffset(graph) * 4; // clearly separate squares (railOffset is the rail spacing)
  return {
    pwr: { x: batteryCentre.x + ax * half, y: batteryCentre.y + ay * half },
    gnd: { x: batteryCentre.x - ax * half, y: batteryCentre.y - ay * half },
  };
}

/**
 * Grow a shortest-path tree from the battery on the in-body graph and emit it as offset bus strips:
 * PWR to every `a` leg (offset +), GND to every `b` leg (offset −). Shared tree edges are emitted
 * once, so branches that share a trunk read as a single strip. A short stub joins each tile to its
 * LED leg pad. LEDs whose leg-tile can't be reached in the body are reported unreachable.
 */
function planTwoNet(
  graph: CornerRouteGraph,
  battery: number,
  terminals: { pwr: Vec2; gnd: Vec2 },
  placed: PlacedLed[],
  traces: Trace2D[],
  unreachable: number[],
): void {
  const dj = dijkstra(graph, battery);
  const off = railOffset(graph);

  // The reachable gray-ring node of `face` nearest the LED's leg pad — copper meets the tile on its
  // gray boundary, then takes one short stub onto the pad. Null when the tile isn't wired to the battery.
  const reachNode = (face: number, leg: Vec2): number | null => {
    let best: number | null = null;
    let bestD = Infinity;
    for (const n of graph.ringNodes[face] ?? []) {
      if (dj.dist[n] === Infinity) continue;
      const d = dist2(graph.pos[n]!, leg);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  };

  const pwrTargets: { node: number; leg: Vec2 }[] = [];
  const gndTargets: { node: number; leg: Vec2 }[] = [];
  for (const p of placed) {
    const aNode = reachNode(p.aFace, p.aLeg);
    const bNode = reachNode(p.bFace, p.bLeg);
    if (aNode == null || bNode == null) {
      unreachable.push(p.index); // a leg tile is cut off from the battery within the body
      continue;
    }
    pwrTargets.push({ node: aNode, leg: p.aLeg });
    gndTargets.push({ node: bNode, leg: p.bLeg });
  }
  emitTree(graph, dj, battery, terminals.pwr, pwrTargets, "pwr", +off, traces);
  emitTree(graph, dj, battery, terminals.gnd, gndTargets, "gnd", -off, traces);
}

/** Lateral offset (flat mm) that separates the PWR/GND strips — relative to the pattern size. */
function railOffset(graph: CornerRouteGraph): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of graph.pos) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  return diag * 0.006;
}

/**
 * Emit a net's shortest-path tree (deduped edges) + leg stubs, each offset perpendicular by `off`.
 * Edges touching the battery node start at `anchor` (the net's own terminal pad) instead of the
 * battery centroid, so the tape visibly leaves its `+`/`−` square.
 */
function emitTree(
  graph: CornerRouteGraph,
  dj: Dijkstra,
  battery: number,
  anchor: Vec2,
  targets: { node: number; leg: Vec2 }[],
  net: "pwr" | "gnd",
  off: number,
  traces: Trace2D[],
): void {
  const posOf = (node: number): Vec2 => (node === battery ? anchor : graph.pos[node]!);
  const edges = new Map<string, [number, number]>();
  for (const t of targets) {
    let cur = t.node;
    while (cur !== battery) {
      const prev = dj.prev[cur]!;
      if (prev === -1) break;
      const key = cur < prev ? `${cur}_${prev}` : `${prev}_${cur}`;
      if (!edges.has(key)) edges.set(key, [Math.min(cur, prev), Math.max(cur, prev)]);
      cur = prev;
    }
  }
  for (const [, [u, v]] of edges) {
    traces.push({ net, points: offsetSeg(posOf(u), posOf(v), off) });
  }
  // One short stub from the reached corner onto the LED's leg pad (the only copper near a hinge).
  for (const t of targets) {
    traces.push({ net, points: offsetSeg(posOf(t.node), t.leg, off) });
  }
}

/** Two-point segment offset perpendicular by `off` (parallel strip for the two nets). */
function offsetSeg(a: Vec2, b: Vec2, off: number): Vec2[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * off, ny = (dx / l) * off;
  return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
}

interface Dijkstra {
  dist: number[];
  prev: number[];
}

/** Single-source shortest paths over the route graph (binary-heap Dijkstra). */
function dijkstra(graph: CornerRouteGraph, source: number): Dijkstra {
  const n = graph.pos.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  dist[source] = 0;
  const heap = new MinHeap();
  heap.push(source, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    const du = dist[u]!;
    for (const { to, w } of graph.adj[u]!) {
      const nd = du + w;
      if (nd < dist[to]!) {
        dist[to] = nd;
        prev[to] = u;
        heap.push(to, nd);
      }
    }
  }
  return { dist, prev };
}

/** Minimal binary min-heap keyed by priority (lazy-deletion: stale entries skipped by caller dist). */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    this.nodes.push(node);
    this.prio.push(priority);
    this.bubbleUp(this.nodes.length - 1);
  }

  pop(): number {
    const top = this.nodes[0]!;
    const lastN = this.nodes.pop()!;
    const lastP = this.prio.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN;
      this.prio[0] = lastP;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.nodes.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let small = i;
      if (l < n && this.prio[l]! < this.prio[small]!) small = l;
      if (r < n && this.prio[r]! < this.prio[small]!) small = r;
      if (small === i) break;
      this.swap(i, small);
      i = small;
    }
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
  }
}
