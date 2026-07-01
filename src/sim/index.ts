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
export type { FoldScene, SimMaterial } from "./build.js";

// Origami Simulator SVG importer (1:1 port of pattern.js loadSVG) — any OS crease-pattern SVG → FOLD.
export { importOrigamiSimulatorSvg, DEFAULT_VERT_TOL } from "./svg-import.js";
export type { SvgImportOptions, SvgImportStats } from "./svg-import.js";

// FOLD/FKLD adapters + scene resolution (Node-safe: no Three.js anywhere below).
export { buildSceneFromFold, isFoldable, ORIGAMI_PARAMS, PRINTED_PARAMS, DEFAULT_PRINTED, printedThetaMax } from "./fold-adapter.js";
export type { PrintedParams } from "./fold-adapter.js";
export { buildScene, canSimulate, pyramidInputsFromFold } from "./scene.js";
export type { BuiltScene, SimKind, FoldMode } from "./scene.js";

// Velocity stabilization helpers (used by the sim view and tests).
export {
  totalKineticEnergy,
  kineticDamp,
  dampVelocity,
  removeRigidBodyMotion,
  guardFinite,
} from "./stabilize.js";

export * as vec3 from "./vec3.js";
export type { Vec3 } from "./vec3.js";
