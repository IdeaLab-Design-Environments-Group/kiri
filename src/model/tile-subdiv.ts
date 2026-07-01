/**
 * Shared fold-adaptive tile subdivision — the single source of truth used by BOTH the STL export
 * (`stl-export.ts`) and the 3D-printed sim render (`sim-canvas.ts`), so what you see and what you
 * print match. Faces that fold harder get split into more, smaller coplanar tiles; flatter faces
 * stay coarse. The split is purely visual (no new physics hinges) — a triangle's sub-tiles are
 * coplanar in both views — so the layouts are identical for a given fold metric and detail cap.
 */

/** Each tile is shrunk this fraction toward its centroid (the bare-fabric hinge strips become gaps). */
export const TILE_INSET_FRAC = 0.16;
/**
 * Adjustable gap range for the 3D Sim's "Gap" slider (printed tiles). The slider value is this same
 * shrink-toward-centroid fraction; `TILE_INSET_FRAC` is its default so the un-touched look is unchanged.
 * Clamped so tiles never vanish (too large) or fuse (too small) — both would break the kirigami gaps.
 */
export const MIN_TILE_GAP = 0.02;
export const MAX_TILE_GAP = 0.45;
/**
 * Detail "level" (the slider/menu value) → actual subdivision cap = level + DETAIL_OFFSET. So level 0
 * gives 1 subdivision deep, and the 0–4 slider spans caps 1–5. Shared by sim + export.
 */
export const DETAIL_OFFSET = 1;
/** Default detail LEVEL (the slider value). With the offset this is a cap of `DETAIL_OFFSET` (= 2). */
export const DEFAULT_MAX_SUBDIV = 0;
/** Below this peak fold angle (rad) the whole model reads as flat → no subdivision anywhere. */
export const MIN_FOLD = 0.05;

/** Barycentric weight over a parent triangle's three corners. */
export type Bary = [number, number, number];
/** A sub-triangle expressed in the parent triangle's barycentric coordinates. */
export type BaryTri = [Bary, Bary, Bary];

/**
 * Per-face subdivision depth from per-face fold scores, normalised to the model's sharpest fold so
 * resolution is relative ("more folding → more res"). `cap` ≤ 0, or an essentially-flat model, → all 0.
 */
export function foldDepths(scores: number[], cap: number): number[] {
  if (cap <= 0) return scores.map(() => 0);
  const peak = scores.reduce((m, s) => Math.max(m, s), 0);
  if (peak < MIN_FOLD) return scores.map(() => 0);
  return scores.map((s) => Math.min(cap, Math.max(0, Math.round((s / peak) * cap))));
}

const baryCache = new Map<number, BaryTri[]>();

/** The sub-triangles (in parent-barycentric coords) of a triangle 4-way midpoint-subdivided to `depth`. */
export function subdivBary(depth: number): BaryTri[] {
  const d = Math.max(0, Math.floor(depth));
  let r = baryCache.get(d);
  if (!r) {
    r = subdivide([[1, 0, 0], [0, 1, 0], [0, 0, 1]], d);
    baryCache.set(d, r);
  }
  return r;
}

function subdivide(tri: BaryTri, depth: number): BaryTri[] {
  if (depth <= 0) return [tri];
  const [a, b, c] = tri;
  const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
  return [
    ...subdivide([a, ab, ca], depth - 1),
    ...subdivide([ab, b, bc], depth - 1),
    ...subdivide([ca, bc, c], depth - 1),
    ...subdivide([ab, bc, ca], depth - 1),
  ];
}

const mid = (a: Bary, b: Bary): Bary => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
