import type { KirigamiState } from "../model/types.js";
import { buildFoldNet, foldNetFromMesh, type FoldNet } from "./foldnet.js";
import { buildModel, DEFAULT_PARAMS, type BarHingeModel, type SolverParams } from "./model.js";
import { FoldSolver } from "./solver.js";
import { vec3 } from "./vec3.js";

/** A ready-to-run folding simulation: topology + bar-and-hinge model + solver. */
export interface FoldScene {
  net: FoldNet;
  model: BarHingeModel;
  solver: FoldSolver;
}

/**
 * Build the full forward-folding simulation from a computed kirigami state:
 * FoldNet (topology) → bar-and-hinge SoA model → Gershenfeld solver, set up for the **DETC
 * forward process**: the boundary is driven to the goal mesh M0 (apex tips → apex height H,
 * each molecule's outer-corner pair → the merged base-ring vertex at radius R) as `foldPercent`
 * ramps 0→1, while the bar-and-hinge interior (molecules) tucks via its creases and cuts. This
 * folds to the *designed* shape rather than an arbitrary amount, so the cone lands crisply.
 */
export function buildFoldScene(state: KirigamiState, params: SolverParams = DEFAULT_PARAMS): FoldScene {
  const net = buildFoldNet(state);
  const model = buildModel(net, params);
  setupGuidedFold(model, net);
  const solver = new FoldSolver(model);
  return { net, model, solver };
}

/**
 * Mark the boundary nodes as kinematically driven and store their goal (folded) positions.
 * Coordinates are in the net's normalized units (`meta.scale`), matching `model.position`.
 */
export function setupGuidedFold(model: BarHingeModel, net: FoldNet): void {
  const drive = (i: number, gx: number, gy: number, gz: number): void => {
    model.driven[i] = 1;
    model.fixed[i] = 1; // forces never move a driven node; its position is set kinematically
    model.goal[3 * i] = gx;
    model.goal[3 * i + 1] = gy;
    model.goal[3 * i + 2] = gz;
  };
  // Close the major cut as the fold ramps: drive every inner-ring vertex (flat radius ≲ rApex) to a
  // SMALL ring at the apex. Because driven nodes move rest→goal by foldPercent, the rim interpolates
  // from its flat radius (rApex) down to `smallR` as the fold goes 0→1, so the apex hole shrinks
  // during folding and ends small — regardless of the flat hole size. Angular position is preserved
  // so the rim stays a clean ring. Pulling in below the isometric radius stretches the lateral-face
  // beams (the cut "closing"), but those run between driven/fixed nodes, so the faces stay flat
  // triangles and the visible mesh is a clean pyramid with a tiny apex hole.
  const innerRimR = net.meta.rApex * 1.4;
  const { R, s, H } = net.meta;
  const smallR = Math.max(net.meta.rApex * Math.sin(net.meta.theta / 2), 0.025 * R);
  const apexZ = H * (1 - smallR / s);
  for (let i = 0; i < net.vertices.length; i++) {
    const rho = Math.hypot(net.vertices[i].x, net.vertices[i].y);
    if (rho <= innerRimR && rho > 1e-9) {
      drive(i, (net.vertices[i].x / rho) * smallR, (net.vertices[i].y / rho) * smallR, apexZ);
    }
  }
  // each molecule's outer-corner pair merges into one cone base vertex at radius R
  for (const [a, b] of net.basePairs) {
    const angA = Math.atan2(net.vertices[a].y, net.vertices[a].x);
    const angB = Math.atan2(net.vertices[b].y, net.vertices[b].x);
    const mid = angA + 0.5 * (((angB - angA) + 2 * Math.PI) % (2 * Math.PI));
    const gx = net.meta.R * Math.cos(mid);
    const gy = net.meta.R * Math.sin(mid);
    drive(a, gx, gy, 0);
    drive(b, gx, gy, 0);
  }
  // Drive each molecule's valley-convergence node to an INSIDE goal (below the cone surface,
  // pulled toward the axis) so the molecule tucks into the pyramid volume rather than buckling
  // outward — the apex-region nodes stay free and relax around it. (DETC: excess is hidden.)
  const TUCK_RADIUS = 0.7; // fraction of base radius R (inside the surface)
  const TUCK_HEIGHT = 0.1; // fraction of apex height H (below the local surface ⇒ inside)
  for (const fp of net.valleyOuter) {
    const ang = Math.atan2(net.vertices[fp].y, net.vertices[fp].x);
    drive(
      fp,
      net.meta.R * TUCK_RADIUS * Math.cos(ang),
      net.meta.R * TUCK_RADIUS * Math.sin(ang),
      net.meta.H * TUCK_HEIGHT,
    );
  }
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
