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
import type { Jump } from "./trace-types.js";

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
  /**
   * What this is, so the view can colour it as the 2D layout does.
   *
   * The fixed names are the pieces this file draws itself; anything else is a net id off a
   * {@link Trace2D}, since a circuit may now carry any number of named nets rather than two rails.
   */
  kind:
    | "pwr" | "gnd" | "led-pwr" | "led-gnd" | "led-body" | "batt-pwr" | "batt-gnd" | "mark"
    /**
     * The ribbon of a jump: the wire the author solders across a cut once the sheet is folded.
     *
     * It exists only here. In the flat pattern a jump has no copper between its ends — the two lips are
     * hundreds of units apart and every planar rule is right to refuse tape across them — so nothing draws
     * it as a run. Folded, the two lips are the same edge, and the quad spanning them is a real, short
     * thing lying on the model. Drawing it is what makes the rejoin visible as a rejoin rather than as two
     * unexplained lands that happen to share a net.
     */
    | "jump"
    | (string & {});
  /** Corners in threes: one triangle per three entries. */
  tris: AnchorPoint[];
}

/** One trace, with every point expressed against the mesh instead of the flat plane. */
export interface AnchoredTrace {
  /** A net id — see {@link Trace2D.net}. `"pwr"`/`"gnd"` for the two-rail bus. */
  net: string;
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
  /** The jumps to draw as ribbons across their seams — see {@link jumpRibbon}. Their solder lands are
   *  ordinary {@link Trace2D}s and arrive in `traces`; empty by default, so a caller that knows of no
   *  jumps gets exactly the overlay it got before they existed. */
  jumps: Jump[] = [],
): AnchoredMesh[] {
  const out: AnchoredMesh[] = [];

  for (const t of traces) {
    const tris = ribbon(t.pts, t.width ?? tapeW, faces);
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

  for (const j of jumps) {
    const tris = jumpRibbon(j, tapeW, faces);
    if (tris.length) out.push({ kind: "jump", tris });
  }

  return out;
}

/**
 * The quad spanning one jump, at tape width, or nothing if either end is off the material.
 *
 * A jump's two ends lie on two lips that the fold brings together, so the quad's own two short edges lie
 * ALONG those lips: `a ± dirA·half` and `b ± dirB·half`, where the directions are the lip directions the
 * router (or the jump tool) recorded. Folded, those four corners are two coincident pairs and the quad
 * collapses onto the seam, which is exactly what a soldered wire across a closed cut looks like. This is
 * also why the file needs no adjacency of its own: the correspondence is carried on the jump.
 *
 * Corners are wound `a+ → b+ → b− → a−` so the ring respects that correspondence. Winding it the other way
 * would pair the plus side of one lip with the minus side of the other and fold the quad into a bowtie.
 *
 * A jump with no directions recorded is skipped rather than guessed at — a ribbon drawn across a direction
 * we invented would be a wire lying somewhere the author is not going to solder one.
 */
function jumpRibbon(j: Jump, tapeW: number, faces: FlatFace[]): AnchorPoint[] {
  if (!j.dirA || !j.dirB) return [];
  const half = tapeW / 2;
  const dA = scaled(j.dirA, half), dB = scaled(j.dirB, half);
  if (!dA || !dB) return [];
  // Each end's own face owns both of its corners. The corners sit ON the lip, which is a boundary of the
  // pattern, and `pushQuad` drops a quad with any corner off the material — so they are nudged a hair
  // inward first, the same move `corridor.ts` makes for its own on-edge nodes.
  const fa = faceUnder(j.a, faces), fb = faceUnder(j.b, faces);
  if (!fa || !fb) return [];
  const tris: AnchorPoint[] = [];
  pushQuad(
    tris,
    [
      nudgeInto({ x: j.a.x + dA.x, y: j.a.y + dA.y }, fa),
      nudgeInto({ x: j.b.x + dB.x, y: j.b.y + dB.y }, fb),
      nudgeInto({ x: j.b.x - dB.x, y: j.b.y - dB.y }, fb),
      nudgeInto({ x: j.a.x - dA.x, y: j.a.y - dA.y }, fa),
    ],
    faces,
  );
  return tris;
}

/** `d` as a direction of length `n`, or null when it has no direction at all. */
function scaled(d: Vec2, n: number): Vec2 | null {
  const L = Math.hypot(d.x, d.y);
  if (L < 1e-12) return null;
  return { x: (d.x / L) * n, y: (d.y / L) * n };
}

/** The face a jump's end sits on — the one that owns both of that end's corners. */
function faceUnder(p: Vec2, faces: FlatFace[]): FlatFace | null {
  const fi = pointInFace(faces, p);
  return fi >= 0 ? faces[fi] ?? null : null;
}

/** `p`, moved a hair toward the face's centroid — off its boundary line and unambiguously inside it. */
function nudgeInto(p: Vec2, f: FlatFace): Vec2 {
  const dx = f.centroid.x - p.x, dy = f.centroid.y - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return p;
  return { x: p.x + dx * 1e-6, y: p.y + dy * 1e-6 };
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
