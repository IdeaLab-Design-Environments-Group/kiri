/**
 * Pipeline DTO contracts (AKDE `kirigami/model/types.ts` precedent): every
 * cross-stage type of the general kirigamize pipeline lives here so each stage
 * states what it consumes/produces in one place. Pure data — no behavior.
 *
 * Units: millimetres for lengths, radians for angles (degrees only at the
 * FOLD `edges_foldAngle` boundary in emit.ts).
 *
 * The one cross-milestone contract that must never break is the provenance
 * pair `origVertex` + `goalPos`. `origVertex` maps flat/sheet vertex index →
 * source target-mesh (Q) vertex index, with −1 for vertices SYNTHESIZED by
 * K1 vents — so it answers "which Q vertex?" but not "where must this vertex
 * land?". `goalPos` does: a folded-target position on Q for EVERY vertex
 * (including synthesized ones), the authoritative source of the emitted
 * guided-fold goal frame. M3/K1 creates both (cutting duplicates vertices;
 * vents synthesize new ones), M4 carries them on the Sheet and into the
 * FKLD's foldedForm frame, and M5 verification folds against that frame.
 */

import type { Vec3 } from "../core/vec3.js";
import { AppError } from "../core/errors.js";

export type { Vec3 };

/** 2D point on the flat pattern (mm). */
export interface Vec2 {
  x: number;
  y: number;
}

/** Triangle mesh in mm. The substrate every pipeline stage operates on. */
export interface TriMesh {
  vertices: Vec3[];
  faces: [number, number, number][];
}

/** Undirected edge with incident faces (1 = boundary, 2 = interior). */
export interface MeshEdge {
  a: number; // min vertex id
  b: number; // max vertex id
  faces: number[];
}

/**
 * Derived adjacency for a TriMesh (see `mesh.ts#buildTopology`). Ordered
 * one-ring fans, not a half-edge structure — fans are all that defect math
 * (M2) and cut-splitting (M3) need.
 */
export interface MeshTopology {
  edges: MeshEdge[];
  /** "a_b" with a<b → edge index. */
  edgeIndex: Map<string, number>;
  /** Per vertex: incident faces ordered as a fan (boundary fans start at the boundary). */
  vertexFaces: number[][];
  /** Per vertex: incident edge ids (unordered). */
  vertexEdges: number[][];
  boundaryVertices: Set<number>;
}

/** Audit record for one conditioning pass. */
export interface ConditionReport {
  pass: "weld" | "orient" | "degenerate" | "components" | "handle-cut";
  changed: number;
  notes?: string;
}

/** Per-vertex discrete curvature report (M2, `curvature.ts`). */
export interface DefectReport {
  /** Signed angle defect δ(v) = 2π − Σαᵢ(v) in rad; 0 for boundary vertices. */
  defects: number[];
  /** Matches the fkld:vertices_curvatureClass enum. */
  classes: ("positive" | "negative" | "flat" | "boundary")[];
  /** Σδ over interior vertices — equals 2πχ for a closed mesh (Gauss–Bonnet). */
  totalDefect: number;
}

/** Output of the cut planner (M2, `plan-cuts.ts`). */
export interface CutPlan {
  /** Edge ids into topo.edges — a forest on the mesh graph. */
  cutEdges: number[];
  perVertexAction: ("dart" | "slit" | "tuck" | "none")[];
  cost: { length: number; visibility: number; lambda: number };
}

/** A cut edge's two boundary copies after splitting (M3). */
export interface LipPair {
  /** Source edge id in the target-mesh topology. */
  sourceEdge: number;
  /** [a-side, b-side] vertex ids per lip, in the cut/flat mesh. */
  lipA: [number, number];
  lipB: [number, number];
}

/**
 * A vent at a δ<0 vertex (K1, proper-kirigami semantics): a sliver of
 * Q-coverage of total angle |δ| removed from the flat sheet so the remaining
 * material is exactly 2π around the vertex. The slit through the vertex is
 * zero-width in the flat pattern and opens into a small uncovered hole when
 * folded — the algorithm spec's "open slit / deliberate hole".
 */
export interface VentRecord {
  /** Source (Q) vertex the vent relieves. */
  sourceVertex: number;
  /** Removed wedge angle = |δ(sourceVertex)| (rad). */
  angle: number;
  /**
   * Sheet edges (cut-mesh vertex pairs) bounding the removed sliver — the
   * physically-cut vent lines, tagged cutType "vent" downstream.
   */
  ventEdges: [number, number][];
}

/**
 * Flattened single-sheet kirigami pattern (M3/K1, `unfold.ts`), globally
 * indexed. Proper-kirigami invariant: the sheet is ONE connected piece and
 * every interior vertex carries exactly 2π of flat material — δ>0 vertices
 * show dart gaps (wedges cut out BETWEEN Q-faces), δ<0 vertices have vent
 * slivers removed from coverage so their slits are zero-width in flat.
 */
export interface UnfoldResult {
  /** Flat position per cut-mesh vertex (mm). */
  flat: Vec2[];
  /** Cut-mesh triangles (global vertex indices). */
  faces: [number, number, number][];
  /** Connected-component label per face (single sheet ⇒ all 0). */
  patchOfFace: number[];
  patchCount: number;
  /** Provenance: cut-mesh vertex → Q vertex; −1 for synthesized vertices. */
  origVertex: number[];
  /**
   * Folded-target position per cut-mesh vertex (mm, on Q): Q's position for
   * copies, the interpolated on-Q point for synthesized vent vertices. The
   * authoritative source for the emitted goal frame (origVertex can be −1).
   */
  goalPos: Vec3[];
  /** Cut-edge lip pairs (global cut-mesh vertex ids). */
  lips: LipPair[];
  /** Vent slivers removed at δ<0 vertices. */
  vents: VentRecord[];
  /** Source-mesh edge ids added by the relief loop and KEPT after pruning. */
  reliefEdges: number[];
  /** Relief edges dropped by post-relief pruning (0 when pruning is off). */
  reliefPruned: number;
  /** Sum of source-edge lengths over all cuts incl. relief (mm). */
  totalCutLength: number;
}

export type EdgeAssignment = "M" | "V" | "F" | "B" | "C";
export type CutType = "major" | "minor" | "seam" | "dart" | "auxetic" | "vent" | "tab";

/** Placed flat pattern with classification (M4/K3, `route-seams.ts`). */
export interface Sheet {
  vertices: Vec2[];
  faces: [number, number, number][];
  edges: MeshEdge[];
  assignment: EdgeAssignment[];
  /** Signed dihedral target θ in rad (AKDE convention: mountain positive); null on B/C. */
  foldAngle: (number | null)[];
  cutType: (CutType | null)[];
  /** Provenance: sheet vertex → Q vertex; −1 for synthesized vertices. */
  origVertex: number[];
  /** Folded-target position per sheet vertex (mm) — feeds the goal frame. */
  goalPos: Vec3[];
  lips: LipPair[];
  vents: VentRecord[];
  patchOfFace: number[];
  /** The rectangle of paper the pattern is cut from (pattern bbox + margin, mm). */
  sheetRect: { widthMm: number; heightMm: number; marginMm: number };
}

/** Metrics of one settled fold (K4, `verify.ts`). */
export interface FoldMetrics {
  /**
   * Sampled symmetric Hausdorff distance to Q after rigid alignment, mm.
   * Vent-aware (open kirigami): Q→folded samples inside a declared vent hole
   * are excluded — the folded surface legitimately has a small hole there, so
   * missing coverage at a vent is not a coverage error. The folded→Q
   * direction stays full strength (the sheet must lie ON Q everywhere).
   */
  dH: number;
  /** dH / bbox diagonal of Q. */
  dHRel: number;
  meanStrain: number;
  maxStrain: number;
  /** Mean |θ_measured − θ_target| over creases at the settled pose (rad). */
  creaseResidual: number;
  iterations: number;
  /** solveUntilSettled converged (finite, KE below threshold). */
  settled: boolean;
  /**
   * Fold-from-flat only (phase A, kinematic transport): max over fp =
   * 0.25/0.5/0.75 of the mean TENSILE bar strain max(l/l₀ − 1, 0) while every
   * vertex is driven linearly rest→goal. Tensile, not unsigned: by the
   * triangle inequality |(1−fp)·d₀ + fp·d₁| ≤ l₀ whenever |d₀| = |d₁| = l₀,
   * so a consistent (isometric) pattern can NEVER lengthen a bar along the
   * linear path — pathStrain ≈ 0 iff the pattern is consistent — while the
   * unsigned mid-path strain carries an irreducible chord-shortening artifact
   * (≈ 1 − cos(φ/2) for face rotation φ; ~31% mean on a perfect cube).
   * Absent on equilibrium metrics (no transport phase).
   */
  pathStrain?: number;
}

/**
 * Result of the simulator verification (K4, `verify.ts`).
 *
 * `foldFromFlat` is the PRIMARY gate, run in two phases:
 *   A. kinematic transport — EVERY vertex is driven linearly rest→goal as
 *      foldPercent eases 0→1, demonstrating a continuous motion from the
 *      flat sheet; the mean tensile bar strain sampled at fp = 0.25/0.5/0.75
 *      is recorded as `pathStrain` (≈ 0 iff the pattern is isometrically
 *      consistent — see FoldMetrics.pathStrain);
 *   B. release-and-settle — at fp = 1 the original driven flags are
 *      restored (only sheet-boundary vertices stay pinned), velocities are
 *      zeroed, and the solver relaxes until settled: the folded state must
 *      HOLD under the pattern's own bars/creases. Metrics are measured after
 *      phase B.
 * This makes free interior fold-line vertices (e.g. a tent ridge) verifiable
 * — the driven forward process alone cannot raise them (mirror-side crease
 * reactions) — while staying honest: a wrong pattern spikes pathStrain in
 * phase A or drifts away in phase B. `equilibrium` (start at the goal pose,
 * relax, measure drift) is kept as a secondary reported metric — never
 * sufficient alone.
 */
export interface VerifyReport {
  foldFromFlat: FoldMetrics;
  equilibrium: FoldMetrics;
  /** The ε actually used, mm. */
  epsilon: number;
  /** Number of non-driven sheet vertices in the equilibrium (guided) mode. */
  freeVertices: number;
  attempts: number;
  /**
   * foldFromFlat settled AND its dH ≤ ε AND strain/crease residuals within
   * tolerance AND pathStrain ≤ 2× strainTol.
   */
  converged: boolean;
  /** Q vertex nearest the worst fold-from-flat sample — the refine terminal. */
  worstSourceVertex: number;
}

/**
 * Stage-tagged pipeline failure. Every stage throws this (never bare Error)
 * so the controller can show "<stage>: <message>" and tests can pin stages.
 * Specializes the app-wide [[AppError]] (domain "pipeline") so a single
 * `instanceof AppError` catch handles every domain uniformly.
 */
export class PipelineError extends AppError {
  readonly stage: "import" | "conditioning" | "mesh" | "curvature" | "plan-cuts" | "unfold" | "route-seams" | "emit" | "verify";

  constructor(stage: PipelineError["stage"], message: string, details?: unknown) {
    super("pipeline", `${stage}: ${message}`, details);
    this.name = "PipelineError";
    this.stage = stage;
  }
}
