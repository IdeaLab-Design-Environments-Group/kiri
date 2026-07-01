import type { KirigamiInputs } from "./types.js";

export const APEX_HEIGHT_ERROR = "Apex height must be greater than 0 mm";
export const MATERIAL_THICKNESS_ERROR = "Material thickness must be greater than 0 mm";

/** Input validation (not constraint checklist). Returns error message or null if OK. */
export function validateInputs(inputs: KirigamiInputs): string | null {
  if (!(inputs.totalCurvature > 0)) {
    return APEX_HEIGHT_ERROR;
  }
  if (!(inputs.materialThickness > 0)) {
    return MATERIAL_THICKNESS_ERROR;
  }
  return null;
}
