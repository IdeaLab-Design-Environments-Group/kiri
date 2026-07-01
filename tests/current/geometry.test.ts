import { describe, expect, it } from "vitest";
import {
  computeDerived,
  computeDihedralGamma,
  computeMinorCutLength,
  computeState,
} from "@kirigami/model/index.js";

const TOL = 1e-9;

describe("geometry golden row (N=4, L=100mm, H≈70.7mm)", () => {
  const N = 4;
  const L = 100;
  const H = L / Math.SQRT2;
  const T = 1;

  it("matches plan: theta≈π/6, w=2s·sin(θ/2)≈51.76mm, R≈H, ψ=45°, rApex=T/sin(θ/2)", () => {
    const state = computeState({
      edgeCount: N,
      edgeLength: L,
      totalCurvature: H,
      materialThickness: T,
    });

    expect(state.R).toBeCloseTo(L / Math.SQRT2, 6);
    expect(state.H).toBeCloseTo(H, 6);
    expect(state.s).toBeCloseTo(100, 6);
    expect(state.psi).toBeCloseTo(Math.PI / 4, 6);
    expect(state.kappa).toBeCloseTo(1, 6);
    expect(state.eta).toBeCloseTo(Math.PI / 3, 6);
    expect(state.theta).toBeCloseTo(Math.PI / 6, 6);
    expect(state.w).toBeCloseTo(2 * 100 * Math.sin(Math.PI / 12), 6);
    expect(state.deltaApex).toBeCloseTo((2 * Math.PI) / 3, 6);
    expect(state.tau).toBeCloseTo(Math.PI / 2, 6);
    expect(state.rApex).toBeCloseTo(T / Math.sin(Math.PI / 12), 6);
  });

  it("computeDerived matches computeState scalars", () => {
    const derived = computeDerived(N, L, H, T);
    const state = computeState({
      edgeCount: N,
      edgeLength: L,
      totalCurvature: H,
      materialThickness: T,
    });
    expect(state.theta).toBeCloseTo(derived.theta, 12);
    expect(state.w).toBeCloseTo(derived.w, 12);
    expect(state.R).toBeCloseTo(derived.R, 12);
    expect(state.rApex).toBeCloseTo(derived.rApex, 12);
  });

  it("dihedral gamma and minor cut length are positive for square pyramid", () => {
    const state = computeState({
      edgeCount: N,
      edgeLength: L,
      totalCurvature: H,
      materialThickness: T,
    });
    expect(state.gamma).toBeCloseTo(Math.acos(-1 / 3), 6);
    expect(computeDihedralGamma(state.R, state.H, N)).toBeCloseTo(state.gamma, 12);
    expect(
      computeMinorCutLength(
        state.gamma,
        state.w,
        state.inputs.materialThickness,
      ),
    ).toBeGreaterThan(0);
  });

  it("satisfies angle closure Nθ + Nη = 2π", () => {
    const state = computeState({
      edgeCount: N,
      edgeLength: L,
      totalCurvature: H,
      materialThickness: T,
    });
    const residual = Math.abs(N * state.theta + N * state.eta - 2 * Math.PI);
    expect(residual).toBeLessThan(TOL);
  });
});
