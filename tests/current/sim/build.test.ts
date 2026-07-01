import { describe, expect, it } from "vitest";
import { computeState } from "@kirigami/model/geometry.js";
import { buildFoldScene, singleHingeModel } from "../../../src/sim/build.js";

describe("sim/build", () => {
  it("creates a guided fold scene with driven apex, base-pair, and valley nodes", () => {
    const state = computeState({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 100,
      materialThickness: 1,
    });
    const { net, model, solver } = buildFoldScene(state);

    expect(net.tips.every((id) => model.driven[id] === 1 && model.fixed[id] === 1)).toBe(true);
    expect(net.basePairs.flat().every((id) => model.driven[id] === 1 && model.fixed[id] === 1)).toBe(true);
    expect(net.valleyOuter.every((id) => model.driven[id] === 1)).toBe(true);
    expect(solver.theta.length).toBe(model.creases.count);
  });

  it("builds a single-hinge model with the requested target", () => {
    const model = singleHingeModel(0.75, 1.5);
    expect(model.creases.count).toBe(1);
    expect(model.creases.targetTheta[0]).toBeCloseTo(0.75, 6);
  });
});
