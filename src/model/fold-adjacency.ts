/**
 * Which pairs of cut lips the folded artifact brings back together.
 *
 * A flat pattern is a *tree* of the solid's faces: the unfolder had to sever every edge that would
 * have closed a loop, and each severed edge leaves two lips lying somewhere else in the sheet. In the
 * flat pattern those lips can be 300 units apart; in the folded artifact they are the same edge,
 * touching. Nothing in `electronics.ts` expresses that relation — `isGapEdge` needs two incident
 * faces, so a cut's lips are simply boundary — which is why copper can only travel the long way round.
 * This module recovers the relation, with the ordered endpoint correspondence (`lipA[i]` welds to
 * `lipB[i]`) that a hop across the seam needs in order to land on the same 3D point on both sides.
 *
 * **Two sources, and the key wins.** The pipeline knows the pairing exactly — `unfold.ts` builds it
 * as `Sheet.lips` — so `emit.ts` writes it into the file under {@link LIP_PEER_KEY}, and reading it
 * back is both cheap and exact. But almost every file bundled today predates that key, so the
 * fallback matters more in practice: weld the declared folded form. Two distinct vertices the goal
 * frame places at the same point are a join the fabrication makes, which is the same statement
 * `sim/origami-import.ts buildSeams` makes for the solver, at the same `1e-3 × span` tolerance. The
 * key is preferred when it is present *and* well formed; a malformed key falls through to the weld
 * rather than failing, because a stale key is a worse answer than a measured one.
 *
 * Measured over the bundled examples (weld path): desk-lamp-shade 112 "C" edges → 56 pairs, of which
 * 27 have their lips more than 5 units apart in the flat pattern; house 9; church 6; puffin 49;
 * akde-hex 6, with no edge appearing in two pairs; kirigami-flap 0 (its cuts are slits, both lips on
 * one face); akde-square-pyramid carries no goal frame at all, so `"none"`. No group of one or three
 * edges was seen anywhere — a weld class that is not a clean pair is dropped rather than guessed at.
 */
import type { FoldFile } from "./fold-file.js";
import type { FlatFace, Vec2 } from "./electronics.js";
import { segPointDist } from "./trace-geometry.js";

/**
 * The FKLD key `src/pipeline/emit.ts` writes the lip pairing under. That file keeps its own copy of
 * this string: `model/` may not import `pipeline/` (R8), the same split `DRIVEN_KEY` already lives
 * with. Value: an array parallel to `edges_vertices`, each entry `null` or `[peerEdge, aligned]`,
 * where `aligned === 1` means `edges_vertices[e][0]` corresponds to `edges_vertices[peer][0]`.
 */
export const LIP_PEER_KEY = "fkld:edges_lipPeer";

/** One severed edge and the edge it rejoins, with the endpoint correspondence spelled out. */
export interface LipPairFlat {
  /** Edge indices into `edges_vertices`; each has exactly one incident face. */
  edgeA: number;
  edgeB: number;
  faceA: number;
  faceB: number;
  /** Flat endpoints in corresponding order: `lipA[i]` is welded to `lipB[i]` in the folded form. */
  lipA: [Vec2, Vec2];
  lipB: [Vec2, Vec2];
  /** Vertex ids, same order. */
  vA: [number, number];
  vB: [number, number];
}

/** The whole relation for one pattern, plus where it came from. */
export interface FoldAdjacency {
  pairs: LipPairFlat[];
  source: "key" | "goal-frame" | "none";
  /** Optional override of the jump toll in pattern diagonals, read by the corridor; unset means the module default. */
  tollDiags?: number;
}

/** No adjacency at all — a pattern with neither key nor goal frame. Frozen: it is shared. */
export const EMPTY_ADJACENCY: FoldAdjacency = Object.freeze({
  pairs: Object.freeze([]) as readonly LipPairFlat[] as LipPairFlat[],
  source: "none",
});

/** Relative weld tolerance, the value `sim/origami-import.ts` uses for the same question. */
const TOL_REL = 1e-3;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** Face index by unordered vertex pair, counted the way `electronics.ts sharedEdges` counts it. */
function faceIncidence(faces: FlatFace[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  faces.forEach((f, fi) => {
    const v = f.verts;
    for (let k = 0; k < v.length; k++) {
      const key = edgeKey(v[k]!, v[(k + 1) % v.length]!);
      const rec = out.get(key);
      if (rec) rec.push(fi);
      else out.set(key, [fi]);
    }
  });
  return out;
}

/** Flat (x,y) endpoints of an edge, or null when the file does not describe it. */
function flatEnds(coords: number[][], e: [number, number]): [Vec2, Vec2] | null {
  const a = coords[e[0]], b = coords[e[1]];
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  return [{ x: num(a[0]), y: num(a[1]) }, { x: num(b[0]), y: num(b[1]) }];
}

/** The single face this edge belongs to, or -1 unless there is exactly one and it exists. */
function loneFace(inc: Map<string, number[]>, faces: FlatFace[], e: [number, number]): number {
  const f = inc.get(edgeKey(e[0], e[1]));
  if (!f || f.length !== 1) return -1;
  const fi = f[0]!;
  return fi >= 0 && fi < faces.length ? fi : -1;
}

/** Pair order is part of the interface: `Jump.pair` and the `J<n>` labels key on it. */
function sorted(pairs: LipPairFlat[]): LipPairFlat[] {
  return pairs.sort((p, q) => {
    const pl = Math.min(p.edgeA, p.edgeB), ql = Math.min(q.edgeA, q.edgeB);
    return pl !== ql ? pl - ql : Math.max(p.edgeA, p.edgeB) - Math.max(q.edgeA, q.edgeB);
  });
}

/**
 * Assemble one pair from two edges and the correspondence `vB[i] ↔ vA[i]`, given as the index into
 * edge B's own vertex list that matches `vA[0]`.
 */
function makePair(
  coords: number[][],
  inc: Map<string, number[]>,
  faces: FlatFace[],
  ea: number,
  eb: number,
  ev: [number, number][],
  firstOfB: 0 | 1,
): LipPairFlat | null {
  const a = ev[ea]!, b = ev[eb]!;
  const faceA = loneFace(inc, faces, a), faceB = loneFace(inc, faces, b);
  if (faceA < 0 || faceB < 0 || faceA === faceB) return null;
  const endsA = flatEnds(coords, a), endsB = flatEnds(coords, b);
  if (!endsA || !endsB) return null;
  const vB: [number, number] = firstOfB === 0 ? [b[0], b[1]] : [b[1], b[0]];
  const lipB: [Vec2, Vec2] = firstOfB === 0 ? endsB : [endsB[1], endsB[0]];
  return { edgeA: ea, edgeB: eb, faceA, faceB, lipA: endsA, lipB, vA: [a[0], a[1]], vB };
}

/**
 * Read the pairing off {@link LIP_PEER_KEY}. Null — not an empty list — when the key is absent or
 * malformed, so the caller can fall back to the weld: a stale or truncated key must not be read as
 * "this pattern has no seams".
 */
export function lipPairsFromKey(fold: FoldFile, faces: FlatFace[]): LipPairFlat[] | null {
  const ev = fold.edges_vertices;
  const coords = fold.vertices_coords;
  const raw = (fold as Record<string, unknown>)[LIP_PEER_KEY];
  if (!Array.isArray(ev) || !Array.isArray(coords) || !Array.isArray(raw)) return null;
  if (raw.length !== ev.length) return null;

  const peer: (readonly [number, number] | null)[] = [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) { peer.push(null); continue; }
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [p, aligned] = entry as unknown[];
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p >= ev.length) return null;
    if (aligned !== 0 && aligned !== 1) return null;
    peer.push([p, aligned]);
  }

  const inc = faceIncidence(faces);
  const pairs: LipPairFlat[] = [];
  for (let e = 0; e < peer.length; e++) {
    const rec = peer[e]!;
    if (!rec) continue;
    const [p, aligned] = rec;
    if (p === e) return null;                      // an edge cannot rejoin itself
    const back = peer[p];
    if (!back || back[0] !== e || back[1] !== aligned) return null;   // must be symmetric
    if (loneFace(inc, faces, ev[e]!) < 0 || loneFace(inc, faces, ev[p]!) < 0) return null;
    if (p < e) continue;                           // each unordered pair once
    const pair = makePair(coords, inc, faces, e, p, ev, aligned === 1 ? 0 : 1);
    if (!pair) return null;
    pairs.push(pair);
  }
  return sorted(pairs);
}

/** The declared folded form, tested exactly as `sim/origami-import.ts applyDeclaredGoal` tests it. */
function goalFrame(fold: FoldFile): number[][] | null {
  const coords = fold.vertices_coords;
  if (!Array.isArray(coords)) return null;
  const frames = (fold as { file_frames?: Array<{ frame_classes?: string[]; vertices_coords?: number[][] }> })
    .file_frames;
  const folded = frames?.find(
    (fr) =>
      Array.isArray(fr.vertices_coords) &&
      fr.vertices_coords.length === coords.length &&
      (fr.frame_classes ?? []).includes("foldedForm"),
  );
  return folded?.vertices_coords ?? null;
}

/** Union-find over vertices the goal frame puts at the same point, via a grid hash at the tolerance. */
function weldClasses(goal: number[][], tolRel: number): number[] {
  const n = goal.length;
  const parent = Array.from({ length: n }, (_v, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r]! !== r) r = parent[r]!;
    while (parent[i]! !== i) { const nx = parent[i]!; parent[i] = r; i = nx; }
    return r;
  };
  const pt = (i: number): [number, number, number] => {
    const g = goal[i]!;
    return [num(g[0]), num(g[1]), num(g[2])];
  };

  let span = 0;
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = pt(i)[axis]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > span) span = hi - lo;
  }
  if (!(span > 0)) return parent.map((_p, i) => i);
  const tol = tolRel * span;

  const cell = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = pt(i);
    const k = key(x, y, z);
    const bucket = cell.get(k);
    if (bucket) bucket.push(i);
    else cell.set(k, [i]);
  }
  for (let i = 0; i < n; i++) {
    const [x, y, z] = pt(i);
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol), cz = Math.floor(z / tol);
    // a point may sit anywhere in its cell, so a neighbour within tol can be one cell over
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cell.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const [jx, jy, jz] = pt(j);
            if (Math.hypot(x - jx, y - jy, z - jz) > tol) continue;
            const a = find(i), b = find(j);
            if (a !== b) parent[a] = b;
          }
        }
  }
  return parent.map((_p, i) => find(i));
}

/**
 * Weld the declared folded form and read the lip pairs off it.
 *
 * Only `"C"` edges with exactly one incident face are candidates — a cut that still has material on
 * both sides was never severed, and a slit whose lips are both on one face (kirigami-flap) is not a
 * crossing a jump could shorten. Candidates are keyed by the sorted pair of weld classes of their
 * endpoints: two edges under one key are the two lips of one cut. A key holding one edge is a lip
 * whose peer stayed on the same face or fell outside tolerance; a key holding three or more is a
 * point where several lips converge (a cone apex) and no single pairing is right. Both are dropped.
 */
export function lipPairsFromGoalFrame(fold: FoldFile, faces: FlatFace[], tolRel = TOL_REL): LipPairFlat[] {
  const ev = fold.edges_vertices;
  const coords = fold.vertices_coords;
  const goal = goalFrame(fold);
  if (!Array.isArray(ev) || !Array.isArray(coords) || !goal) return [];
  const assign = fold.edges_assignment;
  if (!Array.isArray(assign)) return [];

  const cls = weldClasses(goal, tolRel);
  const inc = faceIncidence(faces);
  const groups = new Map<string, number[]>();
  for (let e = 0; e < ev.length; e++) {
    if (assign[e] !== "C") continue;
    const edge = ev[e]!;
    if (!Array.isArray(edge) || loneFace(inc, faces, edge) < 0) continue;
    const ca = cls[edge[0]], cb = cls[edge[1]];
    if (ca === undefined || cb === undefined) continue;
    const k = ca < cb ? `${ca}_${cb}` : `${cb}_${ca}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }

  const pairs: LipPairFlat[] = [];
  for (const g of groups.values()) {
    if (g.length !== 2) continue;
    const ea = Math.min(g[0]!, g[1]!), eb = Math.max(g[0]!, g[1]!);
    // Order B's endpoints so that class(vB[i]) === class(vA[i]): that correspondence is what makes
    // "the same u along both lips" the same point on the folded artifact.
    const a = ev[ea]!, b = ev[eb]!;
    const firstOfB: 0 | 1 = cls[a[0]] === cls[b[0]] ? 0 : 1;
    const pair = makePair(coords, inc, faces, ea, eb, ev, firstOfB);
    if (pair) pairs.push(pair);
  }
  return sorted(pairs);
}

/** The fold adjacency of a pattern: the key where it is trustworthy, else the weld, else nothing. */
export function foldAdjacency(fold: FoldFile, faces: FlatFace[]): FoldAdjacency {
  const keyed = lipPairsFromKey(fold, faces);
  if (keyed) return { pairs: keyed, source: "key" };
  if (goalFrame(fold)) return { pairs: lipPairsFromGoalFrame(fold, faces), source: "goal-frame" };
  return { pairs: [], source: "none" };
}

/**
 * The lip nearest `p` within `reach`, as a pair index, a side, and the parameter `u ∈ [0,1]` of the
 * projection along `lipX[0] → lipX[1]`. The u is what carries a point across: the same u on the peer
 * lip is the same point on the folded artifact.
 */
export function pairContaining(
  adj: FoldAdjacency,
  p: Vec2,
  reach: number,
): { pair: number; side: "A" | "B"; u: number } | null {
  let best: { pair: number; side: "A" | "B"; u: number } | null = null;
  let bestD = reach;
  adj.pairs.forEach((pair, i) => {
    for (const side of ["A", "B"] as const) {
      const lip = side === "A" ? pair.lipA : pair.lipB;
      const d = segPointDist(lip[0], lip[1], p);
      if (d > bestD) continue;
      const dx = lip[1].x - lip[0].x, dy = lip[1].y - lip[0].y;
      const l2 = dx * dx + dy * dy;
      const u = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - lip[0].x) * dx + (p.y - lip[0].y) * dy) / l2));
      bestD = d;
      best = { pair: i, side, u };
    }
  });
  return best;
}
