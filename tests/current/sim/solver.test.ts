import { describe, expect, it } from "vitest";
import { singleHingeModel } from "../../../src/sim/build.js";
import { FoldSolver, measureTheta } from "../../../src/sim/solver.js";

describe("sim/solver", () => {
  it("moves driven boundary nodes along rest-to-goal interpolation", () => {
    const model = singleHingeModel(0);
    model.driven[0] = 1;
    model.fixed[0] = 1;
    model.goal[2] = 2;

    const solver = new FoldSolver(model);
    solver.foldPercent = 0.5;
    solver.step();

    expect(model.position[2]).toBeCloseTo(1, 6);
  });

  it("solves a single hinge toward its target angle and reports positions", () => {
    const model = singleHingeModel(1.1);
    model.fixed[0] = 1;
    model.fixed[1] = 1;
    model.fixed[2] = 1;

    const solver = new FoldSolver(model);
    solver.solve(4000, 1);

    expect(Math.abs(measureTheta(model, 0, 1, 0, 1))).toBeCloseTo(1.1, 1);
    expect(solver.foldPercent).toBe(1);
    expect(solver.positions()).toHaveLength(model.numNodes);
  });
});
