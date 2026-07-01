/**
 * FOLD/FKLD → runnable bar-and-hinge fold scene — a faithful TypeScript port of Amanda
 * Ghassaei's Origami Simulator model build (`js/model.js` `sync` + `js/dynamicSolver.js`
 * `initTypedArrays`, MIT). One uniform path simulates **any origami or kirigami**:
 *
 *   1. `processFold` (fold-ops.ts) splits cuts open and triangulates, then extracts
 *      winding-consistent crease records.
 *   2. We assemble the struct-of-arrays `BarHingeModel` exactly as the original does: a Node per
 *      vertex (unit mass), a Beam per edge (`k = EA/l₀`), a Crease per M/V/F edge
 *      (`k = creaseStiffness·l₀`, `targetTheta = fold angle`, type 0 = facet driven flat), and an
 *      interior-angle spring per triangle.
 *   3. Geometry is centred and scaled to bounding-sphere radius 1 (Origami Simulator scales every
 *      model this way so the stiffness ratios and timestep stay in the stable regime).
 *
 * The fold is the standard forward fold: `FoldSolver.foldPercent` (0→1) scales every crease's
 * target dihedral. Mountains fold to −π, valleys to +π by default (FOLD-spec sign; matches the
 * engine's measured θ via the consistent crease winding), or to the file's explicit
 * `edges_foldAngles`/`edges_foldAngle` when present. No goal mesh, no driven boundary — kirigami
 * cuts open because `splitCuts` made their lips independent nodes.
 */
import type { FoldFile } from "../model/fold-file.js";
import { type CreaseParams, processFold, type WorkFold } from "./fold-ops.js";
import { type BarHingeModel, DEFAULT_PARAMS, type SolverParams, TILE_COLLIDE_SIGN } from "./model.js";
import type { EdgeAssignment, FoldNet, FoldNetEdge } from "./foldnet.js";
import { FoldSolver, measureTheta } from "./solver.js";
import { type Vec3, vec3 } from "./vec3.js";
import type { FoldScene, SimMaterial } from "./build.js";

export type { FoldScene, SimMaterial };

/**
 * Origami Simulator material/solver constants (`js/globals.js`): EA 20, crease & panel
 * stiffness 0.7, face stiffness EA/100 = 0.2, percentDamping (ζ) 0.85, beam damping uploaded as
 * `getD()·0.5`. This is the single param set for every fold (origami and kirigami alike).
 */
export const ORIGAMI_PARAMS: SolverParams = {
  ...DEFAULT_PARAMS,
  EA: 20,
  kFold: 0.7,
  kFacet: 0.7,
  kFace: 0.2,
  zeta: 0.85,
  beamDampingScale: 0.5,
};

/**
 * 3D-PRINTED kirigami material: rigid tiles + soft fabric hinges. The KEY is the ratio
 * kFacet/kFace ≫ kFold — faces stay flat planes while only the fold lines articulate. EA is
 * bumped so panels barely stretch (computeDt auto-shrinks the step, so it stays stable, just
 * slower). `kGoal` is the soft-driven goal spring and `kBarrier` the thick-hinge closure barrier
 * (kBarrier ≫ kGoal so contact wins). Only used on the printed path; vinyl keeps ORIGAMI_PARAMS.
 */
export const PRINTED_PARAMS: SolverParams = {
  ...ORIGAMI_PARAMS,
  EA: 40, // stiffer panels (dt auto-shrinks); modest so the explicit integrator stays stable
  // Rigid POLYGON panels: each FKLD polygon is triangulated with interior facet ("F") diagonals; the
  // printed sheet must fold only at the real M/V panel hinges, NOT bend along those facet lines like
  // the vinyl sim. The facet stiffness `kFacet` ≫ `kFold` is what holds a polygon flat. At the old
  // 1.0 a polygon could buckle ~110° at its facet line mid-fold (e.g. house-door); 8.0 keeps it < 10°
  // across every example and stays stable (kFacet is torsional, so it does not shrink computeDt's
  // axial-only step). The `rigidFacets` cross-brace below adds an axial (dt-tracked) rigidity floor.
  kFold: 0.12,
  kFacet: 8.0,
  kFace: 0.5,
  zeta: 1.0,
  beamDampingScale: 0.8,
  kGoal: 0.6,
  kBarrier: 1.5,
  // Rigid polygon panels: cross-brace every facet ("F") diagonal so a polygon folds as one rigid
  // tile and the model only hinges at the real M/V panel boundaries (not the FKLD facet lines).
  rigidFacets: true,
};

/** Fabrication geometry for the printed thickness limit (mm). */
export interface PrintedParams {
  /** Tile thickness (printed wall, mm). */
  thicknessMm: number;
  /** Bare-fabric hinge gap between tiles at a fold line (mm). */
  gapMm: number;
}
export const DEFAULT_PRINTED: PrintedParams = { thicknessMm: 1.2, gapMm: 1.0 };

/**
 * Max fold angle θ toward the TILE side (θ=0 flat) before two rigid tiles of thickness t on one
 * face, bridged by a bare-cloth hinge gap g, collide: θ_max = 2·atan(g/t). Thinner tiles or wider
 * gaps fold more (t→0 ⇒ θ_max→π; g→0 ⇒ θ_max→0). Scale-invariant (depends only on g/t). One-sided:
 * the fabric-backing side has no such limit and folds freely (see TILE_COLLIDE_SIGN).
 */
export function printedThetaMax(p: PrintedParams): number {
  const t = Math.max(p.thicknessMm, 1e-6);
  return 2 * Math.atan(p.gapMm / t);
}

/** True when a fold file has the vertices/faces/edges needed to simulate. */
export function isFoldable(fold: FoldFile): boolean {
  return (
    Array.isArray(fold.vertices_coords) &&
    fold.vertices_coords.length >= 3 &&
    Array.isArray(fold.faces_vertices) &&
    fold.faces_vertices.length >= 1 &&
    Array.isArray(fold.edges_vertices) &&
    fold.edges_vertices.length >= 1
  );
}

const mapAssignment = (a: string | undefined): EdgeAssignment => {
  switch (a) {
    case "M":
    case "V":
    case "F":
    case "B":
    case "C":
      return a;
    default:
      return "B"; // "U"/unassigned/border → free boundary beam
  }
};

/**
 * Per-edge target dihedral (radians) BEFORE preprocessing, so the array stays parallel to
 * `edges_vertices` as `splitCuts`/`triangulatePolys` append edges. Priority: explicit
 * `edges_foldAngles` (radians) → `edges_foldAngle` (degrees) → assignment default (M −π, V +π,
 * F 0; boundary/unassigned null = not a crease). This is the Origami Simulator import policy
 * (`js/importer.js`): fold a flat crease pattern fully unless the file carries fold angles.
 */
function targetFoldAngles(fold: FoldFile): (number | null)[] {
  const ea = (fold.edges_assignment as string[] | undefined) ?? [];
  const faRad = fold.edges_foldAngles as (number | null)[] | undefined;
  const faDeg = fold.edges_foldAngle as (number | null)[] | undefined;
  return (fold.edges_vertices as number[][]).map((_e, i) => {
    const rad = faRad?.[i];
    if (typeof rad === "number" && Number.isFinite(rad)) return rad;
    const deg = faDeg?.[i];
    if (typeof deg === "number" && Number.isFinite(deg)) return (deg * Math.PI) / 180;
    switch (ea[i]) {
      case "M":
        return -Math.PI;
      case "V":
        return Math.PI;
      case "F":
        return 0;
      default:
        return null;
    }
  });
}

interface V3 {
  x: number;
  y: number;
  z: number;
}
const angleBetween = (u: V3, v: V3): number => {
  const lu = Math.hypot(u.x, u.y, u.z);
  const lv = Math.hypot(v.x, v.y, v.z);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const c = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
  return Math.acos(Math.max(-1, Math.min(1, c)));
};

/** Build the bar-and-hinge model from a processed (cut-split, triangulated) fold + crease params. */
function assembleModel(work: WorkFold, creaseParams: CreaseParams[], params: SolverParams): BarHingeModel {
  const coords = work.vertices_coords;
  const numNodes = coords.length;

  // --- centre on the bounding-box centre, scale to bounding-sphere radius 1 (OS sync) ---
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of coords) {
    for (let d = 0; d < 3; d++) {
      const x = c[d] ?? 0;
      lo[d] = Math.min(lo[d], x);
      hi[d] = Math.max(hi[d], x);
    }
  }
  const ctr = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let radius = 1e-9;
  for (const c of coords) {
    const dx = (c[0] ?? 0) - ctr[0];
    const dy = (c[1] ?? 0) - ctr[1];
    const dz = (c[2] ?? 0) - ctr[2];
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }
  const scale = 1 / radius;

  const position = new Float32Array(3 * numNodes);
  const rest = new Float32Array(3 * numNodes);
  const vertices: Vec3[] = [];
  for (let i = 0; i < numNodes; i++) {
    const x = ((coords[i][0] ?? 0) - ctr[0]) * scale;
    const y = ((coords[i][1] ?? 0) - ctr[1]) * scale;
    const z = ((coords[i][2] ?? 0) - ctr[2]) * scale;
    position[3 * i] = rest[3 * i] = x;
    position[3 * i + 1] = rest[3 * i + 1] = y;
    position[3 * i + 2] = rest[3 * i + 2] = z;
    vertices.push(vec3(x, y, z));
  }
  const p = (i: number): V3 => ({ x: rest[3 * i], y: rest[3 * i + 1], z: rest[3 * i + 2] });
  const dist = (a: number, b: number): number =>
    Math.hypot(rest[3 * a] - rest[3 * b], rest[3 * a + 1] - rest[3 * b + 1], rest[3 * a + 2] - rest[3 * b + 2]);

  // --- beams: one axial spring per edge (k = EA / l₀) ---
  // Rigid-panel mode (printed): also brace every facet ("F") diagonal with an axial spring between
  // the crease's two wing vertices. That diagonal can only change length if the polygon folds at the
  // facet line, so the brace holds coplanar triangles together as one rigid panel — the model then
  // hinges only at the real M/V panel boundaries. Axial, so `computeDt` keeps the step stable.
  const ev = work.edges_vertices;
  const braces: Array<[number, number]> = [];
  if (params.rigidFacets) {
    for (const [, wing1, , wing2, edgeIndex, angle] of creaseParams) {
      if (angle === 0) braces.push([wing1, wing2]); // angle 0 ⇔ facet "F" crease
    }
  }
  const nBeams = ev.length + braces.length;
  const beams = {
    count: nBeams,
    n0: new Int32Array(nBeams),
    n1: new Int32Array(nBeams),
    rest: new Float32Array(nBeams),
    k: new Float32Array(nBeams),
  };
  for (let i = 0; i < ev.length; i++) {
    beams.n0[i] = ev[i][0];
    beams.n1[i] = ev[i][1];
    const l0 = Math.max(dist(ev[i][0], ev[i][1]), 1e-9);
    beams.rest[i] = l0;
    beams.k[i] = params.EA / l0;
  }
  for (let b = 0; b < braces.length; b++) {
    const i = ev.length + b;
    beams.n0[i] = braces[b][0];
    beams.n1[i] = braces[b][1];
    const l0 = Math.max(dist(braces[b][0], braces[b][1]), 1e-9);
    beams.rest[i] = l0;
    beams.k[i] = params.EA / l0;
  }

  // --- creases: one torsional spring per M/V/F edge (from winding-consistent creaseParams) ---
  const creases = {
    count: creaseParams.length,
    n1: new Int32Array(creaseParams.length),
    n2: new Int32Array(creaseParams.length),
    n3: new Int32Array(creaseParams.length),
    n4: new Int32Array(creaseParams.length),
    face1: new Int32Array(creaseParams.length),
    face2: new Int32Array(creaseParams.length),
    k: new Float32Array(creaseParams.length),
    targetTheta: new Float32Array(creaseParams.length),
    assignment: new Array<EdgeAssignment>(creaseParams.length),
  };
  for (let i = 0; i < creaseParams.length; i++) {
    const [face1, wing1, face2, wing2, edgeIndex, angle] = creaseParams[i];
    creases.face1[i] = face1;
    creases.face2[i] = face2;
    creases.n1[i] = wing1;
    creases.n2[i] = wing2;
    creases.n3[i] = ev[edgeIndex][0];
    creases.n4[i] = ev[edgeIndex][1];
    const l0 = Math.max(dist(creases.n3[i], creases.n4[i]), 1e-9);
    const type1 = angle !== 0; // type 1 = mountain/valley crease; type 0 = facet driven flat
    creases.k[i] = (type1 ? params.kFold : params.kFacet) * l0;
    creases.targetTheta[i] = angle;
    creases.assignment[i] = mapAssignment(work.edges_assignment[edgeIndex]);
  }

  // --- faces: nominal interior angles in the flat (rest) state ---
  const fv = work.faces_vertices;
  const faces = {
    count: fv.length,
    a: new Int32Array(fv.length),
    b: new Int32Array(fv.length),
    c: new Int32Array(fv.length),
    nominalAngles: new Float32Array(3 * fv.length),
    normal: new Float32Array(3 * fv.length),
  };
  for (let f = 0; f < fv.length; f++) {
    const [ia, ib, ic] = fv[f];
    faces.a[f] = ia;
    faces.b[f] = ib;
    faces.c[f] = ic;
    const A = p(ia);
    const B = p(ib);
    const C = p(ic);
    faces.nominalAngles[3 * f] = angleBetween(sub(B, A), sub(C, A));
    faces.nominalAngles[3 * f + 1] = angleBetween(sub(A, B), sub(C, B));
    faces.nominalAngles[3 * f + 2] = angleBetween(sub(A, C), sub(B, C));
  }

  const meta: FoldNet["meta"] = {
    N: 0,
    scale,
    R: 0,
    s: 1,
    H: 1,
    gamma: Math.PI,
    theta: 0,
    rApex: 0,
  };

  return {
    numNodes,
    position,
    rest,
    velocity: new Float32Array(3 * numNodes),
    force: new Float32Array(3 * numNodes),
    mass: new Float32Array(numNodes).fill(1),
    fixed: new Uint8Array(numNodes),
    goal: rest.slice(),
    driven: new Uint8Array(numNodes),
    beams,
    creases,
    faces,
    params,
    meta,
  };
}

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** Clamp a measured design target just short of the ±π flat-fold singularity. */
const MAX_FOLD = 2.7;
const clampFold = (t: number): number => Math.max(-MAX_FOLD, Math.min(MAX_FOLD, t));

/** Mean |l/l₀ − 1| over beams at the model's current positions (goal-frame isometry check). */
function beamStrainAt(model: BarHingeModel): number {
  const p = model.position;
  let sum = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    const l = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
    sum += Math.abs(l / model.beams.rest[i] - 1);
  }
  return sum / Math.max(1, model.beams.count);
}

/**
 * **Adaptive fold-mode inference.** Reads the nature of the kirigami it is given and configures
 * the SAME paper engine accordingly:
 *
 *  - If the FKLD declares a folded-form footprint — a `foldedForm` frame + `fkld:vertices_driven`
 *    (the generator's statement of "this is the 3D shape I lift into and these boundary nodes hold
 *    it") — we **drive that minimal boundary** to its designed positions so the forward fold lands
 *    the intended shape. This is how a floppy kirigami (e.g. the AKDE pyramid, whose cone is not a
 *    free equilibrium) cones instead of splaying. It is **not** pyramid-specific: any kirigami that
 *    declares a footprint is guided to it.
 *  - Otherwise the model is left **free** (no driven nodes) and folds by crease targets alone —
 *    exactly the paper's uniform method (origami, honeycomb kirigami, anything self-supporting).
 *
 * Goal alignment is translation-only, matching the driven nodes' centroids (the flat sheet and the
 * declared goal need not share a frame). Crease targets are measured from the goal only where it is
 * **trustworthy** — globally isometric, or a crease whose four nodes are all driven — because a
 * declared goal can be a chimera (real positions for driven vertices, flat coords for the rest);
 * elsewhere the assignment-default target already on the crease is kept.
 *
 * Returns true iff the model was guided.
 */
function applyDeclaredGoal(fold: FoldFile, work: WorkFold, model: BarHingeModel): boolean {
  const f = fold as {
    file_frames?: Array<{ frame_classes?: string[]; vertices_coords?: number[][] }>;
    "fkld:vertices_driven"?: number[];
  };
  const drivenDecl = f["fkld:vertices_driven"];
  const nOrig = (fold.vertices_coords as number[][]).length;
  const folded = f.file_frames?.find(
    (fr) =>
      Array.isArray(fr.vertices_coords) &&
      fr.vertices_coords.length === nOrig &&
      (fr.frame_classes ?? []).includes("foldedForm"),
  );
  if (!folded?.vertices_coords || !Array.isArray(drivenDecl) || !drivenDecl.some((d) => d)) return false;

  const origin = work.originOf ?? Array.from({ length: model.numNodes }, (_v, i) => i);
  const scale = model.meta.scale;
  const g = folded.vertices_coords;
  const goalScaled = (n: number): [number, number, number] => {
    const gv = g[origin[n]] ?? [0, 0, 0];
    return [(gv[0] ?? 0) * scale, (gv[1] ?? 0) * scale, (gv[2] ?? 0) * scale];
  };

  // Align goal to rest by matching the driven nodes' centroids (translation only).
  let rx = 0, ry = 0, rz = 0, gx = 0, gy = 0, gz = 0, cnt = 0;
  for (let n = 0; n < model.numNodes; n++) {
    if (!drivenDecl[origin[n]]) continue;
    rx += model.rest[3 * n]; ry += model.rest[3 * n + 1]; rz += model.rest[3 * n + 2];
    const gs = goalScaled(n);
    gx += gs[0]; gy += gs[1]; gz += gs[2]; cnt++;
  }
  if (cnt === 0) return false;
  const t = [rx / cnt - gx / cnt, ry / cnt - gy / cnt, rz / cnt - gz / cnt];

  for (let n = 0; n < model.numNodes; n++) {
    const gs = goalScaled(n);
    model.goal[3 * n] = gs[0] + t[0];
    model.goal[3 * n + 1] = gs[1] + t[1];
    model.goal[3 * n + 2] = gs[2] + t[2];
    if (drivenDecl[origin[n]]) {
      model.driven[n] = 1;
      model.fixed[n] = 1; // force passes never move a driven node; the solver drives it kinematically
    }
  }

  // Measure design crease targets from the goal where it is trustworthy.
  const flat = model.position.slice();
  model.position.set(model.goal);
  const goalConsistent = beamStrainAt(model) < 0.05;
  const c = model.creases;
  for (let i = 0; i < c.count; i++) {
    const allDriven =
      model.driven[c.n1[i]] === 1 &&
      model.driven[c.n2[i]] === 1 &&
      model.driven[c.n3[i]] === 1 &&
      model.driven[c.n4[i]] === 1;
    if (goalConsistent || allDriven) {
      c.targetTheta[i] = clampFold(measureTheta(model, c.face1[i], c.face2[i], c.n3[i], c.n4[i]));
    }
  }
  model.position.set(flat);
  return true;
}

/**
 * Build a renderer-facing FoldNet (vertices/faces/edges + meta) from the assembled model.
 *
 * `cutPairs` holds the ORIGINAL (pre-split) vertex pairs that were `"C"` cuts, keyed by
 * `min_max`. `splitCuts` relabels every cut lip to `"B"` so the solver treats it as a free
 * boundary beam; here we recover the cut identity (via `work.originOf`, which maps each split
 * vertex back to its source vertex) and re-tag those lips `"C"` so the renderer draws them as
 * cut lines, not as silhouette. Display only — the solver reads beams/creases, not net edges.
 */
function netFromModel(work: WorkFold, model: BarHingeModel, cutPairs: Set<string>): FoldNet {
  const vertices: Vec3[] = [];
  for (let i = 0; i < model.numNodes; i++) {
    vertices.push(vec3(model.position[3 * i], model.position[3 * i + 1], model.position[3 * i + 2]));
  }
  const faces = work.faces_vertices.map((f) => [f[0], f[1], f[2]] as [number, number, number]);
  const origin = work.originOf;
  const edges: FoldNetEdge[] = [];
  for (let i = 0; i < work.edges_vertices.length; i++) {
    const a = work.edges_vertices[i][0];
    const b = work.edges_vertices[i][1];
    let assignment = mapAssignment(work.edges_assignment[i]);
    if (assignment === "B" && origin && cutPairs.size) {
      const oa = origin[a], ob = origin[b];
      if (oa != null && ob != null && cutPairs.has(oa < ob ? `${oa}_${ob}` : `${ob}_${oa}`)) {
        assignment = "C";
      }
    }
    edges.push({
      a: Math.min(a, b),
      b: Math.max(a, b),
      assignment,
      rest: model.beams.rest[i],
      faces: [],
    });
  }
  return {
    vertices,
    faces,
    edges,
    base: [],
    basePairs: [],
    valleyOuter: [],
    tips: [],
    meta: model.meta,
  };
}

/**
 * Build a runnable fold scene from any FOLD/FKLD file. Kirigami cuts open, origami folds — one
 * uniform path. `scene.solver.foldPercent` ramps 0→1 to animate the fold.
 */
/** Build options. `splitCuts` (default true) opens kirigami cuts; the verify pipeline disables it
 *  to keep the welded-seam fold its goal frames were authored against. */
export interface BuildSceneOptions {
  splitCuts?: boolean;
  /** 3D-printed mode: rigid tiles + thickness-limited closure. Default false (vinyl). */
  printed?: boolean;
  /** Printed thickness/gap (mm); defaults to the file's meta or DEFAULT_PRINTED. */
  printedParams?: PrintedParams;
}

export function buildSceneFromFold(
  fold: FoldFile,
  params: SolverParams = ORIGAMI_PARAMS,
  opts: BuildSceneOptions = {},
): FoldScene {
  if (!isFoldable(fold)) throw new Error("FOLD file lacks vertices/faces/edges to simulate.");

  const work: WorkFold = {
    vertices_coords: (fold.vertices_coords as number[][]).map((c) => c.slice()),
    edges_vertices: (fold.edges_vertices as number[][]).map((e) => e.slice()),
    edges_assignment: ((fold.edges_assignment as string[] | undefined) ?? []).slice(),
    edges_foldAngles: targetFoldAngles(fold),
    faces_vertices: (fold.faces_vertices as number[][]).map((f) => f.slice()),
  };

  // Original cut edges (pre-split, source vertex indices) so the renderer can re-tag the lips
  // `splitCuts` flattens to `"B"` back to `"C"` — see netFromModel.
  const cutPairs = new Set<string>();
  const origEdges = fold.edges_vertices as number[][] | undefined;
  const origAssign = fold.edges_assignment as string[] | undefined;
  if (origEdges && origAssign) {
    for (let i = 0; i < origEdges.length; i++) {
      if (origAssign[i] !== "C") continue;
      const [a, b] = origEdges[i];
      cutPairs.add(a < b ? `${a}_${b}` : `${b}_${a}`);
    }
  }

  const { fold: processed, creaseParams } = processFold(work, { splitCuts: opts.splitCuts ?? true });
  const model = assembleModel(processed, creaseParams, params);
  // Adaptive: drive a declared folded-form footprint if the file states one; else free fold.
  const driven = applyDeclaredGoal(fold, processed, model);

  // 3D-printed: rigid tiles can't close past the thickness limit. Set per-crease θ_max + clamp
  // the design targets (handles free-fold patterns); for driven files additionally relax the goal
  // pose so the kinematically-pinned hinges physically open to ≤ θ_max.
  if (opts.printed) {
    const pp = opts.printedParams ?? printedParamsFromMeta(fold) ?? DEFAULT_PRINTED;
    applyPrintedClosure(model, pp);
    if (driven) relaxPrintedGoal(model);
  }

  const net = netFromModel(processed, model, cutPairs);
  const solver = new FoldSolver(model);
  return { net, model, solver, material: opts.printed ? "printed" : "vinyl" };
}

/** Read printed thickness from the file's architecture meta, if present (gap stays default). */
function printedParamsFromMeta(fold: FoldFile): PrintedParams | null {
  const arch = (fold as Record<string, unknown>)["fkld:meta_architecture"] as
    | { materialThickness?: number }
    | undefined;
  const t = arch?.materialThickness;
  return typeof t === "number" && t > 0 ? { thicknessMm: t, gapMm: DEFAULT_PRINTED.gapMm } : null;
}

/**
 * Set each crease's thickness limit θ_max (printed mode) and clamp its design target on the
 * tile-collide side only. The tiles sit on one face (the +normal side, `TILE_COLLIDE_SIGN`), so
 * folding toward them is capped at θ_max while the fabric-backing side keeps its full target and
 * folds freely (one-sided closure; the runtime barrier in `forces.ts` enforces the same side).
 */
function applyPrintedClosure(model: BarHingeModel, pp: PrintedParams): void {
  const thetaMax = printedThetaMax(pp);
  const c = model.creases;
  c.thetaMax = new Float32Array(c.count);
  for (let i = 0; i < c.count; i++) {
    c.thetaMax[i] = thetaMax;
    if (TILE_COLLIDE_SIGN * c.targetTheta[i] > thetaMax) c.targetTheta[i] = TILE_COLLIDE_SIGN * thetaMax;
  }
}

/**
 * Build-time goal relaxation for driven (guided) printed files: the declared goal pose may close
 * hinges past θ_max (it was authored thickness-free). Soft-drive from the goal with the thick-hinge
 * barriers active, settle, and freeze the result as the new goal — so the runtime hard-drive lands
 * on a thickness-respecting pose where tiles stop short of colliding. Keeps the live loop stable.
 */
function relaxPrintedGoal(model: BarHingeModel): void {
  const savedFixed = model.fixed.slice();
  const savedPos = model.position.slice();
  const savedVel = model.velocity.slice();

  for (let i = 0; i < model.numNodes; i++) if (model.driven[i]) model.fixed[i] = 0; // unpin
  model.softDriven = true;
  model.position.set(model.goal);
  model.velocity.fill(0);

  const solver = new FoldSolver(model);
  solver.foldPercent = 1;
  solver.solveUntilSettled({ maxIters: 3000, keEps: 1e-7, quench: true, guard: true });

  model.goal.set(model.position); // relaxed, thickness-respecting goal

  model.softDriven = false; // runtime drives hard to the relaxed goal
  model.fixed.set(savedFixed);
  model.position.set(savedPos);
  model.velocity.set(savedVel);
}
