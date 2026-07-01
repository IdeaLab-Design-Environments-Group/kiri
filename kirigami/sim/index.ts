/**
 * Kirigami forward-folding simulation — Gershenfeld bar-and-hinge model (Ghassaei, Demaine,
 * Gershenfeld) over the DETC2019-97557 edge-molecule geometry, in struct-of-arrays form so the
 * same data drives both the CPU reference solver and the GPU (GPUComputationRenderer) path.
 *
 * The Three.js view (`kirigami/view/sim-canvas.ts`) and the GPU solver (`./gpu/`) are NOT
 * re-exported here, so this barrel stays importable in plain Node (vitest). See
 * `theory/sim-ecs.md` for architecture.
 */
export { buildFoldNet, foldNetFromMesh } from "./foldnet.js";
export type { FoldNet, FoldNetEdge, EdgeAssignment } from "./foldnet.js";

export { buildModel, setFixed, DEFAULT_PARAMS } from "./model.js";
export type { BarHingeModel, SolverParams } from "./model.js";

export {
  computeFaceNormals,
  computeThetas,
  accumulateForces,
  integrate,
  computeDt,
} from "./forces.js";

export { FoldSolver, measureTheta } from "./solver.js";

export { buildFoldScene, setupGuidedFold, singleHingeModel } from "./build.js";
export type { FoldScene } from "./build.js";

export * as vec3 from "./vec3.js";
export type { Vec3 } from "./vec3.js";
