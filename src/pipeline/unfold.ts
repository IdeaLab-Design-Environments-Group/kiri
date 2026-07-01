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
import { shortestPaths } from "./plan-cuts.js";
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

/** Hard cap on relief-loop iterations (each adds ≥1 cut edge, so ≤E anyway). */
export const RELIEF_MAX = 64;

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
  /** cornerCopy.get(`${f}_${v}`) → cut-mesh vertex id for face f's corner at v. */
  const cornerCopy = new Map<string, number>();
  /** Fan-ordered wedges per source vertex (kept for vent application). */
  const wedgesOf = new Map<number, { copy: number; faces: number[]; angle: number }[]>();

  for (let v = 0; v < mesh.vertices.length; v++) {
    const wedges = vertexWedges(mesh, topo, v, isCut);
    const recorded: { copy: number; faces: number[]; angle: number }[] = [];
    for (const wedge of wedges) {
      const id = vertices.length;
      vertices.push({ ...mesh.vertices[v] });
      origVertex.push(v);
      for (const f of wedge.faces) cornerCopy.set(`${f}_${v}`, id);
      recorded.push({ copy: id, faces: wedge.faces, angle: wedge.angle });
    }
    if (ventAngles.has(v)) wedgesOf.set(v, recorded);
  }

  const goalPos = vertices.map((p) => ({ ...p }));

  // Faces by SOURCE face id; vent application may null (remove) or split them.
  const faces: ([number, number, number] | null)[] = mesh.faces.map(
    (fv, f) => fv.map((v) => cornerCopy.get(`${f}_${v}`)!) as [number, number, number],
  );
  const lips: LipPair[] = [];
  for (const e of cutSet) {
    const { a, b, faces: ef } = topo.edges[e];
    const [f1, f2] = ef;
    lips.push({
      sourceEdge: e,
      lipA: [cornerCopy.get(`${f1}_${a}`)!, cornerCopy.get(`${f1}_${b}`)!],
      lipB: [cornerCopy.get(`${f2}_${a}`)!, cornerCopy.get(`${f2}_${b}`)!],
    });
  }

  // --- Vents (K1): remove a sliver of total angle |δ| at each δ<0 slit -----
  // vertex, working on LIVE geometry (earlier vents may have consumed or
  // split faces another vent's fan touches — source-mesh angles go stale).
  // The removal target is DYNAMIC: whatever live angle exceeds 2π at the
  // vertex right now. Candidates (each wedge copy × walk direction) are
  // tried with rollback until one fits AND keeps the sheet connected.
  const vents: VentRecord[] = [];
  const liveAngleAt = (vc: number): number => {
    let sum = 0;
    for (const tri of faces) {
      if (tri === null || !tri.includes(vc)) continue;
      const [i, j, k] = tri;
      const at = vc;
      const others = (i === vc ? [j, k] : j === vc ? [k, i] : [i, j]) as [number, number];
      const u = {
        x: vertices[others[0]].x - vertices[at].x,
        y: vertices[others[0]].y - vertices[at].y,
        z: vertices[others[0]].z - vertices[at].z,
      };
      const w = {
        x: vertices[others[1]].x - vertices[at].x,
        y: vertices[others[1]].y - vertices[at].y,
        z: vertices[others[1]].z - vertices[at].z,
      };
      const cr = {
        x: u.y * w.z - u.z * w.y,
        y: u.z * w.x - u.x * w.z,
        z: u.x * w.y - u.y * w.x,
      };
      sum += Math.atan2(Math.hypot(cr.x, cr.y, cr.z), u.x * w.x + u.y * w.y + u.z * w.z);
    }
    return sum;
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

  const ventVerts = [...ventAngles.keys()].sort((a, b) => a - b);
  const initialLiveFaces = faces.length;

  // Vents may not make connectivity WORSE than the bare cut already is. A
  // disconnecting cut set is the CALLER's problem (seamedUnfold hard-gates
  // it; relief trials reject it) — blaming the vent here used to surface as
  // a bogus "mesh too coarse" failure on connectivity-unsafe relief trials.
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
   * between the same two rays. Working in the live development (exact, since
   * every split is an affine sub-division of a flat face), remove every face
   * piece strictly between ray d1 and ray d2 from `apex`, splitting crossed
   * faces conformingly. Stops at the sheet boundary. Connectivity damage is
   * caught by the caller's component check.
   */
  const carveCone = (
    apex: Vec2,
    d1: Vec2,
    d2: Vec2,
    frontier: [number, number][],
    ventEdges: [number, number][],
  ): void => {
    if (flatLive === null) return;
    const flat = flatLive;
    const orient = Math.sign(cross2(d1.x, d1.y, d2.x, d2.y)) || 1;
    const sideOf = (ray: Vec2, p: Vec2): number => {
      const c = cross2(ray.x, ray.y, p.x - apex.x, p.y - apex.y) * orient;
      const eps = 1e-9 * (Math.hypot(ray.x, ray.y) * Math.hypot(p.x - apex.x, p.y - apex.y) + 1e-12);
      return c > eps ? 1 : c < -eps ? -1 : 0;
    };
    /** Crossing of `ray` with live segment (u, t): param r on u→t, or null. */
    const crossingOn = (ray: Vec2, u: number, t: number): number | null => {
      const pu = flat[u];
      const pt = flat[t];
      const ex = pt.x - pu.x;
      const ey = pt.y - pu.y;
      const det = cross2(ex, ey, -ray.x, -ray.y); // [e  -d] r,s solve
      if (Math.abs(det) < 1e-15) return null;
      const wx = apex.x - pu.x;
      const wy = apex.y - pu.y;
      const r = cross2(wx, wy, -ray.x, -ray.y) / det;
      const s = cross2(ex, ey, wx, wy) / det;
      // Length-aware window: crossings within SNAP_LEN of u reuse u via the
      // single-crossing branches; near t the leftover ≤SNAP_LEN in-cone sliver
      // stays (below the shrink-SAT registration — see "degenerate slivers").
      const tEps = Math.min(0.5, SNAP_LEN / Math.hypot(ex, ey));
      if (r < tEps || r > 1 - tEps || s <= 0) return null;
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

    const guardMax = Math.max(64, faces.length * 8);
    let guard = 0;
    while (queue.length > 0 && guard++ < guardMax) {
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
        const s1 = sideOf(d1, flat[t]);
        const s2 = sideOf(d2, flat[t]);
        if (s1 >= 0 && s2 <= 0) {
          // Third corner on/inside the cone: excise every live piece on (x, y).
          faces[gi] = null;
          pushEdge(x, t);
          pushEdge(t, y);
          carved = true;
          continue;
        }
        // Exactly one ray separates t from the cone; chord it off.
        const ray = s1 < 0 ? d1 : d2;
        const rx = crossingOn(ray, x, t);
        const ry = crossingOn(ray, y, t);
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

    /** Walk one candidate, mutating live state; returns fit + vent edges. */
    const walkCandidate = (
      vc: number,
      chain: number[],
      flip: boolean,
      deep = true,
    ): { fits: boolean; ventEdges: [number, number][] } => {
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
      // displaces material at all radii, not just the one-ring).
      if (deep && ok && remaining <= 1e-6 && flatLive !== null && firstLead !== -1 && coneEnd !== -1) {
        const apex = flatLive[vc];
        const d1 = { x: flatLive[firstLead].x - apex.x, y: flatLive[firstLead].y - apex.y };
        const d2 = { x: flatLive[coneEnd].x - apex.x, y: flatLive[coneEnd].y - apex.y };
        carveCone(apex, d1, d2, frontier, ventEdges);
      }

      const fits = ok && remaining <= 1e-6 && liveComponents() === baseComponents;
      return { fits, ventEdges };
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
        const { fits, ventEdges } = walkCandidate(vc, chain, flip, deep);
        if (fits && flatLive === null) {
          vents.push({ sourceVertex: v, angle: excess, ventEdges });
          applied = true;
          break; // first fit — keep mutations
        }
        if (fits && flatLive !== null) {
          const live = faces.filter((f): f is [number, number, number] => f !== null);
          const score = countFlatOverlaps(flatLive, live, bestScore);
          if (score < bestScore) {
            bestScore = score;
            bestIdx = ci;
            bestVentEdges = ventEdges;
          }
        }
        rollback(snap);
      }
      if (!applied && bestIdx !== -1) {
        const { vc, chain, flip } = candidates[bestIdx];
        const { fits } = walkCandidate(vc, chain, flip, deep); // deterministic re-walk
        /* istanbul ignore if */
        if (!fits) throw new PipelineError("unfold", `vent re-walk diverged at vertex ${v}`, { vertex: v });
        vents.push({ sourceVertex: v, angle: excess, ventEdges: bestVentEdges });
        applied = true;
      }
      if (applied) break;
    }

    if (!applied) {
      throw new PipelineError(
        "unfold",
        `no vent placement at vertex ${v} absorbs ${excess.toFixed(4)} rad while keeping the sheet connected — mesh too coarse for this defect`,
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

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * BFS isometric layout of one connected patch of the cut mesh. Throws
 * PipelineError("unfold") when a non-tree placement disagrees — that means
 * the patch is not developable, i.e. a planner bug, not a relief case.
 */
export function unfoldPatch(cut: CutMesh, patchFaces: number[]): Vec2[] {
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
function countFlatOverlaps(flat: Vec2[], faces: [number, number, number][], cap = Number.POSITIVE_INFINITY): number {
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
        reliefPruned = pruneReliefEdges(mesh, topo, cutSet, reliefEdges, ventAngles);
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

/** Face-connectivity labeling over shared edges of a TriMesh. */
function labelComponents(mesh: TriMesh): { count: number; label: number[] } {
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      const list = edgeFaces.get(key) ?? [];
      list.push(f);
      edgeFaces.set(key, list);
    }
  }
  const label = new Array<number>(mesh.faces.length).fill(-1);
  let count = 0;
  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (label[seed] !== -1) continue;
    const queue = [seed];
    label[seed] = count;
    while (queue.length > 0) {
      const f = queue.pop()!;
      const [i, j, k] = mesh.faces[f];
      for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
        for (const g of edgeFaces.get(edgeKey(a, b)) ?? []) {
          if (label[g] === -1) {
            label[g] = count;
            queue.push(g);
          }
        }
      }
    }
    count++;
  }
  return { count, label };
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
  const overlapsFor = (edges: number[], cap: number): number => {
    try {
      const trial = cutAlongEdges(mesh, topo, edges, ventAngles);
      if (labelComponents(trial.mesh).count !== 1) return Number.POSITIVE_INFINITY;
      const tflat = unfoldPatch(trial, trial.mesh.faces.map((_, f) => f));
      return countFlatOverlaps(tflat, trial.mesh.faces, cap);
    } catch (err) {
      if (err instanceof PipelineError) return Number.POSITIVE_INFINITY;
      throw err;
    }
  };

  const current = countFlatOverlaps(flat, cut.mesh.faces);
  let best = current;
  let bestAdd = -1;
  let bestRemove = -1;
  for (let add = 0; add < topo.edges.length; add++) {
    if (cutSet.has(add) || topo.edges[add].faces.length !== 2) continue;
    const withAdd = [...cutSet, add];
    const nAdd = overlapsFor(withAdd, best - 1);
    if (nAdd < best) {
      best = nAdd;
      bestAdd = add;
      bestRemove = -1;
    }
    for (const rm of cutSet) {
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

  throw new PipelineError("unfold", "relief cut: no connectivity-safe edge near overlap", { overlap });
}
