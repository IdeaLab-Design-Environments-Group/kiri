import type { ConstraintState, KirigamiState } from "./types.js";

export const CONSTRAINT_EPS = 1e-10;

/** C1 — angle closure: |Nθ + Nη − 2π|. */
export function evaluateC1(state: KirigamiState): ConstraintState {
  const N = state.inputs.edgeCount;
  const residual = Math.abs(N * state.theta + N * state.eta - 2 * Math.PI);
  return {
    id: "C1",
    label: "C1 Angle closure (Eq. 1)",
    satisfied: residual < CONSTRAINT_EPS,
    residual,
  };
}

/** C2 — vector closure: |Σ w exp(i nτ)|. */
export function evaluateC2(state: KirigamiState): ConstraintState {
  const N = state.inputs.edgeCount;
  const residual = vectorClosureResidual(N, state.w, state.tau);
  return {
    id: "C2",
    label: "C2 Vector closure (Eq. 2)",
    satisfied: residual < CONSTRAINT_EPS,
    residual,
  };
}

/** C3 — molecule angle in range: |θ| < π. */
export function evaluateC3(state: KirigamiState): ConstraintState {
  const { theta } = state;
  const residual = Math.max(0, Math.abs(theta) - (Math.PI - CONSTRAINT_EPS));
  return {
    id: "C3",
    label: "C3 |θ| < π",
    satisfied: Math.abs(theta) < Math.PI - CONSTRAINT_EPS,
    residual,
  };
}

/** C4 — non-negative width: w ≥ 0. */
export function evaluateC4(state: KirigamiState): ConstraintState {
  const { w } = state;
  const residual = w < 0 ? -w : 0;
  return {
    id: "C4",
    label: "C4 w ≥ 0",
    satisfied: w >= -CONSTRAINT_EPS,
    residual,
  };
}

/**
 * C5 — fold overlap (AKDE interpretation; the paper gives no closed form). When the cone
 * folds, each molecule tucks against its faces; a molecule wider than the face base cannot
 * tuck without protruding/overlapping. Condition: w ≤ L.
 */
export function evaluateC5(state: KirigamiState): ConstraintState {
  const { w } = state;
  const L = state.inputs.edgeLength;
  const residual = Math.max(0, w - L);
  return {
    id: "C5",
    label: "C5 Fold overlap (w ≤ L)",
    satisfied: residual <= CONSTRAINT_EPS,
    residual,
    message:
      residual > CONSTRAINT_EPS
        ? `Molecule width w=${w.toFixed(1)} mm exceeds face edge L=${L.toFixed(1)} mm — molecule folds overlap`
        : undefined,
  };
}

/**
 * C6 — cut vs dihedral γ (AKDE interpretation). The dihedral-driven relief depth must fit
 * within the molecule's radial slant so the minor cut does not overshoot the apex hole.
 * Condition: T·tan(γ/2) ≤ s − r_apex.
 */
export function evaluateC6(state: KirigamiState): ConstraintState {
  const half = state.gamma / 2;
  const reliefDepth =
    half > 0 && half < Math.PI / 2 - 1e-12
      ? state.inputs.materialThickness * Math.tan(half)
      : Infinity;
  const available = state.s - state.rApex;
  const residual = Math.max(0, reliefDepth - available);
  return {
    id: "C6",
    label: "C6 Cut vs dihedral (T·tan(γ/2) ≤ s − r_apex)",
    satisfied: residual <= CONSTRAINT_EPS,
    residual,
    message:
      residual > CONSTRAINT_EPS
        ? `Relief depth T·tan(γ/2) exceeds molecule slant s − r_apex — minor cut overshoots`
        : undefined,
  };
}

/**
 * Evaluate C1–C6. H > 0 stays input validation (not C7). C1–C4 are DETC Eqs. (1)–(4);
 * C5 (fold overlap) and C6 (cut vs dihedral γ) are AKDE geometric-validity checks.
 */
export function evaluateConstraints(state: KirigamiState): ConstraintState[] {
  return [
    evaluateC1(state),
    evaluateC2(state),
    evaluateC3(state),
    evaluateC4(state),
    evaluateC5(state),
    evaluateC6(state),
  ];
}

/** |Σ w exp(i Φ_n)| with Φ_n = n τ. */
function vectorClosureResidual(N: number, w: number, tau: number): number {
  let sumX = 0;
  let sumY = 0;
  for (let n = 0; n < N; n++) {
    const phi = n * tau;
    sumX += w * Math.cos(phi);
    sumY += w * Math.sin(phi);
  }
  return Math.hypot(sumX, sumY);
}
