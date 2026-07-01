import type { KirigamiState } from "../model/types.js";
import { computeMinorCutLength } from "../model/geometry.js";
import { vec3, type Vec3 } from "./vec3.js";

/**
 * FoldNet — the topological mesh that bridges the flat DETC kirigami pattern to the
 * bar-and-hinge folding solver (see `model.ts`, `forces.ts`).
 *
 * It is built **analytically** from the same apex-centered fan geometry as
 * `pattern.ts` (NOT by re-parsing the exported SVG), so adjacency is known exactly:
 *
 *  - N **lateral-face triangles** (polygons): [tip, outerL, outerR].
 *  - N **edge molecules** between adjacent polygons, each split down its **valley crease**
 *    into a left/right half so the fold is an explicit shared edge.
 *  - Polygon ↔ molecule **slant edges** are shared (the tip points are common vertices) →
 *    they become **mountain creases**.
 *
 * Kirigami vs origami is captured purely by topology: a **cut is an absent edge** (no beam,
 * no crease couples across it), so the major-cut hole around the apex opens and the polygon
 * **tips stay distinct nodes** (one per wedge) instead of welding into a single cone point.
 * Edges are classified by how many faces share them:
 *   - "C" cut: the molecule **dart-mouth** (outer chord) — a real kirigami cut carrying NO bar,
 *      so adjacent base corners can close together and the molecule tucks flat (DETC minor cut).
 *   - 1 face  → "B" boundary (free, but bar-carrying): outer base edges, inner major-cut edges.
 *   - 2 faces → crease: "V" valley (molecule centerline), "M" mountain (polygon/molecule
 *               slant), or "F" facet (triangulation diagonal, driven flat).
 *
 * The distinction between "C" and "B" is the crux of folding: both are free boundaries, but a
 * "C" edge carries no axial bar, so the excess molecule material can collapse instead of buckling
 * (the over-constraint that crumpled the earlier mesh).
 */
export type EdgeAssignment = "M" | "V" | "F" | "B" | "C";

export interface FoldNetEdge {
  /** Vertex indices (a < b). */
  a: number;
  b: number;
  assignment: EdgeAssignment;
  /** Rest length in the flat net (mm). */
  rest: number;
  /** Face indices sharing this edge (1 = boundary, 2 = crease). */
  faces: number[];
}

export interface FoldNet {
  /** Flat-net vertex positions (z = 0), mm. */
  vertices: Vec3[];
  /** Triangle faces as vertex-index triples (CCW in the flat net). */
  faces: [number, number, number][];
  /** Unique edges with assignment + adjacency. */
  edges: FoldNetEdge[];
  /** Outer base-ring vertex indices (the pyramid base perimeter) — anchor candidates. */
  base: number[];
  /**
   * Base-corner pairs that **merge** into one cone base vertex when folded — each molecule's two
   * outer corners (polyOuterR[k], polyOuterL[k+1]). Drives the forward fold to the goal mesh:
   * the pair collapses together (radius R) so the molecule between them tucks (DETC §3).
   */
  basePairs: [number, number][];
  /**
   * Molecule valley-convergence node (`foldPt`) indices, one per molecule (aligned with
   * `basePairs`). These are driven to an *inside* goal in the forward fold so the molecule tucks
   * into the pyramid volume instead of buckling outward.
   */
  valleyOuter: number[];
  /** Polygon apex-tip vertex indices (one per wedge; they converge but never weld). */
  tips: number[];
  meta: {
    N: number;
    /** Normalization factor applied to all coordinates: simUnits = mm · scale (≈ 1/outerRadius). */
    scale: number;
    R: number;
    s: number;
    H: number;
    gamma: number;
    theta: number;
    rApex: number;
  };
}

interface P2 {
  x: number;
  y: number;
}

/** Build the folding mesh from a computed kirigami state. */
export function buildFoldNet(state: KirigamiState): FoldNet {
  const N = Math.max(3, Math.round(state.inputs.edgeCount));
  const { s, eta, tau, rApex } = state;

  // --- Fan geometry (mirrors pattern.ts buildPatternNet) -------------------------------
  const phaseOffset = -Math.PI / 2 - eta / 2;
  const ring = (radius: number, angle: number): P2 => ({
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  });
  const angleLeft = (k: number): number => k * tau + phaseOffset;
  const angleRight = (k: number): number => k * tau + eta + phaseOffset;
  const polyOuterBisector = (k: number): number => k * tau + eta / 2 + phaseOffset;

  const outerEdgeLength =
    state.inputs.outerEdgeLength && state.inputs.outerEdgeLength > 0
      ? state.inputs.outerEdgeLength
      : state.inputs.edgeLength;
  const maxOuterHalf = tau / 2 - 1e-3;
  const outerHalf = Math.min(
    Math.max(Math.asin(Math.min(1, outerEdgeLength / (2 * s))), 1e-4),
    maxOuterHalf,
  );

  const polyInnerL: P2[] = [];
  const polyInnerR: P2[] = [];
  const polyOuterL: P2[] = [];
  const polyOuterR: P2[] = [];
  const tip: P2[] = [];
  for (let k = 0; k < N; k++) {
    const iL = ring(rApex, angleLeft(k));
    const iR = ring(rApex, angleRight(k));
    polyInnerL.push(iL);
    polyInnerR.push(iR);
    polyOuterL.push(ring(s, polyOuterBisector(k) - outerHalf));
    polyOuterR.push(ring(s, polyOuterBisector(k) + outerHalf));
    // Midpoint of the polygon's two inner corners. The polygon is meshed as ONE triangle
    // [tip, outerL, outerR]; the molecule meshes around it through tip[k]/tip[k+1] too. With
    // a single inner node per polygon there is no load-bearing inner edge to resist as both
    // tips converge at the apex — that bar is what was making the integrator jitter.
    tip.push({ x: (iL.x + iR.x) / 2, y: (iL.y + iR.y) / 2 });
  }
  const mid = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const pdist = (a: P2, b: P2): number => Math.hypot(a.x - b.x, a.y - b.y);

  // --- Vertex weld registry (shared corners/tips merge by position) --------------------
  const vertices: Vec3[] = [];
  const lookup = new Map<string, number>();
  const key = (p: P2): string => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const vid = (p: P2): number => {
    const k = key(p);
    const existing = lookup.get(k);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    vertices.push(vec3(p.x, p.y, 0));
    lookup.set(k, id);
    return id;
  };

  // --- Faces + crease tagging ----------------------------------------------------------
  const faces: [number, number, number][] = [];
  const valleyKeys = new Set<string>();
  const mountainKeys = new Set<string>();
  const cutKeys = new Set<string>(); // molecule dart-mouth (minor cut) — free, no bar
  const basePairs: [number, number][] = []; // outer corners that merge into a cone base vertex
  const valleyOuter: number[] = []; // foldPt (valley convergence) per molecule
  const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const addTri = (a: P2, b: P2, c: P2): void => {
    faces.push([vid(a), vid(b), vid(c)]);
  };

  for (let k = 0; k < N; k++) {
    const kp = (k + 1) % N;

    // Lateral face: ONE triangle [tip, outerL, outerR]. tip is the single inner-side vertex
    // (midpoint of polyInnerL/R); both slants are mountain creases, shared with neighbouring
    // molecule halves. A single inner node keeps the integrator stable as all N tips converge
    // at the apex during folding (no inner bar to resist that convergence).
    addTri(tip[k], polyOuterL[k], polyOuterR[k]);
    mountainKeys.add(ekey(vid(tip[k]), vid(polyOuterL[k])));
    mountainKeys.add(ekey(vid(tip[k]), vid(polyOuterR[k])));

    // Edge molecule k between polygon k (right slant) and polygon k+1 (left slant).
    const innerL = polyInnerR[k];
    const innerR = polyInnerL[kp];
    const outerR1 = polyOuterR[k]; // shared corner with polygon k
    const outerL2 = polyOuterL[kp]; // shared corner with polygon k+1
    const innerMid = mid(innerL, innerR);
    const outerMid = mid(outerR1, outerL2);

    // These two outer corners merge into one cone base vertex when folded (the molecule tucks).
    basePairs.push([vid(outerR1), vid(outerL2)]);

    // Minor cut (DETC §3.1 / computeMinorCutLength): two slits run from the outer corners and
    // converge on the valley centreline at `foldPt`, removing the outer wedge so the molecule can
    // fold flat and tuck. Geometrically foldPt sits a depth √(minorLen² − (chord/2)²) inward of
    // the outer-chord midpoint along the valley (the slit's perpendicular penetration).
    const chordHalf = pdist(outerR1, outerMid);
    const minorLen = computeMinorCutLength(
      state.gamma,
      pdist(outerR1, outerL2),
      state.inputs.materialThickness,
      state.theta,
      rApex,
    );
    const valLen = pdist(innerMid, outerMid) || 1;
    const depth = Math.min(
      Math.sqrt(Math.max(0, minorLen * minorLen - chordHalf * chordHalf)),
      valLen * 0.9,
    );
    const vdir = { x: (innerMid.x - outerMid.x) / valLen, y: (innerMid.y - outerMid.y) / valLen };
    const foldPt: P2 = { x: outerMid.x + vdir.x * depth, y: outerMid.y + vdir.y * depth };
    valleyOuter.push(vid(foldPt));

    // Valley crease: inner-chord mid → minor-cut convergence (shortened by the removed wedge).
    valleyKeys.add(ekey(vid(innerMid), vid(foldPt)));
    // The two minor cuts (corner → foldPt) are real kirigami cuts: free boundaries carrying no
    // crease across them, so the molecule corners separate as it tucks.
    cutKeys.add(ekey(vid(outerR1), vid(foldPt)));
    cutKeys.add(ekey(vid(outerL2), vid(foldPt)));

    // Left half (5-gon innerL, innerMid, foldPt, outerR1, tip[k]) fanned from innerMid. The
    // shared edge outerR1→tip[k] IS polygon k's right slant mountain crease.
    addTri(innerMid, foldPt, outerR1);
    addTri(innerMid, outerR1, tip[k]);
    addTri(innerMid, tip[k], innerL);
    // Right half (5-gon innerR, innerMid, foldPt, outerL2, tip[k+1]).
    addTri(innerMid, innerR, tip[kp]);
    addTri(innerMid, tip[kp], outerL2);
    addTri(innerMid, outerL2, foldPt);
  }

  // --- Derive unique edges + classify by face adjacency --------------------------------
  const edgeMap = new Map<string, FoldNetEdge>();
  const dist = (i: number, j: number): number => {
    const a = vertices[i];
    const b = vertices[j];
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  };
  for (let f = 0; f < faces.length; f++) {
    const [i, j, k] = faces[f];
    for (const [a, b] of [
      [i, j],
      [j, k],
      [k, i],
    ] as const) {
      const k2 = ekey(a, b);
      let e = edgeMap.get(k2);
      if (!e) {
        e = { a: Math.min(a, b), b: Math.max(a, b), assignment: "B", rest: dist(a, b), faces: [] };
        edgeMap.set(k2, e);
      }
      e.faces.push(f);
    }
  }
  // Major cut: the apex hole. Boundary edges with both endpoints on the inner ring (radius
  // ≈ rApex) bound the central hole that opens as the tips converge — tag them as cuts too.
  const innerRimR = rApex * 1.4;
  const radius = (i: number): number => Math.hypot(vertices[i].x, vertices[i].y);
  const edges: FoldNetEdge[] = [];
  for (const [k2, e] of edgeMap) {
    if (e.faces.length >= 2) {
      e.assignment = valleyKeys.has(k2) ? "V" : mountainKeys.has(k2) ? "M" : "F";
    } else if (cutKeys.has(k2) || (radius(e.a) <= innerRimR && radius(e.b) <= innerRimR)) {
      e.assignment = "C"; // designed kirigami cut (dart mouth or apex-hole rim)
    } else {
      e.assignment = "B";
    }
    edges.push(e);
  }

  // --- Anchor / validation handles -----------------------------------------------------
  const base: number[] = [];
  const seen = new Set<number>();
  for (let k = 0; k < N; k++) {
    for (const p of [polyOuterL[k], polyOuterR[k]]) {
      const id = vid(p);
      if (!seen.has(id)) {
        seen.add(id);
        base.push(id);
      }
    }
  }
  // One apex-tip handle per polygon — the inner-chord midpoint. These N distinct nodes
  // converge at the apex when folded (kirigami: separate nodes, not a welded cone point).
  const tips = tip.map((p) => vid(p));

  // Normalize to ~unit scale (Gershenfeld scales geometry to bounding-sphere radius 1). With
  // mm-scale lengths the stiffness relation k_axial = EA/l0 vs k_crease = k_fold·l0 inverts
  // (k_crease ends up ≫ k_axial), which makes the explicit integrator blow up. Scaling lengths
  // to ~1 restores k_axial ≫ k_crease and a valid timestep. Edge `rest` is recomputed from the
  // scaled vertices below.
  let maxR = 1e-9;
  for (const v of vertices) maxR = Math.max(maxR, Math.hypot(v.x, v.y, v.z));
  const scale = 1 / maxR;
  for (const v of vertices) {
    v.x *= scale;
    v.y *= scale;
    v.z *= scale;
  }
  for (const e of edges) e.rest *= scale;

  return {
    vertices,
    faces,
    edges,
    base,
    basePairs,
    valleyOuter,
    tips,
    meta: {
      N,
      scale,
      R: state.R * scale,
      s: s * scale,
      H: state.H * scale,
      gamma: state.gamma,
      theta: state.theta,
      rApex: rApex * scale,
    },
  };
}

/**
 * Build a FoldNet from an arbitrary triangle mesh — edges are derived by face adjacency and
 * interior edges classified by `interiorAssignment` (default "F" facet). Used for unit tests
 * (e.g. a single two-triangle hinge) and any externally-supplied mesh.
 */
export function foldNetFromMesh(
  vertices: Vec3[],
  faces: [number, number, number][],
  interiorAssignment: (a: number, b: number) => EdgeAssignment = () => "F",
  meta: Partial<FoldNet["meta"]> = {},
): FoldNet {
  const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const dist = (i: number, j: number): number =>
    Math.hypot(
      vertices[i].x - vertices[j].x,
      vertices[i].y - vertices[j].y,
      vertices[i].z - vertices[j].z,
    );
  const edgeMap = new Map<string, FoldNetEdge>();
  for (let f = 0; f < faces.length; f++) {
    const [i, j, k] = faces[f];
    for (const [a, b] of [
      [i, j],
      [j, k],
      [k, i],
    ] as const) {
      const key = ekey(a, b);
      let e = edgeMap.get(key);
      if (!e) {
        e = { a: Math.min(a, b), b: Math.max(a, b), assignment: "B", rest: dist(a, b), faces: [] };
        edgeMap.set(key, e);
      }
      e.faces.push(f);
    }
  }
  const edges: FoldNetEdge[] = [];
  for (const e of edgeMap.values()) {
    e.assignment = e.faces.length >= 2 ? interiorAssignment(e.a, e.b) : "B";
    edges.push(e);
  }
  return {
    vertices,
    faces,
    edges,
    base: [],
    basePairs: [],
    valleyOuter: [],
    tips: [],
    meta: {
      N: meta.N ?? 0,
      scale: meta.scale ?? 1,
      R: meta.R ?? 0,
      s: meta.s ?? 0,
      H: meta.H ?? 0,
      gamma: meta.gamma ?? Math.PI,
      theta: meta.theta ?? 0,
      rApex: meta.rApex ?? 0,
    },
  };
}
