/**
 * A taped seam is a fold of the artifact, so the sim gives it a hinge.
 *
 * A closed shape cannot be folded from a flat sheet without cutting itself open. house.fkld's solid
 * has 7 faces and 15 polygon edges, so a flat net keeps at most a spanning tree of 6 of them as
 * scored folds — the file has exactly 6 "M", the maximum — and the other 9 are cut into 18 lips that
 * fabrication tapes back together. Two thirds of that house's real fold lines are seams. Held only
 * by `buildSeams`' position springs they were bare PINS, free to scissor, so the artifact's own
 * structure was two thirds missing and the shape had to be found by the guide.
 *
 * `origami-import.ts › buildSeamCreases` gives each lip pair a torsional spring whose target is the
 * dihedral the declared form puts between the two lips' faces — an "M" crease in every respect,
 * because in the folded artifact that is exactly what it is.
 *
 * The one thing a seam hinge is not is a hinge while the tape is off, and that is what these pin
 * down: an open pair leaves a net torque on the artifact (its two couples are about different
 * lines), so the hinge must carry nothing until its lips actually meet.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import { FoldRunner } from "../../../src/sim/fold-run.js";
import { measureTheta } from "../../../src/sim/solver.js";
import { accumulateForces, computeFaceNormals, computeThetas } from "../../../src/sim/forces.js";
import type { BarHingeModel } from "../../../src/sim/model.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const load = (name: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${name}`, import.meta.url)), "utf8")) as FoldFile;

const deg = (r: number): number => (r * 180) / Math.PI;

function goalSpan(m: BarHingeModel): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 3 * m.numNodes; i++) {
    if (m.goal[i] < lo) lo = m.goal[i];
    if (m.goal[i] > hi) hi = m.goal[i];
  }
  return hi - lo || 1;
}

/** Farthest any node sits from where the declared form puts it, as a fraction of the form's span. */
function offGoal(m: BarHingeModel): number {
  let worst = 0;
  for (let i = 0; i < m.numNodes; i++) {
    worst = Math.max(worst, Math.hypot(
      m.position[3 * i] - m.goal[3 * i],
      m.position[3 * i + 1] - m.goal[3 * i + 1],
      m.position[3 * i + 2] - m.goal[3 * i + 2],
    ));
  }
  return worst / goalSpan(m);
}

/** Net torque the force pass leaves on the whole model, about its centroid. */
function netTorque(m: BarHingeModel, foldPercent: number, lastTheta: Float32Array): number {
  computeFaceNormals(m);
  computeThetas(m, lastTheta);
  m.force.fill(0);
  accumulateForces(m, lastTheta, foldPercent);
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < m.numNodes; i++) { cx += m.position[3 * i]; cy += m.position[3 * i + 1]; cz += m.position[3 * i + 2]; }
  cx /= m.numNodes; cy /= m.numNodes; cz /= m.numNodes;
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < m.numNodes; i++) {
    const rx = m.position[3 * i] - cx, ry = m.position[3 * i + 1] - cy, rz = m.position[3 * i + 2] - cz;
    const fx = m.force[3 * i], fy = m.force[3 * i + 1], fz = m.force[3 * i + 2];
    tx += ry * fz - rz * fy; ty += rz * fx - rx * fz; tz += rx * fy - ry * fx;
  }
  return Math.hypot(tx, ty, tz);
}

describe("seam hinges — a taped lip pair folds like a crease", () => {
  it("house: every cut pair the folded form closes becomes a hinge, aimed where the form aims it", () => {
    const { model } = buildScene(load("house.fkld"))!.scene;
    const c = model.creases;
    const seams = model.seamCreases ?? 0;
    // 18 lips → 9 pairs, on top of the file's own 6 M + 9 F = 15 scored creases.
    expect(seams).toBe(9);
    expect(c.count).toBe(15 + seams);

    const first = c.count - seams;
    let folded = 0;
    for (let i = first; i < c.count; i++) {
      expect(c.seamPeer3![i]).toBeGreaterThanOrEqual(0); // knows which lip it is taped to
      expect(c.seamPeer4![i]).toBeGreaterThanOrEqual(0);
      expect(c.k[i]).toBeGreaterThan(0);
      if (Math.abs(deg(c.targetTheta[i])) > 45) folded++;
    }
    expect(folded).toBeGreaterThanOrEqual(4); // these are real folds of the box, not flat joins
    for (let i = 0; i < first; i++) expect(c.seamPeer3![i]).toBe(-1); // a scored crease is not a seam
  });

  it("the declared form is an equilibrium of the hinges: hands off, it does not move", () => {
    const { model, solver } = buildScene(load("house.fkld"))!.scene;
    expect(model.seamCreases).toBeGreaterThan(0);
    model.position.set(model.goal);
    model.velocity.fill(0);
    model.guideWeight = 0; // no guide, nothing pinned — only the pattern's own creases and seams
    solver.foldPercent = 1;
    for (let i = 0; i < 4000; i++) solver.step();
    expect(offGoal(model)).toBeLessThan(0.01); // 0.00% measured
  });

  it("an OPEN joint carries no moment — otherwise the pair torques the whole artifact", () => {
    const { model } = buildScene(load("house.fkld"))!.scene;
    const c = model.creases;
    const seams = model.seamCreases ?? 0;
    expect(seams).toBeGreaterThan(0);
    const last = new Float32Array(c.count);

    // Half folded: the lips are still a sheet apart, so the seam hinges must be inert. With them
    // acting, this pair of couples is about two different lines and leaves |Στ| ≈ 8.9e-2 on a model
    // whose forces otherwise sum to no torque at all — enough to spin church 50% of a span off.
    for (let i = 0; i < 3 * model.numNodes; i++) model.position[i] = 0.5 * (model.position[i] + model.goal[i]);
    const withHinges = netTorque(model, 0.5, last);
    const k = c.k.slice();
    for (let i = c.count - seams; i < c.count; i++) c.k[i] = 0;
    const without = netTorque(model, 0.5, last);
    c.k.set(k);
    expect(withHinges).toBeCloseTo(without, 6);
    expect(without).toBeLessThan(1e-4); // nothing else torques it either
  });

  it("house and church still land their declared form, now with every seam hinge on target", () => {
    for (const [name, bound] of [["house.fkld", 0.08], ["church.fkld", 0.08]] as const) {
      const { model, solver } = buildScene(load(name))!.scene;
      const runner = new FoldRunner(model, solver);
      runner.setTarget(1);
      for (let i = 0; i < 900 && !runner.settled(); i++) runner.frame();
      expect(offGoal(model)).toBeLessThan(bound); // 4.1% / 2.3% measured

      const c = model.creases;
      let worst = 0;
      for (let i = c.count - (model.seamCreases ?? 0); i < c.count; i++) {
        worst = Math.max(worst, Math.abs(deg(measureTheta(model, c.face1[i], c.face2[i], c.n3[i], c.n4[i]) - c.targetTheta[i])));
      }
      expect(worst).toBeLessThan(15); // 3° / 4° measured — the seams fold, they do not just meet
    }
  }, 30000);
});
