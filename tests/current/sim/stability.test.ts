/**
 * Headless stability proof for `FoldSolver.solveUntilSettled`. The plain `solve()` leaves residual
 * jitter on a free/frustrated mesh (squaretwist/box never settle); `solveUntilSettled` with the
 * free-mesh preset (viscous damp + rigid-body-motion removal + divergence guard) must drive each
 * bundled crease pattern to a finite, low-energy, bounded-strain pose and report `converged`.
 *
 * Also guards: determinism (same input → bit-identical output) and the AKDE-dt invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import { computeDt } from "../../../src/sim/forces.js";
import type { BarHingeModel } from "../../../src/sim/model.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function loadExample(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

function meanStrain(model: BarHingeModel): number {
  const p = model.position;
  let s = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    const l = Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);
    s += Math.abs(l / model.beams.rest[i] - 1);
  }
  return s / model.beams.count;
}

// Free/frustrated meshes have a stressed equilibrium (creases can't all hit their targets at once);
// plain viscous damping orbits it (a limit cycle), so we use the Otter kinetic quench — which
// descends to that equilibrium where velocity → 0 — plus rigid-body-motion removal to kill drift.
const FREE_PRESET = {
  target: 1,
  maxIters: 20000,
  easeRate: 0.01,
  keEps: 1e-2,
  minSettleIters: 300,
  quench: true,
  removeRigidBody: true,
  guard: true,
} as const;

const FREE_EXAMPLES = [
  "fold-upstream/simple.fold",
  "fold-upstream/squaretwist.fold",
  "fold-upstream/box.fold",
  "fold-upstream/diagonal-cp.fold",
];

describe("solveUntilSettled — free crease patterns settle to a stable pose", () => {
  for (const name of FREE_EXAMPLES) {
    it(`${name}: finite, converged, bounded strain`, () => {
      const built = buildScene(loadExample(name));
      expect(built, `${name} should be a foldable scene`).not.toBeNull();
      expect(built!.mode).toBe("free");

      const { model, solver } = built!.scene;
      const res = solver.solveUntilSettled(FREE_PRESET);

      for (let i = 0; i < model.position.length; i++) {
        expect(Number.isFinite(model.position[i])).toBe(true);
      }
      expect(res.converged, `KE ${res.ke} after ${res.iters} iters`).toBe(true);
      expect(res.ke).toBeLessThan(FREE_PRESET.keEps);
      expect(meanStrain(model)).toBeLessThan(0.25);
    });
  }
});

describe("solveUntilSettled — determinism", () => {
  it("the same input folds bit-identically twice", () => {
    const a = buildScene(loadExample("fold-upstream/squaretwist.fold"))!.scene;
    const b = buildScene(loadExample("fold-upstream/squaretwist.fold"))!.scene;
    a.solver.solveUntilSettled(FREE_PRESET);
    b.solver.solveUntilSettled(FREE_PRESET);
    let maxDiff = 0;
    for (let i = 0; i < a.model.position.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a.model.position[i] - b.model.position[i]));
    }
    expect(maxDiff).toBe(0);
  });
});

describe("AKDE dt invariant (fidelity guard)", () => {
  it("the guided pyramid solver dt equals computeDt(model) — AKDE dt cannot silently drift", () => {
    const built = buildScene(loadExample("akde-square-pyramid.fkld"))!;
    expect(built.mode).toBe("guided");
    expect(built.scene.solver.dt).toBe(computeDt(built.scene.model));
  });
});
