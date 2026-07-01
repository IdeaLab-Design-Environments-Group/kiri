import { describe, expect, it } from "vitest";
import {
  computeDerived,
  computeDihedralGamma,
  computeEta,
  computeFoldClearance,
  computeFoldReach,
  computeKappa,
  computeMinorCutLength,
  computeMoleculeEndLeg,
  computePsi,
  computeR,
  computeRApex,
  computeS,
  computeState,
  computeTau,
  computeTheta,
  computeW,
  defaultInputs,
} from "@kirigami/model/geometry.js";

describe("model/geometry", () => {
  it("computes the canonical square-pyramid row consistently", () => {
    const state = computeState({
      edgeCount: 4,
      edgeLength: 100,
      totalCurvature: 100 / Math.SQRT2,
      materialThickness: 1,
    });

    expect(state.R).toBeCloseTo(100 / Math.SQRT2, 9);
    expect(state.s).toBeCloseTo(100, 9);
    expect(state.psi).toBeCloseTo(Math.PI / 4, 9);
    expect(state.eta).toBeCloseTo(Math.PI / 3, 9);
    expect(state.theta).toBeCloseTo(Math.PI / 6, 9);
    expect(state.deltaApex).toBeCloseTo((2 * Math.PI) / 3, 9);
    expect(state.tau).toBeCloseTo(Math.PI / 2, 9);
    expect(state.rApex).toBeCloseTo(1 / Math.sin(Math.PI / 12), 9);
  });

  it("keeps angle invariants under scaling and doubles length outputs", () => {
    const base = computeState({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 80,
      materialThickness: 1,
    });
    const scaled = computeState({
      edgeCount: 6,
      edgeLength: 200,
      totalCurvature: 160,
      materialThickness: 2,
    });

    for (const key of ["theta", "eta", "psi", "kappa", "tau", "deltaApex", "gamma"] as const) {
      expect(scaled[key]).toBeCloseTo(base[key], 9);
    }
    for (const key of ["R", "H", "s", "w", "rApex", "moleculeEndLeg", "minorCutLength"] as const) {
      expect(scaled[key]).toBeCloseTo(2 * base[key], 6);
    }
  });

  it("handles degenerate helper cases defensively", () => {
    expect(computeEta(0, 10, 4)).toBe(0);
    expect(computeEta(10, 0, 4)).toBe(0);
    expect(computeKappa(1, 0)).toBeNaN();
    expect(computeRApex(0, 1, 100)).toBe(0);
    expect(computeMoleculeEndLeg(100, 0)).toBe(0);
    expect(computeFoldClearance(0, 2)).toBe(0);
    expect(computeFoldReach(7, 0)).toBe(7);
  });

  it("satisfies core identities for the scalar helper functions", () => {
    const R = computeR(6, 100);
    const s = computeS(R, 100);
    const psi = computePsi(100, R);
    const eta = computeEta(R, s, 6);
    const delta = computeDerived(6, 100, 100, 1).deltaApex;
    const theta = computeTheta(delta, 6);
    const tau = computeTau(6);
    const w = computeW(s, theta);

    expect(R).toBeCloseTo(100, 9);
    expect(psi).toBeCloseTo(Math.PI / 4, 9);
    expect(6 * theta + 6 * eta).toBeCloseTo(2 * Math.PI, 9);
    expect(tau).toBeCloseTo(Math.PI / 3, 9);
    expect(w).toBeCloseTo(2 * s * Math.sin(theta / 2), 9);
  });

  it("uses the active fold-reach minor-cut formula", () => {
    const theta = Math.PI / 6;
    const w = 40;
    const rApex = 3;
    expect(computeMinorCutLength(2, w, 1, theta, rApex)).toBeCloseTo(Math.hypot(w / 2, rApex), 12);
  });

  it("computes geometric dihedral trends correctly", () => {
    const flat = computeDihedralGamma(100, 50, 6);
    const tall = computeDihedralGamma(100, 500, 6);
    expect(tall).toBeLessThan(flat);
    expect(computeDihedralGamma(0, 1, 4)).toBe(Math.PI);
  });

  it("provides stable defaults for the hexagonal base case", () => {
    const state = computeState(defaultInputs());
    expect(state.inputs.edgeCount).toBe(6);
    expect(state.H).toBeCloseTo(state.R, 9);
    expect(state.kappa).toBeCloseTo(1, 9);
  });
});
