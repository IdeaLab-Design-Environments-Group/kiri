/**
 * Kirigamizer **app sim path** test — exercises `src/sim` (the code the app
 * actually runs) rather than the transferred `kirigami/sim` reference copy.
 *
 * After restoring the CPU core (model/forces/solver) to AKDE-exact and routing
 * cut edges through AKDE's `cutRatio` API, the guided pyramid fold here must
 * reproduce AKDE's result: apex hole closes, base spreads to R, cone height = H,
 * mean bar strain small. We drive it through `scene.buildScene`, the same entry
 * the SimModal uses, fed the bundled FKLD example.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../src/sim/scene.js";
import { maxTensileStrain, meanTensileStrain, REFERENCE_ONLY_EXAMPLES } from "../../src/sim/strain.js";
import type { FoldFile } from "../../src/model/fold-file.js";

function loadExample(name: string): FoldFile {
  const url = new URL(`../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

describe("kirigamizer app sim path (src/sim via scene.buildScene)", () => {
  it("recognizes the bundled AKDE pyramid FKLD and folds it guided (AKDE-faithful)", { timeout: 15000 }, () => {
    const fold = loadExample("akde-square-pyramid.fkld");
    const built = buildScene(fold);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("guided");

    const { net, model, solver } = built!.scene;
    solver.solve(16000, 1);

    for (let i = 0; i < model.position.length; i++) {
      expect(Number.isFinite(model.position[i])).toBe(true);
    }

    const meanZ = (ids: number[]) => ids.reduce((a, i) => a + model.position[3 * i + 2], 0) / ids.length;
    const meanR = (ids: number[]) =>
      ids.reduce((a, i) => a + Math.hypot(model.position[3 * i], model.position[3 * i + 1]), 0) / ids.length;

    // apex tips converge to the axis (major cut closes — kirigami), base spreads to radius R
    expect(meanR(net.tips)).toBeLessThan(0.05 * net.meta.R);
    expect(meanR(net.base)).toBeCloseTo(net.meta.R, 1);

    // cone height tracks the designed apex altitude H
    const height = Math.abs(meanZ(net.base) - meanZ(net.tips));
    expect(height).toBeCloseTo(net.meta.H, 1);

    // near-isometric: molecules tuck via their cuts. Stretch only — compression at the cut mouths is
    // legitimate (see src/sim/strain.ts) and is what the app shows, so an absolute mean of ~0.18 here
    // measured the cut geometry, not a bad fold.
    expect(meanTensileStrain(model)).toBeLessThan(0.05);
    expect(maxTensileStrain(model)).toBeLessThan(0.12);
  });

  // akde-decagon-pyramid was reference-only until it was regenerated (issue #14): its old goal
  // stretched its worst bar by 118%. Its goal is now an isometry of its flat net with every valley
  // folded to 2 rad, short of the importer's MAX_FOLD clamp, and it settles within the pyramid's bounds.
  it("folds the AKDE decagon guided, within the pyramid's strain bounds", { timeout: 30000 }, () => {
    const built = buildScene(loadExample("akde-decagon-pyramid.fkld"))!;
    expect(built.mode).toBe("guided");
    const { model, solver } = built.scene;
    const flat = model.position.slice();
    model.position.set(model.goal);
    expect(maxTensileStrain(model)).toBeLessThan(1e-4);
    model.position.set(flat);
    solver.solve(16000, 1);
    expect(meanTensileStrain(model)).toBeLessThan(0.05);
    expect(maxTensileStrain(model)).toBeLessThan(0.12);
  });

  // akde-hex stays REFERENCE-ONLY (issue #14): its declared foldedForm goal is not an isometry of its
  // own flat net, so no fold can reach it and the tensile bound above cannot hold for it: measured
  // goal strain is mean 0.054 / max 0.336. A goal regenerated from `pyramidGoal` is isometric, but the
  // hex does not settle to it reliably, so the file is kept. This pins the known gap: when a
  // regenerated file passes mean < 0.05 and max < 0.12 this fails, and the preset should move to
  // REACHABLE in fold-realism.test.ts and get the same checks as the pyramid. Dropping it from
  // REFERENCE_ONLY_EXAMPLES (src/sim/strain.ts) also removes the reference-only note from the load status.
  it("hex goal pose is not isometric (reference-only, known gap)", () => {
    expect(REFERENCE_ONLY_EXAMPLES).toEqual(["akde-hex.fkld"]);
    for (const name of REFERENCE_ONLY_EXAMPLES) {
      const { model } = buildScene(loadExample(name))!.scene;
      model.position.set(model.goal);
      expect(maxTensileStrain(model)).toBeGreaterThan(0.12);
    }
  });

  it("folds a generic FKLD crease pattern (free path) without blowing up", () => {
    const fold = loadExample("fold-upstream/diagonal-cp.fold");
    const built = buildScene(fold);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("free");
    const { model, solver } = built!.scene;
    solver.solve(4000, 1);
    for (let i = 0; i < model.position.length; i++) {
      expect(Number.isFinite(model.position[i])).toBe(true);
    }
  });
});
