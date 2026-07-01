import type { BarHingeModel } from "./model.js";

/**
 * Penalty-based **self-collision** for the bar-and-hinge solver — keeps folded layers from
 * passing through each other, which the bare Gershenfeld/Origami-Simulator model does not.
 *
 * Method (proximity penalty, the tractable choice for an explicit integrator):
 *   - broad phase: a uniform spatial hash of the triangle faces, rebuilt each step;
 *   - narrow phase: for every node, the closest point on each nearby **non-adjacent** triangle.
 *     If the gap is below the contact `thickness` h, a repulsion `k·(h − d)` along the contact
 *     normal pushes the node out and the reaction is spread over the triangle's three vertices by
 *     the barycentric weights of the closest point (so linear momentum is conserved);
 *   - a contact-damping term removes the *approaching* normal velocity so layers settle in contact
 *     instead of bouncing, and the per-contact force is clamped for explicit-integration stability.
 *
 * Excludes a (node, triangle) pair when the node shares a face with the triangle (its 1-face-ring
 * neighbourhood), so creases and shared edges fold freely instead of self-triggering. This is
 * proximity-only (no continuous CCD): it stops the common layer-on-layer interpenetration of a
 * fold; very fast motion could still tunnel, and pure edge-edge crossings aren't handled.
 */
export interface CollisionParams {
  /** Contact distance h (model units; the model is scaled to bounding-sphere radius 1). */
  thickness: number;
  /** Penalty stiffness. */
  k: number;
  /** Contact damping coefficient (resists approaching normal velocity only). */
  damp: number;
  /** Per-contact force-magnitude clamp (explicit-integration safety). */
  maxForce: number;
}

export const DEFAULT_COLLISION: CollisionParams = {
  thickness: 0.03,
  k: 220,
  damp: 8,
  maxForce: 2.5,
};

export interface CollisionState {
  params: CollisionParams;
  /** vertex → set of vertices sharing a face with it (1-face-ring; excluded from contact). */
  faceRing: Set<number>[];
  cellSize: number;
  /** scratch hash, reused each step: cell key → triangle indices. */
  hash: Map<number, number[]>;
}

const HASH_P1 = 73856093, HASH_P2 = 19349663, HASH_P3 = 83492791;
const cellKey = (ix: number, iy: number, iz: number): number =>
  ((ix * HASH_P1) ^ (iy * HASH_P2) ^ (iz * HASH_P3)) | 0;

/** Precompute the exclusion neighbourhood and grid sizing for a model. */
export function buildCollisionState(m: BarHingeModel, params: CollisionParams): CollisionState {
  const faceRing: Set<number>[] = Array.from({ length: m.numNodes }, () => new Set<number>());
  for (let f = 0; f < m.faces.count; f++) {
    const a = m.faces.a[f], b = m.faces.b[f], c = m.faces.c[f];
    faceRing[a].add(b).add(c);
    faceRing[b].add(a).add(c);
    faceRing[c].add(a).add(b);
  }
  let sum = 0;
  for (let i = 0; i < m.beams.count; i++) sum += m.beams.rest[i];
  const avgEdge = m.beams.count ? sum / m.beams.count : params.thickness;
  // Cell large enough to find contacts within h, but ~edge-sized so cells stay sparse.
  const cellSize = Math.max(params.thickness * 2, avgEdge);
  return { params, faceRing, cellSize, hash: new Map() };
}

/** Closest point on triangle (a,b,c) to p; returns the point and its barycentric weights. */
function closestOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): { qx: number; qy: number; qz: number; u: number; v: number; w: number } {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { qx: ax, qy: ay, qz: az, u: 1, v: 0, w: 0 };
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { qx: bx, qy: by, qz: bz, u: 0, v: 1, w: 0 };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { qx: ax + abx * v, qy: ay + aby * v, qz: az + abz * v, u: 1 - v, v, w: 0 };
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { qx: cx, qy: cy, qz: cz, u: 0, v: 0, w: 1 };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { qx: ax + acx * w, qy: ay + acy * w, qz: az + acz * w, u: 1 - w, v: 0, w };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { qx: bx + (cx - bx) * w, qy: by + (cy - by) * w, qz: bz + (cz - bz) * w, u: 0, v: 1 - w, w };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return { qx: ax + abx * v + acx * w, qy: ay + aby * v + acy * w, qz: az + abz * v + acz * w, u: 1 - v - w, v, w };
}

/**
 * Accumulate self-collision repulsion into `m.force` (call AFTER the elastic/crease forces, before
 * integrate). Rebuilds the spatial hash from the current positions each call.
 */
export function accumulateCollisionForces(m: BarHingeModel, st: CollisionState): void {
  const pos = m.position, vel = m.velocity, F = m.force;
  const { thickness: h, k, damp, maxForce } = st.params;
  const cs = st.cellSize;
  const hash = st.hash;
  hash.clear();

  // --- broad phase: insert each triangle into the grid cells its (h-expanded) AABB covers ---
  const fa = m.faces.a, fb = m.faces.b, fc = m.faces.c;
  for (let f = 0; f < m.faces.count; f++) {
    const a = fa[f], b = fb[f], c = fc[f];
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
    const cx = pos[3 * c], cy = pos[3 * c + 1], cz = pos[3 * c + 2];
    const lo = (v0: number, v1: number, v2: number) => Math.floor((Math.min(v0, v1, v2) - h) / cs);
    const hi = (v0: number, v1: number, v2: number) => Math.floor((Math.max(v0, v1, v2) + h) / cs);
    const ix0 = lo(ax, bx, cx), ix1 = hi(ax, bx, cx);
    const iy0 = lo(ay, by, cy), iy1 = hi(ay, by, cy);
    const iz0 = lo(az, bz, cz), iz1 = hi(az, bz, cz);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          const key = cellKey(ix, iy, iz);
          const bucket = hash.get(key);
          if (bucket) bucket.push(f);
          else hash.set(key, [f]);
        }
  }

  // --- narrow phase: each node vs the triangles in its cell ---
  for (let vtx = 0; vtx < m.numNodes; vtx++) {
    if (m.fixed[vtx]) continue; // pinned/driven nodes are prescribed; don't push them
    const px = pos[3 * vtx], py = pos[3 * vtx + 1], pz = pos[3 * vtx + 2];
    const ring = st.faceRing[vtx];
    const bucket = hash.get(cellKey(Math.floor(px / cs), Math.floor(py / cs), Math.floor(pz / cs)));
    if (!bucket) continue;
    for (let bi = 0; bi < bucket.length; bi++) {
      const f = bucket[bi];
      const a = fa[f], b = fb[f], c = fc[f];
      if (a === vtx || b === vtx || c === vtx) continue;
      if (ring.has(a) || ring.has(b) || ring.has(c)) continue; // shares a face → fold, not contact
      const q = closestOnTriangle(
        px, py, pz,
        pos[3 * a], pos[3 * a + 1], pos[3 * a + 2],
        pos[3 * b], pos[3 * b + 1], pos[3 * b + 2],
        pos[3 * c], pos[3 * c + 1], pos[3 * c + 2],
      );
      let nx = px - q.qx, ny = py - q.qy, nz = pz - q.qz;
      let d = Math.hypot(nx, ny, nz);
      if (d >= h) continue;
      if (d > 1e-9) { nx /= d; ny /= d; nz /= d; }
      else {
        // node sits on the triangle: push along the face normal
        nx = m.faces.normal[3 * f]; ny = m.faces.normal[3 * f + 1]; nz = m.faces.normal[3 * f + 2];
        d = 0;
      }
      let mag = k * (h - d);
      // contact damping: resist only the approaching component of relative normal velocity
      const vrx = vel[3 * vtx] - (q.u * vel[3 * a] + q.v * vel[3 * b] + q.w * vel[3 * c]);
      const vry = vel[3 * vtx + 1] - (q.u * vel[3 * a + 1] + q.v * vel[3 * b + 1] + q.w * vel[3 * c + 1]);
      const vrz = vel[3 * vtx + 2] - (q.u * vel[3 * a + 2] + q.v * vel[3 * b + 2] + q.w * vel[3 * c + 2]);
      const vn = vrx * nx + vry * ny + vrz * nz;
      if (vn < 0) mag -= damp * vn; // approaching (vn<0) → add resistance
      if (mag < 0) mag = 0;
      if (mag > maxForce) mag = maxForce;
      const fx = mag * nx, fy = mag * ny, fz = mag * nz;
      F[3 * vtx] += fx; F[3 * vtx + 1] += fy; F[3 * vtx + 2] += fz;
      // reaction onto the triangle, distributed by barycentric weights (momentum-conserving)
      F[3 * a] -= q.u * fx; F[3 * a + 1] -= q.u * fy; F[3 * a + 2] -= q.u * fz;
      F[3 * b] -= q.v * fx; F[3 * b + 1] -= q.v * fy; F[3 * b + 2] -= q.v * fz;
      F[3 * c] -= q.w * fx; F[3 * c + 1] -= q.w * fy; F[3 * c + 2] -= q.w * fz;
    }
  }
}
