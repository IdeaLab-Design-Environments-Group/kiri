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

describe("the fold is drawn, not skipped", () => {
  it("no frame jumps a node across the model, ramping or letting go", { timeout: 30000 }, async () => {
    // Letting go of the guide is a snap-through: the pose the guide holds is not an equilibrium of
    // the pattern alone, so the mesh crosses a barrier and slides to the one that is. That is real —
    // stretching the release from 1 second to 15 does not change it — but at a full frame's worth of
    // stepping the whole slide landed in about five rendered frames, moving a node 36% of the span
    // in ONE of them. Correct when paused, a flick in motion. Frames are cut short through fast
    // motion instead, with everything measured per frame scaled by the share that ran, so the fold
    // itself is untouched.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { buildScene } = await import("../../../src/sim/scene.js");
    const fold = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../public/examples/house.fkld", import.meta.url)), "utf8"),
    );
    const { model, solver } = buildScene(fold)!.scene;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 3 * model.numNodes; i++) {
      lo = Math.min(lo, model.rest[i]);
      hi = Math.max(hi, model.rest[i]);
    }
    const span = hi - lo;

    const runner = new FoldRunner(model, solver);
    runner.setTarget(1);
    const before = new Float32Array(model.position.length);
    let worst = 0;
    let sawRelease = false;
    for (let f = 0; f < 2000 && !runner.settled(); f++) {
      before.set(model.position);
      runner.frame();
      if (runner.atTarget()) sawRelease = true;
      for (let i = 0; i < model.numNodes; i++) {
        worst = Math.max(worst, Math.hypot(
          model.position[3 * i] - before[3 * i],
          model.position[3 * i + 1] - before[3 * i + 1],
          model.position[3 * i + 2] - before[3 * i + 2],
        ) / span);
      }
    }
    expect(sawRelease).toBe(true); // the run actually got as far as letting go
    expect(runner.settled()).toBe(true);
    // 1.2% measured. It was 36.2% before frames could be cut short, and 4.3% once they could; the
    // rest went when the guide started aiming along the net's own kinematics (`fold-kinematics.ts`),
    // because the sheet then arrives at a real equilibrium of its creases and letting go of it moves
    // almost nothing — the release frames now peak at 0.1%. The bound stays loose: it is here to
    // catch a frame that skips a snap, not to pin today's number.
    expect(worst).toBeLessThan(0.08);
  });
});
