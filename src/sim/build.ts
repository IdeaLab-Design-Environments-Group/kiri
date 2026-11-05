import type { KirigamiState } from "@kirigami/model/types.js";
import { buildFoldNet, foldNetFromMesh, type FoldNet } from "./foldnet.js";
import { buildModel, DEFAULT_PARAMS, type BarHingeModel, type SolverParams } from "./model.js";
import { FoldSolver } from "./solver.js";
import { add, cross, distance, dot, length, normalize, scale, sub, vec3, type Vec3 } from "./vec3.js";

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
 *  - each inner-rim corner swings out of its lateral face about the mountain tip→B_k, inward, by an
 *    angle φ shared by every molecule;
 *  - each molecule then tucks inside the pyramid as a fin about the plane Σ_k through the axis and
 *    B_k: its valley end (foldPt) and centre node (innerMid) are the in-plane points at their flat
 *    distances from the rim corner and B_k, on the axis side of the lateral edge.
 *
 * φ is what keeps the valley short of flat. With the rim corners left in their faces (φ = 0) both
 * halves of a molecule lie in Σ_k and the valley is folded to exactly π, which the sim cannot reach
 * (it clamps design folds to `MAX_FOLD` in origami-import.ts). Swinging the rim corners out opens the
 * valley; φ is chosen so it folds to {@link VALLEY_FOLD}.
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

/**
 * Valley fold of every molecule in the goal, rad: inside the sim's `MAX_FOLD` of 2.7 with margin.
 * Measured on the decagon preset, goals with valley folds from 1.2 to 2.3 all settle exact.
 */
export const VALLEY_FOLD = 2;

/** The isometric folded position of every FoldNet node (see {@link setupGuidedFold}). */
export function pyramidGoal(net: FoldNet): Vec3[] {
  // The valley fold falls as φ grows, from π where the rim corners leave their faces; scan for the
  // first φ that folds it to VALLEY_FOLD or less, then bisect back to the crossing.
  const STEP = 0.01;
  let lo = -1;
  let hi = -1;
  for (let phi = STEP; phi < Math.PI / 2; phi += STEP) {
    const placed = placePyramid(net, phi);
    if (!placed) continue;
    if (placed.valleyFold > VALLEY_FOLD) lo = phi;
    else if (lo >= 0) {
      hi = phi;
      break;
    }
  }
  if (hi < 0) throw new Error(`pyramidGoal: no rim swing folds the valleys to ${VALLEY_FOLD}`);
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    const placed = placePyramid(net, mid);
    if (placed && placed.valleyFold > VALLEY_FOLD) lo = mid;
    else hi = mid;
  }
  return placePyramid(net, hi)!.goal;
}

/**
 * Place every node with the inner-rim corners swung out of their faces by `phi`. Null when no
 * isometric fin exists at that angle: a rim corner past Σ_k (the two halves of its molecule would
 * pass through each other) or a fin node out of reach.
 */
function placePyramid(net: FoldNet, phi: number): { goal: Vec3[]; valleyFold: number } | null {
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

  // Swing node `w` of the triangle (w, p, q) about its edge p→q, which is shared with the placed
  // triangle (third, p, q): angle 0 keeps the two coplanar, positive turns w toward `inward`.
  const swing = (w: number, p: number, q: number, third: number, angle: number, inward: Vec3): Vec3 => {
    const fe = normalize(sub(flat[q], flat[p]));
    const fr = sub(flat[w], flat[p]);
    const along = dot(fr, fe);
    const across = length(sub(fr, scale(fe, along)));
    const ge = normalize(sub(goal[q]!, goal[p]!));
    const gt = sub(goal[third]!, goal[p]!);
    const away = normalize(scale(sub(gt, scale(ge, dot(gt, ge))), -1));
    let n = normalize(cross(ge, away));
    if (dot(n, inward) < 0) n = scale(n, -1);
    return add(goal[p]!, add(scale(ge, along), scale(add(scale(away, Math.cos(angle)), scale(n, Math.sin(angle))), across)));
  };

  let valleyFold = 0;
  for (let k = 0; k < N; k++) {
    const kp = (k + 1) % N;
    const [oR, oL2] = net.basePairs[k];
    const f = net.valleyOuter[k];
    const v = net.edges.find((e) => e.assignment === "V" && (e.a === f || e.b === f));
    if (!v) throw new Error(`pyramidGoal: molecule ${k} has no valley`);
    const mid = v.a === f ? v.b : v.a;

    // Σ_k coordinates: ρ along the corner direction, z up; `off` is the distance out of the plane.
    const u = vec3(Math.cos(baseAngle[k]), Math.sin(baseAngle[k]), 0);
    const n = vec3(-u.y, u.x, 0);
    const inPlane = ([rho, z]: [number, number]): Vec3 => vec3(rho * u.x, rho * u.y, z);
    const project = (p: Vec3) => ({ rho: dot(p, u), z: p.z, off: dot(p, n) });
    const reach = (len: number, off: number): number => Math.sqrt(len * len - off * off);

    // The rim corner of each half, swung inward from its face (toward Σ_k, from the face's side).
    const rims: number[] = [];
    for (const [t, outer, faceOuter] of [
      [net.tips[k], oR, net.basePairs[(k - 1 + N) % N][1]],
      [net.tips[kp], oL2, net.basePairs[kp][0]],
    ]) {
      const rim = other(t, outer, faceOuter);
      const side = Math.sign(dot(goal[t]!, n));
      goal[rim] = swing(rim, t, outer, faceOuter, phi, scale(n, -side));
      if (Math.sign(dot(goal[rim]!, n)) !== side) return null; // past Σ_k: the halves would cross
      rims.push(rim);
    }

    const rp = project(goal[rims[0]]!);
    const fp = tuckedIntersection(rp, reach(flatDist(f, rims[0]), rp.off), { rho: R, z: 0 }, flatDist(f, oR), R, H);
    if (!fp) return null;
    goal[f] = inPlane(fp);
    const mp = tuckedIntersection(rp, reach(flatDist(mid, rims[0]), rp.off), project(goal[f]!), flatDist(mid, f), R, H);
    if (!mp) return null;
    goal[mid] = inPlane(mp);

    // Valley fold: π minus the opening between the two rim corners, seen down the valley.
    const axis = normalize(sub(goal[f]!, goal[mid]!));
    const [pa, pb] = rims.map((r) => {
      const d = sub(goal[r]!, goal[mid]!);
      return normalize(sub(d, scale(axis, dot(d, axis))));
    });
    valleyFold = Math.max(valleyFold, Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(pa, pb)))));
  }

  return {
    goal: goal.map((g, i) => {
      if (!g) throw new Error(`pyramidGoal: node ${i} has no goal`);
      return g;
    }),
    valleyFold,
  };
}

/**
 * The point in a lateral-edge plane Σ (coordinates: ρ along the corner direction, z up) at distance
 * `r1` from `c1` and `r2` from `c2`, choosing of the two intersections the one deeper inside the
 * pyramid (farther below the apex→corner line z = H(1 − ρ/R)). Null when the circles do not meet.
 */
function tuckedIntersection(
  c1: { rho: number; z: number },
  r1: number,
  c2: { rho: number; z: number },
  r2: number,
  R: number,
  H: number,
): [number, number] | null {
  const dx = c2.rho - c1.rho;
  const dz = c2.z - c1.z;
  const d = Math.hypot(dx, dz);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  if (!(h2 >= 0)) return null;
  const h = Math.sqrt(h2);
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
