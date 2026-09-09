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
 * Printed tile thickness as a fraction of the flat pattern's bounding-box diagonal.
 *
 * Shared by the 3D-printed render and by the sim's closure limit, because they are the same tile: a
 * printed model can only fold until two tiles of this thickness meet across the gap the shrink above
 * opens, and a limit derived from anything else stops the fold at an angle that matches nothing on
 * screen. (`stl-export.ts` has its own 0.02 default for the exported height; the two are close but
 * not tied, so an exported sheet is fractionally thicker than the one simulated.)
 */
export const TILE_THICK_FRAC = 0.018;
/**
 * Default detail LEVEL — and the level IS the subdivision cap, so the default is **no subdivision**:
 * one tile per face, gaps only along the joints the pattern itself has. That is the base layout the
 * sample designs are drawn and read against, and anything the slider does is measured from it. The
 * 0–4 slider therefore spans caps 0–4, splitting only the faces that fold hardest (`foldDepths`).
 */
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

/**
 * Ceiling on how many sub-tiles one printed model may be split into. A face's sub-tile count is
 * 4^depth, so a few thousand faces at the top detail level asks for millions of prisms — enough to
 * stall the viewport and blow the vertex buffer. `fitDepths` steps the cap down until the plan fits,
 * so the Detail slider degrades to a coarser split on a heavy mesh instead of hanging on it.
 */
export const MAX_PRINTED_TILES = 60000;

/** How many sub-tiles a depth plan produces. */
const planSize = (depths: number[]): number => depths.reduce((n, d) => n + 4 ** d, 0);

/** {@link foldDepths}, with the cap stepped down until the plan fits within `budget` sub-tiles. */
export function fitDepths(scores: number[], cap: number, budget = MAX_PRINTED_TILES): number[] {
  for (let c = Math.max(0, Math.floor(cap)); c > 0; c--) {
    const depths = foldDepths(scores, c);
    if (planSize(depths) <= budget) return depths;
  }
  return scores.map(() => 0);
}

/** One printed tile: where it sits on its parent face, and which of its own edges open a gap. */
export interface SubTile {
  /** Index of the parent face in the net. */
  face: number;
  /** The tile's three corners, in the parent face's barycentric coordinates. */
  bary: BaryTri;
  /** Per tile edge [AB, BC, CA]: true = a joint between two tiles, so its midpoint pinches inward. */
  pinch: [boolean, boolean, boolean];
}

/**
 * Which parent edge a sub-edge lies on (0 = AB, 1 = BC, 2 = CA), or −1 for one interior to the face.
 * Each edge is the locus where the weight of the corner opposite it vanishes, and midpoint
 * subdivision only ever halves those weights, so the zeros are exact.
 */
function parentEdgeOf(p: Bary, q: Bary): number {
  if (p[2] === 0 && q[2] === 0) return 0; // AB
  if (p[0] === 0 && q[0] === 0) return 1; // BC
  if (p[1] === 0 && q[1] === 0) return 2; // CA
  return -1;
}

/**
 * The printed tile layout at a given detail cap: each face split by how hard it folds, with the gap
 * flags each sub-tile needs.
 *
 * A sub-edge on the parent's boundary inherits that edge's flag — it is the same joint (or the same
 * merged flat facet) it always was. A sub-edge INTERIOR to the face is a new joint: the face has
 * been printed as several tiles, and they part along it. That is what the split buys — a face that
 * folds hard is paved with small tiles that can follow the curve, instead of one rigid plate.
 *
 * The per-face `depths` come back with the tiles because the closure limit needs them: a sub-tile of
 * a face split `d` times is that face scaled by 1/2^d, so the gap it opens at a hinge — and with it
 * how far the print can fold — shrinks by the same factor (`applyPrintedClosure`).
 */
export function planSubTiles(
  scores: number[],
  parentPinch: readonly (readonly boolean[])[],
  cap: number,
  budget = MAX_PRINTED_TILES,
): { depths: number[]; tiles: SubTile[] } {
  const depths = fitDepths(scores, cap, budget);
  const out: SubTile[] = [];
  for (let f = 0; f < depths.length; f++) {
    const parent = parentPinch[f] ?? [true, true, true];
    for (const bary of subdivBary(depths[f])) {
      const pinch = [0, 1, 2].map((k) => {
        const e = parentEdgeOf(bary[k], bary[(k + 1) % 3]);
        return e < 0 ? true : parent[e] === true;
      }) as [boolean, boolean, boolean];
      out.push({ face: f, bary, pinch });
    }
  }
  return { depths, tiles: out };
}
