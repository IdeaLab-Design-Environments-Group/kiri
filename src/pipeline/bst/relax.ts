/**
 * Projective dynamic relaxation for the BST deployment (paper Sec 5, step 1).
 *
 * Solves the EXPANDED copy: rigid tile edges (EqualLength to their known rest lengths — the tiles
 * stay congruent to the flat contracted pattern, i.e. isometric) PROJECTED onto the target surface
 * (OnMesh). The result is flat rigid tiles arranged as facets approximating the curved surface, with
 * the auxetic voids opening where curvature demands. (A perfectly flat tile cannot lie on a curved
 * surface, so a faceted approximation with small residual is the correct outcome — matching the
 * paper's Fig. 13/14.) Jacobi projective averaging with light damping; the flat contracted tiling is
 * used as-is for the crease pattern, so only this copy is relaxed.
 */
import { type Vec3, add, scale, sub, length } from "../../core/vec3.js";
import type { MeshHit } from "./mesh-project.js";

export interface RelaxEdge {
  a: number;
  b: number;
  rest: number;
}

export interface RelaxResult {
  positions: Vec3[];
  residual: number; // RMS-ish normalized violation
  converged: boolean;
}

export interface RelaxOptions {
  iters: number;
  /** Stiffness of the rigid-tile edge constraint (default 1). */
  edgeW?: number;
  /** Stiffness of the on-surface projection (default 1). */
  meshW?: number;
  /** Per-iteration position damping in [0,1) (default 0.1). */
  damp?: number;
  /** Convergence tolerance on the normalized residual (default 1e-3). */
  tol?: number;
}

/**
 * @param seed       initial expanded positions (e.g. uniform β0 tiling lifted onto the surface)
 * @param edges      rigid edges with rest lengths (tile boundaries + diagonals)
 * @param projVerts  vertex ids to keep on the surface (all tile corners)
 * @param project    closest-point-on-surface
 */
export function relax(
  seed: Vec3[],
  edges: RelaxEdge[],
  projVerts: number[],
  project: (p: Vec3) => MeshHit,
  opts: RelaxOptions,
): RelaxResult {
  const edgeW = opts.edgeW ?? 1;
  const meshW = opts.meshW ?? 1;
  const damp = opts.damp ?? 0.1;
  const tol = opts.tol ?? 1e-3;
  const meanRest = edges.reduce((s, e) => s + e.rest, 0) / Math.max(1, edges.length);

  const pos = seed.map((p) => ({ ...p }));
  const n = pos.length;
  let residual = Infinity;
  let converged = false;

  for (let it = 0; it < opts.iters; it++) {
    const accX = new Float64Array(n), accY = new Float64Array(n), accZ = new Float64Array(n), wsum = new Float64Array(n);
    const addTarget = (i: number, t: Vec3, w: number): void => { accX[i] += t.x * w; accY[i] += t.y * w; accZ[i] += t.z * w; wsum[i] += w; };

    // rigid tile edges → both endpoints toward a length-restored pair about their midpoint
    let maxEdgeErr = 0;
    for (const e of edges) {
      const a = pos[e.a], b = pos[e.b];
      const d = sub(a, b);
      const l = length(d) || 1e-9;
      maxEdgeErr = Math.max(maxEdgeErr, Math.abs(l - e.rest));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
      const h = e.rest / (2 * l);
      addTarget(e.a, { x: mx + d.x * h, y: my + d.y * h, z: mz + d.z * h }, edgeW);
      addTarget(e.b, { x: mx - d.x * h, y: my - d.y * h, z: mz - d.z * h }, edgeW);
    }

    // on-surface projection
    let maxMeshErr = 0;
    for (const v of projVerts) {
      const hit = project(pos[v]);
      maxMeshErr = Math.max(maxMeshErr, hit.dist);
      addTarget(v, hit.point, meshW);
    }

    // apply averaged targets with damping
    for (let i = 0; i < n; i++) {
      if (wsum[i] === 0) continue;
      const tx = accX[i] / wsum[i], ty = accY[i] / wsum[i], tz = accZ[i] / wsum[i];
      pos[i] = { x: pos[i].x + (1 - damp) * (tx - pos[i].x), y: pos[i].y + (1 - damp) * (ty - pos[i].y), z: pos[i].z + (1 - damp) * (tz - pos[i].z) };
    }

    residual = (maxEdgeErr + maxMeshErr) / meanRest;
    if (residual < tol) { converged = true; break; }
  }

  return { positions: pos, residual, converged };
}

/** Build the rigid-edge list (tile boundaries + one diagonal per quad) with rest lengths from a flat tiling. */
export function rigidEdges(tiles: number[][], verts: { x: number; y: number }[]): RelaxEdge[] {
  const out: RelaxEdge[] = [];
  const seen = new Set<string>();
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const restOf = (a: number, b: number): number => Math.hypot(verts[a].x - verts[b].x, verts[a].y - verts[b].y);
  const push = (a: number, b: number): void => { const k = key(a, b); if (seen.has(k)) return; seen.add(k); out.push({ a, b, rest: restOf(a, b) }); };
  for (const t of tiles) {
    push(t[0], t[1]); push(t[1], t[2]); push(t[2], t[3]); push(t[3], t[0]); push(t[0], t[2]); // edges + diagonal
  }
  return out;
}
