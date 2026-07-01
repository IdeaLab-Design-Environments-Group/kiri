/** User-facing inputs (all lengths in mm). */
export interface KirigamiInputs {
  /** Edge count N (dimensionless). */
  edgeCount: number;
  /** Base edge length L (mm). */
  edgeLength: number;
  /**
   * Outer polygon-face edge length L_o (mm) along the net perimeter. Optional; defaults to
   * edgeLength (which reproduces the standard pyramid net). It sets the angular span of each
   * polygon's outer base on the radius-s perimeter; the molecule chords absorb the remainder
   * so the outer 2N-gon stays closed.
   */
  outerEdgeLength?: number;
  /** Total curvature K_tot = vertical apex altitude H (mm), not slant s. */
  totalCurvature: number;
  /** Material thickness T (mm) — sets the molecule-fold pinch radius (major cut size). */
  materialThickness: number;
}

/** Computed geometry and molecule parameters (angles in rad internally). */
export interface KirigamiDerived {
  /** Uniform edge-molecule angle θ (rad). */
  theta: number;
  /** Uniform edge-molecule width w (mm). */
  w: number;
  /** Base circumradius R (mm). */
  R: number;
  /** Vertical apex altitude H = K_tot (mm). */
  H: number;
  /** Slant edge apex → base vertex s = √(R² + H²) (mm). */
  s: number;
  /** Apex elevation angle ψ = atan(H/R) (rad). */
  psi: number;
  /** Rise ratio κ = H/R (dimensionless). */
  kappa: number;
  /** Face angle at 3D pyramid apex η (rad). */
  eta: number;
  /** Discrete angle defect at apex δ_apex = 2π − Nη (rad). */
  deltaApex: number;
  /** Closure step τ = 2π/N (rad). */
  tau: number;
  /** Dihedral γ between adjacent lateral faces at a base corner (rad). */
  gamma: number;
  /** Major-cut radius r_apex = T / sin(θ/2) (mm), clamped to ≤ 0.4·s for v1 visualization. */
  rApex: number;
  /**
   * Edge-molecule end-leg length D(i,j) = 2·s·tan(θ/2) = w / cos(θ/2) (mm).
   * The slanted end edge of the symmetric-trapezoid molecule (DETC Figure 2),
   * derived from the trapezoid geometry: the leg spans width w while leaning by
   * the half-opening angle θ/2. Always ≥ w (so ≥ w/2). See computeMoleculeEndLeg.
   */
  moleculeEndLeg: number;
  /**
   * Active "fold-reach" minor cut length ℓ = hypot(w/2, rApex) (mm). The w/2 leg reaches the
   * valley crease; the penetration past it is the major-cut radius rApex = T/sin(θ/2), which
   * DECREASES with apex height H (the DETC-Figure-4 direction). Total length grows with H, the
   * landing depth past the crease shrinks with H. See computeFoldReach.
   */
  minorCutLength: number;
}

/** Full model state: inputs plus derived scalars (flat for view binding). */
export interface KirigamiState extends KirigamiDerived {
  inputs: KirigamiInputs;
}

export type ConstraintId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

export interface ConstraintState {
  id: ConstraintId;
  label: string;
  satisfied: boolean;
  residual: number;
  message?: string;
}
