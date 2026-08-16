/**
 * **Model** — pinning flat-pattern copper to the mesh, so it can be drawn on the folded model.
 *
 * A trace is planned in the flat pattern, but the simulation shows the sheet part-way folded, where every face
 * has moved. Rather than re-plan anything, each point of tape is stored as *a triangle of the pattern plus the
 * weights that place the point inside it*. A face is rigid and stays planar as the sheet folds, so the same
 * weights over the folded corners give where that piece of tape has ended up. The copper then follows the fold
 * exactly, and costs nothing per frame beyond three multiplies per point.
 *
 * Points that fall outside every face — which should not happen, since the router keeps copper on the material,
 * but a stale circuit against a changed pattern can produce one — are dropped rather than pinned to the nearest
 * guess, so a wrong answer never appears on the model as if it were real.
 */
import { type FlatFace, type Vec2, pointInFace } from "./electronics.js";
import type { Trace2D } from "./electronics-routing.js";

/** One trace, with every point expressed against the mesh instead of the flat plane. */
export interface AnchoredTrace {
  net: "pwr" | "gnd";
  points: { tri: [number, number, number]; bary: [number, number, number] }[];
}

/**
 * Pin `traces` to `faces`.
 *
 * `faces` must be the flat faces of the same pattern the simulation is folding, since the vertex ids in the
 * result index that mesh's vertices directly.
 */
export function anchorTraces(traces: Trace2D[], faces: FlatFace[]): AnchoredTrace[] {
  const out: AnchoredTrace[] = [];
  for (const t of traces) {
    const points: AnchoredTrace["points"] = [];
    for (const p of t.pts) {
      const pinned = anchorPoint(p, faces);
      if (pinned) points.push(pinned);
    }
    // A single point cannot be drawn as a run, and a trace reduced to one has lost its shape anyway.
    if (points.length >= 2) out.push({ net: t.net, points });
  }
  return out;
}

/** Pin one point: the face under it, a triangle of that face, and the weights inside that triangle. */
function anchorPoint(
  p: Vec2,
  faces: FlatFace[],
): { tri: [number, number, number]; bary: [number, number, number] } | null {
  const fi = pointInFace(faces, p);
  const face = fi >= 0 ? faces[fi] : undefined;
  if (!face || face.verts.length < 3) return null;

  // A polygon face is fanned from its first corner; the point sits in exactly one of those triangles. Testing
  // them is what makes this correct for quads and larger faces, where one arbitrary triangle would not contain
  // every point of the face.
  for (let k = 1; k + 1 < face.verts.length; k++) {
    const a = face.poly[0]!, b = face.poly[k]!, c = face.poly[k + 1]!;
    const w = barycentric(p, a, b, c);
    if (!w) continue;
    const inside = w[0] >= -1e-9 && w[1] >= -1e-9 && w[2] >= -1e-9;
    if (!inside) continue;
    return { tri: [face.verts[0]!, face.verts[k]!, face.verts[k + 1]!], bary: w };
  }

  // On a boundary the tests above can all fail by a hair. Fall back to the fan triangle whose weights are least
  // negative — still this face, still exact on its own plane, just resolved against rounding.
  let best: { tri: [number, number, number]; bary: [number, number, number] } | null = null;
  let bestErr = Infinity;
  for (let k = 1; k + 1 < face.verts.length; k++) {
    const w = barycentric(p, face.poly[0]!, face.poly[k]!, face.poly[k + 1]!);
    if (!w) continue;
    const err = Math.min(0, w[0]) + Math.min(0, w[1]) + Math.min(0, w[2]);
    if (-err < bestErr) {
      bestErr = -err;
      best = { tri: [face.verts[0]!, face.verts[k]!, face.verts[k + 1]!], bary: w };
    }
  }
  return best;
}

/** Weights placing `p` in triangle abc, or null when the triangle is degenerate. */
function barycentric(
  p: Vec2,
  a: Vec2,
  b: Vec2,
  c: Vec2,
): [number, number, number] | null {
  const v0x = b.x - a.x, v0y = b.y - a.y;
  const v1x = c.x - a.x, v1y = c.y - a.y;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-12) return null;
  const px = p.x - a.x, py = p.y - a.y;
  const wb = (px * v1y - v1x * py) / den;
  const wc = (v0x * py - px * v0y) / den;
  return [1 - wb - wc, wb, wc];
}
