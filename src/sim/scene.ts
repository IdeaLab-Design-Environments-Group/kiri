/**
 * Picks the fold scene for a loaded model. As of the 1:1 Origami Simulator port there is **one
 * uniform path** for every foldable file — `buildSceneFromFold` runs the exact Ghassaei–Demaine–
 * Gershenfeld forward fold over the file's own geometry: cuts are split open (kirigami) and
 * creases ramp flat → folded via `foldPercent`. FKLD stays the kirigami backend format; it is
 * simply FOLD-with-cuts, so the same path folds it. The only special case is a non-foldable file
 * we can still recognize as an AKDE pyramid spec, which we recompute via `buildFoldScene`.
 */
import { type FoldFile, isFkld } from "../model/fold-file.js";
import type { KirigamiInputs } from "@kirigami/model/types.js";
import { computeState } from "@kirigami/model/geometry.js";
import { buildFoldScene } from "./build.js";
import { buildSceneFromFold, isFoldable } from "./fold-adapter.js";
import { ORIGAMI_PARAMS, PRINTED_PARAMS } from "./origami-import.js";
import type { FoldScene, SimMaterial } from "./build.js";
import type { SolverParams } from "./model.js";

export type { SimMaterial };

/** Which simulator handled the model: `kirigami` (cut-aware / guided) or `origami` (Neil's free fold). */
export type SimKind = "kirigami" | "origami";
/** Drive style: `guided` (boundary driven to a goal mesh) or `free` (crease-target forward fold). */
export type FoldMode = "guided" | "free";
export interface BuiltScene {
  scene: FoldScene;
  mode: FoldMode;
  sim: SimKind;
  /** Fabrication material this scene models (vinyl thin-sheet vs 3D-printed rigid tiles). */
  material: SimMaterial;
}

const paramsFor = (m: SimMaterial): SolverParams => (m === "printed" ? PRINTED_PARAMS : ORIGAMI_PARAMS);

const num = (re: RegExp, s: string): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

/** Recover AKDE uniform-pyramid inputs from FKLD metadata or frame_title. */
export function pyramidInputsFromFold(fold: FoldFile): KirigamiInputs | null {
  const arch = fold["fkld:meta_architecture"] as
    | { materialThickness?: number; sourcePyramid?: { edgeCount: number; edgeLength: number; apexHeight: number } }
    | undefined;
  const sp = arch?.sourcePyramid;
  if (sp && sp.edgeCount >= 3 && sp.edgeLength > 0 && sp.apexHeight > 0) {
    return {
      edgeCount: sp.edgeCount,
      edgeLength: sp.edgeLength,
      totalCurvature: sp.apexHeight,
      materialThickness: arch?.materialThickness ?? 1,
    };
  }

  const title = fold.frame_title;
  if (typeof title !== "string") return null;
  const edgeCount = num(/N=(\d+(?:\.\d+)?)/, title);
  const edgeLength = num(/L=(\d+(?:\.\d+)?)\s*mm/, title);
  const totalCurvature = num(/H=(\d+(?:\.\d+)?)\s*mm/, title);
  const materialThickness = num(/T=(\d+(?:\.\d+)?)\s*mm/, title);
  if (edgeCount == null || edgeLength == null || totalCurvature == null || materialThickness == null) return null;
  return { edgeCount, edgeLength, totalCurvature, materialThickness };
}

/** True when we can build a fold scene from this model (pyramid inputs or a foldable crease pattern). */
export function canSimulate(fold: FoldFile): boolean {
  return pyramidInputsFromFold(fold) !== null || isFoldable(fold);
}

const anyDriven = (driven: Uint8Array): boolean => {
  for (let i = 0; i < driven.length; i++) if (driven[i]) return true;
  return false;
};

/**
 * Build the fold scene for a model — one uniform Origami-Simulator engine, mode inferred per file.
 * `material` selects vinyl (thin flexible sheet, default) or 3D-printed (rigid tiles + thickness).
 */
export function buildScene(fold: FoldFile, material: SimMaterial = "vinyl"): BuiltScene | null {
  const printed = material === "printed";
  if (isFoldable(fold)) {
    // Folds the file's own geometry: cuts split open (kirigami), creases ramp via foldPercent.
    // The importer infers the mode from the file: a file that declares a folded-form footprint
    // (foldedForm frame + fkld:vertices_driven) is driven to it; everything else free-folds.
    const scene = buildSceneFromFold(fold, paramsFor(material), { printed });
    if (anyDriven(scene.model.driven)) return { scene, mode: "guided", sim: isFkld(fold) ? "kirigami" : "origami", material };

    // Foldable FKLD pyramid preset with NO declared footprint (a legacy export): its recoverable
    // N/L/H/T params ARE its declared 3D intent, so guide it via the pyramid recompute as a
    // fallback. (Newer presets ship a foldedForm and take the faithful path above.) The recompute
    // path does not support printed tiles, so it stays vinyl.
    if (isFkld(fold)) {
      const inputs = pyramidInputsFromFold(fold);
      if (inputs) {
        const guided = buildFoldScene(computeState(inputs));
        if (guided.net.vertices.length === (fold.vertices_coords?.length ?? -1)) {
          return { scene: guided, mode: "guided", sim: "kirigami", material: "vinyl" };
        }
      }
    }
    return { scene, mode: "free", sim: isFkld(fold) ? "kirigami" : "origami", material };
  }

  // Not directly foldable, but recognizable as an AKDE pyramid spec → recompute as a last resort.
  const inputs = pyramidInputsFromFold(fold);
  if (inputs) return { scene: buildFoldScene(computeState(inputs)), mode: "guided", sim: "kirigami", material: "vinyl" };
  return null;
}
