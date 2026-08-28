/**
 * How the fold is driven over time — `sim/fold-run.ts`.
 *
 * Worth its own file because ramp rate is part of the physics for an explicit integrator, not a
 * presentation detail: drive the fold faster than the mesh can relax and creases overshoot into the
 * wrong branch. That is a real regression this project shipped. A softly guided model was
 * classified by whether anything was *pinned*, which is false for it, so it went down the free
 * fold's per-step ramp — about 20× faster than the quasi-static one — and house.fkld drew with 4 of
 * its 9 creases up to 43° off target, 14% of a span from its declared form.
 *
 * The three properties below are therefore independent, and this is what says so.
 */
import { describe, expect, it } from "vitest";
import { FoldRunner } from "../../../src/sim/fold-run.js";
import { buildModel, DEFAULT_PARAMS, type BarHingeModel } from "../../../src/sim/model.js";
import { foldNetFromMesh } from "../../../src/sim/foldnet.js";
import { FoldSolver } from "../../../src/sim/solver.js";
import { vec3 } from "../../../src/sim/vec3.js";

/** Two triangles over a shared edge — enough to have a crease and a fold percent. */
function hinge(): BarHingeModel {
  const net = foldNetFromMesh(
    [vec3(0, 0, 0), vec3(1, 0, 0), vec3(0.5, 1, 0), vec3(0.5, -1, 0)],
    [
      [0, 1, 2],
      [1, 0, 3],
    ],
    () => "V",
  );
  return buildModel(net, DEFAULT_PARAMS);
}

const runnerFor = (m: BarHingeModel): FoldRunner => new FoldRunner(m, new FoldSolver(m));

describe("which cadence a scene gets", () => {
  it("a free fold is neither driven to a goal nor pinned", () => {
    const r = runnerFor(hinge());
    expect(r.toGoal).toBe(false);
    expect(r.unpinned).toBe(true);
    expect(r.guideHeld).toBe(false);
  });

  it("a pinned model is driven to a goal and needs no drift removal", () => {
    const m = hinge();
    m.fixed[0] = 1;
    const r = runnerFor(m);
    expect(r.toGoal).toBe(true);
    expect(r.unpinned).toBe(false);
  });

  it("a softly guided model is BOTH driven to a goal and unpinned", () => {
    // The regression in one assertion. Nothing is fixed, so a pinned-vs-not test calls this free and
    // ramps it 20× too fast; it needs the quasi-static cadence AND the drift removal.
    const m = hinge();
    m.softDriven = true;
    m.guideWeight = 1;
    m.driven[0] = 1;
    const r = runnerFor(m);
    expect(r.toGoal).toBe(true);
    expect(r.unpinned).toBe(true);
    expect(r.guideHeld).toBe(true);
  });
});

describe("the ramp", () => {
  it("is quasi-static when going to a goal — a frame moves a small fraction of the way", () => {
    const m = hinge();
    m.softDriven = true;
    m.guideWeight = 1;
    const r = runnerFor(m);
    r.setTarget(1);
    r.frame();
    // 5% of the remaining fold per frame. Well under the free ramp, which covers ~43% in its first
    // frame (40 steps at 1.4% each) and is what overshot the creases.
    expect(r.foldPercent).toBeGreaterThan(0.01);
    expect(r.foldPercent).toBeLessThan(0.1);
  });

  it("holds the guide through the ramp and only lets go once the fold has arrived", () => {
    const m = hinge();
    m.softDriven = true;
    m.guideWeight = 1;
    const r = runnerFor(m);
    r.setTarget(1);
    r.frame();
    expect(m.guideWeight).toBe(1); // mid-ramp: still holding
    expect(r.guideReleased()).toBe(false);
    expect(r.settled()).toBe(false);

    for (let i = 0; i < 500 && !r.settled(); i++) r.frame();
    expect(r.atTarget()).toBe(true);
    expect(m.guideWeight).toBe(0); // arrived, and let go of
    expect(r.settled()).toBe(true);
  });

  it("takes hold again when the slider moves, so a re-fold is guided too", () => {
    const m = hinge();
    m.softDriven = true;
    m.guideWeight = 1;
    const r = runnerFor(m);
    r.setTarget(1);
    for (let i = 0; i < 500 && !r.settled(); i++) r.frame();
    expect(m.guideWeight).toBe(0);
    r.setTarget(0.5);
    expect(m.guideWeight).toBe(1);
  });

  it("leaves a free fold's guide alone, there being none to hold", () => {
    const m = hinge();
    const r = runnerFor(m);
    r.setTarget(1);
    r.frame();
    expect(m.guideWeight).toBeUndefined();
    expect(r.guideReleased()).toBe(true);
  });
});
