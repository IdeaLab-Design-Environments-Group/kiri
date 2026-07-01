import type { FoldNet, EdgeAssignment } from "./foldnet.js";
import type { CollisionState } from "./collision.js";

/**
 * Bar-and-hinge model in **struct-of-arrays** form — the CPU twin of Gershenfeld's GPU
 * texture layout (Ghassaei, Demaine, Gershenfeld, "Fast, Interactive Origami Simulation
 * using GPU Computation"). Each component is a flat typed array indexed by entity id, so the
 * same data uploads directly into the float textures consumed by the GLSL passes in `gpu/`.
 *
 *  - **Beams** (every FoldNet edge): linear springs, `k_axial = EA / l0`  (paper Eq 1).
 *  - **Creases** (interior edges): torsional springs `−k_crease·(θ − θ_target)` over 4 nodes
 *    (paper Eqs 2–6). `n1,n2` are the opposite "wing" vertices; `n3,n4` lie on the crease.
 *  - **Faces**: interior-angle springs that keep triangles from shearing (paper §2.4).
 *
 * **Kirigami coupling (DETC2019-97557 §3.2 / Eq 6, `Kd = Fx`).** A cut weakens a hinge:
 * effective stiffness scales by the connected (un-cut) ligament fraction,
 * `k_crease = (1 − cutRatio)·l0·k_fold`. With `cutRatio = 0` this is exactly Gershenfeld;
 * `cutRatio = 1` is a free flap. (Major/minor cuts are already absent edges in the FoldNet,
 * so the topology is kirigami; this knob additionally softens partially-relieved hinges.)
 */
export interface SolverParams {
  /** Axial EA (constant; k_axial = EA/l0). Paper default 20. */
  EA: number;
  /** Mountain/valley fold stiffness scale. Paper default 0.7. */
  kFold: number;
  /** Facet (triangulation) crease stiffness scale. Paper default 0.7. */
  kFacet: number;
  /** Face interior-angle stiffness. Paper default 0.2. */
  kFace: number;
  /** Damping ratio ζ (OrigamiSimulator `percentDamping`). Paper ~0.45; OS default 0.85. */
  zeta: number;
  /**
   * Beam viscous damping scale. OrigamiSimulator uploads `beam.getD() * 0.5` to the GPU
   * (`dynamicSolver.js`); set to 0.5 on the plain-FOLD path to match.
   */
  beamDampingScale: number;
  /**
   * Design fold-angle magnitude (rad) for the **mountain** polygon↔molecule slants.
   * v1 empirical default; exact per-crease angles need the DETC closure solve (Eqs 1–2).
   */
  foldMountain: number;
  /**
   * Design fold-angle magnitude (rad) for the **valley** molecule centrelines. Near π so each
   * molecule tucks (nearly) flat — required to collapse the flat-net perimeter (radius s) down
   * to the pyramid base (radius R). v1 empirical default; see `foldMountain`.
   */
  foldValley: number;
  /**
   * 3D-PRINTED mode only. Stiffness of the soft goal-spring that pulls a *soft-driven* boundary
   * node toward its kinematic target rest→goal·foldPercent (replaces the hard pin so thick-hinge
   * barriers can push the goal pose open). Unused in vinyl mode.
   */
  kGoal?: number;
  /**
   * 3D-PRINTED mode only. Stiffness of the one-sided hinge barrier that resists closing a crease
   * past `creases.thetaMax` (tile thickness/gap limit). Should be ≫ kGoal so contact wins. Unused
   * in vinyl mode.
   */
  kBarrier?: number;
  /**
   * 3D-PRINTED mode only. Rigid polygon panels: add an axial cross-brace across every facet ("F")
   * triangulation diagonal, so coplanar triangles fold as ONE rigid panel and the model only
   * articulates at the real mountain/valley hinges between panels — not at the FKLD facet lines the
   * vinyl sim bends along. Axial braces are tracked by `computeDt`, so this stays stable (unlike just
   * raising `kFacet`). Unused in vinyl mode.
   */
  rigidFacets?: boolean;
}

export const DEFAULT_PARAMS: SolverParams = {
  EA: 20,
  kFold: 0.7,
  kFacet: 0.7,
  kFace: 0.2,
  // Faithful to Origami Simulator: percentDamping ζ = 0.85, and beam viscous damping is the
  // GPU-uploaded `beam.getD() * 0.5` (beamDampingScale = 0.5). Net beam damping = 0.85·√(k·m),
  // i.e. UNDER-damped. The previous ζ=1.0 + scale=1.0 (≈2.3× OS) over-damped the explicit
  // integrator so an underconstrained free fold settled in the nearest flat-ish equilibrium
  // instead of dynamically buckling UP — the RES tower never erected. OS relies on this
  // under-damped dynamics (off numerical asymmetry, no explicit perturbation) to rise.
  zeta: 0.85,
  beamDampingScale: 0.5,
  foldMountain: 1.2,
  foldValley: 2.9,
};

/**
 * 3D-PRINTED mode: the rigid tiles sit on the **+face-normal** side of the hinge sheet, so closure
 * is ONE-SIDED. The fold that brings the tile faces together — the direction where
 * `TILE_COLLIDE_SIGN · θ` grows positive — is blocked by the tile thickness at `creases.thetaMax`;
 * the opposite (fabric-backing) side folds freely to flat. Flip to −1 if a model's winding puts the
 * tile side on the −θ direction (tiles would otherwise interpenetrate when folding toward them).
 */
export const TILE_COLLIDE_SIGN = 1;

export interface BarHingeModel {
  numNodes: number;

  // node components (xyz interleaved where 3-wide)
  position: Float32Array; // 3N — current (init = flat net)
  rest: Float32Array; // 3N — flat rest positions p0
  velocity: Float32Array; // 3N
  force: Float32Array; // 3N (scratch)
  mass: Float32Array; // N
  fixed: Uint8Array; // N (1 = pinned)
  /** 3N — goal (folded) position for driven boundary nodes (the DETC goal mesh M0). */
  goal: Float32Array;
  /** N — 1 = boundary node kinematically driven rest→goal by foldPercent (forward process). */
  driven: Uint8Array;
  /**
   * 3D-PRINTED mode only. When true, driven nodes are NOT hard-pinned: the solver skips the
   * kinematic placement and instead a goal-spring (params.kGoal) pulls them toward rest→goal,
   * so the thick-hinge barriers can relax an over-closed goal pose. Undefined ⇒ vinyl (hard pin).
   */
  softDriven?: boolean;

  /**
   * Self-collision state (penalty layer-vs-layer repulsion so folds don't pass through each
   * other). Undefined ⇒ collisions off (the bare Gershenfeld model). Set via
   * {@link FoldSolver.enableCollision}; the solver folds its stiffness into the stable dt.
   */
  collide?: CollisionState;

  beams: {
    count: number;
    n0: Int32Array;
    n1: Int32Array;
    rest: Float32Array; // l0
    k: Float32Array; // EA/l0
  };

  creases: {
    count: number;
    n1: Int32Array; // wing vertex opposite, on face1
    n2: Int32Array; // wing vertex opposite, on face2
    n3: Int32Array; // crease edge node a
    n4: Int32Array; // crease edge node b
    face1: Int32Array;
    face2: Int32Array;
    k: Float32Array; // crease stiffness (incl. kirigami cut coupling)
    targetTheta: Float32Array; // design fold angle (signed); scaled by foldPercent at solve
    assignment: EdgeAssignment[];
    /**
     * 3D-PRINTED mode only. Per-crease max |fold angle| before tiles of the print thickness collide
     * across the fabric gap (θ_max = 2·atan(g/t)). Undefined ⇒ vinyl (no thickness limit).
     */
    thetaMax?: Float32Array;
  };

  faces: {
    count: number;
    a: Int32Array;
    b: Int32Array;
    c: Int32Array;
    nominalAngles: Float32Array; // 3F — interior angles at a,b,c in the flat state
    normal: Float32Array; // 3F (scratch)
  };

  params: SolverParams;
  meta: FoldNet["meta"];
}

interface V3 {
  x: number;
  y: number;
  z: number;
}
function nodeP(arr: Float32Array, i: number): V3 {
  return { x: arr[3 * i], y: arr[3 * i + 1], z: arr[3 * i + 2] };
}
function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function norm(a: V3): number {
  return Math.hypot(a.x, a.y, a.z);
}
function angleBetween(u: V3, v: V3): number {
  const lu = norm(u);
  const lv = norm(v);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const c = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** The third vertex of triangle `face` that is not `x` or `y`. */
function oppositeVertex(face: [number, number, number], x: number, y: number): number {
  for (const v of face) if (v !== x && v !== y) return v;
  return face[0];
}

/**
 * Assemble the SoA bar-and-hinge model from a FoldNet.
 *
 * @param net      topology from `buildFoldNet`
 * @param params   material/solver constants
 * @param cutRatio per-crease ligament loss in [0,1] (DETC Eq 6); default 0 = full stiffness
 */
export function buildModel(
  net: FoldNet,
  params: SolverParams = DEFAULT_PARAMS,
  cutRatio: (e: { assignment: EdgeAssignment; a: number; b: number }) => number = () => 0,
): BarHingeModel {
  const numNodes = net.vertices.length;
  const position = new Float32Array(3 * numNodes);
  const rest = new Float32Array(3 * numNodes);
  for (let i = 0; i < numNodes; i++) {
    const v = net.vertices[i];
    position[3 * i] = v.x;
    position[3 * i + 1] = v.y;
    position[3 * i + 2] = v.z;
    rest[3 * i] = v.x;
    rest[3 * i + 1] = v.y;
    rest[3 * i + 2] = v.z;
  }
  const mass = new Float32Array(numNodes).fill(1); // paper assumes unit mass
  const fixed = new Uint8Array(numNodes);
  const goal = rest.slice(); // default goal = rest (overwritten for driven boundary nodes)
  const driven = new Uint8Array(numNodes);

  // --- Beams: one per edge. Cut ("C") edges are kirigami separations (apex-hole rim + molecule
  // dart mouths): they carry a face-boundary bar like any free edge, but couple no crease across
  // them and the two sides are independent nodes — that is what lets the hole and darts open. ---
  const be = net.edges;
  const beams = {
    count: be.length,
    n0: new Int32Array(be.length),
    n1: new Int32Array(be.length),
    rest: new Float32Array(be.length),
    k: new Float32Array(be.length),
  };
  for (let i = 0; i < be.length; i++) {
    const e = be[i];
    beams.n0[i] = e.a;
    beams.n1[i] = e.b;
    const l0 = Math.max(e.rest, 1e-9);
    beams.rest[i] = l0;
    beams.k[i] = params.EA / l0; // k_axial = EA / l0
  }

  // --- Creases: one per interior edge --------------------------------------------------
  const interior = be.filter((e) => e.faces.length >= 2);
  const creases = {
    count: interior.length,
    n1: new Int32Array(interior.length),
    n2: new Int32Array(interior.length),
    n3: new Int32Array(interior.length),
    n4: new Int32Array(interior.length),
    face1: new Int32Array(interior.length),
    face2: new Int32Array(interior.length),
    k: new Float32Array(interior.length),
    targetTheta: new Float32Array(interior.length),
    assignment: new Array<EdgeAssignment>(interior.length),
  };
  for (let i = 0; i < interior.length; i++) {
    const e = interior[i];
    const [f1, f2] = e.faces;
    creases.n3[i] = e.a;
    creases.n4[i] = e.b;
    creases.face1[i] = f1;
    creases.face2[i] = f2;
    creases.n1[i] = oppositeVertex(net.faces[f1], e.a, e.b);
    creases.n2[i] = oppositeVertex(net.faces[f2], e.a, e.b);
    creases.assignment[i] = e.assignment;

    const c = Math.max(0, Math.min(1, cutRatio(e)));
    const base = e.assignment === "F" ? params.kFacet : params.kFold;
    creases.k[i] = (1 - c) * base * e.rest; // (1 − cutRatio)·l0·k  (DETC Eq 6 coupling)

    // Design fold-angle directions (the inside-tuck itself is enforced by driving each molecule's
    // valley node to an inside goal, see setupGuidedFold; these bias the free apex-region nodes).
    if (e.assignment === "M") creases.targetTheta[i] = +params.foldMountain;
    else if (e.assignment === "V") creases.targetTheta[i] = -params.foldValley;
    else creases.targetTheta[i] = 0; // F (facet) — driven flat
  }

  // --- Faces: nominal interior angles in the flat state --------------------------------
  const nf = net.faces.length;
  const faces = {
    count: nf,
    a: new Int32Array(nf),
    b: new Int32Array(nf),
    c: new Int32Array(nf),
    nominalAngles: new Float32Array(3 * nf),
    normal: new Float32Array(3 * nf),
  };
  for (let f = 0; f < nf; f++) {
    const [ia, ib, ic] = net.faces[f];
    faces.a[f] = ia;
    faces.b[f] = ib;
    faces.c[f] = ic;
    const A = nodeP(rest, ia);
    const B = nodeP(rest, ib);
    const C = nodeP(rest, ic);
    faces.nominalAngles[3 * f] = angleBetween(sub(B, A), sub(C, A));
    faces.nominalAngles[3 * f + 1] = angleBetween(sub(A, B), sub(C, B));
    faces.nominalAngles[3 * f + 2] = angleBetween(sub(A, C), sub(B, C));
  }

  return {
    numNodes,
    position,
    rest,
    velocity: new Float32Array(3 * numNodes),
    force: new Float32Array(3 * numNodes),
    mass,
    fixed,
    goal,
    driven,
    beams,
    creases,
    faces,
    params,
    meta: net.meta,
  };
}

/** Pin a set of nodes (mass[i] stays 1 but force/integration skip fixed nodes). */
export function setFixed(model: BarHingeModel, ids: Iterable<number>, pinned = true): void {
  for (const i of ids) model.fixed[i] = pinned ? 1 : 0;
}
