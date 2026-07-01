/**
 * FOLD/FKLD → fold-simulation adapter.
 *
 * As of the 1:1 Origami Simulator port this is a thin facade over `origami-import.ts`, which
 * runs the exact Ghassaei–Demaine–Gershenfeld forward fold (cut-split kirigami + winding-
 * consistent creases) uniformly for every origami and kirigami file. The bespoke AKDE
 * guided-cone path has been retired from the default route; `build.ts` still exposes
 * `buildFoldScene` for the pyramid-recompute fallback in `scene.ts`.
 */
export {
  buildSceneFromFold,
  isFoldable,
  ORIGAMI_PARAMS,
  PRINTED_PARAMS,
  DEFAULT_PRINTED,
  printedThetaMax,
} from "./origami-import.js";
export type { FoldScene, SimMaterial, PrintedParams } from "./origami-import.js";
