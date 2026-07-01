/**
 * Type declarations for `fkld/spec.coffee`.
 *
 * The `.coffee` file is the source of truth at runtime; this `.d.ts` only
 * tells TypeScript what shape the CoffeeScript exports have so consumers
 * (the AKDE controller, the validators in later steps, the unit tests)
 * get autocomplete and type-checking. If you add a key to the registry in
 * `spec.coffee`, mirror it in the `Keys` interface below.
 */

/** Reserved namespace prefix for every FKLD-specific property name. */
export const NAMESPACE: "fkld:";

export interface FkldEdgeKeys {
  readonly cutType: "fkld:edges_cutType";
  readonly moleculeTheta: "fkld:edges_moleculeTheta";
  readonly moleculeWidth: "fkld:edges_moleculeWidth";
  readonly moleculeDepth: "fkld:edges_moleculeDepth";
  readonly dihedralTarget: "fkld:edges_dihedralTarget";
}

export interface FkldVertexKeys {
  readonly curvatureClass: "fkld:vertices_curvatureClass";
  readonly angleDefect: "fkld:vertices_angleDefect";
  readonly reliefStrategy: "fkld:vertices_reliefStrategy";
}

export interface FkldFaceKeys {
  readonly materialId: "fkld:faces_materialId";
  readonly thickness: "fkld:faces_thickness";
  readonly structuralRole: "fkld:faces_structuralRole";
  readonly panelId: "fkld:faces_panelId";
}

export interface FkldMetaKeys {
  readonly architecture: "fkld:meta_architecture";
}

export interface FkldKeys {
  readonly edges: FkldEdgeKeys;
  readonly vertices: FkldVertexKeys;
  readonly faces: FkldFaceKeys;
  readonly meta: FkldMetaKeys;
}

/** Grouped key registry — single source of truth for FKLD property names. */
export const KEYS: FkldKeys;

/** Every registered FKLD key string, in registration order. */
export const KEY_LIST: ReadonlyArray<string>;

/** True iff `key` is a registered FKLD field name (strict). */
export function isRegisteredKey(key: unknown): key is string;

/** True iff `key` starts with the FKLD namespace prefix (lenient). */
export function isFkldKey(key: unknown): key is string;

/**
 * Recursively `Object.freeze` every plain-object subtree of `obj` and
 * return `obj` itself (typed unchanged). Other FKLD modules import this
 * so every registry seals the same way.
 */
export function deepFreeze<T>(obj: T): T;
