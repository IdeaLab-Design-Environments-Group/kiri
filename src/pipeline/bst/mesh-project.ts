/**
 * Closest-point-on-mesh (the "OnMesh" goal) + the target's planar footprint (for grid sizing).
 *
 * Self-contained: depends only on core/vec3 and the pipeline TriMesh DTO — no sim imports (the
 * sim's collision.ts has an equivalent routine but is internal to sim/, which the layering rules
 * keep out of pipeline). Brute-force over faces; fine for the modest target meshes here.
 */
import { type Vec3, vec3, sub, add, scale, dot, cross, length, normalize } from "../../core/vec3.js";
import type { TriMesh, Vec2 } from "../types.js";

export interface MeshHit {
  point: Vec3;
  faceId: number;
  bary: [number, number, number];
  dist: number;
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection §5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): { point: Vec3; bary: [number, number, number]; dist: number } {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let u = 0, v = 0, w = 0;
  let q: Vec3;
  if (d1 <= 0 && d2 <= 0) { q = a; u = 1; }
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) { q = b; v = 1; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); q = add(a, scale(ab, t)); u = 1 - t; v = t; }
      else {
        const cp = sub(p, c);
        const d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) { q = c; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); q = add(a, scale(ac, t)); u = 1 - t; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); q = add(b, scale(sub(c, b), t)); v = 1 - t; w = t; }
            else { const denom = 1 / (va + vb + vc); v = vb * denom; w = vc * denom; u = 1 - v - w; q = add(a, add(scale(ab, v), scale(ac, w))); }
          }
        }
      }
    }
  }
  return { point: q, bary: [u, v, w], dist: length(sub(p, q)) };
}

/** Project p onto the nearest point of the mesh surface (brute force over faces). */
export function projectToMesh(p: Vec3, mesh: TriMesh): MeshHit {
  let best: MeshHit = { point: mesh.vertices[0], faceId: 0, bary: [1, 0, 0], dist: Infinity };
  for (let f = 0; f < mesh.faces.length; f++) {
    const [ia, ib, ic] = mesh.faces[f];
    const r = closestOnTriangle(p, mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]);
    if (r.dist < best.dist) best = { point: r.point, faceId: f, bary: r.bary, dist: r.dist };
  }
  return best;
}

/**
 * Curried projector with exact AABB-distance culling — precomputes per-face corner positions,
 * AABBs, and centroids once, then per query seeds the best distance from the nearest-centroid face
 * and skips any face whose AABB is already farther than the running best. Exact (no approximation),
 * just far fewer closest-point evaluations than the brute force — the relax loop calls it per vertex
 * per iteration, so this is the difference between a snappy fit and a multi-second one.
 */
export function makeProjector(mesh: TriMesh): (p: Vec3) => MeshHit {
  const F = mesh.faces.length;
  const a: Vec3[] = [], b: Vec3[] = [], c: Vec3[] = [], cen: Vec3[] = [];
  const lo: Vec3[] = [], hi: Vec3[] = [];
  for (let f = 0; f < F; f++) {
    const [ia, ib, ic] = mesh.faces[f];
    const pa = mesh.vertices[ia], pb = mesh.vertices[ib], pc = mesh.vertices[ic];
    a.push(pa); b.push(pb); c.push(pc);
    cen.push({ x: (pa.x + pb.x + pc.x) / 3, y: (pa.y + pb.y + pc.y) / 3, z: (pa.z + pb.z + pc.z) / 3 });
    lo.push({ x: Math.min(pa.x, pb.x, pc.x), y: Math.min(pa.y, pb.y, pc.y), z: Math.min(pa.z, pb.z, pc.z) });
    hi.push({ x: Math.max(pa.x, pb.x, pc.x), y: Math.max(pa.y, pb.y, pc.y), z: Math.max(pa.z, pb.z, pc.z) });
  }
  const aabbMinDist2 = (p: Vec3, f: number): number => {
    const dx = Math.max(0, lo[f].x - p.x, p.x - hi[f].x);
    const dy = Math.max(0, lo[f].y - p.y, p.y - hi[f].y);
    const dz = Math.max(0, lo[f].z - p.z, p.z - hi[f].z);
    return dx * dx + dy * dy + dz * dz;
  };
  return (p: Vec3): MeshHit => {
    // seed from the nearest-centroid face so `best` shrinks immediately and the cull is effective
    let seed = 0, seedD2 = Infinity;
    for (let f = 0; f < F; f++) {
      const d2 = (cen[f].x - p.x) ** 2 + (cen[f].y - p.y) ** 2 + (cen[f].z - p.z) ** 2;
      if (d2 < seedD2) { seedD2 = d2; seed = f; }
    }
    let r = closestOnTriangle(p, a[seed], b[seed], c[seed]);
    let best: MeshHit = { point: r.point, faceId: seed, bary: r.bary, dist: r.dist };
    for (let f = 0; f < F; f++) {
      if (f === seed) continue;
      if (aabbMinDist2(p, f) >= best.dist * best.dist) continue; // cannot beat best
      r = closestOnTriangle(p, a[f], b[f], c[f]);
      if (r.dist < best.dist) best = { point: r.point, faceId: f, bary: r.bary, dist: r.dist };
    }
    return best;
  };
}

export interface PlaneBasis {
  origin: Vec3; // centroid
  u: Vec3; // in-plane axis 1 (unit)
  v: Vec3; // in-plane axis 2 (unit)
  n: Vec3; // plane normal (unit)
}

/** Area-weighted average face normal → best-fit plane; returns an orthonormal in-plane basis. */
function fitPlane(mesh: TriMesh): PlaneBasis {
  let nx = 0, ny = 0, nz = 0;
  const c = vec3();
  for (const v of mesh.vertices) { c.x += v.x; c.y += v.y; c.z += v.z; }
  const origin = scale(c, 1 / mesh.vertices.length);
  for (const [ia, ib, ic] of mesh.faces) {
    const fn = cross(sub(mesh.vertices[ib], mesh.vertices[ia]), sub(mesh.vertices[ic], mesh.vertices[ia]));
    nx += fn.x; ny += fn.y; nz += fn.z; // area-weighted (cross magnitude = 2·area)
  }
  let n = normalize(vec3(nx, ny, nz));
  if (length(n) < 1e-9) n = vec3(0, 0, 1);
  // pick any in-plane axis not parallel to n
  const seed = Math.abs(n.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0);
  const u = normalize(cross(seed, n));
  const v = cross(n, u);
  return { origin, u, v, n };
}

/** The target's planar footprint: best-fit plane + 2D bbox of all vertices projected into it. */
export function planarDomain(mesh: TriMesh): { min: Vec2; max: Vec2; basis: PlaneBasis } {
  const basis = fitPlane(mesh);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of mesh.vertices) {
    const d = sub(p, basis.origin);
    const uu = dot(d, basis.u), vv = dot(d, basis.v);
    minU = Math.min(minU, uu); maxU = Math.max(maxU, uu);
    minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
  }
  return { min: { x: minU, y: minV }, max: { x: maxU, y: maxV }, basis };
}

/** Lift a 2D domain point (u,v in the fit plane) back to 3D. */
export function liftToPlane(uv: Vec2, basis: PlaneBasis): Vec3 {
  return add(basis.origin, add(scale(basis.u, uv.x), scale(basis.v, uv.y)));
}
