/**
 * The fold every panel agrees on — `sim/fold-kinematics.ts`.
 *
 * The sim landed its declared forms but the *motion* was wrong: panels swung off in different
 * directions, the sheet squashed and re-expanded, and the fold finished with a fifth of the slider
 * unused (77% of the target angles at a slider of 0.6, 95% at 0.8). The guide was aiming down the
 * straight `rest → goal` chord, which is not a fold — at `s = 0.5` that pose has every vertex at its
 * chord midpoint, bars foreshortened by up to 100% and its own crease angles reading 0% folded — so
 * guide and crease springs pulled at the sheet from two different shapes.
 *
 * These nets admit an exact answer instead. The Kirigamizer flattens a closed shape by cutting it to
 * a disk, and what comes out has no loop in its panel graph, so the pose at fold fraction `s` follows
 * from the crease angles alone: hold a panel and rotate every subtree about its hinge by `s·θ`. What
 * this file checks is that the construction really is that — rigid panels, every crease at exactly
 * `s` of its target, the declared form at `s = 1` — and that driving the real `FoldRunner` with it
 * makes the slider mean what it says.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import { buildCreaseTree, kinematicPose, spreadAnchors } from "../../../src/sim/fold-kinematics.js";
import { measureTheta } from "../../../src/sim/solver.js";
import { FoldRunner } from "../../../src/sim/fold-run.js";
import type { BarHingeModel } from "../../../src/sim/model.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { applyRigid, kabsch } from "../../../src/pipeline/verify.js";

const load = (name: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${name}`, import.meta.url)), "utf8")) as FoldFile;

/** Nets whose panel graph is a tree, so a coordinated fold exists. */
const COORDINATED = ["house.fkld", "church.fkld", "puffin.fkld"] as const;

function span(m: BarHingeModel): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 3 * m.numNodes; i++) {
    if (m.goal[i] < lo) lo = m.goal[i];
    if (m.goal[i] > hi) hi = m.goal[i];
  }
  return hi > lo ? hi - lo : 1;
}

/** Mean fraction of its target angle each crease is holding, over the ones worth measuring. */
function foldedFraction(m: BarHingeModel): number {
  const c = m.creases;
  let sum = 0, n = 0;
  for (let i = 0; i < c.count - (m.seamCreases ?? 0); i++) {
    if (Math.abs(c.targetTheta[i]) < 0.17) continue;
    sum += measureTheta(m, c.face1[i], c.face2[i], c.n3[i], c.n4[i]) / c.targetTheta[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
}

describe("the panel tree", () => {
  it("finds one for the closed shapes, and reports the loop in the nets that have one", () => {
    for (const name of COORDINATED) {
      const { model } = buildScene(load(name))!.scene;
      expect(buildCreaseTree(model).loops).toEqual([]);
      expect(model.foldDrive).toBe("kinematic");
    }
    // Its one loop closes on a facet crease whose target is zero, so the tree fold shuts it exactly
    // and it still qualifies — the gate is whether the fold reproduces the form, not whether the
    // graph is a tree.
    const flap = buildScene(load("kirigami-flap.fkld"))!.scene.model;
    expect(buildCreaseTree(flap).loops.length).toBe(1);
    expect(flap.foldDrive).toBe("kinematic");
  });

  it("refuses the AKDE cones, whose declared form no fold reaches", () => {
    for (const name of ["akde-hex.fkld", "akde-decagon-pyramid.fkld"]) {
      const { model } = buildScene(load(name))!.scene;
      expect(buildCreaseTree(model).loops.length).toBe(1);
      expect(model.foldDrive).toBe("chord"); // and so nothing is pinned, and the guide is as before
      expect(Array.from(model.fixed).some((f) => f === 1)).toBe(false);
    }
  });
});

describe("the kinematic pose is the fold", () => {
  for (const name of COORDINATED) {
    it(`${name}: panels stay rigid, every crease sits at exactly its share, and s=1 is the form`, () => {
      const { model } = buildScene(load(name))!.scene;
      // The tree the scene is actually driven by. Rebuilding one here would pick a different root —
      // `buildCreaseTree` reads `model.goal` for that, and the goal has since been re-placed onto
      // this tree's own fold — and a different root means a different rigid placement.
      const tree = model.creaseTree!;
      const pose = new Float32Array(3 * model.numNodes);
      const saved = model.position.slice();
      const c = model.creases;
      const scored = c.count - (model.seamCreases ?? 0);

      for (const s of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
        kinematicPose(model, tree, s, pose);

        // Rigid panels: every bar at its rest length, to floating-point.
        let worstStrain = 0;
        for (let e = 0; e < model.beams.count; e++) {
          const a = model.beams.n0[e], b = model.beams.n1[e];
          const l = Math.hypot(pose[3 * a] - pose[3 * b], pose[3 * a + 1] - pose[3 * b + 1], pose[3 * a + 2] - pose[3 * b + 2]);
          worstStrain = Math.max(worstStrain, Math.abs(l / model.beams.rest[e] - 1));
        }
        expect(worstStrain).toBeLessThan(1e-4);

        // Coordinated: no crease ahead of another. This is the whole point — the wrong rotation sign
        // still gives perfectly rigid panels, and misses here by twice the fold angle (190° on house).
        model.position.set(pose);
        let worstTheta = 0;
        for (let i = 0; i < scored; i++) {
          worstTheta = Math.max(worstTheta, Math.abs(measureTheta(model, c.face1[i], c.face2[i], c.n3[i], c.n4[i]) - s * c.targetTheta[i]));
        }
        expect(worstTheta).toBeLessThan(1e-3);
      }

      // The ends are exact: flat sheet at 0, the declared form at 1.
      kinematicPose(model, tree, 0, pose);
      for (let i = 0; i < pose.length; i++) expect(pose[i]).toBeCloseTo(model.rest[i], 5);
      kinematicPose(model, tree, 1, pose);
      for (let i = 0; i < pose.length; i++) expect(pose[i]).toBeCloseTo(model.goal[i], 5);
      model.position.set(saved);
    });
  }
});

describe("the fold as the viewer drives it", () => {
  it("rises off the table rather than hanging below it, and nails nothing down", () => {
    const { model } = buildScene(load("house.fkld"))!.scene;
    const tree = model.creaseTree!;
    const rootNodes = [model.faces.a[tree.root], model.faces.b[tree.root], model.faces.c[tree.root]];
    // The panel the artifact rests on is held by the guide, as a force. Pinning it would make it the
    // one part of the sheet not being simulated, and measured it buys nothing: the shape puffin
    // settles into is the same to within 0.01% of a span either way.
    expect(Array.from(model.fixed).some((f) => f === 1)).toBe(false);

    // Which side of the sheet the fold rises to is fixed by the crease signs, not by the root — every
    // panel of this net gives a fold that descends — so the scene is turned over to put it up.
    const plane = model.rest[3 * rootNodes[0] + 2];
    let above = 0, below = 0;
    for (let i = 0; i < model.numNodes; i++) {
      if (model.goal[3 * i + 2] > plane + 1e-6) above++;
      else if (model.goal[3 * i + 2] < plane - 1e-6) below++;
    }
    expect(above).toBeGreaterThan(below);
  });

  for (const name of COORDINATED) {
    it(`${name}: the slider means how folded it is, and the base does not move`, { timeout: 40000 }, () => {
      const { model, solver } = buildScene(load(name))!.scene;
      const tree = model.creaseTree!;
      const rootNodes = [model.faces.a[tree.root], model.faces.b[tree.root], model.faces.c[tree.root]];
      const rootStart = rootNodes.map((n) => [model.position[3 * n], model.position[3 * n + 1], model.position[3 * n + 2]]);

      const runner = new FoldRunner(model, solver);
      for (const s of [0.2, 0.4, 0.6, 0.8, 1]) {
        runner.setTarget(s);
        for (let i = 0; i < 3000 && !runner.settled(); i++) runner.frame();
        // Measured 20/40/60/80/100 on all three, within a point. It read 17/40/77/95 down the chord.
        expect(Math.abs(foldedFraction(model) - s)).toBeLessThan(0.05);
      }

      // Lands its form, without stretching to get there.
      let off = 0;
      for (let i = 0; i < model.numNodes; i++) {
        off = Math.max(off, Math.hypot(
          model.position[3 * i] - model.goal[3 * i],
          model.position[3 * i + 1] - model.goal[3 * i + 1],
          model.position[3 * i + 2] - model.goal[3 * i + 2],
        ));
      }
      expect(off / span(model)).toBeLessThan(0.06); // 1.4% / 3.1% / 1.5% measured

      // The panel it rests on has stayed put through all of it — held there by the guide rather than
      // nailed, so it is a solved node like every other. 0.65-0.95% of a span measured; it wandered
      // 11-15% when rigid-body motion was still being removed from a fold the guide already places.
      rootNodes.forEach((n, k) => {
        expect(Math.hypot(
          model.position[3 * n] - rootStart[k][0],
          model.position[3 * n + 1] - rootStart[k][1],
          model.position[3 * n + 2] - rootStart[k][2],
        ) / span(model)).toBeLessThan(0.03);
      });
    });
  }
});

/**
 * The gate that decides whether a net gets the coordinated fold at all.
 *
 * It has to be trustworthy in BOTH directions, and it was not: measured through the root panel's
 * three corners it under-reported a genuine 4.4% miss on church as 0.61% and a 4.0% one on puffin as
 * 0.48%. Against a 2% tolerance that let a net miss its declared form by a sixth of the model and
 * still be driven as though every hinge folding to its target reproduced it — which is what put
 * splayed flaps on a finely meshed model while the modal read "coordinated".
 */
describe("the closure gate", () => {
  /** Bend one hinge past its target and see how much of the resulting error the metric can see. */
  function blindness(m: BarHingeModel): number {
    const tree = m.creaseTree ?? buildCreaseTree(m);
    const c = m.creases;
    const base = kinematicPose(m, tree, 1, new Float32Array(3 * m.numNodes));
    const probe = new Float32Array(3 * m.numNodes);
    const anchors = spreadAnchors(base, m.numNodes, 4);
    const sp = span(m);
    let worst = 0;
    for (let i = 0; i < c.count - (m.seamCreases ?? 0); i++) {
      if ((c.seamPeer3?.[i] ?? -1) >= 0 || Math.abs(c.targetTheta[i]) < 0.17) continue;
      const save = c.targetTheta[i];
      c.targetTheta[i] = save + 0.2;
      kinematicPose(m, tree, 1, probe);
      c.targetTheta[i] = save;

      // What the gate would say.
      let reported = 0;
      for (let n = 0; n < m.numNodes; n++) for (const a of anchors) {
        const dp = Math.hypot(probe[3*n]-probe[3*a], probe[3*n+1]-probe[3*a+1], probe[3*n+2]-probe[3*a+2]);
        const dg = Math.hypot(base[3*n]-base[3*a], base[3*n+1]-base[3*a+1], base[3*n+2]-base[3*a+2]);
        reported = Math.max(reported, Math.abs(dp - dg));
      }
      // The truth: the same two poses, best-fit onto each other first, since the declared form is
      // only ever meant up to rigid motion — a bend near the root turns nearly the whole model and
      // is largely NOT an error at all.
      const from = [], to = [];
      for (let n = 0; n < m.numNodes; n++) {
        from.push({ x: probe[3*n], y: probe[3*n+1], z: probe[3*n+2] });
        to.push({ x: base[3*n], y: base[3*n+1], z: base[3*n+2] });
      }
      const { R, t } = kabsch(from, to);
      let real = 0;
      for (let n = 0; n < m.numNodes; n++) {
        const q = applyRigid(R, t, from[n]);
        real = Math.max(real, Math.hypot(q.x - to[n].x, q.y - to[n].y, q.z - to[n].z));
      }
      if (real / sp > 0.005) worst = Math.max(worst, real / Math.max(reported, 1e-12));
    }
    return worst;
  }

  it("sees an error at something like its real size, on a fine mesh as well as a coarse one", () => {
    for (const name of [...COORDINATED, "kirigami-flap.fkld", "akde-hex.fkld"]) {
      const { model } = buildScene(load(name))!.scene;
      // 0.8-1.7x measured. Through the root triangle's corners it was 7.2x on church and 8.3x on
      // puffin, and got worse the finer the mesh, because that one triangle shrinks while the model
      // does not: distances to anchors that huddle together barely move when a panel swings sideways.
      expect(blindness(model)).toBeLessThan(2);
    }
  });

  it("separates a form the net can fold from one it cannot, with room to spare", () => {
    for (const name of [...COORDINATED, "kirigami-flap.fkld"]) {
      const { model } = buildScene(load(name))!.scene;
      expect(model.foldDrive).toBe("kinematic");
      expect(model.foldClosure!).toBeLessThan(1e-4); // 0.000% measured on all four
    }
    // A form no fold reaches: akde-hex wants 34% strain on its own bars. It misses by 88.7%, so the
    // 0.2% tolerance is not a close call in either direction — it is 400x clear of the nets that pass.
    const { model } = buildScene(load("akde-hex.fkld"))!.scene;
    expect(model.foldDrive).toBe("chord");
    expect(model.foldClosure!).toBeGreaterThan(0.5);
  });
});
