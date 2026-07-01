/**
 * Bistable Star Tiling (BST) kirigami — data types.
 *
 * Implements Toyooka & Tachi, DETC2022/MESA-88761 "Programming Surfaces by Bistable Star Tiling
 * Kirigami". A flat sheet is tiled with rigid tiles connected at pivots; the parallelogram voids
 * form a 1-DOF auxetic linkage that expands isotropically by a scale factor as the slit angle θ
 * opens from α (contracted) to β (expanded). Grading the local expansion over the sheet programs
 * Gaussian curvature so the flat sheet deploys into a target surface. Bistable bar elements added
 * to the voids make the structure stable both flat and deployed.
 *
 * Conventions: lengths in mm, angles in radians (degrees only at the FOLD `edges_foldAngle`
 * boundary, matching src/pipeline/emit.ts). Pure module — no DOM, no sim, no three.
 */
import type { Vec2 } from "../types.js";
import type { Vec3 } from "../../core/vec3.js";

export interface BstParams {
  /** Acute slit angle at the contracted stable state (rad). 0 = square tiling; −π/4<α<0 = concave star. */
  alpha: number;
  /** Slit edge-length ratio. 1 = square; √2<γ = star regime (paper). */
  gamma: number;
  /** Planar-expanded slit angle β0 (rad), α<β0≤π/2. The uniform deployment state. */
  beta0: number;
  /** Tile grid size. */
  grid: { nx: number; ny: number };
  /** Bar strain target (ε<0 = compression), used by the bistable-bar pass (P3). */
  epsilon: number;
  /** Dynamic-relaxation iteration cap (P2). */
  relaxIters: number;
}

export const DEFAULT_BST: BstParams = {
  alpha: 0, // square tiling (validated first; star is α<0)
  gamma: 1,
  beta0: (80 * Math.PI) / 180,
  grid: { nx: 5, ny: 5 },
  epsilon: -0.1,
  relaxIters: 400,
};

/** One parallelogram void = a 4-bar linkage between 4 surrounding tiles. */
export interface VoidCell {
  /** The 4 hinge/corner vertex ids around the void, CCW. */
  corners: number[];
  /** Barycenter vertex position id is not stored; barycenter is derived from corners. */
}

/** A planar star tiling at one slit angle θ: rigid tiles + voids over a shared vertex set. */
export interface BstTiling {
  /** Deduped vertex positions (hinge pivots + tile corners) at this θ. */
  vertices: Vec2[];
  /** Per tile: its 4 corner vertex ids, CCW. */
  tiles: number[][];
  /** Parallelogram voids between tiles. */
  voids: VoidCell[];
  /** θ this tiling was built at (rad). */
  theta: number;
}

/** A kept bistable bar: connector vertices E,F in both the flat and deployed states + the void ABCD. */
export interface ResultBar {
  /** Void corner vertex ids A,B,C,D (CCW). Connectors: ABE, CDF. */
  corners: [number, number, number, number];
  Ec: Vec2; // contracted (flat) E
  Fc: Vec2; // contracted (flat) F
  Ee: Vec3; // deployed E
  Fe: Vec3; // deployed F
}

/** Everything emit-bst needs: the flat contracted crease pattern + the deployed goal + drive set. */
export interface BstResult {
  /** Flat contracted pattern (θ=α) — the crease pattern. */
  contracted: BstTiling;
  /** Deployed 3D positions per vertex (the foldedForm goal); same indexing as contracted.vertices. */
  expandedCurved: Vec3[];
  /** Per-vertex driven flag (1 = kinematically driven to the goal). */
  driven: boolean[];
  /** Kept bistable bars (P3). */
  bars: ResultBar[];
}
