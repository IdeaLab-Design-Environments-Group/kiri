/**
 * Compatibility shim — vec3 math now lives in `core/vec3.ts` (the
 * dependency-free shared layer) so pipeline/ and services/ can use it without
 * importing sim internals. Sim-internal imports of `./vec3.js` and the
 * barrel's `export * as vec3` keep working through this re-export.
 */
export * from "../core/vec3.js";
