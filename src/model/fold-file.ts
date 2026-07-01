/**
 * Minimal FOLD / FKLD typings for the Kirigamizer shell. FKLD is a strict
 * superset of FOLD: standard keys plus a `fkld:` namespace ignored by plain
 * FOLD tools. We only type the keys the shell reads; the index signature
 * keeps arbitrary `fkld:*` and frame keys accessible.
 *
 * See FKLD-SPEC / FOLD spec for the full vocabulary.
 */
export interface FoldFile {
  file_spec?: number;
  file_creator?: string;
  file_classes?: string[];
  frame_title?: string;
  frame_classes?: string[];
  frame_attributes?: string[];
  frame_unit?: string;
  vertices_coords?: number[][];
  edges_vertices?: [number, number][];
  edges_assignment?: string[];
  faces_vertices?: number[][];
  /** FKLD extensions (`fkld:edges_cutType`, `fkld:meta_architecture`, …). */
  [key: string]: unknown;
}

/** A model loaded into the convert panel. */
export type LoadedModel =
  | { kind: "fold"; name: string; object: FoldFile }
  | { kind: "mesh"; name: string; ext: "obj" | "stl"; text: string };

/** True when the file carries any `fkld:` extension key. */
export function isFkld(file: FoldFile): boolean {
  return Object.keys(file).some((k) => k.startsWith("fkld:"));
}
