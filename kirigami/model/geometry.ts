import type { KirigamiDerived, KirigamiInputs, KirigamiState } from "./types.js";

const TAU = 2 * Math.PI;

/** Base circumradius R = L / (2 sin(π/N)) (mm). */
export function computeR(N: number, L: number): number {
  return L / (2 * Math.sin(Math.PI / N));
}

/** Slant edge s = √(R² + H²) (mm). */
export function computeS(R: number, H: number): number {
  return Math.sqrt(R * R + H * H);
}

/** Apex elevation ψ = atan(H/R) (rad). */
export function computePsi(H: number, R: number): number {
  return Math.atan2(H, R);
}

/** Rise ratio κ = H/R (dimensionless). */
export function computeKappa(H: number, R: number): number {
  return R !== 0 ? H / R : NaN;
}

/** Face angle at 3D pyramid apex η = 2 arcsin(R sin(π/N) / s) (rad). */
export function computeEta(R: number, s: number, N: number): number {
  if (!(s > 0 && R > 0)) return 0;
  const arg = Math.min(1, (R * Math.sin(Math.PI / N)) / s);
  return 2 * Math.asin(arg);
}

/** Discrete angle defect at apex δ_apex = 2π − Nη (rad). */
export function computeDeltaApex(N: number, eta: number): number {
  return TAU - N * eta;
}

/** Uniform molecule angle θ = δ_apex / N (rad). */
export function computeTheta(deltaApex: number, N: number): number {
  return deltaApex / N;
}

/** Closure step τ = 2π/N (rad). */
export function computeTau(N: number): number {
  return TAU / N;
}

/** Molecule width w = 2 s sin(θ/2) (mm) — outer chord of molecule wedge at slant radius s. */
export function computeW(s: number, theta: number): number {
  return 2 * s * Math.sin(theta / 2);
}

/**
 * Major-cut radius r_apex = T / sin(θ/2) (mm) — radius at which the molecule fold pinch
 * equals the material thickness T. Below this radius the material cannot lie flat at the
 * apex. Clamped to ≤ 0.4·s so degenerate cases (θ → 0, very flat pyramid) don't
 * produce a hole larger than the pattern; clamped ≥ 0.
 */
export function computeRApex(theta: number, T: number, s: number): number {
  if (!(T > 0) || !(theta > 0)) return 0;
  const physical = T / Math.sin(theta / 2);
  const maxVisual = 0.4 * s;
  return Math.min(physical, maxVisual);
}

/**
 * Edge-molecule end-leg length D(i,j) = 2·s·tan(θ/2) (mm), equivalently w / cos(θ/2)
 * since w = 2·s·sin(θ/2). This is the slanted end edge of the symmetric-trapezoid
 * edge molecule labelled D(i,j) / D(j,i) in DETC Figure 2.
 *
 * Derivation (uniform AKDE): the molecule is symmetric about its valley crease, so each
 * end leg spans the molecule width w while leaning over by the half-opening angle θ/2;
 * hence leg = w / cos(θ/2). Limits: θ→0 ⇒ D→0 (no molecule); θ→π ⇒ D→∞ (molecule
 * degenerates to a straight line, consistent with Eq. (3) −π<θ<π). D ≥ w for all θ,
 * so it can never fall below w/2.
 */
export function computeMoleculeEndLeg(s: number, theta: number): number {
  if (!(s > 0) || !(theta > 0) || theta >= Math.PI) return 0;
  return 2 * s * Math.tan(theta / 2);
}

/**
 * Fold-clearance penetration depth d = T·tan(γ/2) (mm) — the thickness-scaled tuck
 * relief at the rim end of the valley crease. Adjacent faces meet at dihedral γ, each
 * deviating from flat by (π−γ)/2, so a relief of depth d clears thickness T when
 * T = d·tan((π−γ)/2), i.e. d = T·tan(γ/2) (the half-angles are complementary).
 *
 * This is where the DETC-Figure-4 inverse proportionality lives: it DECREASES with apex
 * height H as γ closes. γ→π (flat) ⇒ large; γ→0 (steep) ⇒ 0. On its own it is a short
 * corner notch that does NOT reach the crease (it is ≪ w/2); see computeFoldReach.
 */
export function computeFoldClearance(gamma: number, T: number): number {
  const half = gamma / 2;
  if (!(T > 0) || half <= 1e-9 || half >= Math.PI / 2 - 1e-9) return 0;
  return T * Math.tan(half);
}

/**
 * Minor cut that BOTH reaches the valley crease AND keeps the H-proportionality, with the
 * penetration tied to the MAJOR cut:  ℓ = hypot(w/2, rApex).
 *
 * An outer corner (p2/p3) sits exactly w/2 from the crease (the fold passes through the
 * outer-chord midpoint, perpendicular to the chord). The w/2 leg guarantees the cut lands
 * on the fold; the cut then penetrates the crease by the major-cut radius rApex = T/sin(θ/2),
 * which SHRINKS with apex height H (Figure-4 direction) over a wide range (~10× here). The
 * TOTAL length grows with H — reaching the crease costs ≥ w/2 and w grows — but the landing
 * depth past the crease shrinks with H: deep when flat, just touching when steep.
 */
export function computeFoldReach(rApex: number, w: number): number {
  const d = Math.max(0, rApex);
  return w > 0 ? Math.hypot(w / 2, d) : d;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function len3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * Interior dihedral γ (rad) between adjacent lateral faces along the ridge
 * apex → base vertex (DETC tuck clearance at each base corner).
 */
export function computeDihedralGamma(R: number, H: number, N: number): number {
  if (!(R > 0 && H > 0 && N >= 3)) {
    return Math.PI;
  }
  const step = TAU / N;
  const phi = -Math.PI / 2;
  const baseVert = (angle: number): Vec3 => ({
    x: R * Math.cos(angle),
    y: R * Math.sin(angle),
    z: 0,
  });
  const bi = baseVert(phi);
  const bPrev = baseVert(phi - step);
  const bNext = baseVert(phi + step);
  const apex: Vec3 = { x: 0, y: 0, z: H };

  const n1 = cross3(sub3(bPrev, bi), sub3(apex, bi));
  const n2 = cross3(sub3(apex, bi), sub3(bNext, bi));
  const l1 = len3(n1);
  const l2 = len3(n2);
  if (l1 < 1e-12 || l2 < 1e-12) {
    return Math.PI;
  }
  const cosAngle =
    (n1.x * n2.x + n1.y * n2.y + n1.z * n2.z) / (l1 * l2);
  const betweenNormals = Math.acos(Math.max(-1, Math.min(1, cosAngle)));
  // Outward normals on a convex pyramid: interior dihedral γ = π − angle(n1, n2).
  return Math.PI - betweenNormals;
}

/**
 * Selects which formula computeMinorCutLength uses. Three AKDE-internal
 * candidates — DETC2019-97557 and Liu et al. 2018 both say only that the
 * minor cut depends on γ and W qualitatively, no closed-form is given.
 *
 * - "tuck-flap": ℓ = w · tan((π − γ)/2). Plan §6 inferred form; assumes the
 *   slit reaches the valley fold to define a triangular tuck flap. Gives
 *   long cuts (~w-scale) that shrink as γ → π. Does NOT use T.
 *
 * - "lie-flat": ℓ = T / sin(γ/2). Derived by analogy with the major-cut
 *   formula rApex = T/sin(θ/2) (plan §2.6.4): two paper sheets of thickness
 *   T meeting at dihedral γ have their inner offset surfaces meet at
 *   distance T/sin(γ/2) along the dihedral bisector — material inside that
 *   pinch zone can't fold flat. Gives short cuts (~T-scale). Does NOT
 *   guarantee the slit reaches the valley fold; for typical T it doesn't.
 *
 * - "fold-bound": ℓ = √((w/2)² + (T/sin(γ/2))²). Combines the lie-flat
 *   physics with an added "cut must reach the fold" geometric rule. The
 *   straight-line cut from p2 has two perpendicular components in the
 *   molecule frame: w/2 (perpendicular distance from p2 to the fold
 *   bisector — forced by geometry) and T/sin(γ/2) (inward depth past
 *   topMid along the fold — the lie-flat stacking distance). The endpoint
 *   lands on the fold at offset T/sin(γ/2) inward of topMid; cuts from p2
 *   and p3 converge there by symmetry; ℓ is strictly > w/2 whenever T > 0
 *   so the cut is always visible and never overlaps the outer chord.
 *   Limits: T→0 ⇒ ℓ→w/2 (just touches topMid); γ→π ⇒ ℓ→√((w/2)²+T²);
 *   γ→0 ⇒ ℓ→∞ (sharp fold needs unbounded relief, consistent with both
 *   other candidates).
 *
 * - "strip-removal": ℓ = T/sin(γ/2). The returned scalar is the perpendicular
 *   DEPTH (not a slit length) of the trapezoidal overlap strip near the
 *   outer chord — the region of the molecule that would self-intersect when
 *   folded face-to-face along the valley crease. Strip area per molecule is
 *   wℓ − ℓ² tan(θ/2). Pattern rendering interprets this depth by emitting
 *   three cut segments tracing the strip's inner boundary (right slant-leg
 *   portion, strip bottom, left slant-leg portion); the outer-chord side is
 *   already drawn by the outer 2N-gon boundary. This is the only candidate
 *   that physically cuts out the overlap rather than relieving it with a
 *   slit.
 *
 * - "end-leg": ℓ = D(i,j) = w / cos(θ/2) = 2·s·tan(θ/2). The molecule end-leg
 *   length labelled D(i,j) in DETC Figure 2 (computeMoleculeEndLeg). Derived
 *   from the symmetric-trapezoid geometry rather than the dihedral: the end leg
 *   spans width w while leaning by θ/2. Depends on θ (and w), NOT on γ or T.
 *   ℓ ≥ w for every θ, so it never falls below w/2. θ→0 ⇒ ℓ→0; θ→π ⇒ ℓ→∞.
 *   GROWS with apex height H (a molecule SIZE, not a clearance).
 *
 * - "fold-clearance": ℓ = T·tan(γ/2) (computeFoldClearance). The bare thickness-scaled
 *   tuck relief; DECREASES with H (matches Figure 4 direction) but is a short corner
 *   notch that does NOT reach the crease (≪ w/2). Reference/components only.
 *
 * - "fold-reach": ℓ = hypot(w/2, rApex) (computeFoldReach). Reaches the valley crease at
 *   every N/H (the w/2 leg) AND keeps the H-proportionality in the penetration depth,
 *   tied to the major-cut radius rApex = T/sin(θ/2) (shrinks with H, ~10× range). Total
 *   length grows with H — reaching costs ≥ w/2 and w grows — but how far the cut lands
 *   past the crease shrinks with H. Needs rApex (5th arg of computeMinorCutLength).
 *
 * Switch this constant to flip the formula globally. The formulas are not
 * equivalent — they produce cuts that differ by 1–2 orders of magnitude at
 * typical inputs, "strip-removal" emits a different cut count per molecule
 * (3 vs 2), and "end-leg" vs "fold-clearance"/"fold-reach" differ in how they
 * move with H — so flipping requires re-checking visualizations and tolerance-
 * tight tests. "end-leg" needs θ; pass it as the 4th arg to computeMinorCutLength.
 */
export type MinorCutFormula =
  | "tuck-flap"
  | "lie-flat"
  | "fold-bound"
  | "strip-removal"
  | "end-leg"
  | "fold-clearance"
  | "fold-reach";
// "fold-reach" is the active default: it reaches the valley crease at every N/H AND
// keeps the Figure-4 inverse-H behaviour in the penetration depth (how far past the
// crease the cut lands). "fold-clearance" is the bare depth (shrinks with H but does
// not reach); "end-leg" (D) is a large always-reaching cut that GROWS with H.
export const MINOR_CUT_FORMULA: MinorCutFormula = "fold-reach";

/**
 * Minor cut length (mm) at each outer corner of an edge molecule.
 * Behavior is controlled by MINOR_CUT_FORMULA — see that constant for the
 * four candidate formulas and their derivations. "tuck-flap" ignores T;
 * the other three consume T. For "strip-removal" the returned value is a
 * perpendicular depth (used by pattern.ts to construct the strip boundary),
 * not a slit length.
 */
export function computeMinorCutLength(
  gamma: number,
  w: number,
  T: number = 0,
  theta?: number,
  rApex?: number,
): number {
  if (MINOR_CUT_FORMULA === "fold-reach") {
    // ℓ = hypot(w/2, rApex): reaches the crease; penetration = major-cut radius, shrinks with H.
    const depth = rApex ?? (theta && theta > 0 ? T / Math.sin(theta / 2) : 0);
    return computeFoldReach(depth, w);
  }
  if (MINOR_CUT_FORMULA === "fold-clearance") {
    // ℓ = T·tan(γ/2): bare depth, shrinks with H but does not reach the crease.
    return computeFoldClearance(gamma, T);
  }
  if (MINOR_CUT_FORMULA === "end-leg") {
    // D(i,j) = w / cos(θ/2); needs θ. Fall back to w (cos 0) for legacy 3-arg calls.
    if (!(w > 0)) return 0;
    const half = (theta ?? 0) / 2;
    if (half <= 1e-9) return w;
    if (half >= Math.PI / 2 - 1e-9) return 0;
    return w / Math.cos(half);
  }
  if (
    MINOR_CUT_FORMULA === "lie-flat" ||
    MINOR_CUT_FORMULA === "strip-removal"
  ) {
    const half = gamma / 2;
    if (!(T > 0) || half <= 1e-9 || half >= Math.PI - 1e-9) {
      return 0;
    }
    return T / Math.sin(half);
  }
  if (MINOR_CUT_FORMULA === "fold-bound") {
    const half = gamma / 2;
    if (!(T > 0) || !(w > 0) || half <= 1e-9 || half >= Math.PI - 1e-9) {
      return 0;
    }
    const lieFlatDepth = T / Math.sin(half);
    return Math.hypot(w / 2, lieFlatDepth);
  }
  // "tuck-flap" — original AKDE plan §6 formula.
  const halfSupplement = (Math.PI - gamma) / 2;
  if (halfSupplement <= 1e-9 || w <= 0) {
    return 0;
  }
  return w * Math.tan(halfSupplement);
}

/** Dihedral γ from full model state (uses R, H, N). */
export function computeDihedralGammaFromState(state: KirigamiState): number {
  return computeDihedralGamma(state.R, state.H, state.inputs.edgeCount);
}

/** All derived scalars from N, L, vertical altitude H (mm), and material thickness T (mm). */
export function computeDerived(
  N: number,
  L: number,
  H: number,
  T: number,
): KirigamiDerived {
  const R = computeR(N, L);
  const s = computeS(R, H);
  const psi = computePsi(H, R);
  const kappa = computeKappa(H, R);
  const eta = computeEta(R, s, N);
  const deltaApex = computeDeltaApex(N, eta);
  const theta = computeTheta(deltaApex, N);
  const tau = computeTau(N);
  const w = computeW(s, theta);

  const gamma = computeDihedralGamma(R, H, N);
  const rApex = computeRApex(theta, T, s);
  const moleculeEndLeg = computeMoleculeEndLeg(s, theta);
  const minorCutLength = computeFoldReach(rApex, w);

  return {
    theta,
    w,
    R,
    H,
    s,
    psi,
    kappa,
    eta,
    deltaApex,
    tau,
    gamma,
    rApex,
    moleculeEndLeg,
    minorCutLength,
  };
}

/** Recompute pyramid geometry from user inputs. H = totalCurvature (vertical, mm). */
export function computeState(inputs: KirigamiInputs): KirigamiState {
  const {
    edgeCount: N,
    edgeLength: L,
    totalCurvature: H,
    materialThickness: T,
  } = inputs;
  if (!(H > 0)) {
    throw new Error("Apex height H (K_tot) must be greater than 0 mm");
  }
  return { inputs, ...computeDerived(N, L, H, T) };
}

/** Default inputs: N=6, L=100 mm, H = R = 100 mm (ψ = 45°, κ = 1), T = 1 mm (paper sheet). */
export function defaultInputs(): KirigamiInputs {
  const N = 6;
  const L = 100;
  const R = L / (2 * Math.sin(Math.PI / N));
  return {
    edgeCount: N,
    edgeLength: L,
    outerEdgeLength: L, // outer perimeter edge = base edge by default
    totalCurvature: R, // H = R → ψ = 45°, κ = 1
    materialThickness: 1,
  };
}
