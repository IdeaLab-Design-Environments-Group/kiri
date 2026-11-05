/**
 * Slit-lip geometry for vent carving (K1), pure helpers for `cutAlongEdges`.
 *
 * Developed flat, a cut saddle overlaps itself: the fan around a slit vertex
 * carries 2π + |δ|, so lip B of the slit lands |δ| inside the material on lip
 * A's side. The double cover the vent removes is the region between the two
 * lip images. Near the apex that is a cone; once the slit bends, or passes
 * another saddle whose own excess turns lip B further, it is the region
 * between the two lip POLYLINES, which these helpers trace and test.
 */

import { cross2 } from "./flat-layout.js";
import type { MeshTopology, Vec2 } from "./types.js";

/** Boundary neighbours of every vertex of a face list (a one-wedge boundary copy has exactly two). */
export function boundaryNeighbours(faces: readonly (readonly number[] | null)[]): Map<number, number[]> {
  const directed = new Set<string>();
  for (const f of faces) if (f !== null) for (let i = 0; i < 3; i++) directed.add(`${f[i]}_${f[(i + 1) % 3]}`);
  const nbrs = new Map<number, number[]>();
  for (const f of faces) {
    if (f === null) continue;
    for (let i = 0; i < 3; i++) {
      const [a, b] = [f[i], f[(i + 1) % 3]];
      if (directed.has(`${b}_${a}`)) continue;
      nbrs.set(a, [...(nbrs.get(a) ?? []), b]);
      nbrs.set(b, [...(nbrs.get(b) ?? []), a]);
    }
  }
  return nbrs;
}

/** Hops along cut edges from the mesh boundary to every vertex the cut forest reaches. */
export function slitDepths(topo: MeshTopology, isCut: (e: number) => boolean): Map<number, number> {
  const depth = new Map<number, number>();
  let ring = [...topo.boundaryVertices];
  for (const v of ring) depth.set(v, 0);
  for (let d = 1; ring.length > 0; d++) {
    const next: number[] = [];
    for (const u of ring) {
      for (const e of topo.vertexEdges[u]) {
        const w = topo.edges[e].a === u ? topo.edges[e].b : topo.edges[e].a;
        if (!isCut(e) || depth.has(w)) continue;
        depth.set(w, d);
        next.push(w);
      }
    }
    ring = next;
  }
  return depth;
}

/**
 * Flat polyline of one lip: from `apex` into boundary neighbour `start`, then
 * onward along the sheet boundary while `passes(copy)` holds. Collinear
 * interior points are dropped, so a straight lip comes back as two points.
 */
export function followLip(
  flat: readonly Vec2[],
  nbrs: Map<number, number[]>,
  apex: number,
  start: number,
  passes: (copy: number) => boolean,
): Vec2[] {
  const pts = [flat[apex], flat[start]];
  for (let [prev, cur] = [apex, start]; pts.length <= flat.length && passes(cur); ) {
    const next = (nbrs.get(cur) ?? []).find((x) => x !== prev);
    if (next === undefined) break;
    [prev, cur] = [cur, next];
    const [a, b, q] = [pts[pts.length - 2], pts[pts.length - 1], flat[cur]];
    const [e1x, e1y, e2x, e2y] = [b.x - a.x, b.y - a.y, q.x - b.x, q.y - b.y];
    if (Math.abs(cross2(e1x, e1y, e2x, e2y)) <= 1e-9 * Math.hypot(e1x, e1y) * Math.hypot(e2x, e2y)) pts.pop();
    pts.push(q);
  }
  return pts;
}

/** A length that carries any point of the layout past all of it (4× its bbox diagonal, plus 1). */
export function clearLength(flat: readonly Vec2[]): number {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of flat) [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
  return 4 * Math.hypot(x1 - x0, y1 - y0) + 1;
}

/** The point `len` past a polyline's last vertex, on the line of its last segment. */
export function extendLip(lip: readonly Vec2[], len: number): Vec2 {
  const [p, q] = [lip[lip.length - 2], lip[lip.length - 1]];
  const l = Math.hypot(q.x - p.x, q.y - p.y);
  return { x: q.x + ((q.x - p.x) / l) * len, y: q.y + ((q.y - p.y) / l) * len };
}

/** Even-odd point-in-polygon; points on an edge (relative 1e-9) count as inside. */
export function insideRing(ring: readonly Vec2[], p: Vec2): boolean {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const [ex, ey, px, py] = [ring[i].x - a.x, ring[i].y - a.y, p.x - a.x, p.y - a.y];
    const along = (ex * px + ey * py) / (ex * ex + ey * ey);
    if (along >= 0 && along <= 1 && Math.abs(cross2(ex, ey, px, py)) <= 1e-9 * (Math.hypot(ex, ey) * Math.hypot(px, py) + 1e-12)) {
      return true;
    }
    if (a.y > p.y !== ring[i].y > p.y && p.x < a.x + (py * ex) / ey) odd = !odd;
  }
  return odd;
}
