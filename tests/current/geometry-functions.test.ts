import { describe, expect, it } from "vitest";
import {
  computeDeltaApex,
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
  MINOR_CUT_FORMULA,
} from "@kirigami/model/geometry.js";

describe("computeR (base circumradius)", () => {
  it("hexagon: R = L (since 2·sin(π/6) = 1)", () => {
    expect(computeR(6, 100)).toBeCloseTo(100, 9);
  });
  it("square: R = L/√2", () => {
    expect(computeR(4, 100)).toBeCloseTo(100 / Math.SQRT2, 9);
  });
  it("scales linearly with L", () => {
    expect(computeR(7, 250)).toBeCloseTo(2.5 * computeR(7, 100), 9);
  });
});

describe("computeS / computePsi / computeKappa", () => {
  it("computeS is the Pythagorean slant (3,4,5)", () => {
    expect(computeS(3, 4)).toBeCloseTo(5, 12);
  });
  it("computePsi = atan2(H, R): 45° when H = R, 0 when flat, 90° when R = 0", () => {
    expect(computePsi(1, 1)).toBeCloseTo(Math.PI / 4, 12);
    expect(computePsi(0, 5)).toBeCloseTo(0, 12);
    expect(computePsi(5, 0)).toBeCloseTo(Math.PI / 2, 12);
  });
  it("computeKappa = H/R, NaN when R = 0", () => {
    expect(computeKappa(2, 1)).toBe(2);
    expect(Number.isNaN(computeKappa(1, 0))).toBe(true);
  });
});

describe("computeEta (apex face angle)", () => {
  it("clamps the arcsin argument to ≤ 1 (degenerate s < R sin(π/N) ⇒ η = π)", () => {
    expect(computeEta(100, 50, 4)).toBeCloseTo(Math.PI, 12);
  });
  it("returns 0 for non-positive R or s", () => {
    expect(computeEta(0, 100, 4)).toBe(0);
    expect(computeEta(100, 0, 4)).toBe(0);
  });
  it("decreases as the pyramid gets taller (slant s grows ⇒ slimmer faces)", () => {
    const R = 100;
    const short = computeEta(R, computeS(R, 50), 6);
    const tall = computeEta(R, computeS(R, 500), 6);
    expect(tall).toBeLessThan(short);
  });
});

describe("computeDeltaApex / computeTheta / computeTau", () => {
  it("θ = δ/N and the closure identity Nθ + Nη = 2π holds by construction", () => {
    const N = 5;
    const eta = 0.8;
    const delta = computeDeltaApex(N, eta); // 2π − Nη
    const theta = computeTheta(delta, N);
    expect(N * theta + N * eta).toBeCloseTo(2 * Math.PI, 12);
  });
  it("computeTau = 2π/N", () => {
    expect(computeTau(6)).toBeCloseTo(Math.PI / 3, 12);
  });
});

describe("computeW / computeMoleculeEndLeg", () => {
  it("w = 2·s·sin(θ/2)", () => {
    expect(computeW(100, Math.PI / 6)).toBeCloseTo(200 * Math.sin(Math.PI / 12), 9);
  });
  it("end leg D = 2·s·tan(θ/2) = w/cos(θ/2) ≥ w", () => {
    const s = 120;
    const theta = 0.9;
    const D = computeMoleculeEndLeg(s, theta);
    const w = computeW(s, theta);
    expect(D).toBeCloseTo(w / Math.cos(theta / 2), 9);
    expect(D).toBeGreaterThanOrEqual(w);
  });
  it("end leg is 0 for degenerate θ (≤ 0 or ≥ π)", () => {
    expect(computeMoleculeEndLeg(100, 0)).toBe(0);
    expect(computeMoleculeEndLeg(100, Math.PI)).toBe(0);
  });
});

describe("computeRApex (major-cut radius)", () => {
  it("equals T/sin(θ/2) when below the 0.4·s visualization clamp", () => {
    expect(computeRApex(Math.PI / 6, 1, 100)).toBeCloseTo(1 / Math.sin(Math.PI / 12), 9);
  });
  it("clamps to 0.4·s for tiny θ / thick material", () => {
    expect(computeRApex(Math.PI / 6, 100, 100)).toBeCloseTo(40, 9);
  });
  it("returns 0 for non-positive T or θ", () => {
    expect(computeRApex(Math.PI / 6, 0, 100)).toBe(0);
    expect(computeRApex(0, 1, 100)).toBe(0);
  });
});

describe("computeFoldClearance / computeFoldReach", () => {
  it("fold clearance = T·tan(γ/2); 0 at the degenerate γ boundaries", () => {
    expect(computeFoldClearance(Math.PI / 2, 2)).toBeCloseTo(2, 9); // tan(π/4)=1
    expect(computeFoldClearance(0, 2)).toBe(0);
    expect(computeFoldClearance(Math.PI, 2)).toBe(0);
  });
  it("fold reach = hypot(w/2, rApex) (3-4-5) and falls back to rApex when w = 0", () => {
    expect(computeFoldReach(3, 8)).toBeCloseTo(5, 12); // hypot(4,3)
    expect(computeFoldReach(7, 0)).toBe(7);
  });
});

describe("computeDihedralGamma", () => {
  it("square pyramid (H = R) → arccos(−1/3)", () => {
    const R = 100 / Math.SQRT2;
    expect(computeDihedralGamma(R, R, 4)).toBeCloseTo(Math.acos(-1 / 3), 9);
  });
  it("returns π for degenerate inputs (R≤0, H≤0, or N<3)", () => {
    expect(computeDihedralGamma(0, 5, 4)).toBe(Math.PI);
    expect(computeDihedralGamma(5, 0, 4)).toBe(Math.PI);
    expect(computeDihedralGamma(5, 5, 2)).toBe(Math.PI);
  });
  it("closes (smaller γ) as the pyramid gets taller", () => {
    expect(computeDihedralGamma(100, 500, 6)).toBeLessThan(
      computeDihedralGamma(100, 50, 6),
    );
  });
});

describe("computeMinorCutLength (active formula)", () => {
  it("is wired to fold-reach: hypot(w/2, rApex)", () => {
    expect(MINOR_CUT_FORMULA).toBe("fold-reach");
    const w = 40;
    const rApex = 3;
    const ell = computeMinorCutLength(1.9, w, 1, Math.PI / 6, rApex);
    expect(ell).toBeCloseTo(Math.hypot(w / 2, rApex), 12);
  });
  it("derives the penetration from θ and T when rApex is omitted", () => {
    const w = 40;
    const theta = Math.PI / 6;
    const T = 2;
    const ell = computeMinorCutLength(1.9, w, T, theta);
    expect(ell).toBeCloseTo(Math.hypot(w / 2, T / Math.sin(theta / 2)), 9);
  });
});

describe("computeState invariants", () => {
  it("throws when H ≤ 0", () => {
    expect(() =>
      computeState({ edgeCount: 6, edgeLength: 100, totalCurvature: 0, materialThickness: 1 }),
    ).toThrow();
  });

  it("is scale-invariant: ×k on all lengths keeps angles fixed and scales lengths by k", () => {
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
    // angles unchanged
    for (const k of ["theta", "eta", "psi", "kappa", "tau", "deltaApex", "gamma"] as const) {
      expect(scaled[k]).toBeCloseTo(base[k], 9);
    }
    // lengths doubled
    for (const k of ["R", "s", "w", "rApex", "moleculeEndLeg", "minorCutLength"] as const) {
      expect(scaled[k]).toBeCloseTo(2 * base[k], 6);
    }
  });

  it("defaultInputs gives a 45° hexagonal pyramid (H = R, κ = 1)", () => {
    const s = computeState(defaultInputs());
    expect(s.inputs.edgeCount).toBe(6);
    expect(s.kappa).toBeCloseTo(1, 9);
    expect(s.psi).toBeCloseTo(Math.PI / 4, 9);
    expect(s.H).toBeCloseTo(s.R, 9);
  });
});
