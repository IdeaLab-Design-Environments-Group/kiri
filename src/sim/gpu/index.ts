/**
 * Browser-only GPU barrel — the ONLY sanctioned entry point for the GPU solver.
 * Deliberately separate from `../index.js` (the Node-safe sim barrel): everything
 * here imports Three.js, so it must never be re-exported from the main barrel
 * (vitest imports `sim/index.js` in plain Node).
 */
export { GpuFoldSolver } from "./gpu-solver.js";
