/**
 * Handle-loop cutting (un-defers the v1 genus-0-only scope of conditioning).
 *
 * A genus-g surface can't be developed flat without first cutting its g handles.
 * Kirigami already *is* cutting, so the natural fix is to cut the handle loops up
 * front: the mesh becomes a genus-0 surface (with extra boundary) that the rest of
 * the pipeline (curvature → plan-cuts → seamed unfold) handles unchanged. The cuts
 * land in `edges_assignment` as ordinary "C" cuts.
 *
 * The g handle loops come from the classic **tree-cotree** (Eppstein) decomposition:
 *   - a spanning tree T of the primal (vertex) graph,
 *   - a spanning tree C of the dual (face) graph using only edges whose primal edge
 *     is NOT in T,
 *   - the edges in neither T nor C are exactly the 2g homology generators; each one
 *     plus its T-path between endpoints is a non-contractible loop.
 * Cutting the union of those loops opens every handle. The actual mesh surgery
 * (splitting vertices along the cut into independent fan-wedges) reuses the tested
 * `cutAlongEdges` from the unfold stage.
 */
import { buildTopology, countBoundaryLoops, eulerCharacteristic } from "./mesh.js";
import { cutAlongEdges } from "./unfold.js";
import type { ConditionReport, TriMesh } from "./types.js";

/** Hard cap on handle-cutting rounds (each removes ≥1 handle; bounds a pathological mesh). */
const MAX_ROUNDS = 8;

function genusOf(mesh: TriMesh): number {
  const topo = buildTopology(mesh);
  const chi = eulerCharacteristic(mesh, topo);
  const b = countBoundaryLoops(mesh, topo);
  return (2 - b - chi) / 2;
}

/**
 * Find the homology-generator loop edges (tree-cotree) and return their union as a
 * set of topo edge indices. Empty for a genus-0 surface.
 */
function handleLoopEdges(mesh: TriMesh): number[] {
  const topo = buildTopology(mesh);
  const nE = topo.edges.length;
  const nV = mesh.vertices.length;
  const nF = mesh.faces.length;

  // --- primal spanning tree T over vertices (BFS via edges) -----------------
  const inT = new Uint8Array(nE);
  const parentEdge = new Int32Array(nV).fill(-1);
  const parentVertex = new Int32Array(nV).fill(-1);
  const seenV = new Uint8Array(nV);
  for (let s = 0; s < nV; s++) {
    if (seenV[s]) continue;
    seenV[s] = 1;
    const q = [s];
    while (q.length) {
      const v = q.pop()!;
      for (const e of topo.vertexEdges[v]) {
        const w = topo.edges[e].a === v ? topo.edges[e].b : topo.edges[e].a;
        if (!seenV[w]) {
          seenV[w] = 1;
          inT[e] = 1;
          parentEdge[w] = e;
          parentVertex[w] = v;
          q.push(w);
        }
      }
    }
  }

  // --- dual spanning tree C over faces (BFS via interior edges with primal ∉ T) ---
  const faceEdges: number[][] = Array.from({ length: nF }, () => []);
  for (let e = 0; e < nE; e++) for (const f of topo.edges[e].faces) faceEdges[f].push(e);
  const inC = new Uint8Array(nE);
  const seenF = new Uint8Array(nF);
  for (let s = 0; s < nF; s++) {
    if (seenF[s]) continue;
    seenF[s] = 1;
    const q = [s];
    while (q.length) {
      const f = q.pop()!;
      for (const e of faceEdges[f]) {
        if (inT[e] || topo.edges[e].faces.length !== 2) continue;
        const g = topo.edges[e].faces[0] === f ? topo.edges[e].faces[1] : topo.edges[e].faces[0];
        if (!seenF[g]) {
          seenF[g] = 1;
          inC[e] = 1;
          q.push(g);
        }
      }
    }
  }

  // --- generators = interior edges in neither tree; cut each one's loop --------
  const rootPath = (v: number): Set<number> => {
    const s = new Set<number>();
    while (parentEdge[v] !== -1) {
      s.add(parentEdge[v]);
      v = parentVertex[v];
    }
    return s;
  };
  const cut = new Set<number>();
  for (let e = 0; e < nE; e++) {
    if (inT[e] || inC[e] || topo.edges[e].faces.length !== 2) continue;
    cut.add(e); // the generator edge
    // symmetric difference of the two root-paths = the T-path between its endpoints
    const pa = rootPath(topo.edges[e].a);
    const pb = rootPath(topo.edges[e].b);
    for (const x of pa) (pb.has(x) ? pb.delete(x) : cut.add(x));
    for (const x of pb) cut.add(x);
  }
  return [...cut];
}

/**
 * Cut a genus>0 mesh down to genus 0 by slitting its handle loops. No-op (returns
 * the input) for a surface that is already genus 0. Does NOT re-weld afterward —
 * welding would re-merge the split lips and undo the cut.
 */
export function cutHandles(mesh: TriMesh): { mesh: TriMesh; report: ConditionReport } {
  let current = mesh;
  let handlesCut = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (genusOf(current) <= 0) break;
    const topo = buildTopology(current);
    const loops = handleLoopEdges(current);
    if (loops.length === 0) break; // genus>0 but no generators found — give up to the gate
    const cut = cutAlongEdges(current, topo, loops, new Map());
    current = cut.mesh;
    handlesCut++;
  }
  return { mesh: current, report: { pass: "handle-cut", changed: handlesCut } };
}
