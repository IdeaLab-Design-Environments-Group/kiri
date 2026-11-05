/**
 * Cut planning (M2/K2): decide where the cuts go — necessity, connection,
 * routing — under the PROPER-KIRIGAMI invariant: the cut sheet must stay one
 * connected piece.
 *
 * Pattern: greedy approximation algorithm + strategy switch. The dart-vs-tuck
 * decision supports three modes:
 *   "dart"     — cut all δ>0 vertices (original mode).
 *   "tuck-all" — tuck all δ>0 vertices (Origamizer reduction).
 *   "hybrid"   — per-vertex cost comparison: dart iff path-to-boundary length
 *                ≤ tuckCostScale·δ(v)·r̄(v) (mean one-ring length as a
 *                molecule-size proxy). Closed meshes fall back to dart.
 *
 * Edge weights implement the full routing objective:
 *   w(e) = len(e) + λ·vis(e),   vis(e) = 1 − |θ_e| / π
 * where θ_e is the signed dihedral angle (mountain positive, 0 on boundary
 * edges). High-fold (ridge/crease) edges have vis → 0 → lower cost when
 * λ > 0, so cuts naturally route along existing fold lines. At λ = 0 (default)
 * the result is identical to the original length-only routing.
 *
 * Optional leaf pruning: degree-1 dart terminals with δ below a threshold are
 * demoted to tuck and their leaf branch removed, reducing total cut length.
 *
 * Formulas / rules (kirigamizer_algorithms.tex §4 + K1 vents):
 *   necessity:   v needs a cut  ⟺  δ(v) ≠ 0 (and not tucked)
 *   routing:     min_C Σ_{e∈C} (len(e) + λ·vis(e))
 *   sign rule:   δ>0 → dart; δ<0 → slit (vent supplies 2π closure, no wedge rule)
 *
 * Connectivity: the cut set is a FOREST (cycles pruned, each boundary loop
 * counted as one node) in which every tree touches each boundary loop at most
 * ONCE (loops are pseudo-terminals of the MST, and paths are forbidden from
 * passing THROUGH boundary vertices) — such a forest never disconnects. With
 * several loops the tree also joins them, which is what lets an open cylinder
 * flatten (one rim-to-rim seam). On an open surface each δ<0 slit is its own
 * shortest path to the boundary, outside the MST.
 */

import { edgeLength } from "./mesh.js";
import { signedDihedral } from "./curvature.js";
import { PipelineError, type CutPlan, type DefectReport, type MeshTopology, type TriMesh } from "./types.js";

export interface PlanOptions {
  /**
   * Seam-visibility weight λ. Routing cost: w(e) = len(e) + λ·vis(e),
   * vis(e) = 1 − |θ_e|/π. λ=0 (default) gives length-only routing;
   * λ>0 biases cuts toward high-dihedral (fold/ridge) edges.
   */
  lambda: number;
  /**
   * "dart"    — cut all δ>0 vertices.
   * "tuck-all"— tuck all δ>0 vertices (Origamizer reduction).
   * "hybrid"  — per-vertex cost comparison: dart iff path-to-boundary ≤
   *             tuckCostScale·δ(v)·r̄(v). Closed meshes fall back to dart.
   */
  strategy: "dart" | "tuck-all" | "hybrid";
  /**
   * Scale for tuck cost in hybrid mode. tuckCost(v) = tuckCostScale·δ(v)·r̄(v)
   * where r̄(v) is the mean one-ring edge length (molecule-size proxy). Default 1.
   */
  tuckCostScale?: number;
  /**
   * Drop degree-1 dart leaves with δ < leafPruneDeltaMax from the cut forest,
   * promoting them to tucks. Reduces total cut length. Default false.
   */
  leafPruning?: boolean;
  /**
   * Max angle defect (rad) for leaf pruning. Default π/4 ≈ 45°.
   */
  leafPruneDeltaMax?: number;
  /** Extra terminals (Q vertex ids) — M5's refine hook. */
  extraTerminals?: number[];
}

export interface ShortestPathResult {
  dist: number[];
  /** prev[v] = edge id used to reach v (or -1). */
  prevEdge: number[];
  prevVertex: number[];
}

/**
 * Dijkstra over mesh vertices from (possibly multiple) sources.
 * Weight of edge e defaults to len(e) + λ·vis(e); vis ≡ 0 in v1.
 * Vertices in `noTransit` may be reached (as path endpoints) but are never
 * expanded — paths cannot pass THROUGH them (K2: keeps interior cut paths
 * off the boundary so the sheet cannot be torn boundary-to-boundary).
 */
export function shortestPaths(
  mesh: TriMesh,
  topo: MeshTopology,
  sources: number[],
  weights?: number[],
  noTransit?: Set<number>,
): ShortestPathResult {
  const n = mesh.vertices.length;
  const w = weights ?? topo.edges.map((_, e) => edgeLength(mesh, topo, e));
  const dist = new Array<number>(n).fill(Infinity);
  const prevEdge = new Array<number>(n).fill(-1);
  const prevVertex = new Array<number>(n).fill(-1);
  // Binary-heap-free O(V²) Dijkstra — fine for coarse meshes.
  const done = new Array<boolean>(n).fill(false);
  for (const s of sources) dist[s] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let v = 0; v < n; v++) {
      if (!done[v] && dist[v] < best) {
        best = dist[v];
        u = v;
      }
    }
    if (u === -1) break;
    done[u] = true;
    if (noTransit?.has(u) && dist[u] > 0) continue; // reachable, not expandable
    for (const e of topo.vertexEdges[u]) {
      const edge = topo.edges[e];
      const v = edge.a === u ? edge.b : edge.a;
      const d = dist[u] + w[e];
      if (d < dist[v] - 1e-12) {
        dist[v] = d;
        prevEdge[v] = e;
        prevVertex[v] = u;
      }
    }
  }
  return { dist, prevEdge, prevVertex };
}

/** Walk prev pointers from v back to the source; returns edge ids. */
function extractPath(res: ShortestPathResult, v: number): number[] {
  const edges: number[] = [];
  let cur = v;
  while (res.prevEdge[cur] !== -1) {
    edges.push(res.prevEdge[cur]);
    cur = res.prevVertex[cur];
  }
  return edges;
}

/** Mean edge length over the one-ring of v (molecule-size proxy for hybrid tuck cost). */
function meanOneRingLength(mesh: TriMesh, topo: MeshTopology, v: number): number {
  const edges = topo.vertexEdges[v];
  if (edges.length === 0) return 1;
  let sum = 0;
  for (const e of edges) sum += edgeLength(mesh, topo, e);
  return sum / edges.length;
}

/**
 * Prune degree-1 dart leaves from the cut forest whose δ < maxDelta, demoting
 * them to tucks and removing their leaf branch. Iterates until no eligible
 * leaves remain. Slit vertices are never pruned.
 */
function pruneLeaves(
  topo: MeshTopology,
  cutSet: Set<number>,
  cutTerminals: number[],
  defects: DefectReport,
  perVertexAction: CutPlan["perVertexAction"],
  maxDelta: number,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const degree = new Map<number, number>();
    for (const e of cutSet) {
      const { a, b } = topo.edges[e];
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    for (const v of cutTerminals) {
      if (perVertexAction[v] !== "dart") continue;
      if ((degree.get(v) ?? 0) !== 1) continue;
      if (defects.defects[v] > maxDelta) continue;
      for (const e of topo.vertexEdges[v]) {
        if (cutSet.has(e)) {
          cutSet.delete(e);
          perVertexAction[v] = "tuck";
          changed = true;
          break;
        }
      }
    }
  }
}

/** Boundary vertices grouped into loops (joined through boundary edges), in vertex order. */
function boundaryLoops(topo: MeshTopology): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x)! !== x) x = parent.get(x)!;
    return x;
  };
  for (const v of topo.boundaryVertices) parent.set(v, v);
  for (const edge of topo.edges) {
    if (edge.faces.length === 1) parent.set(find(edge.a), find(edge.b));
  }
  const loops = new Map<number, number[]>();
  for (const v of [...topo.boundaryVertices].sort((a, b) => a - b)) {
    const r = find(v);
    (loops.get(r) ?? loops.set(r, []).get(r)!).push(v);
  }
  return [...loops.values()];
}

/**
 * Spanning forest of an edge subset (drops cycle-closing edges). Each boundary
 * loop counts as one node, so no kept tree reaches the same loop twice (that
 * path would sever the sheet).
 */
function spanningForest(topo: MeshTopology, edgeSet: Set<number>, loops: number[][]): Set<number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const loop of loops) for (const v of loop) parent.set(v, loop[0]);
  const kept = new Set<number>();
  for (const e of edgeSet) {
    const { a, b } = topo.edges[e];
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(ra, rb);
      kept.add(e);
    }
  }
  return kept;
}

/**
 * Plan the cut set: necessity → connection (MST of metric closure, ≤1
 * boundary attachment, interior paths never transit the boundary) →
 * per-vertex action tags. δ<0 closure is handled by K1 vents in the unfold.
 */
export function planCuts(
  mesh: TriMesh,
  topo: MeshTopology,
  defects: DefectReport,
  opts: PlanOptions,
): CutPlan {
  const { lambda, strategy } = opts;
  const tuckCostScale = opts.tuckCostScale ?? 1.0;
  const n = mesh.vertices.length;

  // --- Edge weights: w(e) = len(e) + λ·vis(e), vis(e) = 1 − |θ_e|/π. ------
  // Boundary edges (θ undefined): vis = 1 (no fold → full visual penalty).
  const dihedrals = topo.edges.map((edge, e) =>
    edge.faces.length === 2 ? Math.abs(signedDihedral(mesh, topo, e)) : 0,
  );
  const weights = topo.edges.map((_, e) => {
    const vis = 1 - dihedrals[e] / Math.PI;
    return edgeLength(mesh, topo, e) + lambda * vis;
  });

  // --- Pre-compute boundary shortest paths for hybrid dart-vs-tuck. ---------
  // Also reused in the MST step, so always computed when boundary exists.
  const hasBoundary = topo.boundaryVertices.size > 0;
  const boundarySol = hasBoundary
    ? shortestPaths(mesh, topo, [...topo.boundaryVertices], weights)
    : null;

  // --- Terminal classification. ----------------------------------------------
  const perVertexAction: CutPlan["perVertexAction"] = new Array(n).fill("none");
  const cutTerminals: number[] = [];

  for (let v = 0; v < n; v++) {
    const cls = defects.classes[v];
    if (cls === "positive") {
      let action: "dart" | "tuck" = "dart";
      if (strategy === "tuck-all") {
        action = "tuck";
      } else if (strategy === "hybrid") {
        const dartCost = boundarySol?.dist[v] ?? Infinity;
        if (!Number.isFinite(dartCost)) {
          // Closed mesh or unreachable boundary: force dart so the mesh gets at
          // least one cut (a tuck cannot close a genus-0 closed mesh alone).
          action = "dart";
        } else {
          // dartCost = length of cheapest weighted path to the mesh boundary.
          // tuckCost = proxy for the molecule material area: δ(v) · r̄(v).
          const tuckCost = tuckCostScale * defects.defects[v] * meanOneRingLength(mesh, topo, v);
          action = dartCost <= tuckCost ? "dart" : "tuck";
        }
      }
      perVertexAction[v] = action;
      if (action === "dart") cutTerminals.push(v);
    } else if (cls === "negative") {
      perVertexAction[v] = "slit"; // tucking cannot supply missing angle
      cutTerminals.push(v);
    }
  }
  for (const v of opts.extraTerminals ?? []) {
    if (!cutTerminals.includes(v) && !topo.boundaryVertices.has(v)) cutTerminals.push(v);
  }

  const cutSet = new Set<number>();
  const loops = boundaryLoops(topo);

  if (cutTerminals.length > 0 || loops.length > 1) {
    // --- Connection: MST of the terminals' metric closure ------------------
    // Each boundary loop acts as one extra pseudo-terminal reachable at the
    // distance to its nearest vertex (multi-source Dijkstra; a lone loop is
    // exactly boundarySol). Paths must not pass THROUGH boundary vertices
    // (K2 connectivity: a cut path transiting the boundary tears the sheet).
    const sols = new Map<number, ShortestPathResult>();
    for (const t of cutTerminals) {
      sols.set(t, shortestPaths(mesh, topo, [t], weights, topo.boundaryVertices));
    }
    const loopSols =
      loops.length === 1
        ? [boundarySol!]
        : loops.map((loop) => {
            const others = new Set([...topo.boundaryVertices].filter((v) => !loop.includes(v)));
            return shortestPaths(mesh, topo, loop, weights, others);
          });
    /** Vertex of loop j nearest to loop i (where the joining path ends). */
    const loopEnd = (i: number, j: number): number =>
      loops[j].reduce((best, v) => (loopSols[i].dist[v] < loopSols[i].dist[best] ? v : best));

    // Slit terminals on an open surface each take their OWN shortest path to
    // the boundary instead of joining the tree: a vent carves the double cover
    // along its slit, so a slit routed through other saddles swallows them.
    const ownSlit = (v: number): boolean => hasBoundary && perVertexAction[v] === "slit";
    for (const v of cutTerminals.filter(ownSlit)) for (const e of extractPath(boundarySol!, v)) cutSet.add(e);
    type Node = number | { loop: number };
    const nodes: Node[] = [...cutTerminals.filter((v) => !ownSlit(v)), ...loops.map((_, loop) => ({ loop }))];
    const distOf = (u: Node, v: Node): number => {
      if (typeof u !== "number" && typeof v !== "number") return loopSols[u.loop].dist[loopEnd(u.loop, v.loop)];
      if (typeof u !== "number") return loopSols[u.loop].dist[v as number];
      if (typeof v !== "number") return loopSols[v.loop].dist[u];
      return sols.get(u)!.dist[v];
    };
    // Prim's MST over the closure.
    const inTree = new Set<Node>([nodes[0]]);
    const mstPairs: [Node, Node][] = [];
    while (inTree.size < nodes.length) {
      let bestPair: [Node, Node] | null = null;
      let best = Infinity;
      for (const u of inTree) {
        for (const v of nodes) {
          if (inTree.has(v)) continue;
          const d = distOf(u, v);
          if (d < best) {
            best = d;
            bestPair = [u, v];
          }
        }
      }
      if (!bestPair || !Number.isFinite(best)) {
        throw new PipelineError("plan-cuts", "mesh is disconnected — cannot connect cut terminals");
      }
      mstPairs.push(bestPair);
      inTree.add(bestPair[1]);
    }
    // Expand MST pairs to mesh-edge paths.
    for (const [u, v] of mstPairs) {
      let path: number[];
      if (typeof u !== "number" && typeof v !== "number") path = extractPath(loopSols[u.loop], loopEnd(u.loop, v.loop));
      else if (typeof u !== "number") path = extractPath(loopSols[u.loop], v as number);
      else if (typeof v !== "number") path = extractPath(loopSols[v.loop], u);
      else path = extractPath(sols.get(u)!, v);
      for (const e of path) cutSet.add(e);
    }
    // Path unions can close cycles — prune to a forest.
    const forest = spanningForest(topo, cutSet, loops);
    cutSet.clear();
    for (const e of forest) cutSet.add(e);

    // Single isolated terminal on a closed mesh (|terminals|=1, no boundary):
    // the MST is a lone vertex with no edges, but necessity still demands an
    // incident cut edge (a dangling slit) so the vertex becomes boundary.
    if (cutSet.size === 0 && cutTerminals.length === 1) {
      let bestE = -1;
      let best = Infinity;
      for (const e of topo.vertexEdges[cutTerminals[0]]) {
        if (weights[e] < best) {
          best = weights[e];
          bestE = e;
        }
      }
      cutSet.add(bestE);
    }

    // Leaf pruning: demote small-δ degree-1 dart leaves to tuck, drop branch.
    if (opts.leafPruning) {
      pruneLeaves(
        topo,
        cutSet,
        cutTerminals,
        defects,
        perVertexAction,
        opts.leafPruneDeltaMax ?? Math.PI / 4,
      );
    }
  }

  // δ<0 closure: handled by K1 VENTS in the unfold — a slit reaching v
  // (cut-degree ≥ 1, guaranteed: every terminal is on the tree or its
  // dangling-slit special case) plus a sliver of |δ| removed makes the flat
  // material at v exactly 2π. No fan-splitting wedge rule, no extra tears.

  const cutEdges = [...cutSet].sort((a, b) => a - b);
  const lengthCost = cutEdges.reduce((acc, e) => acc + edgeLength(mesh, topo, e), 0);
  const visCost = lambda * cutEdges.reduce((acc, e) => acc + (1 - dihedrals[e] / Math.PI), 0);
  return {
    cutEdges,
    perVertexAction,
    cost: { length: lengthCost, visibility: visCost, lambda },
  };
}

