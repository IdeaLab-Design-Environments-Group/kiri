/**
 * Flat layout of a cut patch and its self-overlap tests (pure functions of
 * the cut mesh): the BFS isometric development `unfoldPatch` with its
 * developability audit, and the shrunk-triangle SAT predicates the relief
 * loop and vent ranking count overlaps with.
 */

import { distance } from "../core/vec3.js";
import { edgeKey } from "./mesh.js";
import { PipelineError, type TriMesh, type Vec2 } from "./types.js";

/** Relative tolerance for the developability audit (per edge length). */
const AUDIT_REL = 1e-6;

/**
 * Absolute audit floor, as a fraction of the patch bbox diagonal. BFS flat
 * placement accumulates ~1e-9·diag of FP error regardless of edge length, so
 * a purely relative tolerance falsely flags vent-synthesized micro-edges
 * (~1e-6 mm). Floor ≈ 1.5e-7 mm on a 150 mm model — ~200× the observed
 * accumulation, ~700× below WELD_TOL_MM=1e-4 (conditioning.ts) and 5+ orders
 * below legitimate features, so real violations still trip the relative term.
 */
const AUDIT_ABS_FRAC = 1e-9;

export const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * BFS isometric layout of one connected patch of the cut mesh. Throws
 * PipelineError("unfold") when a non-tree placement disagrees — that means
 * the patch is not developable, i.e. a planner bug, not a relief case.
 */
export function unfoldPatch(cut: { mesh: TriMesh }, patchFaces: number[]): Vec2[] {
  const { mesh } = cut;
  const flat: (Vec2 | null)[] = new Array(mesh.vertices.length).fill(null);
  const inPatch = new Set(patchFaces);

  // Face adjacency over shared (undirected) edges, limited to the patch.
  const edgeFaces = new Map<string, number[]>();
  for (const f of patchFaces) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      const list = edgeFaces.get(key) ?? [];
      list.push(f);
      edgeFaces.set(key, list);
    }
  }

  const d3 = (a: number, b: number): number => distance(mesh.vertices[a], mesh.vertices[b]);

  // Absolute audit floor scaled to the patch extent (see AUDIT_ABS_FRAC).
  let lo = { x: Infinity, y: Infinity, z: Infinity };
  let hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const f of patchFaces) {
    for (const v of mesh.faces[f]) {
      const p = mesh.vertices[v];
      lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y), z: Math.min(lo.z, p.z) };
      hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y), z: Math.max(hi.z, p.z) };
    }
  }
  const diag = Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
  const auditAbs = AUDIT_ABS_FRAC * diag;

  // Seed: first face at the origin, first edge along +x, third vertex at +y.
  const f0 = patchFaces[0];
  const [s0, s1, s2] = mesh.faces[f0];
  const l01 = d3(s0, s1);
  flat[s0] = { x: 0, y: 0 };
  flat[s1] = { x: l01, y: 0 };
  {
    const lac = d3(s0, s2);
    const lbc = d3(s1, s2);
    const x = (lac * lac + l01 * l01 - lbc * lbc) / (2 * l01);
    const y = Math.sqrt(Math.max(0, lac * lac - x * x));
    flat[s2] = { x, y };
  }

  const placeAcross = (a: number, b: number, c: number, oppositeTo: number): Vec2 => {
    const pa = flat[a]!;
    const pb = flat[b]!;
    const lab = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const lac = d3(a, c);
    const lbc = d3(b, c);
    const x = (lac * lac + lab * lab - lbc * lbc) / (2 * lab);
    const y = Math.sqrt(Math.max(0, lac * lac - x * x));
    const ux = (pb.x - pa.x) / lab;
    const uy = (pb.y - pa.y) / lab;
    // n̂ = û rotated +90°; choose the sign putting c opposite `oppositeTo`.
    const po = flat[oppositeTo]!;
    const sideO = cross2(pb.x - pa.x, pb.y - pa.y, po.x - pa.x, po.y - pa.y);
    const sign = sideO > 0 ? -1 : 1;
    return { x: pa.x + x * ux + sign * y * -uy, y: pa.y + x * uy + sign * y * ux };
  };

  const visited = new Set<number>([f0]);
  const queue: number[] = [f0];
  while (queue.length > 0) {
    const f = queue.shift()!;
    const [i, j, k] = mesh.faces[f];
    for (const [a, b, c] of [[i, j, k], [j, k, i], [k, i, j]] as [number, number, number][]) {
      for (const g of edgeFaces.get(edgeKey(a, b)) ?? []) {
        if (g === f || visited.has(g) || !inPatch.has(g)) continue;
        const gc = mesh.faces[g].find((v) => v !== a && v !== b)!;
        const pos = placeAcross(a, b, gc, c);
        if (flat[gc] === null) {
          flat[gc] = pos;
        } else {
          const err = Math.hypot(flat[gc]!.x - pos.x, flat[gc]!.y - pos.y);
          const scale = Math.max(d3(a, gc), d3(b, gc), 1e-12);
          if (err > AUDIT_REL * scale * 10 + auditAbs) {
            throw new PipelineError(
              "unfold",
              `developability audit failed: vertex ${gc} placed inconsistently (err ${err.toExponential(2)} mm) — patch is not developable (planner bug)`,
              { vertex: gc, err },
            );
          }
        }
        visited.add(g);
        queue.push(g);
      }
    }
  }

  // Audit: every patch edge's flat length must equal its 3D rest length.
  for (const [key, fs] of edgeFaces) {
    if (fs.length === 0) continue;
    const [a, b] = key.split("_").map(Number);
    const pa = flat[a];
    const pb = flat[b];
    if (!pa || !pb) {
      throw new PipelineError("unfold", `patch vertex ${pa ? b : a} never placed — patch not edge-connected`);
    }
    const lFlat = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const l3 = d3(a, b);
    if (Math.abs(lFlat - l3) > AUDIT_REL * Math.max(l3, 1e-12) * 10 + auditAbs) {
      throw new PipelineError("unfold", `isometry audit failed on edge ${key}: flat ${lFlat} vs rest ${l3}`);
    }
  }

  return flat.map((p) => p ?? { x: 0, y: 0 });
}

/**
 * SAT overlap test for two triangles, each shrunk by `eps` toward its
 * centroid so adjacent triangles sharing vertices/edges never false-positive.
 */
export function trianglesOverlap(a: Vec2[], b: Vec2[], eps = 1e-6): boolean {
  const shrink = (t: Vec2[]): Vec2[] => {
    const cx = (t[0].x + t[1].x + t[2].x) / 3;
    const cy = (t[0].y + t[1].y + t[2].y) / 3;
    return t.map((p) => ({ x: cx + (p.x - cx) * (1 - eps), y: cy + (p.y - cy) * (1 - eps) }));
  };
  const A = shrink(a);
  const B = shrink(b);
  const axes: Vec2[] = [];
  for (const t of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i];
      const q = t[(i + 1) % 3];
      axes.push({ x: -(q.y - p.y), y: q.x - p.x });
    }
  }
  for (const axis of axes) {
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const p of A) {
      const d = p.x * axis.x + p.y * axis.y;
      minA = Math.min(minA, d);
      maxA = Math.max(maxA, d);
    }
    for (const p of B) {
      const d = p.x * axis.x + p.y * axis.y;
      minB = Math.min(minB, d);
      maxB = Math.max(maxB, d);
    }
    if (maxA < minB || maxB < minA) return false; // separating axis found
  }
  return true;
}

/**
 * First overlapping face pair in the flat layout (BFS-order indices into
 * `faces`), or null. Pairs sharing a vertex articulate legally and are skipped.
 */
export function findSelfOverlap(
  flat: Vec2[],
  faces: [number, number, number][],
): [number, number] | null {
  const tris = faces.map((f) => f.map((v) => flat[v]) as Vec2[]);
  const boxes = tris.map((t) => ({
    minX: Math.min(t[0].x, t[1].x, t[2].x),
    maxX: Math.max(t[0].x, t[1].x, t[2].x),
    minY: Math.min(t[0].y, t[1].y, t[2].y),
    maxY: Math.max(t[0].y, t[1].y, t[2].y),
  }));
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[i].some((v) => faces[j].includes(v))) continue; // share a vertex
      const a = boxes[i];
      const b = boxes[j];
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
      if (trianglesOverlap(tris[i], tris[j])) return [i, j];
    }
  }
  return null;
}

/**
 * Count of overlapping face pairs in a flat layout (same predicate family as
 * `findSelfOverlap`; vertex-sharing pairs articulate legally and are skipped).
 * Stops early once the count exceeds `cap` — callers compare against a best.
 */
export function countFlatOverlaps(flat: Vec2[], faces: [number, number, number][], cap = Number.POSITIVE_INFINITY): number {
  const tris = faces.map((f) => f.map((v) => flat[v]) as Vec2[]);
  const boxes = tris.map((t) => ({
    minX: Math.min(t[0].x, t[1].x, t[2].x),
    maxX: Math.max(t[0].x, t[1].x, t[2].x),
    minY: Math.min(t[0].y, t[1].y, t[2].y),
    maxY: Math.max(t[0].y, t[1].y, t[2].y),
  }));
  let count = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[i].some((v) => faces[j].includes(v))) continue;
      const a = boxes[i];
      const b = boxes[j];
      if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
      if (trianglesOverlap(tris[i], tris[j])) {
        count++;
        if (count > cap) return count;
      }
    }
  }
  return count;
}
