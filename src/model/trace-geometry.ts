/**
 * **Model** — the flat-pattern segment math every copper-routing module shares.
 *
 * ## Why this is its own file
 *
 * These are the primitives — points, segments, polylines — that the router, the corridor search, the part
 * seating and the plan metrics all reach for. They lived inside `electronics-routing.ts` as private
 * helpers, which meant a module that wanted `segsCross` had to import the whole router, and the router
 * imported it back. That is the shape most of this layer's import cycles had.
 *
 * Nothing here knows what a net, a pad or a component is. The only domain types it touches are
 * {@link Vec2} and {@link FlatFace}, both of which are plain geometry. Keep it that way: anything that
 * needs to know which net a run carries belongs a layer up.
 *
 * All coordinates are flat-pattern 2D in the pattern's own units (the SVG export frame).
 */
import { type FlatFace, type Vec2, dist2 } from "./electronics.js";

/** Positional key, for marking a hinge as occupied. Rounded well below any real feature size. */
export const ptKey = (p: Vec2): string => `${Math.round(p.x * 1e6)}_${Math.round(p.y * 1e6)}`;

// ---- small vector helpers ---------------------------------------------------

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);

export function unit(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Left normal of a direction (90 degrees CCW). */
export const leftOf = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

/** Midpoint of two points. */
export const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Two points the same to well inside any feature — the tolerance {@link ptKey} rounds at. */
export const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

/** The flat pattern's own origin, which a zeroed (unplaced) point sits on. */
export const isOrigin = (p: Vec2): boolean => p.x === 0 && p.y === 0;

/** Which side of the ray `origin + t·dir` the point `p` lies on: +1 left, -1 right. */
export function sideOf(origin: Vec2, dir: Vec2, p: Vec2): number {
  const c = cross(dir, sub(p, origin));
  return c >= 0 ? 1 : -1;
}

// ---- crossings --------------------------------------------------------------

/** Whether segment ab properly crosses any of the given polylines. */
export function crossesAny(a: Vec2, b: Vec2, lines: Vec2[][]): boolean {
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      if (segsCross(a, b, line[i - 1]!, line[i]!)) return true;
    }
  }
  return false;
}

/** True when segments ab and cd properly cross (interiors meet; shared endpoints and collinear touching
 *  do not count — same-net tape is allowed to touch). */
export function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  if (d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) return false;
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

/** True when the polyline `pts` properly crosses segment cd anywhere. */
export function polyCrosses(pts: Vec2[], c: Vec2, d: Vec2): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (segsCross(pts[i - 1]!, pts[i]!, c, d)) return true;
  }
  return false;
}

/** Whether two segments share an endpoint, to within a rounding of it. */
export function sharesEnd(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const same = (p: Vec2, q: Vec2): boolean => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
  return same(a, c) || same(a, d) || same(b, c) || same(b, d);
}

/** Where the infinite lines through ab and cd meet, or null when they are parallel. */
export function intersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a), sVec = sub(d, c);
  const den = cross(r, sVec);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(c, a), sVec) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

// ---- distances --------------------------------------------------------------

/** Distance from point `p` to segment ab. */
export function segPointDist(a: Vec2, b: Vec2, p: Vec2): number {
  const ab = sub(b, a);
  const L2 = ab.x * ab.x + ab.y * ab.y;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

/** Distance from point `r` to segment ab. The same measure as {@link segPointDist} with the point last. */
export function distToSeg(r: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return len(sub(r, a));
  const t = Math.max(0, Math.min(1, ((r.x - a.x) * dx + (r.y - a.y) * dy) / l2));
  return Math.hypot(r.x - (a.x + t * dx), r.y - (a.y + t * dy));
}

/** Closest approach between segments ab and cd (0 when they intersect). */
export function segNearSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(
    segPointDist(a, b, c), segPointDist(a, b, d),
    segPointDist(c, d, a), segPointDist(c, d, b),
  );
}

/** Closest approach from `p` to the polyline `pts`. */
export function nearPolyline(pts: Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const d = segPointDist(a, b, p);
    if (d < best) best = d;
  }
  return best;
}

// ---- polylines --------------------------------------------------------------

/** Drop `back` of length from the end of a polyline. */
export function trimEnd(pts: Vec2[], back: number): Vec2[] {
  let left = back;
  const out = [...pts];
  while (out.length >= 2) {
    const a = out[out.length - 2]!, b = out[out.length - 1]!;
    const l = len(sub(b, a));
    if (l > left) {
      const f = (l - left) / l;
      out[out.length - 1] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      return out;
    }
    left -= l;
    out.pop();
  }
  return out;
}

/** Drop consecutive duplicate points, so a pad that coincides with the previous one cannot create a
 *  zero-length segment. */
export function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && dist2(last, p) < 1e-18) continue;
    out.push(p);
  }
  return out;
}

/** The diagonal of the pattern's bounding box, which prices in the router are quoted as fractions of. */
export function patternDiag(faces: FlatFace[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const p of f.poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return 1;
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}
