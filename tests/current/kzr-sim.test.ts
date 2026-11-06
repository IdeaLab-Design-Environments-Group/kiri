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
import { maxTensileStrain, meanTensileStrain } from "../../src/sim/strain.js";
import { pyramidGoal, VALLEY_FOLD } from "../../src/sim/build.js";
import { buildFoldNet } from "../../src/sim/foldnet.js";
import { computeState } from "@kirigami/model/geometry.js";
import { foldNetToFkld } from "@kirigami/model/fkld-bridge.js";
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

  // akde-hex was reference-only until it was regenerated (issue #67): its old goal stretched its worst
  // bar by 34%. Regenerated from `pyramidGoal` its goal is isometric, but with a 1 mm sheet the apex hole
  // (major cut) was smaller than the sim's contact thickness and the fold settled at max 2.1. The preset
  // is now cut for a 3.5 mm sheet, whose major cut is 3.5x larger, and it folds within the pyramid's bounds.
  it("folds the AKDE hex guided, within the pyramid's strain bounds", { timeout: 30000 }, () => {
    const built = buildScene(loadExample("akde-hex.fkld"))!;
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

  // One good fold could be luck: with a 1 mm sheet the hex passed at some swing angles and failed at
  // others (max strain from 0.017 to 2.1). So the hex is rebuilt from its own file's parameters and
  // folded with the sheet thickness, the valley fold (which sets the rim swing φ) and the start pose all
  // nudged; every combination has to land within the same bounds.
  describe("the AKDE hex folds within bounds near its parameters, not at one lucky point", () => {
    const shipped = loadExample("akde-hex.fkld") as FoldFile & {
      "fkld:meta_architecture": { materialThickness: number; sourcePyramid: { edgeCount: number; edgeLength: number; apexHeight: number } };
    };
    const arch = shipped["fkld:meta_architecture"];
    const hexFkld = (T: number, valleyFold: number): FoldFile => {
      const { edgeCount, edgeLength, apexHeight } = arch.sourcePyramid;
      const state = computeState({ edgeCount, edgeLength, totalCurvature: apexHeight, materialThickness: T });
      const net = buildFoldNet(state);
      const inv = 1 / net.meta.scale;
      const fkld = foldNetToFkld(net, state) as unknown as FoldFile & Record<string, unknown>;
      fkld.file_frames = [
        {
          frame_classes: ["foldedForm"],
          frame_attributes: ["3D"],
          frame_inherit: true,
          frame_parent: 0,
          vertices_coords: pyramidGoal(net, valleyFold).map((p) => [p.x * inv, p.y * inv, p.z * inv]),
        },
      ] as FoldFile["file_frames"];
      fkld["fkld:vertices_driven"] = net.vertices.map(() => 1);
      fkld.frame_title = shipped.frame_title;
      return fkld;
    };
    const settle = (fold: FoldFile, jitter = 0, seed = 1): { mean: number; max: number } => {
      const { model, solver } = buildScene(fold)!.scene;
      let s = seed;
      for (let i = 0; i < model.position.length; i++) {
        s = (s * 16807) % 2147483647;
        model.position[i] += jitter * (s / 2147483647 - 0.5);
      }
      solver.solve(16000, 1);
      return { mean: meanTensileStrain(model), max: maxTensileStrain(model) };
    };

    it("is the generator's output for those parameters", () => {
      const regenerated = hexFkld(arch.materialThickness, VALLEY_FOLD);
      const goalOf = (f: FoldFile) => (f as unknown as { file_frames: { vertices_coords: number[][] }[] }).file_frames[0].vertices_coords;
      const want = goalOf(regenerated);
      const got = goalOf(shipped);
      expect(got.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) for (let d = 0; d < 3; d++) expect(got[i][d]).toBeCloseTo(want[i][d], 6);
    });

    const T0 = arch.materialThickness;
    for (const T of [T0 - 0.5, T0, T0 + 0.5]) {
      for (const valleyFold of [VALLEY_FOLD - 0.2, VALLEY_FOLD, VALLEY_FOLD + 0.2]) {
        it(`T=${T} mm, valley fold ${valleyFold.toFixed(1)} rad`, { timeout: 30000 }, () => {
          const { mean, max } = settle(hexFkld(T, valleyFold));
          expect(mean).toBeLessThan(0.05);
          expect(max).toBeLessThan(0.12);
        });
      }
    }
    for (const seed of [1, 2, 3]) {
      it(`start pose jittered by 1% of the span (seed ${seed})`, { timeout: 30000 }, () => {
        const { mean, max } = settle(shipped, 0.01, seed);
        expect(mean).toBeLessThan(0.05);
        expect(max).toBeLessThan(0.12);
      });
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
