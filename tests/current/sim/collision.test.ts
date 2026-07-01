import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PARAMS, type BarHingeModel } from "../../../src/sim/model.js";
import { FoldSolver } from "../../../src/sim/solver.js";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** Two free, non-adjacent triangles stacked `gap` apart in z (overlapping in xy). */
function twoTriangles(gap: number): BarHingeModel {
  const verts = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],         // triangle A (z=0)
    [0, 0, gap], [1, 0, gap], [0, 1, gap],   // triangle B (z=gap)
  ];
  const n = 6;
  const position = new Float32Array(verts.flat());
  const rest = position.slice();
  const faces = { count: 2, a: Int32Array.from([0, 3]), b: Int32Array.from([1, 4]), c: Int32Array.from([2, 5]),
    nominalAngles: new Float32Array(6), normal: new Float32Array(6) };
  const edges: [number, number][] = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]];
  const beams = { count: edges.length, n0: Int32Array.from(edges.map((e) => e[0])),
    n1: Int32Array.from(edges.map((e) => e[1])), rest: new Float32Array(edges.length).fill(1),
    k: new Float32Array(edges.length).fill(DEFAULT_PARAMS.EA) };
  return {
    numNodes: n, position, rest, velocity: new Float32Array(3 * n), force: new Float32Array(3 * n),
    mass: new Float32Array(n).fill(1), fixed: new Uint8Array(n), goal: rest.slice(), driven: new Uint8Array(n),
    beams, creases: { count: 0, n1: new Int32Array(0), n2: new Int32Array(0), n3: new Int32Array(0),
      n4: new Int32Array(0), face1: new Int32Array(0), face2: new Int32Array(0), k: new Float32Array(0),
      targetTheta: new Float32Array(0), assignment: [] },
    faces, params: DEFAULT_PARAMS,
    meta: { N: 0, scale: 1, R: 0, s: 1, H: 1, gamma: Math.PI } as BarHingeModel["meta"],
  };
}

const zGap = (m: BarHingeModel): number => Math.abs(m.position[3 * 3 + 2] - m.position[2]); // node3.z − node0.z (≈ planes)

describe("self-collision (penalty)", () => {
  // Mirror the real loop: a global per-step velocity damp (the modal uses kineticDamp/dampVelocity).
  // Without it, free bodies coast apart forever once the contact force releases past h.
  const settle = (solver: FoldSolver, m: BarHingeModel, steps = 6000, damp = 0.9): void => {
    for (let i = 0; i < steps; i++) {
      solver.step();
      for (let j = 0; j < m.velocity.length; j++) m.velocity[j] *= damp;
    }
  };

  it("pushes two interpenetrating layers apart to ~the contact thickness", () => {
    const m = twoTriangles(0.008); // start well inside h
    const solver = new FoldSolver(m);
    solver.enableCollision({ thickness: 0.03, k: 220, damp: 8, maxForce: 2.5 });
    settle(solver, m);
    const gap = zGap(m);
    expect(Number.isFinite(gap)).toBe(true);
    expect(gap).toBeGreaterThan(0.024); // no longer interpenetrating — held at ≥ the 0.03 thickness
    // Worst case: starts fully interpenetrating, so it's shoved out with momentum and overshoots
    // before the damping settles it. The invariant is "separated and bounded", not a precise rest.
    expect(gap).toBeLessThan(0.12);
  });

  it("does nothing without collision enabled (layers stay interpenetrating)", () => {
    const m = twoTriangles(0.008);
    const solver = new FoldSolver(m);
    settle(solver, m);
    expect(zGap(m)).toBeCloseTo(0.008, 3); // unchanged — no contact forces
  });
});

function load(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

describe("self-collision is stable on a real free fold", () => {
  it("squaretwist folds to a finite, settled pose with collision on", () => {
    const built = buildScene(load("fold-upstream/squaretwist.fold"));
    expect(built).not.toBeNull();
    const solver = built!.scene.solver;
    solver.enableCollision();
    const res = solver.solveUntilSettled({ maxIters: 6000, keEps: 1e-6, damp: 0.9, removeRigidBody: true, guard: true });
    const p = built!.scene.model.position;
    expect([...p].every((x) => Number.isFinite(x))).toBe(true);
    expect(res.converged).toBe(true);
  });
});
