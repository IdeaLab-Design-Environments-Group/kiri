/**
 * Pipeline barrel (node-safe, mirrors `src/sim/index.ts`): no DOM and no
 * Three.js imports anywhere beneath this module, so the whole general
 * kirigamize pipeline runs and tests in plain Node.
 */

export * from "./types.js";
export * from "./mesh.js";
export * from "./import.js";
export * from "./conditioning.js";
export * from "./curvature.js";
export * from "./plan-cuts.js";
export * from "./unfold.js";
export * from "./route-seams.js";
export * from "./emit.js";
export * from "./verify.js";
export * from "./kirigamize.js";
