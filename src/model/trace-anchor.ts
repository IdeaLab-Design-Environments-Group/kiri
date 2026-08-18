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
import type { PadPair, Trace2D } from "./electronics-routing.js";

/** A point of the flat pattern, expressed against the mesh: a triangle and the weights inside it. */
export interface AnchorPoint {
  tri: [number, number, number];
  bary: [number, number, number];
}

/**
 * A flat piece of the electronics layer, ready to be drawn on the folded model.
 *
 * Triangles rather than lines, so the copper has the width it will really be cut at and the pads read as pads.
 * Every corner is anchored, so the whole piece folds with the face it sits on.
 */
export interface AnchoredMesh {
  /** What this is, so the view can colour it as the 2D layout does. */
  kind: "pwr" | "gnd" | "led-pwr" | "led-gnd" | "led-body" | "batt-pwr" | "batt-gnd" | "mark";
  /** Corners in threes: one triangle per three entries. */
  tris: AnchorPoint[];
}

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

/**
 * Build the whole electronics layer as flat triangles, pinned to the mesh.
 *
 * Everything is laid out in the flat pattern first -- ribbons along the traces, squares on the pads -- and only
 * then anchored, so the 3D view shows the same shapes at the same sizes as the 2D layout rather than a separate
 * idea of them. A piece whose corners do not all land on the material is dropped: half a pad drawn against a
 * guessed face is worse than no pad.
 */
export function anchorOverlay(
  traces: Trace2D[],
  pads: PadPair[],
  terminals: { pwr: Vec2; gnd: Vec2; half: number } | null,
  tapeW: number,
  faces: FlatFace[],
): AnchoredMesh[] {
  const out: AnchoredMesh[] = [];

  for (const t of traces) {
    const tris = ribbon(t.pts, tapeW, faces);
    if (tris.length) out.push({ kind: t.net, tris });
  }

  for (const pad of pads) {
    if (isOrigin(pad.pwr) && isOrigin(pad.gnd)) continue;
    // The chip body first, so the two pads sit on top of it as they do in the layout.
    const body = ribbon([pad.pwr, pad.gnd], tapeW * 0.5, faces);
    if (body.length) out.push({ kind: "led-body", tris: body });
    const p = square(pad.pwr, tapeW * 0.55, faces);
    if (p.length) out.push({ kind: "led-pwr", tris: p });
    const g = square(pad.gnd, tapeW * 0.55, faces);
    if (g.length) out.push({ kind: "led-gnd", tris: g });
    // Which end is which, marked on the part itself. Colour alone says it in the 2D layout, where the legend is
    // beside it; on the model, turned to any angle and lit from any side, a shape is the only reliable label.
    marks(out, pad.pwr, pad.gnd, tapeW * 0.55, faces);
  }

  if (terminals) {
    const p = square(terminals.pwr, terminals.half, faces);
    if (p.length) out.push({ kind: "batt-pwr", tris: p });
    const g = square(terminals.gnd, terminals.half, faces);
    if (g.length) out.push({ kind: "batt-gnd", tris: g });
    marks(out, terminals.pwr, terminals.gnd, terminals.half, faces);
  }

  return out;
}

const isOrigin = (p: Vec2): boolean => p.x === 0 && p.y === 0;

/**
 * A `+` on the positive pad and a `−` on the negative one, drawn as bars rather than text.
 *
 * Geometry, not a font: a glyph would need a texture atlas and would face the camera rather than lying on the
 * part, and this has to read at any angle on a folded model. Bars are anchored like everything else, so they
 * fold with the pad they are on.
 */
function marks(out: AnchoredMesh[], pwr: Vec2, gnd: Vec2, half: number, faces: FlatFace[]): void {
  const arm = half * 0.62;   // reaches most of the way across the pad
  const thick = half * 0.26;
  const bars: AnchorPoint[] = [];
  // Minus: one bar. Plus: the same bar crossed. Drawn in the pattern's own axes, as the pads are.
  pushQuad(bars, [
    { x: gnd.x - arm, y: gnd.y - thick }, { x: gnd.x + arm, y: gnd.y - thick },
    { x: gnd.x + arm, y: gnd.y + thick }, { x: gnd.x - arm, y: gnd.y + thick },
  ], faces);
  pushQuad(bars, [
    { x: pwr.x - arm, y: pwr.y - thick }, { x: pwr.x + arm, y: pwr.y - thick },
    { x: pwr.x + arm, y: pwr.y + thick }, { x: pwr.x - arm, y: pwr.y + thick },
  ], faces);
  pushQuad(bars, [
    { x: pwr.x - thick, y: pwr.y - arm }, { x: pwr.x + thick, y: pwr.y - arm },
    { x: pwr.x + thick, y: pwr.y + arm }, { x: pwr.x - thick, y: pwr.y + arm },
  ], faces);
  if (bars.length) out.push({ kind: "mark", tris: bars });
}

/** A strip of the given width along `pts`, as triangles. Corners are squared off rather than mitred: a mitre
 *  that overshoots a face boundary would anchor outside it, and at these widths the difference is invisible. */
function ribbon(pts: Vec2[], width: number, faces: FlatFace[]): AnchorPoint[] {
  const half = width / 2;
  const tris: AnchorPoint[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-12) continue;
    const nx = (-dy / L) * half, ny = (dx / L) * half;
    const quad: Vec2[] = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ];
    pushQuad(tris, quad, faces);
  }
  return tris;
}

/** An axis-aligned square of half-width `half` centred on `c`. */
function square(c: Vec2, half: number, faces: FlatFace[]): AnchorPoint[] {
  const tris: AnchorPoint[] = [];
  pushQuad(
    tris,
    [
      { x: c.x - half, y: c.y - half },
      { x: c.x + half, y: c.y - half },
      { x: c.x + half, y: c.y + half },
      { x: c.x - half, y: c.y + half },
    ],
    faces,
  );
  return tris;
}

/** Anchor a quad as two triangles, or drop it if any corner is off the material. */
function pushQuad(into: AnchorPoint[], quad: Vec2[], faces: FlatFace[]): void {
  const anchored = quad.map((p) => anchorPoint(p, faces));
  if (anchored.some((a) => !a)) return;
  const [p0, p1, p2, p3] = anchored as AnchorPoint[];
  into.push(p0, p1, p2, p0, p2, p3);
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
