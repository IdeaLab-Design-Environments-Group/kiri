/**
 * Type declarations for `fkld/molecule.coffee` (Step 3).
 */

export type MoleculeField = "theta" | "width" | "depth" | "dihedral";

export interface MoleculeFieldInfo {
  readonly key: string;
  readonly units: "rad" | "mm";
  readonly range: readonly [number, number];
  readonly description: string;
  readonly citation: string;
  readonly nullable: boolean;
}

export const MOLECULE_FIELDS: { readonly [K in MoleculeField]: MoleculeFieldInfo };

export function moleculeKey(field: MoleculeField): string | null;

export function isValidTheta(value: unknown): boolean;
export function isValidWidth(value: unknown): boolean;
export function isValidDepth(value: unknown): boolean;
export function isValidDihedral(value: unknown): boolean;

export interface MoleculeArrays {
  theta?: (number | null)[];
  width?: (number | null)[];
  depth?: (number | null)[];
  dihedral?: (number | null)[];
}

/** Pack the four arrays into a FKLD-keyed object, omitting absent fields. */
export function packEdgeMolecules(arrays: MoleculeArrays): {
  [key: string]: (number | null)[];
};

/** Pull the four arrays out of a FKLD-keyed object. */
export function unpackEdgeMolecules(fkld: unknown): MoleculeArrays;

export interface MoleculeError {
  readonly field: MoleculeField | "pair" | null;
  readonly index: number;
  readonly message: string;
}

export interface MoleculeValidation {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<MoleculeError>;
}

export function validateMoleculeArrays(
  edgesVertices: unknown,
  arrays: MoleculeArrays | undefined,
): MoleculeValidation;
