/**
 * Type declarations for `fkld/cut-types.coffee` (Step 2).
 *
 * Adding a subtype = append to the `CutType` union below + add to
 * `CutTypeInfo` + add to `CUT_TYPES`/`CUT_TYPE_INFO` in the .coffee file.
 */

export type CutType =
  | "major"
  | "minor"
  | "seam"
  | "dart"
  | "auxetic"
  | "vent"
  | "tab";

export type CutTypeCategory =
  | "geometry"
  | "topology"
  | "mechanical"
  | "architectural"
  | "fabrication";

export interface CutTypeInfo {
  readonly category: CutTypeCategory;
  readonly description: string;
  readonly fabricationLayer: "cut" | "score" | "engrave";
  readonly citation: string;
}

/** Ordered list of the registered cut subtypes — see source for ordering policy. */
export const CUT_TYPES: ReadonlyArray<CutType>;

/** Per-subtype semantic record. Lookup by subtype string. */
export const CUT_TYPE_INFO: { readonly [K in CutType]: CutTypeInfo };

/** True iff `value` is a registered cut subtype string. */
export function isCutType(value: unknown): value is CutType;

export interface CutTypeError {
  /** Edge index, or -1 for whole-array errors. */
  readonly index: number;
  readonly message: string;
}

export interface CutTypeValidation {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<CutTypeError>;
}

/**
 * Validate a parallel `fkld:edges_cutType` array against the FOLD
 * `edges_assignment` array.
 */
export function validateEdgeCutTypes(
  edgesAssignment: unknown,
  edgesCutType: unknown,
): CutTypeValidation;
