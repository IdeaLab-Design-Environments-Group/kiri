import type { KirigamiState } from "@kirigami/model/types.js";
import { buildFoldNet, foldNetFromMesh, type FoldNet } from "./foldnet.js";
import { buildModel, DEFAULT_PARAMS, type BarHingeModel, type SolverParams } from "./model.js";
import { FoldSolver } from "./solver.js";
import { add, distance, dot, normalize, scale, sub, vec3, type Vec3 } from "./vec3.js";

/**
 * Fabrication material the sim represents:
 *  - "vinyl"   — thin uniformly-flexible sheet (the bar-and-hinge default; paper/vinyl kirigami).
 *  - "printed" — rigid 3D-printed tiles on fabric hinges, with tile thickness limiting closure.
 */
export type SimMaterial = "vinyl" | "printed";

/** A ready-to-run folding simulation: topology + bar-and-hinge model + solver. */
export interface FoldScene {
  net: FoldNet;
  model: BarHingeModel;
  solver: FoldSolver;
  /** Material this scene was built for (drives renderer thick-tile branch). Default "vinyl". */
  material?: SimMaterial;
}

/**
 * Build the full forward-folding simulation from a computed kirigami state:
 * FoldNet (topology) → bar-and-hinge SoA model → Gershenfeld solver, set up for the **DETC
 * forward process**: the nodes are driven to the goal mesh M0 (lateral faces onto the pyramid
 * faces, each molecule's outer-corner pair → the merged base-ring vertex at radius R, molecules
 * tucked flat inside; see {@link setupGuidedFold}) as `foldPercent` ramps 0→1. This folds to the
 * *designed* shape rather than an arbitrary amount, so the cone lands crisply.
 */
export function buildFoldScene(state: KirigamiState, params: SolverParams = DEFAULT_PARAMS): FoldScene {
  const net = buildFoldNet(state);
  const model = buildModel(net, params);
  setupGuidedFold(model, net);
  const solver = new FoldSolver(model);
  return { net, model, solver };
}

/**
 * Mark every net node as kinematically driven and store its goal (folded) position, in the net's
 * normalized units (`meta.scale`), matching `model.position`.
 *
 * The goal is an **isometry of the flat net**: every bar keeps its rest length, so a fold made of
 * forces can reach it (issue #14). It is built piece by piece from the pyramid's own geometry:
 *
 *  - each molecule's outer-corner pair merges into one base corner B_k on the ring of radius R;
 *  - each lateral face [tip, outerL, outerR] is congruent to the pyramid face (apex, B_{k−1}, B_k),
 *    so it is placed there rigidly — the tip lands on the face below the apex, and the apex hole
 *    stays the size the major cut makes it;
 *  - each molecule folds flat into a fin in the plane Σ_k through the axis and B_k, tucked inside
 *    the pyramid: its centre node (innerMid) and its valley end (foldPt) are the in-plane points at
 *    their flat distances from the two tips and from B_k, on the axis side of the lateral edge;
 *  - each inner-rim corner keeps its flat place relative to its facet pair (the facet hinge stays flat).
 *
 * The earlier goal pulled the tips to a small ring at the apex and the valley ends to a fixed tuck
 * point (0.7 R, 0.1 H). That happened to stay within 10% on the square pyramid, but stretched the
 * minor-cut slits by 34% at N=6 and 118% at N=10, a target no sheet can reach.
 */
export function setupGuidedFold(model: BarHingeModel, net: FoldNet): void {
  const goal = pyramidGoal(net);
  for (let i = 0; i < net.vertices.length; i++) {
    model.driven[i] = 1;
    model.fixed[i] = 1; // forces never move a driven node; its position is set kinematically
    model.goal[3 * i] = goal[i].x;
    model.goal[3 * i + 1] = goal[i].y;
    model.goal[3 * i + 2] = goal[i].z;
  }
}

/** The isometric folded position of every FoldNet node (see {@link setupGuidedFold}). */
export function pyramidGoal(net: FoldNet): Vec3[] {
  const { N, R, H } = net.meta;
  const flat = net.vertices;
  const goal: (Vec3 | undefined)[] = new Array(flat.length);
  const nbrs: Set<number>[] = flat.map(() => new Set<number>());
  for (const e of net.edges) {
    nbrs[e.a].add(e.b);
    nbrs[e.b].add(e.a);
  }
  const flatDist = (i: number, j: number): number => distance(flat[i], flat[j]);
  const other = (i: number, j: number, not: number): number => {
    for (const n of nbrs[i]) if (n !== not && nbrs[j].has(n)) return n;
    throw new Error(`pyramidGoal: no common neighbour of ${i} and ${j}`);
  };

  // Base corners: the pair merges at the mid angle of its two flat corners, radius R, z = 0.
  const baseAngle = net.basePairs.map(([a, b]) => {
    const angA = Math.atan2(flat[a].y, flat[a].x);
    const angB = Math.atan2(flat[b].y, flat[b].x);
    return angA + 0.5 * ((angB - angA + 2 * Math.PI) % (2 * Math.PI));
  });
  const corner = baseAngle.map((ang) => vec3(R * Math.cos(ang), R * Math.sin(ang), 0));
  net.basePairs.forEach(([a, b], k) => {
    goal[a] = corner[k];
    goal[b] = corner[k];
  });

  // Lateral faces: rigid map flat (O, outerL, outerR) → (apex, B_{k−1}, B_k), via the base-edge
  // midpoint frame (along the base edge, toward the apex).
  const apex = vec3(0, 0, H);
  const origin = vec3(0, 0, 0);
  for (let k = 0; k < N; k++) {
    const kPrev = (k - 1 + N) % N;
    const oL = net.basePairs[kPrev][1];
    const oR = net.basePairs[k][0];
    const fMid = scale(add(flat[oL], flat[oR]), 0.5);
    const fAlong = normalize(sub(flat[oR], flat[oL]));
    const fUp = normalize(sub(origin, fMid));
    const gMid = scale(add(corner[kPrev], corner[k]), 0.5);
    const gAlong = normalize(sub(corner[k], corner[kPrev]));
    const gUp = normalize(sub(apex, gMid));
    const t = net.tips[k];
    const d = sub(flat[t], fMid);
    goal[t] = add(gMid, add(scale(gAlong, dot(d, fAlong)), scale(gUp, dot(d, fUp))));
  }

  // Molecules: a flat-folded fin in Σ_k, tucked inside.
  for (let k = 0; k < N; k++) {
    const [oR, oL2] = net.basePairs[k];
    const f = net.valleyOuter[k];
    const t = net.tips[k];
    const t2 = net.tips[(k + 1) % N];
    const m = net.edges.find((e) => e.assignment === "V" && (e.a === f || e.b === f));
    if (!m) throw new Error(`pyramidGoal: molecule ${k} has no valley`);
    const mid = m.a === f ? m.b : m.a;

    const u = vec3(Math.cos(baseAngle[k]), Math.sin(baseAngle[k]), 0);
    const n = vec3(-u.y, u.x, 0);
    const inPlane = (rho: number, z: number): Vec3 => vec3(rho * u.x, rho * u.y, z);
    const B = { rho: R, z: 0 };
    const tg = goal[t]!;
    const tOff = dot(tg, n);
    const tIn = { rho: dot(tg, u), z: tg.z };
    const midToTip = Math.sqrt(Math.max(0, flatDist(mid, t) ** 2 - tOff * tOff)); // in-plane reach to the tip
    goal[mid] = inPlane(...tuckedIntersection(tIn, midToTip, B, flatDist(mid, oR), R, H));
    const mg = goal[mid]!;
    goal[f] = inPlane(...tuckedIntersection({ rho: dot(mg, u), z: mg.z }, flatDist(f, mid), B, flatDist(f, oR), R, H));

    // Inner-rim corners: in the plane of (mid, outer corner, tip), where the flat net has them. That
    // is on the outer corner's side of the mid–tip line: the rim triangle overlaps its neighbour in
    // the flat net, so keeping the facet hinge as it is flat keeps the two overlapping.
    for (const [tip, outer] of [
      [t, oR],
      [t2, oL2],
    ]) {
      const rim = other(mid, tip, outer);
      const fe = normalize(sub(flat[tip], flat[mid]));
      const fo = sub(flat[outer], flat[mid]);
      const fw = normalize(sub(fo, scale(fe, dot(fo, fe))));
      const fr = sub(flat[rim], flat[mid]);
      const ge = normalize(sub(goal[tip]!, mg));
      const go = sub(goal[outer]!, mg);
      const gw = normalize(sub(go, scale(ge, dot(go, ge))));
      goal[rim] = add(mg, add(scale(ge, dot(fr, fe)), scale(gw, dot(fr, fw))));
    }
  }

  return goal.map((g, i) => {
    if (!g) throw new Error(`pyramidGoal: node ${i} has no goal`);
    return g;
  });
}

/**
 * The point in a lateral-edge plane Σ (coordinates: ρ along the corner direction, z up) at distance
 * `r1` from `c1` and `r2` from `c2`, choosing of the two intersections the one deeper inside the
 * pyramid (farther below the apex→corner line z = H(1 − ρ/R)).
 */
function tuckedIntersection(
  c1: { rho: number; z: number },
  r1: number,
  c2: { rho: number; z: number },
  r2: number,
  R: number,
  H: number,
): [number, number] {
  const dx = c2.rho - c1.rho;
  const dz = c2.z - c1.z;
  const d = Math.hypot(dx, dz);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  // No intersection means no isometric fold exists for this net; say so rather than stretch to one.
  if (!(h2 > -1e-12 * r1 * r1)) throw new Error("pyramidGoal: molecule cannot fold flat isometrically");
  const h = Math.sqrt(Math.max(0, h2));
  const px = c1.rho + (a * dx) / d;
  const pz = c1.z + (a * dz) / d;
  const cands: [number, number][] = [
    [px - (h * dz) / d, pz + (h * dx) / d],
    [px + (h * dz) / d, pz - (h * dx) / d],
  ];
  const depth = ([rho, z]: [number, number]): number => H * (1 - rho / R) - z;
  return depth(cands[0]) >= depth(cands[1]) ? cands[0] : cands[1];
}

/**
 * Minimal two-triangle hinge model for unit-testing the crease force math: faces share the
 * edge (0,1) along x; nodes 2 and 3 are the wings of each face. The shared edge is driven to
 * `target` (signed fold angle). Returns the model with the crease already configured.
 */
export function singleHingeModel(target: number, kFold = 0.7): BarHingeModel {
  const vertices = [
    vec3(0, 0, 0), // 0 — crease node
    vec3(1, 0, 0), // 1 — crease node
    vec3(0.5, 1, 0), // 2 — wing of face 0
    vec3(0.5, -1, 0), // 3 — wing of face 1
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2],
    [1, 0, 3],
  ];
  const net = foldNetFromMesh(vertices, faces, () => "V");
  const model = buildModel(net, { ...DEFAULT_PARAMS, kFold, kFace: 0 });
  // override the design target with the test's requested angle
  for (let i = 0; i < model.creases.count; i++) model.creases.targetTheta[i] = target;
  return model;
}
