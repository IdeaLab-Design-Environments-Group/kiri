/**
 * Seamed unfolding (M3): cut Q along the planned forest and flatten each
 * developable patch isometrically; add relief cuts until the layout embeds.
 *
 * Pattern: functional core + bounded iterative-refinement loop (the relief
 * loop), with the overlap predicate exported pure for isolated testing.
 *
 * Layout formula (BFS over the face dual; all lengths are 3D rest lengths,
 * so the layout is isometric by construction): placing the third vertex c of
 * a face across placed edge (a,b),
 *     x = (l_ac² + l_ab² − l_bc²) / (2·l_ab)
 *     y = √(max(0, l_ac² − x²))
 *     p_c = p_a + x·û ± y·n̂,   û = (p_b−p_a)/l_ab, n̂ = û rotated 90°,
 * sign chosen so c lands on the side opposite the already-placed face
 * (unfolding flattens the dihedral to zero).
 *
 * Topology: cutting splits each vertex into one copy per fan wedge
 * (separators = cut edges; slit ENDPOINTS keep a single wedge — they don't
 * split, which is why δ<0 vertices need the M2 wedge rule). Provenance is
 * recorded in `origVertex` (cut/flat vertex → Q vertex) and cut edges in
 * `lips` (the two boundary copies that must rejoin when folded).
 */

import { distance } from "../core/vec3.js";
import { edgeKey, edgeLength, faceAngles, vertexWedges } from "./mesh.js";
import { countFlatOverlaps, cross2, findSelfOverlap, unfoldPatch } from "./flat-layout.js";
import { shortestPaths } from "./plan-cuts.js";
import { cutKeepsOnePiece, labelComponents } from "./sheet-components.js";
import { boundaryNeighbours, clearLength, extendLip, followLip, insideRing, slitDepths } from "./slit-lips.js";
import {
  PipelineError,
  type CutPlan,
  type DefectReport,
  type LipPair,
  type MeshTopology,
  type TriMesh,
  type UnfoldResult,
  type Vec2,
  type VentRecord,
} from "./types.js";

export { findSelfOverlap, trianglesOverlap, unfoldPatch } from "./flat-layout.js";

/** Hard cap on relief-loop iterations (each adds ≥1 cut edge, so ≤E anyway). */
export const RELIEF_MAX = 64;

/** Wall-clock cap on one seamedUnfold relief loop (ms). Meshes that reach it (many-vent saddles)
 *  otherwise run for minutes on the main thread; ordinary meshes finish in well under a second. */
export const RELIEF_SEARCH_BUDGET_MS = 20000;

/** Thrown when the budget runs out. A subclass so the "this candidate failed, try the next" catches in the
 *  relief search can tell it apart from an ordinary unfold failure and let it through. */
export class ReliefBudgetError extends PipelineError {
  constructor() {
    super("unfold", `relief search ran past ${RELIEF_SEARCH_BUDGET_MS / 1000}s on this surface — try a simpler mesh or fewer vents`);
  }
}

/** Deadline of the seamedUnfold call in progress (Infinity outside one). Module state so the budget also
 *  reaches inside a single cutAlongEdges, which is where one candidate can spend minutes. */
let reliefDeadline = Number.POSITIVE_INFINITY;
const checkReliefBudget = (): void => {
  if (Date.now() > reliefDeadline) throw new ReliefBudgetError();
};

/**
 * Cap on post-relief pruning passes. Each pass re-tries every still-present
 * relief edge; removing one can make another removable, so we iterate to a
 * fixed point, bounded here so a pathological mesh stays linear-ish.
 */
const PRUNE_MAX_PASSES = 4;

/**
 * Hard cap on pruning TRIALS (each = a full re-cut + re-unfold + overlap test).
 * Bounds worst-case cost regardless of mesh: on tangled patches the relief set
 * is large AND each unfold is expensive, so without this the pruning pass can
 * dominate runtime. Measured headroom is small (relief edges are usually
 * load-bearing), so an early cap costs little — see `pruneRelief` (off by
 * default in DEFAULT_KIRIGAMIZE for exactly this reason).
 */
const PRUNE_MAX_TRIALS = 256;

/**
 * Work cap on one SWAP descent step, in vented-cut units: each trial cut costs
 * one unit plus one per vent it re-places (a vented cut re-walks every vent, so
 * that is where the time goes). When it runs out the step takes the best move
 * found so far, or fails fast if none improved. Every bundled example and test
 * surface settles well inside it; the torus, the heaviest, finds its best move
 * at ~17k units of a ~87k full scan (#15).
 */
export const SWAP_WORK_BUDGET = 30000;

/** Vent-walk angle snap (rad): residues below this never force a sliver split. */
const SNAP_ANG = 1e-7;

/** Vent-carve length snap (mm): crossings closer than this to an endpoint reuse it. */
const SNAP_LEN = 1e-6;

export interface CutMesh {
  mesh: TriMesh;
  /** cut vertex → source (Q) vertex; −1 for synthesized vent vertices. */
  origVertex: number[];
  /** Folded-target position per cut vertex (mm, on Q). */
  goalPos: TriMesh["vertices"];
  lips: LipPair[];
  vents: VentRecord[];
}

/** Angular tolerance for vent consumption arithmetic (rad). */
const ANG_EPS = 1e-9;

/**
 * Split the mesh along `cutEdges`: one vertex copy per fan wedge. Boundary
 * source edges in the cut set are ignored (already boundary). Returns a fresh
 * mesh — re-derive topology, never mutate.
 *
 * `ventAngles` (K1, proper-kirigami): map of δ<0 source vertices → |δ|. At
 * each, a sliver of Q-coverage of total angle |δ| is removed from the LARGER
 * fan wedge, starting at its leading lip — consuming whole faces while they
 * fit and splitting the face where the remainder lands (the neighbor across
 * the split edge is split too, keeping the mesh conforming). Afterward the
 * flat material around the vertex totals exactly 2π, so the slit lips are
 * coincident (zero-width) in the layout and the removed sliver is the vent
 * hole that opens when folded.
 */
export function cutAlongEdges(
  mesh: TriMesh,
  topo: MeshTopology,
  cutEdges: number[],
  ventAngles: Map<number, number> = new Map(),
): CutMesh {
  const cutSet = new Set(cutEdges.filter((e) => topo.edges[e].faces.length === 2));
  const isCut = (e: number): boolean => cutSet.has(e);

  const vertices: TriMesh["vertices"] = [];
  const origVertex: number[] = [];
  /** cornerCopy[3f + i] → cut-mesh vertex id for corner i of source face f. */
  const cornerCopy = new Int32Array(3 * mesh.faces.length);
  const copyAt = (f: number, v: number): number => cornerCopy[3 * f + mesh.faces[f].indexOf(v)];
  /** Fan-ordered wedges per source vertex (kept for vent application). */
  const wedgesOf = new Map<number, { copy: number; faces: number[]; angle: number }[]>();

  for (let v = 0; v < mesh.vertices.length; v++) {
    const wedges = vertexWedges(mesh, topo, v, isCut);
    const recorded: { copy: number; faces: number[]; angle: number }[] = [];
    for (const wedge of wedges) {
      const id = vertices.length;
      vertices.push({ ...mesh.vertices[v] });
      origVertex.push(v);
      for (const f of wedge.faces) cornerCopy[3 * f + mesh.faces[f].indexOf(v)] = id;
      recorded.push({ copy: id, faces: wedge.faces, angle: wedge.angle });
    }
    if (ventAngles.has(v)) wedgesOf.set(v, recorded);
  }

  const goalPos = vertices.map((p) => ({ ...p }));

  // Faces by SOURCE face id; vent application may null (remove) or split them.
  const faces: ([number, number, number] | null)[] = mesh.faces.map(
    (_, f) => [cornerCopy[3 * f], cornerCopy[3 * f + 1], cornerCopy[3 * f + 2]],
  );
  const lips: LipPair[] = [];
  for (const e of cutSet) {
    const { a, b, faces: ef } = topo.edges[e];
    const [f1, f2] = ef;
    lips.push({
      sourceEdge: e,
      lipA: [copyAt(f1, a), copyAt(f1, b)],
      lipB: [copyAt(f2, a), copyAt(f2, b)],
    });
  }

  // --- Vents (K1): remove a sliver of total angle |δ| at each δ<0 slit -----
  // vertex, working on LIVE geometry (earlier vents may have consumed or
  // split faces another vent's fan touches — source-mesh angles go stale).
  // The removal target is DYNAMIC: whatever live angle exceeds 2π at the
  // vertex right now. Candidates (each wedge copy × walk direction) are
  // tried with rollback until one fits AND keeps the sheet connected.
  const vents: VentRecord[] = [];
  /** Corner angle of live triangle `tri` at its vertex vc. */
  const cornerAt = (tri: [number, number, number], vc: number): number => {
    const [i, j, k] = tri;
    const others = (i === vc ? [j, k] : j === vc ? [k, i] : [i, j]) as [number, number];
    const [p, a, b] = [vertices[vc], vertices[others[0]], vertices[others[1]]];
    const u = { x: a.x - p.x, y: a.y - p.y, z: a.z - p.z };
    const w = { x: b.x - p.x, y: b.y - p.y, z: b.z - p.z };
    const cr = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x };
    return Math.atan2(Math.hypot(cr.x, cr.y, cr.z), u.x * w.x + u.y * w.y + u.z * w.z);
  };
  const liveAngleAt = (vc: number): number => {
    let sum = 0;
    for (const tri of faces) if (tri !== null && tri.includes(vc)) sum += cornerAt(tri, vc);
    return sum;
  };
  /** liveAngleAt for many copies in one pass over the faces (same terms, same order). */
  const liveAnglesAt = (copies: number[]): Map<number, number> => {
    const sums = new Map(copies.map((c) => [c, 0]));
    for (const tri of faces) {
      if (tri === null) continue;
      for (let s = 0; s < 3; s++) {
        const sum = sums.get(tri[s]);
        if (sum !== undefined && tri.indexOf(tri[s]) === s) sums.set(tri[s], sum + cornerAt(tri, tri[s]));
      }
    }
    return sums;
  };
  /** Ordered live fan chain of work-face indices around copy vc (open chain). */
  const liveChain = (vc: number): number[] => {
    const incident: number[] = [];
    for (let f = 0; f < faces.length; f++) if (faces[f] !== null && faces[f]!.includes(vc)) incident.push(f);
    if (incident.length === 0) return [];
    // adjacency through shared (vc, x) edges
    const byNeighbor = new Map<number, number[]>(); // x → faces
    for (const f of incident) {
      for (const x of faces[f]!) {
        if (x === vc) continue;
        const list = byNeighbor.get(x) ?? [];
        list.push(f);
        byNeighbor.set(x, list);
      }
    }
    // chain ends: faces with an un-shared neighbor edge
    const isEnd = (f: number): boolean =>
      faces[f]!.filter((x) => x !== vc).some((x) => (byNeighbor.get(x) ?? []).length === 1);
    const start = incident.find(isEnd) ?? incident[0];
    const chain = [start];
    const seen = new Set([start]);
    for (;;) {
      const cur = chain[chain.length - 1];
      const next = faces[cur]!
        .filter((x) => x !== vc)
        .flatMap((x) => byNeighbor.get(x) ?? [])
        .find((f) => !seen.has(f));
      if (next === undefined) break;
      chain.push(next);
      seen.add(next);
    }
    return chain;
  };
  /** Live corner angle of work face f at copy vc. */
  const liveCorner = (f: number, vc: number): number => {
    const tri = faces[f]!;
    const others = tri.filter((x) => x !== vc) as [number, number];
    const u = {
      x: vertices[others[0]].x - vertices[vc].x,
      y: vertices[others[0]].y - vertices[vc].y,
      z: vertices[others[0]].z - vertices[vc].z,
    };
    const w = {
      x: vertices[others[1]].x - vertices[vc].x,
      y: vertices[others[1]].y - vertices[vc].y,
      z: vertices[others[1]].z - vertices[vc].z,
    };
    const cr = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x };
    return Math.atan2(Math.hypot(cr.x, cr.y, cr.z), u.x * w.x + u.y * w.y + u.z * w.z);
  };
  /** Component count over current live faces (0 when no live faces). */
  const liveComponents = (): number => {
    const live = faces.filter((f): f is [number, number, number] => f !== null);
    if (live.length === 0) return 0;
    return labelComponents({ vertices, faces: live }).count;
  };

  // Deepest slit first: a vent carves along its slit toward the boundary and
  // absorbs the saddles it passes, so those must not hold a vent yet.
  const slitDepth = slitDepths(topo, isCut);
  const depthOf = (v: number): number => slitDepth.get(v) ?? 0;
  const ventVerts = [...ventAngles.keys()].sort((a, b) => depthOf(b) - depthOf(a) || a - b);
  const initialLiveFaces = faces.length;

  // Vents may not make connectivity WORSE than the bare cut already is. A
  // disconnecting cut set is the CALLER's problem (seamedUnfold hard-gates
  // it; relief trials reject it) — blaming the vent here used to surface as
  // a bogus vent-placement failure on connectivity-unsafe relief trials.
  const baseComponents = liveComponents();

  // Development of the live sheet, used to RANK vent candidates: removing a
  // sliver never moves surviving material (the split pieces tile flat
  // sub-triangles of their source face), so this one layout stays valid
  // through every excision and across vents. The best candidate is the one
  // whose remaining material self-overlaps least — i.e. the vent is excised
  // exactly where the isometric immersion doubles over.
  let flatLive: Vec2[] | null = null;
  if (ventVerts.length > 0 && baseComponents === 1) {
    try {
      const live = faces.filter((f): f is [number, number, number] => f !== null);
      flatLive = unfoldPatch(
        { mesh: { vertices, faces: live } } as CutMesh,
        live.map((_, i) => i),
      );
    } catch {
      flatLive = null; // not developable yet — fall back to first-fit placement
    }
  }

  /** Synthesize the split vertex at parameter r along live segment (u, w). */
  const lerpVertex = (u: number, w: number, r: number): number => {
    const id = vertices.length;
    const vu = vertices[u];
    const vw = vertices[w];
    vertices.push({ x: vu.x + r * (vw.x - vu.x), y: vu.y + r * (vw.y - vu.y), z: vu.z + r * (vw.z - vu.z) });
    const gu = goalPos[u];
    const gw = goalPos[w];
    goalPos.push({ x: gu.x + r * (gw.x - gu.x), y: gu.y + r * (gw.y - gu.y), z: gu.z + r * (gw.z - gu.z) });
    origVertex.push(-1);
    if (flatLive !== null) {
      const fu = flatLive[u];
      const fw = flatLive[w];
      flatLive.push({ x: fu.x + r * (fw.x - fu.x), y: fu.y + r * (fw.y - fu.y) });
    }
    return id;
  };

  // Slit lips of the bare cut sheet; far points must clear the whole development.
  const lipNbrs = boundaryNeighbours(faces);
  const cutDegree = (v: number): number => topo.vertexEdges[v].filter(isCut).length;
  const farLen = flatLive === null ? 0 : clearLength(flatLive);
  /**
   * Both lips of a LEAF slit at copy vc as flat polylines (apex first), followed
   * through cut-degree-2 vertices to the sheet boundary or a branch. A straight
   * cone misses the double cover where the slit bends or crosses another saddle
   * (whose own excess turns lip B further). Null when both lips are straight
   * (the plain cone is exact), vc is not a clean leaf, or earlier vents moved lip B off the walk's ray.
   */
  const slitLips = (vc: number, wA: number, coneEnd: number): [Vec2[], Vec2[]] | null => {
    const flat = flatLive!;
    const nb = lipNbrs.get(vc) ?? [];
    const wB = nb.find((x) => x !== wA);
    if (nb.length !== 2 || !nb.includes(wA) || wB === undefined || cutDegree(origVertex[vc]) !== 1) return null;
    if (origVertex[wA] !== origVertex[wB]) return null;
    const ap = flat[vc];
    const [ux, uy, bx, by] = [flat[coneEnd].x - ap.x, flat[coneEnd].y - ap.y, flat[wB].x - ap.x, flat[wB].y - ap.y];
    if (Math.abs(cross2(ux, uy, bx, by)) > 1e-6 * Math.hypot(ux, uy) * Math.hypot(bx, by) || ux * bx + uy * by <= 0) return null;
    const passes = (c: number): boolean => origVertex[c] >= 0 && !topo.boundaryVertices.has(origVertex[c]) && cutDegree(origVertex[c]) === 2;
    const [lipA, lipB] = [followLip(flat, lipNbrs, vc, wA, passes), followLip(flat, lipNbrs, vc, wB, passes)];
    return lipA.length === 2 && lipB.length === 2 ? null : [lipA, lipB];
  };
  /** Make flat point q a vertex of every live face it falls in (lip B's bends lie inside side-A faces). */
  const insertAt = (q: Vec2): void => {
    const flat = flatLive!;
    for (let gi = 0; gi < faces.length; gi++) {
      const tri = faces[gi];
      if (tri === null || tri.some((i) => Math.hypot(flat[i].x - q.x, flat[i].y - q.y) < SNAP_LEN)) continue;
      const [a, b, c] = tri.map((i) => flat[i]);
      const area = cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
      if (Math.abs(area) < 1e-12) continue;
      const l0 = cross2(b.x - q.x, b.y - q.y, c.x - q.x, c.y - q.y) / area;
      const l1 = cross2(c.x - q.x, c.y - q.y, a.x - q.x, a.y - q.y) / area;
      const ls = [l0, l1, 1 - l0 - l1];
      if (ls.some((l) => l < -1e-9)) continue;
      const zero = ls.findIndex((l) => l < 1e-9);
      if (zero !== -1) {
        const [opp, u, w] = [tri[zero], tri[(zero + 1) % 3], tri[(zero + 2) % 3]];
        const m = lerpVertex(u, w, ls[(zero + 2) % 3]);
        faces[gi] = [opp, u, m];
        faces.push([opp, m, w]);
        splitFarAt(u, w, m, gi);
        continue;
      }
      const m = vertices.length;
      const mix = (P: { x: number; y: number; z: number }[]) => ({
        x: ls[0] * P[tri[0]].x + ls[1] * P[tri[1]].x + ls[2] * P[tri[2]].x,
        y: ls[0] * P[tri[0]].y + ls[1] * P[tri[1]].y + ls[2] * P[tri[2]].y,
        z: ls[0] * P[tri[0]].z + ls[1] * P[tri[1]].z + ls[2] * P[tri[2]].z,
      });
      vertices.push(mix(vertices));
      goalPos.push(mix(goalPos));
      origVertex.push(-1);
      flat.push({ x: q.x, y: q.y });
      faces[gi] = [tri[0], tri[1], m];
      faces.push([tri[1], tri[2], m], [tri[2], tri[0], m]);
    }
  };

  /** Conformity: split the live face across (u1, u2), other than `exclude`, at mid. */
  const splitFarAt = (u1: number, u2: number, mid: number, exclude: number): void => {
    const far = faces.findIndex((g, gi) => gi !== exclude && g !== null && g.includes(u1) && g.includes(u2));
    if (far === -1) return;
    const ntri = faces[far]!;
    if (ntri.includes(mid)) return; // idempotent — same chord already inserted
    const third = ntri.find((x) => x !== u1 && x !== u2)!;
    const ia = ntri.indexOf(u1);
    if (ntri[(ia + 1) % 3] === u2) {
      faces[far] = [u1, mid, third];
      faces.push([mid, u2, third]);
    } else {
      faces[far] = [u2, mid, third];
      faces.push([mid, u1, third]);
    }
  };

  /**
   * Carve the rest of the vent cone radially outward (K1 depth): the one-ring
   * walk only excises the sector's first ring, but the wrap it compensates
   * displaces material at ALL radii, so the double-cover extends outward
   * between the two lips. Working in the live development (exact, since
   * every split is an affine sub-division of a flat face), remove every face
   * piece between lip polylines `lipA` and `lipB` (both start at the apex; a
   * two-point lip is a ray), splitting crossed faces conformingly. Stops at
   * the sheet boundary. Connectivity damage is
   * caught by the caller's component check. Returns false when the walk
   * exhausts its guard with edges still queued (the carve did not finish).
   */
  const carveCone = (
    lipA: Vec2[],
    lipB: Vec2[],
    frontier: [number, number][],
    ventEdges: [number, number][],
  ): boolean => {
    if (flatLive === null) return true;
    const flat = flatLive;
    const apex = lipA[0];
    const d1 = { x: lipA[1].x - apex.x, y: lipA[1].y - apex.y };
    const d2 = { x: lipB[1].x - apex.x, y: lipB[1].y - apex.y };
    const orient = Math.sign(cross2(d1.x, d1.y, d2.x, d2.y)) || 1;
    const sideOf = (ray: Vec2, p: Vec2): number => {
      const c = cross2(ray.x, ray.y, p.x - apex.x, p.y - apex.y) * orient;
      const eps = 1e-9 * (Math.hypot(ray.x, ray.y) * Math.hypot(p.x - apex.x, p.y - apex.y) + 1e-12);
      return c > eps ? 1 : c < -eps ? -1 : 0;
    };
    // Region boundary: each lip polyline from the apex; its last segment runs on as a ray.
    const segs: { o: Vec2; d: Vec2; ray: boolean }[] = [];
    for (const lip of [lipA, lipB]) {
      for (let i = 0; i + 1 < lip.length; i++) {
        segs.push({ o: lip[i], d: { x: lip[i + 1].x - lip[i].x, y: lip[i + 1].y - lip[i].y }, ray: i + 2 === lip.length });
      }
    }
    const isCone = segs.length === 2;
    const ring = isCone ? [] : [...lipA, extendLip(lipA, farLen), extendLip(lipB, farLen), ...[...lipB].reverse().slice(0, -1)];
    /** Inside the vent region, boundary included (two-ray cone: the original side test). */
    const inside = (p: Vec2): boolean => (isCone ? sideOf(d1, p) >= 0 && sideOf(d2, p) <= 0 : insideRing(ring, p));
    /** Crossing of boundary segment `sg` with live segment (u, t): param r on u→t, or null. */
    const crossingOn = (sg: { o: Vec2; d: Vec2; ray: boolean }, u: number, t: number): number | null => {
      const ray = sg.d;
      const pu = flat[u];
      const pt = flat[t];
      const ex = pt.x - pu.x;
      const ey = pt.y - pu.y;
      const det = cross2(ex, ey, -ray.x, -ray.y); // [e  -d] r,s solve
      if (Math.abs(det) < 1e-15) return null;
      const wx = sg.o.x - pu.x;
      const wy = sg.o.y - pu.y;
      const r = cross2(wx, wy, -ray.x, -ray.y) / det;
      const s = cross2(ex, ey, wx, wy) / det;
      // Length-aware window: crossings within SNAP_LEN of u reuse u via the
      // single-crossing branches; near t the leftover ≤SNAP_LEN in-cone sliver
      // stays (below the shrink-SAT registration — see "degenerate slivers").
      const tEps = Math.min(0.5, SNAP_LEN / Math.hypot(ex, ey));
      if (r < tEps || r > 1 - tEps || s <= 0 || (!sg.ray && s > 1)) return null;
      return r;
    };

    const lerpOnEdge = (() => {
      // Dedup splits closer than SNAP_LEN along the same segment — every
      // coordinate set (3D/goal/flat) lerps with the same r, so 3D rest
      // length is the right yardstick for all of them.
      const cache = new Map<string, { r: number; id: number }[]>();
      return (u: number, w: number, r: number): number => {
        const key = edgeKey(u, w);
        const rc = u < w ? r : 1 - r; // canonical orientation (matches key)
        const segLen = distance(vertices[u], vertices[w]);
        const splits = cache.get(key) ?? [];
        const hit = splits.find((s) => Math.abs(s.r - rc) * segLen < SNAP_LEN);
        if (hit !== undefined) return hit.id;
        const id = lerpVertex(u, w, r);
        splits.push({ r: rc, id });
        cache.set(key, splits);
        return id;
      };
    })();

    const queue = [...frontier];
    const done = new Set<string>();
    const pending = new Set<string>();
    for (const [a, b] of frontier) pending.add(edgeKey(a, b));
    const pushEdge = (a: number, b: number): void => {
      const key = edgeKey(a, b);
      if (done.has(key) || pending.has(key)) return;
      pending.add(key);
      queue.push([a, b]);
    };

    const guardMax = Math.max(64, mesh.faces.length * 8);
    let guard = 0;
    while (queue.length > 0 && guard++ < guardMax) {
      checkReliefBudget();
      const [x, y] = queue.pop()!;
      const key = edgeKey(x, y);
      pending.delete(key);
      if (done.has(key)) continue;
      done.add(key);

      let carved = false;
      for (let gi = 0; gi < faces.length; gi++) {
        const tri = faces[gi];
        if (tri === null || !tri.includes(x) || !tri.includes(y)) continue;
        const t = tri.find((vv) => vv !== x && vv !== y)!;
        if (inside(flat[t])) {
          // Third corner on/inside the cone: excise every live piece on (x, y).
          faces[gi] = null;
          pushEdge(x, t);
          pushEdge(t, y);
          carved = true;
          continue;
        }
        // A zero-area (collinear) live face holds no material to chord: its ray
        // crossing lands back on a vertex, so chording would re-create the same
        // sliver (+1 vertex) and ping-pong forever with its far neighbour.
        const ex = flat[y].x - flat[x].x;
        const ey = flat[y].y - flat[x].y;
        const fx = flat[t].x - flat[x].x;
        const fy = flat[t].y - flat[x].y;
        if (Math.abs(cross2(ex, ey, fx, fy)) <= 1e-9 * Math.hypot(ex, ey) * Math.hypot(fx, fy)) continue;
        // Exactly one ray separates t from the cone; chord it off.
        let rx: number | null = null;
        let ry: number | null = null;
        if (isCone) {
          const sg = segs[sideOf(d1, flat[t]) < 0 ? 0 : 1];
          rx = crossingOn(sg, x, t);
          ry = crossingOn(sg, y, t);
        } else {
          for (const sg of segs) {
            const [cx, cy] = [crossingOn(sg, x, t), crossingOn(sg, y, t)];
            if (cx === null && cy === null) continue;
            if ((rx === null && ry === null) || (cx !== null && cy !== null)) [rx, ry] = [cx, cy];
            if (cx !== null && cy !== null) break;
          }
        }
        if (rx !== null && ry !== null) {
          // Chord crosses both far edges: keep the t-corner piece only.
          const wa = lerpOnEdge(x, t, rx);
          const wb = lerpOnEdge(y, t, ry);
          faces[gi] = tri.map((vv) => (vv === x ? wa : vv === y ? wb : vv)) as [number, number, number];
          ventEdges.push([wa, wb]);
          splitFarAt(x, t, wa, gi);
          splitFarAt(y, t, wb, gi);
          pushEdge(x, wa);
          pushEdge(y, wb);
          carved = true;
        } else if (ry !== null) {
          // x sits on the chord ray: keep (x, w, t), drop (x, y, w).
          const w = lerpOnEdge(y, t, ry);
          faces[gi] = tri.map((vv) => (vv === y ? w : vv)) as [number, number, number];
          ventEdges.push([x, w]);
          splitFarAt(y, t, w, gi);
          pushEdge(y, w);
          carved = true;
        } else if (rx !== null) {
          // y sits on the chord ray: keep (w, y, t), drop (x, y, w).
          const w = lerpOnEdge(x, t, rx);
          faces[gi] = tri.map((vv) => (vv === x ? w : vv)) as [number, number, number];
          ventEdges.push([y, w]);
          splitFarAt(x, t, w, gi);
          pushEdge(x, w);
          carved = true;
        }
        // Degenerate slivers (no usable crossing) are left in place — they are
        // thinner than the SAT shrink tolerance and harmless.
      }
      if (!carved) continue; // sheet boundary (or already carved)
    }
    return queue.length === 0;
  };

  for (const v of ventVerts) {
    if (!topo.vertexEdges[v].some((e) => cutSet.has(e))) {
      throw new PipelineError("unfold", `vent vertex ${v} has no incident slit (cut-degree 0)`, { vertex: v });
    }
    const copies = (wedgesOf.get(v) ?? []).map((w) => w.copy);
    // Dynamic target: live excess over the flat sheet's 2π (earlier vents
    // may already have consumed part of this vertex's material).
    const TAU = 2 * Math.PI;
    const excess = copies.reduce((acc, c) => acc + liveAngleAt(c), 0) - TAU;
    if (excess <= 1e-7) continue; // already flat-compatible

    // Candidates: every copy's live chain, walked from either end, ordered
    // by descending live wedge angle (most room first). `flip` disambiguates
    // the entry side for single-face chains (whose reverse is identical).
    const candidates: { vc: number; chain: number[]; flip: boolean }[] = [];
    for (const vc of copies.sort((a, b) => liveAngleAt(b) - liveAngleAt(a))) {
      const chain = liveChain(vc);
      if (chain.length === 0) continue;
      candidates.push({ vc, chain, flip: false });
      candidates.push({ vc, chain: [...chain].reverse(), flip: true });
    }

    /** Walk one candidate, mutating live state; `walked` = it absorbed the excess and finished its carve. */
    const walkCandidate = (
      vc: number,
      chain: number[],
      flip: boolean,
      deep = true,
    ): { walked: boolean; ventEdges: [number, number][] } => {
      const ventEdges: [number, number][] = [];
      let remaining = excess;
      let ok = true;
      let firstLead = -1; // cone boundary ray 1 passes through this vertex
      let coneEnd = -1; // cone boundary ray 2 passes through this vertex (m or last trail)
      const frontier: [number, number][] = []; // far edges of the excised sector

      for (let i = 0; i < chain.length && remaining > ANG_EPS; i++) {
        const f = chain[i];
        if (faces[f] === null) {
          ok = false;
          break;
        }
        const tri = faces[f]!;
        const others = tri.filter((x) => x !== vc) as [number, number];
        // Walk entry side: shared with the previous chain face; for i=0 the
        // chain-end (boundary) neighbor.
        let lead: number;
        if (i > 0 && faces[chain[i - 1]] !== null) {
          lead = others.find((x) => faces[chain[i - 1]]!.includes(x)) ?? others[0];
        } else if (chain.length > 1 && faces[chain[1]] !== null) {
          lead = others.find((x) => !faces[chain[1]]!.includes(x)) ?? others[0];
        } else {
          lead = flip ? Math.max(...others) : Math.min(...others);
        }
        const trail = others.find((x) => x !== lead)!;
        const alpha = liveCorner(f, vc);
        if (firstLead === -1) firstLead = lead;

        // Find the live far neighbor across (lead, trail) before mutating.
        const farNeighbor = faces.findIndex(
          (g, gi) => gi !== f && g !== null && g.includes(lead) && g.includes(trail),
        );

        // Consume whole faces with a SNAP_ANG slack (over-removal ≤ 1e-7 rad,
        // well inside the 2π invariant tolerance) and zero near-zero residues
        // so a stray FP crumb never forces a sliver split on the next face.
        if (remaining >= alpha - SNAP_ANG) {
          faces[f] = null;
          remaining -= alpha;
          if (remaining < SNAP_ANG) remaining = 0;
          coneEnd = trail;
          frontier.push([lead, trail]);
          if (farNeighbor !== -1) ventEdges.push([lead, trail]);
          continue;
        }

        // Split: m on live segment (lead, trail) at angle `remaining` from
        // (vc, lead). Sine rule in the live triangle.
        const beta = liveCorner(f, lead);
        const lvl = distance(vertices[vc], vertices[lead]);
        const llt = distance(vertices[lead], vertices[trail]);
        const am = (lvl * Math.sin(remaining)) / Math.sin(beta + remaining);
        const t = am / llt;
        // SNAP_ANG bounds remaining away from 0 and alpha here, so t cannot
        // be degenerate; if it is, fail loudly rather than synthesize a
        // near-zero-length edge that poisons the isometry audit downstream.
        if (!(t > 0 && t < 1)) {
          throw new PipelineError("unfold", `vent split parameter ${t} out of (0,1) at vertex ${vc}`, { vertex: vc });
        }
        const pl = vertices[lead];
        const pt = vertices[trail];
        const m3 = { x: pl.x + t * (pt.x - pl.x), y: pl.y + t * (pt.y - pl.y), z: pl.z + t * (pt.z - pl.z) };
        const gl = goalPos[lead];
        const gt = goalPos[trail];
        const mg = { x: gl.x + t * (gt.x - gl.x), y: gl.y + t * (gt.y - gl.y), z: gl.z + t * (gt.z - gl.z) };
        const m = vertices.length;
        vertices.push(m3);
        goalPos.push(mg);
        origVertex.push(-1);
        if (flatLive !== null) {
          const fl = flatLive[lead];
          const ft = flatLive[trail];
          flatLive.push({ x: fl.x + t * (ft.x - fl.x), y: fl.y + t * (ft.y - fl.y) });
        }

        faces[f] = tri.map((x) => (x === lead ? m : x)) as [number, number, number];
        ventEdges.push([vc, m]);

        if (farNeighbor !== -1) {
          const ntri = faces[farNeighbor]!;
          const third = ntri.find((x) => x !== lead && x !== trail)!;
          const ia = ntri.indexOf(lead);
          const traversesLeadToTrail = ntri[(ia + 1) % 3] === trail;
          if (traversesLeadToTrail) {
            faces[farNeighbor] = [lead, m, third];
            faces.push([m, trail, third]);
          } else {
            faces[farNeighbor] = [trail, m, third];
            faces.push([m, lead, third]);
          }
          ventEdges.push([lead, m]);
        }
        coneEnd = m;
        frontier.push([lead, m]);
        remaining = 0;
      }

      // Continue the excised sector radially outward (the wrap it compensates
      // displaces material at all radii, not just the one-ring). An unfinished
      // carve rejects the candidate: its guard-capped sliver fan would seed
      // the next vent with ~8× the faces.
      let carveDone = true;
      if (deep && ok && remaining <= 1e-6 && flatLive !== null && firstLead !== -1 && coneEnd !== -1) {
        let lipA = [flatLive[vc], flatLive[firstLead]];
        let lipB = [flatLive[vc], flatLive[coneEnd]];
        const bent = slitLips(vc, firstLead, coneEnd);
        if (bent !== null) {
          [lipA, lipB] = bent;
          for (const q of lipB.slice(1, -1)) insertAt(q);
        }
        carveDone = carveCone(lipA, lipB, frontier, ventEdges);
      }

      return { walked: ok && carveDone && remaining <= 1e-6, ventEdges };
    };
    /** After a walk: every earlier vent keeps its 2π (a carve through one would not) and the sheet its pieces. */
    const keepsSheet = (): boolean => {
      const ventWedges = vents.map((vt) => wedgesOf.get(vt.sourceVertex) ?? []);
      const angles = liveAnglesAt(ventWedges.flatMap((ws) => ws.map((w) => w.copy)));
      const intact = ventWedges.every((ws) => ws.reduce((a, w) => a + angles.get(w.copy)!, 0) > TAU - 1e-6);
      return intact && liveComponents() === baseComponents;
    };

    const snapshot = () => ({
      facesSnap: faces.map((f) => (f === null ? null : ([...f] as [number, number, number]))),
      vertCount: vertices.length,
    });
    const rollback = (snap: ReturnType<typeof snapshot>) => {
      faces.length = snap.facesSnap.length;
      for (let i = 0; i < snap.facesSnap.length; i++) faces[i] = snap.facesSnap[i];
      vertices.length = snap.vertCount;
      goalPos.length = snap.vertCount;
      origVertex.length = snap.vertCount;
      if (flatLive !== null) flatLive.length = snap.vertCount;
    };

    // Evaluate every candidate with rollback; rank fitting ones by the flat
    // self-overlap their excision leaves behind (fewest wins, ties keep the
    // existing largest-wedge-first priority). Without a layout (sheet not
    // developable / already multi-component) fall back to first fit. If no
    // deep (radial) excision keeps the sheet connected, degrade to the
    // shallow one-ring sliver before giving up.
    let applied = false;
    for (const deep of [true, false]) {
      let bestIdx = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestVentEdges: [number, number][] = [];
      for (let ci = 0; ci < candidates.length && !applied; ci++) {
        const { vc, chain, flip } = candidates[ci];
        const snap = snapshot();
        const { walked, ventEdges } = walkCandidate(vc, chain, flip, deep);
        if (walked && flatLive === null && keepsSheet()) {
          vents.push({ sourceVertex: v, angle: excess, ventEdges });
          applied = true;
          break; // first fit — keep mutations
        }
        if (walked && flatLive !== null) {
          // Score before the sheet checks: a candidate that cannot beat the best needs neither.
          const live = faces.filter((f): f is [number, number, number] => f !== null);
          const score = countFlatOverlaps(flatLive, live, bestScore);
          if (score < bestScore && keepsSheet()) {
            bestScore = score;
            bestIdx = ci;
            bestVentEdges = ventEdges;
          }
        }
        rollback(snap);
      }
      if (!applied && bestIdx !== -1) {
        const { vc, chain, flip } = candidates[bestIdx];
        const { walked } = walkCandidate(vc, chain, flip, deep); // deterministic re-walk
        /* istanbul ignore if */
        if (!walked || !keepsSheet()) throw new PipelineError("unfold", `vent re-walk diverged at vertex ${v}`, { vertex: v });
        vents.push({ sourceVertex: v, angle: excess, ventEdges: bestVentEdges });
        applied = true;
      }
      if (applied) break;
    }

    if (!applied) {
      throw new PipelineError(
        "unfold",
        `no vent placement at vertex ${v} absorbs ${excess.toFixed(4)} rad: every candidate disconnects the sheet, leaves an earlier vent short of 2π, runs out of material, or cannot finish its carve`,
        { vertex: v },
      );
    }
  }

  // --- Assemble final arrays; drop orphaned vertices --------------------------
  const finalFaces = faces.filter((f): f is [number, number, number] => f !== null);
  const used = new Set<number>();
  for (const f of finalFaces) for (const x of f) used.add(x);
  const remap = new Map<number, number>();
  const outVerts: TriMesh["vertices"] = [];
  const outOrig: number[] = [];
  const outGoal: TriMesh["vertices"] = [];
  for (let i = 0; i < vertices.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, outVerts.length);
    outVerts.push(vertices[i]);
    outOrig.push(origVertex[i]);
    outGoal.push(goalPos[i]);
  }
  const remappedFaces = finalFaces.map((f) => f.map((x) => remap.get(x)!) as [number, number, number]);

  // Edge-existence set for lip filtering (a vent may have removed one side).
  const edgeSet = new Set<string>();
  for (const f of remappedFaces) {
    for (const [a, b] of [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]] as [number, number][]) {
      edgeSet.add(edgeKey(a, b));
    }
  }
  const mapPair = (p: [number, number]): [number, number] | null => {
    const a = remap.get(p[0]);
    const b = remap.get(p[1]);
    return a !== undefined && b !== undefined ? [a, b] : null;
  };
  const outLips: LipPair[] = [];
  const extraVentEdges: [number, number][] = [];
  for (const lip of lips) {
    const a = mapPair(lip.lipA);
    const b = mapPair(lip.lipB);
    const aLive = a !== null && edgeSet.has(edgeKey(a[0], a[1]));
    const bLive = b !== null && edgeSet.has(edgeKey(b[0], b[1]));
    if (aLive && bLive) {
      outLips.push({ sourceEdge: lip.sourceEdge, lipA: a!, lipB: b! });
    } else if (aLive || bLive) {
      // One side vanished into a vent sliver — the survivor bounds the vent.
      extraVentEdges.push((aLive ? a : b)!);
    }
  }
  const outVents: VentRecord[] = vents.map((vt) => ({
    sourceVertex: vt.sourceVertex,
    angle: vt.angle,
    ventEdges: vt.ventEdges
      .map(mapPair)
      .filter((p): p is [number, number] => p !== null && edgeSet.has(edgeKey(p[0], p[1]))),
  }));
  if (extraVentEdges.length > 0 && outVents.length > 0) {
    // Attach orphaned lip survivors to the nearest vent record (by shared vertex).
    for (const e of extraVentEdges) {
      const owner =
        outVents.find((vt) => vt.ventEdges.some((ve) => ve.includes(e[0]) || ve.includes(e[1]))) ?? outVents[0];
      owner.ventEdges.push(e);
    }
  }

  return { mesh: { vertices: outVerts, faces: remappedFaces }, origVertex: outOrig, goalPos: outGoal, lips: outLips, vents: outVents };
}

/**
 * Cut → vent → flatten → relief loop, under the proper-kirigami invariants:
 * the sheet must stay ONE connected piece (a disconnecting plan is a planner
 * bug, hard-gated here), and δ<0 slit vertices get vent slivers so the flat
 * material totals exactly 2π everywhere. Each relief pass adds ≥1 interior
 * edge to the cut set, hard-capped at RELIEF_MAX.
 */
export function seamedUnfold(
  mesh: TriMesh,
  topo: MeshTopology,
  plan: CutPlan,
  defects: DefectReport,
  opts: { pruneRelief?: boolean } = {},
): UnfoldResult {
  reliefDeadline = Date.now() + RELIEF_SEARCH_BUDGET_MS; // one budget for the whole relief loop
  try {
    return seamedUnfoldWithinBudget(mesh, topo, plan, defects, opts);
  } finally {
    reliefDeadline = Number.POSITIVE_INFINITY;
  }
}

function seamedUnfoldWithinBudget(
  mesh: TriMesh,
  topo: MeshTopology,
  plan: CutPlan,
  defects: DefectReport,
  opts: { pruneRelief?: boolean },
): UnfoldResult {
  const pruneRelief = opts.pruneRelief ?? false;
  const cutSet = new Set(plan.cutEdges);
  const reliefEdges: number[] = [];

  // δ<0 slit vertices → vent angle |δ| (K1).
  const ventAngles = new Map<number, number>();
  for (let v = 0; v < plan.perVertexAction.length; v++) {
    if (plan.perVertexAction[v] === "slit" && defects.defects[v] < 0) {
      ventAngles.set(v, -defects.defects[v]);
    }
  }

  for (let pass = 0; pass <= RELIEF_MAX; pass++) {
    const cut = cutAlongEdges(mesh, topo, [...cutSet], ventAngles);
    const components = labelComponents(cut.mesh);
    if (components.count !== 1) {
      throw new PipelineError(
        "unfold",
        `cut plan disconnected the sheet into ${components.count} pieces — a proper kirigami is one connected sheet (planner bug)`,
        { components: components.count },
      );
    }

    const allFaces = cut.mesh.faces.map((_, f) => f);
    const flat = unfoldPatch(cut, allFaces);
    const overlap = findSelfOverlap(flat, cut.mesh.faces);

    if (overlap === null) {
      // Post-relief minimization (opt-in): the relief loop adds edges
      // monotonically and never re-examines them, so an edge added to fix an
      // early overlap is often made redundant by later additions. Drop every
      // relief edge whose removal still develops cleanly, then re-derive the
      // returned artifacts from the pruned cut set so they stay consistent.
      let finalCut = cut;
      let finalFlat = flat;
      let finalComponents = components;
      let reliefPruned = 0;
      if (pruneRelief && reliefEdges.length > 0) {
        try {
          reliefPruned = pruneReliefEdges(mesh, topo, cutSet, reliefEdges, ventAngles);
        } catch (err) {
          if (!(err instanceof ReliefBudgetError)) throw err;
          // Pruning is optional: keep the removals already verified clean and stop, rather than throw away a
          // development that is already valid. Lift the budget so re-deriving the artifacts below can finish.
          reliefPruned = reliefEdges.filter((e) => !cutSet.has(e)).length;
          reliefDeadline = Number.POSITIVE_INFINITY;
        }
        if (reliefPruned > 0) {
          finalCut = cutAlongEdges(mesh, topo, [...cutSet], ventAngles);
          finalComponents = labelComponents(finalCut.mesh);
          finalFlat = unfoldPatch(finalCut, finalCut.mesh.faces.map((_, f) => f));
          // Defensive: pruning only accepts clean removals, so this must hold.
          if (findSelfOverlap(finalFlat, finalCut.mesh.faces) !== null) {
            throw new PipelineError(
              "unfold",
              "relief pruning produced an overlapping development (internal invariant violated)",
            );
          }
        }
      }
      const totalCutLength = [...cutSet].reduce((acc, e) => acc + edgeLength(mesh, topo, e), 0);
      return {
        flat: finalFlat,
        faces: finalCut.mesh.faces,
        patchOfFace: finalComponents.label,
        patchCount: finalComponents.count,
        origVertex: finalCut.origVertex,
        goalPos: finalCut.goalPos,
        lips: finalCut.lips,
        vents: finalCut.vents,
        reliefEdges: [...reliefEdges],
        reliefPruned,
        totalCutLength,
      };
    }

    if (pass === RELIEF_MAX) {
      throw new PipelineError(
        "unfold",
        `relief loop exceeded RELIEF_MAX=${RELIEF_MAX} passes; last overlapping face pair: ${overlap[0]}, ${overlap[1]}`,
        { overlap },
      );
    }

    const added = addReliefCut(mesh, topo, cut, flat, overlap, cutSet, ventAngles);
    reliefEdges.push(...added);
  }
  /* istanbul ignore next */
  throw new PipelineError("unfold", "unreachable");
}

/**
 * True iff cutting `mesh` along `edges` (with vents) yields ONE connected piece
 * that flattens with no self-overlap. Same trial `addReliefCut` runs, factored
 * out for the pruning pass. A vent-placement failure (PipelineError "unfold")
 * counts as "does not develop cleanly" rather than a pipeline failure.
 */
function developsCleanly(
  mesh: TriMesh,
  topo: MeshTopology,
  edges: number[],
  ventAngles: Map<number, number>,
): boolean {
  try {
    const trial = cutAlongEdges(mesh, topo, edges, ventAngles);
    if (labelComponents(trial.mesh).count !== 1) return false;
    const flat = unfoldPatch(trial, trial.mesh.faces.map((_, f) => f));
    return findSelfOverlap(flat, trial.mesh.faces) === null;
  } catch (err) {
    if (err instanceof ReliefBudgetError) throw err;
    if (err instanceof PipelineError && err.stage === "unfold") return false;
    throw err;
  }
}

/**
 * Post-relief minimization. Greedily drop every RELIEF edge whose removal still
 * develops cleanly (one piece, overlap-free). Only relief edges are candidates:
 * planned cuts (`plan.cutEdges`) carry 3D curvature-relief duty that the flat
 * developability test cannot judge, so they are never offered here. Vent slits
 * are protected automatically — removing one makes `cutAlongEdges` fail to place
 * the vent, which `developsCleanly` treats as "not removable".
 *
 * Reverse addition order (last-added is likeliest redundant); iterate to a fixed
 * point capped at `PRUNE_MAX_PASSES`. Mutates `cutSet` and rewrites `reliefEdges`
 * to the kept set; returns the number of edges removed.
 */
function pruneReliefEdges(
  mesh: TriMesh,
  topo: MeshTopology,
  cutSet: Set<number>,
  reliefEdges: number[],
  ventAngles: Map<number, number>,
): number {
  // Relief edges still in the cut set (tier-3 swaps may have dropped some).
  const kept = reliefEdges.filter((e) => cutSet.has(e));
  let removed = 0;
  let trials = 0;
  outer: for (let pass = 0; pass < PRUNE_MAX_PASSES; pass++) {
    let removedThisPass = 0;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (trials >= PRUNE_MAX_TRIALS) break outer; // cost guard
      trials++;
      const e = kept[i];
      const trialEdges = [...cutSet].filter((x) => x !== e);
      if (developsCleanly(mesh, topo, trialEdges, ventAngles)) {
        cutSet.delete(e);
        kept.splice(i, 1);
        removed++;
        removedThisPass++;
      }
    }
    if (removedThisPass === 0) break;
  }
  reliefEdges.length = 0;
  reliefEdges.push(...kept);
  return removed;
}

/**
 * Relief: route the shortest interior source-mesh path from the existing cut
 * graph / boundary to a source vertex of the later overlapping face, so the
 * overlapping limb swings away on the next unfold. Every candidate is
 * TRIAL-VERIFIED to keep the sheet one connected piece (proper-kirigami
 * invariant) before being accepted. Returns the edges added.
 */
function addReliefCut(
  mesh: TriMesh,
  topo: MeshTopology,
  cut: CutMesh,
  flat: Vec2[],
  overlap: [number, number],
  cutSet: Set<number>,
  ventAngles: Map<number, number>,
): number[] {
  const [, f2] = overlap; // later face in BFS order — the limb to free
  const tri = cut.mesh.faces[f2];
  const cx = (flat[tri[0]].x + flat[tri[1]].x + flat[tri[2]].x) / 3;
  const cy = (flat[tri[0]].y + flat[tri[1]].y + flat[tri[2]].y) / 3;

  /** Accept a fresh edge set only if the cut sheet stays one piece AND every
   * vent still finds a placement under the enlarged cut set (a trial that
   * throws is a rejected candidate, not a pipeline failure). */
  const staysConnected = (fresh: number[]): boolean => {
    try {
      const trial = cutAlongEdges(mesh, topo, [...cutSet, ...fresh], ventAngles);
      return labelComponents(trial.mesh).count === 1;
    } catch (err) {
      if (err instanceof ReliefBudgetError) throw err;
      if (err instanceof PipelineError && err.stage === "unfold") return false;
      throw err;
    }
  };

  // Sources: every vertex already on the cut graph or the mesh boundary.
  const sources = new Set<number>();
  for (const e of cutSet) {
    sources.add(topo.edges[e].a);
    sources.add(topo.edges[e].b);
  }
  for (const v of topo.boundaryVertices) sources.add(v);

  const res = shortestPaths(mesh, topo, [...sources]);

  // Candidate targets: f2's source vertices ordered by flat distance to the
  // overlap centroid; take the first yielding a non-empty, connectivity-safe
  // path of new edges.
  const candidates = [...tri]
    .map((v) => ({ src: cut.origVertex[v], d: Math.hypot(flat[v].x - cx, flat[v].y - cy) }))
    .filter((c) => c.src >= 0) // skip synthesized vent vertices
    .sort((p, q) => p.d - q.d);

  for (const { src } of candidates) {
    const path: number[] = [];
    let cur = src;
    while (res.prevEdge[cur] !== -1) {
      path.push(res.prevEdge[cur]);
      cur = res.prevVertex[cur];
    }
    const fresh = path.filter((e) => !cutSet.has(e) && topo.edges[e].faces.length === 2);
    if (fresh.length > 0 && staysConnected(fresh)) {
      for (const e of fresh) cutSet.add(e);
      return fresh;
    }
  }

  // All three vertices already touch the cut graph: free the face itself by
  // cutting its shortest not-yet-cut interior edge that keeps one piece.
  const edgeCandidates: { e: number; l: number }[] = [];
  for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
    const sa = cut.origVertex[a];
    const sb = cut.origVertex[b];
    if (sa < 0 || sb < 0) continue;
    const e = topo.edgeIndex.get(edgeKey(sa, sb));
    if (e === undefined || cutSet.has(e) || topo.edges[e].faces.length !== 2) continue;
    edgeCandidates.push({ e, l: edgeLength(mesh, topo, e) });
  }
  edgeCandidates.sort((p, q) => p.l - q.l);
  for (const { e } of edgeCandidates) {
    if (staysConnected([e])) {
      cutSet.add(e);
      return [e];
    }
  }

  // --- Saturated cut graph: greedy ADD(+REMOVE) descent --------------------
  // When the cut graph ∪ boundary already spans every vertex, ANY extra edge
  // closes a cycle and severs the sheet — pure additions are exhausted (this
  // is the normal state on all-saddle grid patches, whose MST comb makes the
  // development wrap and tangle). A cut SWAP (add one edge, drop one) keeps
  // the structure acyclic — the sheet stays one piece — while re-routing the
  // slits toward radial form. Pick the move that STRICTLY reduces the flat
  // self-overlap pair count; the strict integer descent terminates.
  let work = 0;
  const overlapsFor = (edges: number[], cap: number): number => {
    checkReliefBudget();
    // Most swaps close a cut cycle and sever the sheet, or strip a vent vertex of
    // its slit (cutAlongEdges throws on that); skip the vented cut for those.
    if (!cutKeepsOnePiece(mesh, topo, edges)) return Number.POSITIVE_INFINITY;
    const slit = new Set(edges.filter((e) => topo.edges[e].faces.length === 2));
    for (const v of ventAngles.keys()) if (!topo.vertexEdges[v].some((e) => slit.has(e))) return Number.POSITIVE_INFINITY;
    work += 1 + ventAngles.size;
    try {
      const trial = cutAlongEdges(mesh, topo, edges, ventAngles);
      if (labelComponents(trial.mesh).count !== 1) return Number.POSITIVE_INFINITY;
      const tflat = unfoldPatch(trial, trial.mesh.faces.map((_, f) => f));
      return countFlatOverlaps(tflat, trial.mesh.faces, cap);
    } catch (err) {
      if (err instanceof ReliefBudgetError) throw err;
      if (err instanceof PipelineError) return Number.POSITIVE_INFINITY;
      throw err;
    }
  };

  const current = countFlatOverlaps(flat, cut.mesh.faces);
  let best = current;
  let bestAdd = -1;
  let bestRemove = -1;
  // Nothing beats an overlap-free move (ties keep the earlier one), so stop at the first.
  for (let add = 0; add < topo.edges.length && best > 0 && work < SWAP_WORK_BUDGET; add++) {
    if (cutSet.has(add) || topo.edges[add].faces.length !== 2) continue;
    const withAdd = [...cutSet, add];
    const nAdd = overlapsFor(withAdd, best - 1);
    if (nAdd < best) {
      best = nAdd;
      bestAdd = add;
      bestRemove = -1;
    }
    for (const rm of cutSet) {
      if (best === 0 || work >= SWAP_WORK_BUDGET) break;
      const nSwap = overlapsFor(withAdd.filter((e) => e !== rm), best - 1);
      if (nSwap < best) {
        best = nSwap;
        bestAdd = add;
        bestRemove = rm;
      }
    }
  }
  if (bestAdd !== -1) {
    cutSet.add(bestAdd);
    if (bestRemove !== -1) cutSet.delete(bestRemove);
    return [bestAdd];
  }

  if (work >= SWAP_WORK_BUDGET) {
    throw new PipelineError(
      "unfold",
      `relief cut: no cut swap reduced the ${current} overlapping face pairs within the search budget — try a simpler mesh or fewer vents`,
      { overlap },
    );
  }
  throw new PipelineError("unfold", "relief cut: no connectivity-safe edge near overlap", { overlap });
}
