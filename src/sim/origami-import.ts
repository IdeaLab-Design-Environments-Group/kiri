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
import { buildCreaseTree, kinematicPose, spreadAnchors, type CreaseTree } from "./fold-kinematics.js";
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
  // Soft guide toward a declared folded form (see applyDeclaredGoal). Below the axial bars
  // (k_axial = EA/l₀ ≈ 40–100 at this scale) so the bars and creases still decide the shape, but
  // firm enough to pick WHICH branch the fold takes — below ~4 the house lands in a wrong branch
  // (creases over 100° out) as often as not, and far above it the guide starts pulling bars toward
  // the straight-line chord it aims at and crushing them. It is released entirely once the fold lands.
  kGoal: 4,
  // Seam springs (glued tab / taped edge) — same order as the axial bars, k_axial = EA/l₀ ≈ 40–100
  // at this scale: a glue line is not weaker than the sheet it joins.
  kSeam: 20,
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
    // 1 = the bar lies on a FREE EDGE of the sheet (boundary or cut lip), which cannot carry
    // compression — see the slack rule in forces.ts.
    free: new Uint8Array(nBeams),
  };
  for (let i = 0; i < ev.length; i++) {
    const a = work.edges_assignment[i];
    beams.free[i] = a === "B" || a === "C" || a === undefined ? 1 : 0;
  }
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
 *    it") — the declared form is used **twice over**: its dihedral angles become the design crease
 *    targets (below), and its vertex positions become a **weak, fading guide spring** (`softGuide`)
 *    on the declared nodes. This is how a floppy kirigami (e.g. the AKDE pyramid, whose cone is not
 *    a free equilibrium) cones instead of splaying. It is **not** pyramid-specific: any kirigami
 *    that declares a footprint is guided to it.
 *
 *    The guide is a FORCE, never a placement. Hard-pinning the declared nodes (what this used to do)
 *    is fatal when a file declares every vertex driven — the fold degenerates into a straight-line
 *    blend rest→goal, which is not an isometry: bars stretch or collapse by up to 100% mid-fold,
 *    layers pass through each other, and the self-collision pass skips every node because it skips
 *    `fixed` ones. Guiding softly keeps every frame a force equilibrium of the bar-and-hinge model,
 *    the way Origami Simulator's crease-target fold is; and because the guide is RELEASED once the
 *    fold reaches its target (`guideWeight` → 0), the final pose must hold under the pattern's own
 *    creases and seams rather than be held there by an external field.
 *    Printed mode uses this same force-driven path. Its rigid-panel stiffness and thickness barrier
 *    change the equilibrium, but positions remain solver output rather than a second keyframe path.
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
function applyDeclaredGoal(
  fold: FoldFile,
  work: WorkFold,
  model: BarHingeModel,
  softGuide: boolean,
): boolean {
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
      // A normal viewer scene is soft-guided — no pin, so bars, creases, thickness barriers and
      // self-collision all still act on this node. The verification transport audit is the sole
      // caller that explicitly requests a hard pin.
      if (!softGuide) model.fixed[n] = 1;
    }
  }
  // Guide with a weak, fading spring instead of prescribing positions. A file may declare
  // EVERY vertex driven (house.fkld: 18 of 18), and hard-pinning them all reduces the "simulation"
  // to a per-vertex straight-line blend rest→goal — not an isometry, so mid-fold bars stretched or
  // collapsed by up to 100%, faces swept through each other, and `collision.ts` (which skips fixed
  // nodes) never ran. Positions must be an output of the force passes, never an input to them.
  if (softGuide) {
    model.softDriven = true;
    model.guideWeight = 1; // the viewer takes this to 0 at the end of the fold — see BarHingeModel
    buildSeams(model);
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
  if (softGuide) buildSeamCreases(model); // measures its own targets in this same goal pose
  model.position.set(flat);
  if (softGuide) adoptFoldKinematics(model);
  return true;
}

/**
 * How far the kinematic fold may land from the declared form before it is not that form's fold,
 * as a fraction of the model's span.
 *
 * There is no judgement call here to make, because the measured population has no middle: every net
 * that admits a coordinated fold lands its declared form to **0.000%** — house, church and puffin,
 * and kirigami-flap too, whose one loop closes on a facet crease of target zero — while akde-hex, a
 * form no fold can reach (34% strain on its own bars), misses by **88.7%**. So the threshold is set
 * near the passing side rather than midway: it need only be above measurement noise, and every
 * thousandth it is raised is slack a net that does NOT fold to its form can hide in.
 *
 * That slack was the bug. At the old 0.02 with a poorly conditioned metric (see `spreadAnchors`), a
 * net whose panel graph carries loops the tree ignores would land its form badly wrong, report well
 * under tolerance, and be driven as though it were a tree — the panels those loops placed swinging
 * off on their own while the modal said "coordinated". A fold that is really coordinated has margin
 * of four hundred times over this number; one that needs the slack was never entitled to it.
 */
const CLOSURE_TOL = 0.002;
/**
 * Seam reach on the kinematic path, replacing `SEAM_CAPTURE`'s 0.35 of a span.
 *
 * A seam spring exists to close a fold the guide could not: aiming down the chord, nothing else
 * brings a cut's two lips together, so the spring has to reach across the sheet and haul. The
 * kinematic guide already delivers them coincident at `s = 1` by construction, so that long reach
 * becomes a second driver of the fold — and it drives it early. Measured on house it takes the fold
 * to 94% of its target angles at a slider of 0.8; the same run with the seams removed entirely reads
 * 80%, dead on. Shortened to hold rather than haul, the fold tracks the slider to within a point on
 * every preset and lands closer as well.
 */
const KINEMATIC_SEAM_CAPTURE = 0.03;
/**
 * Guide stiffness on the kinematic path, against `ORIGAMI_PARAMS.kGoal`'s 4.
 *
 * The guide was kept far below the axial bars for a reason: aimed down the chord it asks for a pose
 * that is not an isometry, so leaning on it would drag bars off their rest length — the very thing
 * that made the old fold a blend. Aimed along the net's own kinematics that reason is gone, because
 * the target IS a rigid-panel fold; pulling hard toward it cannot stretch anything, and measured, it
 * does not (0.00% at every fraction). What holding firmly buys is the anchor: the panel the artifact
 * rests on stays within 0.9% of a span through the whole fold instead of 5%, without being nailed.
 * The guide still lets go at the end, so the settled pose is still the pattern's own.
 */
const KINEMATIC_KGOAL = 64;

/**
 * Drive the fold along the net's own panel kinematics, if the net admits one.
 *
 * The test is not "is the panel graph a tree" but the stronger thing it is a proxy for: **does
 * folding every hinge to its target actually reproduce the declared form?** Measured, house, church
 * and puffin land it to 0.000% of a span, and so does kirigami-flap — its one loop closes on a facet
 * crease whose target is zero, so the tree fold shuts it exactly. The AKDE cones miss by 74–76%,
 * which is their declared form asking for something no fold can do (34% and 118% strain on their own
 * bars); they keep the chord guide, and the modal says so.
 *
 * Two things follow for a net that passes:
 *
 *  - **The goal is re-placed.** The declared form is only ever used up to rigid motion — seams are
 *    coincidences, crease targets are dihedrals, the wrong-side test is relative — so `model.goal`
 *    becomes the kinematic pose at `s = 1`: the same shape, positioned so the root panel sits exactly
 *    where the flat sheet leaves it. Now `s = 0` is the flat sheet and `s = 1` is the goal exactly,
 *    and no rigid drift is demanded of the sheet at either end.
 *  - **The fold is reckoned from the panel the artifact rests on** — the one the folded form puts
 *    lowest. It stays where the flat sheet leaves it and everything else swings up from it, like
 *    paper on a table. It is held there by the guide, as a FORCE, and not pinned: a pinned node is a
 *    position written into the model, `forces.ts` zeroes it and `collision.ts` skips it, so the panel
 *    would be the one part of the sheet not actually being simulated. Measured, nailing it buys
 *    nothing — the shape puffin settles into is the same to within 0.01% of a span either way, and
 *    the difference in where it *lands* (0.11% against 2.61%) is pure rigid drift of an artifact
 *    whose shape is equally exact.
 */
function adoptFoldKinematics(model: BarHingeModel): void {
  const tree = buildCreaseTree(model);
  const pose = new Float32Array(3 * model.numNodes);
  kinematicPose(model, tree, 1, pose);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 3 * model.numNodes; i++) {
    if (model.goal[i] < lo) lo = model.goal[i];
    if (model.goal[i] > hi) hi = model.goal[i];
  }
  const span = hi > lo ? hi - lo : 1;

  // Compared through distances to a handful of anchor nodes rather than by fitting one pose onto the
  // other: that is rigid-invariant (which is the only way the two are allowed to differ) and needs no
  // alignment — and the Kabsch fit that would do it lives in `pipeline/verify.ts`, which imports this
  // module. A mirrored fold is excluded on other grounds: this pose's dihedrals ARE the targets,
  // measured off the declared form, so a reflection of it would have to disagree with them.
  //
  // The anchors must be SPREAD, and that is not a detail. Distances to anchors read a node's error
  // only along the directions from the node to each anchor, so anchors that huddle together read a
  // sideways swing at `sin` of the angle they subtend — a net folds wrong and the number stays small.
  // Measured with the root panel's three corners as the anchors, blindness tracked exactly the size
  // of that one triangle: house's spans 49% of the model and hid a 1.7× error, church's 19% hid 8×,
  // and puffin's 5.2% reported a real MISS OF 10.7% OF THE SPAN as 0.55% — a tenth of the model, well
  // under the 2% tolerance. Finer meshes have smaller triangles, so the check got blinder the more it
  // had to check. Farthest-point sampling instead: the extremes of the form, four of them so they are
  // not coplanar, which pins a point outright with no reflection ambiguity either.
  const anchors = spreadAnchors(model.goal, model.numNodes, 4);
  let closure = 0;
  for (let i = 0; i < model.numNodes; i++) {
    for (const a of anchors) {
      const dp = Math.hypot(
        pose[3 * i] - pose[3 * a],
        pose[3 * i + 1] - pose[3 * a + 1],
        pose[3 * i + 2] - pose[3 * a + 2],
      );
      const dg = Math.hypot(
        model.goal[3 * i] - model.goal[3 * a],
        model.goal[3 * i + 1] - model.goal[3 * a + 1],
        model.goal[3 * i + 2] - model.goal[3 * a + 2],
      );
      closure = Math.max(closure, Math.abs(dp - dg));
    }
  }
  model.foldClosure = closure / span;
  if (closure > CLOSURE_TOL * span) {
    model.foldDrive = "chord";
    return;
  }

  model.foldDrive = "kinematic";
  model.creaseTree = tree;
  // A copy: `params` is the module-level ORIGAMI_PARAMS, shared by every model built from it.
  model.params = { ...model.params, seamCapture: KINEMATIC_SEAM_CAPTURE, kGoal: KINEMATIC_KGOAL };

  // Fold UP off the table, not down through it. Which side the shape ends up on is fixed by the
  // crease signs, not by the choice of root — measured, every one of house's 16 panels, church's 19
  // and puffin's 96 gives a fold that descends — so the only way to turn it over is to turn the
  // whole scene over. A half-turn about an axis lying IN the root panel's plane does exactly that:
  // the flat sheet stays flat and stays in that plane (it is the paper turned over, the same net
  // seen from its other face), while everything the fold raises swaps sides. Rest, current pose and
  // goal all move together, so it is a rigid motion of the scene and no length, angle or coincidence
  // in the model changes.
  if (foldsAwayFromRoot(model, tree, pose)) {
    turnOver(model, tree);
    kinematicPose(model, tree, 1, pose); // hinge axes are read off `rest`, so re-fold after moving it
  }
  model.goal.set(pose);
}

/** True when the folded shape sits on the far side of the root panel from the root's own normal. */
function foldsAwayFromRoot(model: BarHingeModel, tree: CreaseTree, pose: Float32Array): boolean {
  const { c, n } = rootPlane(model, tree, pose);
  let far = 0;
  for (let i = 0; i < model.numNodes; i++) {
    far +=
      (pose[3 * i] - c[0]) * n[0] + (pose[3 * i + 1] - c[1]) * n[1] + (pose[3 * i + 2] - c[2]) * n[2];
  }
  return far < 0;
}

/** Centroid and outward normal of the root panel, in a given pose. */
function rootPlane(
  model: BarHingeModel,
  tree: CreaseTree,
  pose: Float32Array,
): { c: [number, number, number]; n: [number, number, number]; u: [number, number, number] } {
  const a = model.faces.a[tree.root], b = model.faces.b[tree.root], d = model.faces.c[tree.root];
  const P = (i: number): [number, number, number] => [pose[3 * i], pose[3 * i + 1], pose[3 * i + 2]];
  const pa = P(a), pb = P(b), pd = P(d);
  const c: [number, number, number] = [(pa[0] + pb[0] + pd[0]) / 3, (pa[1] + pb[1] + pd[1]) / 3, (pa[2] + pb[2] + pd[2]) / 3];
  const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
  const vx = pd[0] - pa[0], vy = pd[1] - pa[1], vz = pd[2] - pa[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ul = Math.hypot(ux, uy, uz) || 1;
  return { c, n: [nx / nl, ny / nl, nz / nl], u: [ux / ul, uy / ul, uz / ul] };
}

/** Half-turn of rest, pose and goal about an axis in the root panel's plane. */
function turnOver(model: BarHingeModel, tree: CreaseTree): void {
  const { c, u } = rootPlane(model, tree, model.rest);
  // Rotation by π about a unit axis u is 2uuᵀ − I.
  const R = [
    2 * u[0] * u[0] - 1, 2 * u[0] * u[1], 2 * u[0] * u[2],
    2 * u[1] * u[0], 2 * u[1] * u[1] - 1, 2 * u[1] * u[2],
    2 * u[2] * u[0], 2 * u[2] * u[1], 2 * u[2] * u[2] - 1,
  ];
  for (const arr of [model.rest, model.position, model.goal]) {
    for (let i = 0; i < model.numNodes; i++) {
      const x = arr[3 * i] - c[0], y = arr[3 * i + 1] - c[1], z = arr[3 * i + 2] - c[2];
      arr[3 * i] = c[0] + R[0] * x + R[1] * y + R[2] * z;
      arr[3 * i + 1] = c[1] + R[3] * x + R[4] * y + R[5] * z;
      arr[3 * i + 2] = c[2] + R[6] * x + R[7] * y + R[8] * z;
    }
  }
}

/** Two nodes are the same joint when the declared goal puts them this close, relative to its span. */
const SEAM_TOL_REL = 1e-3;

/**
 * Read the artifact's seams off the declared folded form: every pair of distinct nodes the goal
 * places at the same point is a join the fabrication makes — a cut's two lips brought together, a
 * tab glued to its edge, the tips that converge at a cone's apex. See `BarHingeModel.seams` for why
 * nothing else in the model expresses this and what goes wrong without it.
 *
 * Pairs already tied by a bar are skipped (a bar of length ≈ 0 would be a stiffness singularity —
 * `k_axial = EA/l₀` — and the bar already holds them). Candidates are found through a grid hash at
 * the tolerance, so this stays linear in node count rather than quadratic.
 */
function buildSeams(model: BarHingeModel): void {
  const g = model.goal;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 3 * model.numNodes; i++) {
    if (g[i] < lo) lo = g[i];
    if (g[i] > hi) hi = g[i];
  }
  const span = hi - lo;
  if (!(span > 0)) return;
  const tol = SEAM_TOL_REL * span;

  const bonded = new Set<number>();
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    bonded.add(a < b ? a * model.numNodes + b : b * model.numNodes + a);
  }

  const cell = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string =>
    `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
  for (let i = 0; i < model.numNodes; i++) {
    const k = key(g[3 * i], g[3 * i + 1], g[3 * i + 2]);
    const bucket = cell.get(k);
    if (bucket) bucket.push(i);
    else cell.set(k, [i]);
  }

  const n0: number[] = [];
  const n1: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < model.numNodes; i++) {
    const gx = g[3 * i], gy = g[3 * i + 1], gz = g[3 * i + 2];
    const cx = Math.floor(gx / tol), cy = Math.floor(gy / tol), cz = Math.floor(gz / tol);
    // the point may sit anywhere in its cell, so neighbours within tol can be one cell over
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cell.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // each pair once
            if (bonded.has(i * model.numNodes + j)) continue;
            const d = Math.hypot(gx - g[3 * j], gy - g[3 * j + 1], gz - g[3 * j + 2]);
            if (d > tol) continue;
            n0.push(i);
            n1.push(j);
            rest.push(d);
          }
        }
  }
  if (n0.length === 0) return;
  model.seams = {
    count: n0.length,
    n0: Int32Array.from(n0),
    n1: Int32Array.from(n1),
    rest: Float32Array.from(rest),
    k: model.params.kSeam ?? 0,
  };
}

/**
 * **A taped seam is a hinge, not just a join.** `buildSeams` holds a cut's two lips at the same
 * point; that is a pin, and a pin has no preferred angle. The two panels it joins were free to
 * scissor about it, so the shape had to be found by the guide and then hoped to survive the release.
 *
 * A closed shape cannot avoid these joints. house.fkld's solid has 7 faces and 15 polygon edges, so
 * a flat net keeps at most a spanning tree of 6 of them as folds — the file has exactly 6 `"M"`, the
 * maximum — and the remaining 9 must be cut into 18 lips and taped back together. Two thirds of that
 * house's real fold lines are seams. Modelling them as bare pins throws away two thirds of the
 * structure that holds it up.
 *
 * So every lip pair the goal brings together also gets a torsional spring, with the dihedral the
 * declared form puts between the two lips' faces as its target — identical in every respect to an
 * `"M"` crease, because in the folded artifact that is what it is.
 *
 * Two details make the sign work out. The hinge line is lip A's own nodes, and lip B's face is
 * torqued about it: legitimate only because the seam springs hold the lips coincident, which is why
 * this exists alongside `buildSeams` rather than instead of it. And the target is measured with the
 * SAME `measureTheta` the force uses, so whichever way the two lips wind relative to each other, the
 * target carries the matching sign. In the flat sheet every face normal is +z, so θ starts at 0 and
 * the ramp `targetTheta · foldPercent` opens the seam from flat exactly as it opens a crease.
 */
function buildSeamCreases(model: BarHingeModel): void {
  const seams = model.seams;
  if (!seams || seams.count === 0) return;

  // node → the nodes the goal welds it to (a lip pair may also share an endpoint, e.g. a slit's
  // hinge corner, so each node counts as its own partner too).
  const partners = new Map<number, number[]>();
  const addPartner = (a: number, b: number): void => {
    const list = partners.get(a);
    if (list) list.push(b);
    else partners.set(a, [b]);
  };
  for (let i = 0; i < model.numNodes; i++) addPartner(i, i);
  for (let i = 0; i < seams.count; i++) {
    addPartner(seams.n0[i], seams.n1[i]);
    addPartner(seams.n1[i], seams.n0[i]);
  }

  // edge → the faces on it, with the wing vertex opposite the edge in each.
  const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const onEdge = new Map<string, { face: number; wing: number }[]>();
  const f = model.faces;
  for (let i = 0; i < f.count; i++) {
    const tri = [f.a[i], f.b[i], f.c[i]];
    for (let k = 0; k < 3; k++) {
      const a = tri[k], b = tri[(k + 1) % 3], wing = tri[(k + 2) % 3];
      const kk = key(a, b);
      const list = onEdge.get(kk);
      if (list) list.push({ face: i, wing });
      else onEdge.set(kk, [{ face: i, wing }]);
    }
  }

  // Pair up free edges (one face) that the goal lays on top of one another.
  const lip = (a: number, b: number): { face: number; wing: number } | null => {
    const list = onEdge.get(key(a, b));
    return list && list.length === 1 ? list[0] : null;
  };
  const paired = new Set<string>();
  const n1: number[] = [], n2: number[] = [], n3: number[] = [], n4: number[] = [];
  const face1: number[] = [], face2: number[] = [], kk: number[] = [];
  const peer3: number[] = [], peer4: number[] = [];
  for (const [ek, list] of onEdge) {
    if (list.length !== 1) continue;
    const [as, bs] = ek.split("_");
    const a0 = Number(as), a1 = Number(bs);
    if (paired.has(ek)) continue;
    let found: { b0: number; b1: number; ek: string; lip: { face: number; wing: number } } | null = null;
    for (const b0 of partners.get(a0) ?? []) {
      for (const b1 of partners.get(a1) ?? []) {
        if (b0 === b1) continue;
        const bk = key(b0, b1);
        if (bk === ek || paired.has(bk)) continue;
        const other = lip(b0, b1);
        if (other) found = { b0, b1, ek: bk, lip: other };
        if (found) break;
      }
      if (found) break;
    }
    if (!found) continue;
    paired.add(ek);
    paired.add(found.ek);
    n3.push(a0);
    n4.push(a1);
    face1.push(list[0].face);
    n1.push(list[0].wing);
    face2.push(found.lip.face);
    n2.push(found.lip.wing);
    kk.push(Math.max(nodeDist(model, a0, a1), 1e-9));
    peer3.push(found.b0);
    peer4.push(found.b1);
  }
  if (n3.length === 0) return;

  // Grow the crease arrays. The solver is built after this, so it sizes itself to the new count.
  const c = model.creases;
  const n = c.count + n3.length;
  const grow = <T extends Int32Array | Float32Array>(src: T, make: (len: number) => T): T => {
    const out = make(n);
    out.set(src.subarray(0, c.count));
    return out;
  };
  const next = {
    ...c,
    count: n,
    n1: grow(c.n1, (l) => new Int32Array(l)),
    n2: grow(c.n2, (l) => new Int32Array(l)),
    n3: grow(c.n3, (l) => new Int32Array(l)),
    n4: grow(c.n4, (l) => new Int32Array(l)),
    face1: grow(c.face1, (l) => new Int32Array(l)),
    face2: grow(c.face2, (l) => new Int32Array(l)),
    k: grow(c.k, (l) => new Float32Array(l)),
    targetTheta: grow(c.targetTheta, (l) => new Float32Array(l)),
    assignment: c.assignment.slice(),
    seamPeer3: grow(c.seamPeer3 ?? new Int32Array(c.count).fill(-1), (l) => new Int32Array(l).fill(-1)),
    seamPeer4: grow(c.seamPeer4 ?? new Int32Array(c.count).fill(-1), (l) => new Int32Array(l).fill(-1)),
  };
  for (let i = 0; i < n3.length; i++) {
    const at = c.count + i;
    next.n1[at] = n1[i];
    next.n2[at] = n2[i];
    next.n3[at] = n3[i];
    next.n4[at] = n4[i];
    next.face1[at] = face1[i];
    next.face2[at] = face2[i];
    next.k[at] = model.params.kFold * kk[i];
    next.seamPeer3![at] = peer3[i];
    next.seamPeer4![at] = peer4[i];
    next.assignment[at] = "C"; // a seam: cut in the sheet, hinge in the artifact
  }
  model.creases = next;
  // Measured last, so measureTheta sees the finished arrays. Position is the goal pose here.
  for (let i = 0; i < n3.length; i++) {
    const at = c.count + i;
    next.targetTheta[at] = clampFold(measureTheta(model, next.face1[at], next.face2[at], next.n3[at], next.n4[at]));
  }
  model.seamCreases = n3.length;
}

/** Distance between two nodes in the model's current pose. */
function nodeDist(model: BarHingeModel, a: number, b: number): number {
  const p = model.position;
  return Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
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
  /**
   * PIN the vertices a declared folded form names, instead of guiding them softly toward it — the
   * kinematic transport described in `pipeline/verify.ts`, which drives every vertex along
   * rest→goal on purpose and audits the tensile strain of that path as a statement about the
   * pattern. Nothing that is meant to look like a fold should ask for this: it writes positions
   * into the model rather than solving for them (see `applyDeclaredGoal`).
   */
  pinDeclaredGoal?: boolean;
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
  applyDeclaredGoal(fold, processed, model, !opts.pinDeclaredGoal);

  // 3D-printed: rigid tiles can't close past the thickness limit. Set per-crease θ_max and clamp
  // the design targets (handles free-fold patterns). Guided files use the same live, force-driven
  // simulation as vinyl, so this barrier participates throughout the fold instead of being baked
  // into a replacement goal keyframe.
  if (opts.printed) {
    const pp = opts.printedParams ?? printedParamsFromMeta(fold) ?? DEFAULT_PRINTED;
    applyPrintedClosure(model, pp);
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
