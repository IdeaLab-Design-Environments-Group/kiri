import { describe, expect, it } from "vitest";
import {
  evaluateConstraints,
  evaluateC1,
  evaluateC2,
  evaluateC3,
  evaluateC4,
  CONSTRAINT_EPS,
} from "@kirigami/model/constraints.js";
import { computeState } from "@kirigami/model/geometry.js";
import type { KirigamiState } from "@kirigami/model/types.js";

/** Minimal crafted state for testing a single evaluator's pure math. */
const fakeState = (
  over: Partial<Omit<KirigamiState, "inputs">> & {
    inputs?: Partial<KirigamiState["inputs"]>;
  },
) =>
  ({
    theta: 0,
    eta: 0,
    w: 0,
    tau: 0,
    s: 0,
    rApex: 0,
    gamma: Math.PI,
    ...over,
    inputs: { edgeCount: 6, edgeLength: 100, materialThickness: 1, ...over.inputs },
  }) as unknown as KirigamiState;

describe("evaluateConstraints", () => {
  it("returns C1–C6 and all pass for the canonical square pyramid", () => {
    const state = computeState({
      edgeCount: 4,
      edgeLength: 100,
      totalCurvature: 100 / Math.SQRT2,
      materialThickness: 1,
    });
    const cons = evaluateConstraints(state);
    expect(cons.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
    expect(cons.every((c) => c.satisfied)).toBe(true);
  });

  it("C5 fails for a tall pyramid (κ=2) where w > L", () => {
    const state = computeState({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 200, // R=100 → κ=2
      materialThickness: 1,
    });
    const c5 = evaluateConstraints(state).find((c) => c.id === "C5")!;
    expect(state.w).toBeGreaterThan(state.inputs.edgeLength);
    expect(c5.satisfied).toBe(false);
    expect(c5.residual).toBeGreaterThan(0);
  });

  it("C6 fails for very thick material where the relief overshoots the molecule", () => {
    const state = computeState({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 100, // κ=1
      materialThickness: 80,
    });
    const c6 = evaluateConstraints(state).find((c) => c.id === "C6")!;
    expect(c6.satisfied).toBe(false);
    expect(c6.residual).toBeGreaterThan(0);
  });
});

describe("individual constraint evaluators (crafted states)", () => {
  it("C1 residual is ~0 exactly at angle closure and grows away from it", () => {
    const N = 6;
    const eta = 0.5;
    const closing = fakeState({ theta: 2 * Math.PI / N - eta, eta, inputs: { edgeCount: N } });
    expect(evaluateC1(closing).residual).toBeLessThan(CONSTRAINT_EPS);
    expect(evaluateC1(closing).satisfied).toBe(true);

    const broken = fakeState({ theta: 0.1, eta, inputs: { edgeCount: N } });
    expect(evaluateC1(broken).residual).toBeGreaterThan(CONSTRAINT_EPS);
    expect(evaluateC1(broken).satisfied).toBe(false);
  });

  it("C2 vector closure is ~0 for equal phasors at τ = 2π/N", () => {
    const N = 5;
    const c2 = evaluateC2(fakeState({ w: 42, tau: (2 * Math.PI) / N, inputs: { edgeCount: N } }));
    expect(c2.residual).toBeLessThan(1e-9);
    expect(c2.satisfied).toBe(true);
  });

  it("C2 fails when the phasors don't close (wrong τ)", () => {
    const c2 = evaluateC2(fakeState({ w: 42, tau: 0.1, inputs: { edgeCount: 5 } }));
    expect(c2.residual).toBeGreaterThan(1);
    expect(c2.satisfied).toBe(false);
  });

  it("C3 passes for |θ| < π and fails at θ = π", () => {
    expect(evaluateC3(fakeState({ theta: Math.PI / 6 })).satisfied).toBe(true);
    const fail = evaluateC3(fakeState({ theta: Math.PI }));
    expect(fail.satisfied).toBe(false);
    expect(fail.residual).toBeGreaterThan(0);
  });

  it("C4 passes for w ≥ 0 and fails for negative width (residual = |w|)", () => {
    expect(evaluateC4(fakeState({ w: 12 })).satisfied).toBe(true);
    const fail = evaluateC4(fakeState({ w: -5 }));
    expect(fail.satisfied).toBe(false);
    expect(fail.residual).toBeCloseTo(5, 12);
  });
});
