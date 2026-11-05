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

  // Issue #14: the goal must be an isometry of the flat net for every N, not only the square pyramid.
  // N=6 and N=10 are the hex and decagon presets; before the fix their goals stretched the worst bar
  // by 34% and 118% (minor-cut slits pulled to a fixed tuck point, apex tips pulled past the slant).
  for (const [N, L, H, T] of [
    [4, 50, 30, 0.31],
    [6, 100, 100, 1],
    [10, 100, 100, 1],
  ]) {
    it(`goal pose keeps every bar's length for N=${N} and lands the pyramid`, () => {
      const state = computeState({ edgeCount: N, edgeLength: L, totalCurvature: H, materialThickness: T });
      const { net, model } = buildFoldScene(state);
      let worst = 0;
      for (let i = 0; i < model.beams.count; i++) {
        const a = model.beams.n0[i];
        const b = model.beams.n1[i];
        const g = model.goal;
        const l = Math.hypot(g[3 * a] - g[3 * b], g[3 * a + 1] - g[3 * b + 1], g[3 * a + 2] - g[3 * b + 2]);
        worst = Math.max(worst, Math.abs(l / model.beams.rest[i] - 1));
      }
      expect(worst).toBeLessThan(1e-4); // model arrays are Float32: exact up to single precision

      // base corners pair up on the base ring at radius R, z = 0
      for (const [a, b] of net.basePairs) {
        const ga = [model.goal[3 * a], model.goal[3 * a + 1], model.goal[3 * a + 2]];
        const gb = [model.goal[3 * b], model.goal[3 * b + 1], model.goal[3 * b + 2]];
        expect(Math.hypot(ga[0] - gb[0], ga[1] - gb[1], ga[2] - gb[2])).toBeLessThan(1e-9);
        expect(Math.hypot(ga[0], ga[1])).toBeCloseTo(net.meta.R, 5);
        expect(ga[2]).toBeCloseTo(0, 5);
      }
      // apex tips sit on the lateral faces below the apex, inside the base ring
      for (const t of net.tips) {
        const z = model.goal[3 * t + 2];
        expect(z).toBeGreaterThan(0.75 * net.meta.H);
        expect(z).toBeLessThan(net.meta.H);
      }
      // No crease is folded flat. A crease at ±π is one the sim cannot reach: the importer clamps
      // design folds to MAX_FOLD = 2.7 (origami-import.ts), and the clamped fold no longer closes
      // the panel kinematics. Merging a molecule's two outer corners used to fold its valley to
      // exactly π, the triangles either side of it sharing all three corners.
      const normal = (f: number): number[] => {
        const [a, b, c] = net.faces[f].map((i) => [model.goal[3 * i], model.goal[3 * i + 1], model.goal[3 * i + 2]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const l = Math.hypot(nn[0], nn[1], nn[2]);
        return nn.map((x) => x / l);
      };
      for (const e of net.edges) {
        if (e.faces.length !== 2) continue;
        const [n1, n2] = e.faces.map(normal);
        const fold = Math.acos(Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2])));
        expect(fold).toBeLessThan(2.7);
      }

      // the molecules tuck inside: both ends of every valley sit in the plane of a lateral edge, on
      // the axis side of it (below the apex→base-corner line at their radius)
      const { R, H: Hn } = net.meta;
      const valleyNodes = net.edges.filter((e) => e.assignment === "V").flatMap((e) => [e.a, e.b]);
      expect(valleyNodes.length).toBe(2 * N);
      for (const i of valleyNodes) {
        const r = Math.hypot(model.goal[3 * i], model.goal[3 * i + 1]);
        expect(model.goal[3 * i + 2]).toBeLessThan(Hn * (1 - r / R));
      }
    });
  }

  it("builds a single-hinge model with the requested target", () => {
    const model = singleHingeModel(0.75, 1.5);
    expect(model.creases.count).toBe(1);
    expect(model.creases.targetTheta[0]).toBeCloseTo(0.75, 6);
  });
});
