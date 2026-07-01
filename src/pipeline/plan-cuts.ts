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
 * Connectivity: the cut set is a FOREST (cycles pruned) touching the mesh
 * boundary at most ONCE (the boundary pseudo-terminal joins the MST exactly
 * once, and terminal-to-terminal paths are forbidden from passing THROUGH
 * boundary vertices) — a tree with ≤1 boundary contact never disconnects.
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

/** Spanning forest of an edge subset (drops cycle-closing edges). */
function spanningForest(topo: MeshTopology, edgeSet: Set<number>): Set<number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
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

  if (cutTerminals.length > 0) {
    // --- Connection: MST of the terminals' metric closure ------------------
    // Boundary acts as one extra pseudo-terminal reachable at the distance to
    // the nearest boundary vertex (multi-source Dijkstra already in boundarySol).
    // Terminal-to-terminal paths must not pass THROUGH boundary vertices
    // (K2 connectivity: a cut path transiting the boundary tears the sheet).
    const sols = new Map<number, ShortestPathResult>();
    for (const t of cutTerminals) {
      sols.set(t, shortestPaths(mesh, topo, [t], weights, topo.boundaryVertices));
    }

    type Node = number | "boundary";
    const nodes: Node[] = hasBoundary ? [...cutTerminals, "boundary"] : [...cutTerminals];
    const distOf = (u: Node, v: Node): number => {
      if (u === "boundary") return boundarySol!.dist[v as number];
      if (v === "boundary") return boundarySol!.dist[u as number];
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
      if (u === "boundary") path = extractPath(boundarySol!, v as number);
      else if (v === "boundary") path = extractPath(boundarySol!, u);
      else path = extractPath(sols.get(u)!, v);
      for (const e of path) cutSet.add(e);
    }
    // Path unions can close cycles — prune to a forest.
    const forest = spanningForest(topo, cutSet);
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

