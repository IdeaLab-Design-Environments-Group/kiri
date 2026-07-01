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

    // near-isometric: molecules tuck via their cuts, so mean bar strain stays small
    let strain = 0;
    for (let i = 0; i < model.beams.count; i++) {
      const a = model.beams.n0[i];
      const b = model.beams.n1[i];
      const l = Math.hypot(
        model.position[3 * a] - model.position[3 * b],
        model.position[3 * a + 1] - model.position[3 * b + 1],
        model.position[3 * a + 2] - model.position[3 * b + 2],
      );
      strain += Math.abs(l / model.beams.rest[i] - 1);
    }
    strain /= model.beams.count;
    expect(strain).toBeLessThan(0.1);
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
