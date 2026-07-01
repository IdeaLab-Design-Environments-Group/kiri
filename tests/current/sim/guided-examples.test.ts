/**
 * Adaptive guided fold (see origami-import.ts `applyDeclaredGoal`): an FKLD that declares a
 * folded-form footprint (a `foldedForm` frame + `fkld:vertices_driven`) is driven to it by the
 * SAME 1:1 Origami-Simulator engine, so a floppy kirigami pyramid cones instead of splaying.
 * These bundled AKDE presets exercise that path: cuts are split open, the boundary is driven,
 * and the structure rises into a low-strain 3D cone.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** Mean |l/l₀ − 1| over bars NOT between two driven nodes (driven base pairs collapse by design). */
function freeBarStrain(model: {
  beams: { count: number; n0: Int32Array; n1: Int32Array; rest: Float32Array };
  position: Float32Array;
  driven: Uint8Array;
}): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i];
    const b = model.beams.n1[i];
    if (model.driven[a] && model.driven[b]) continue;
    const l = Math.hypot(
      model.position[3 * a] - model.position[3 * b],
      model.position[3 * a + 1] - model.position[3 * b + 1],
      model.position[3 * a + 2] - model.position[3 * b + 2],
    );
    s += Math.abs(l / model.beams.rest[i] - 1);
    n++;
  }
  return s / Math.max(1, n);
}

describe("bundled AKDE guided examples cone cleanly (declared folded-form)", () => {
  for (const name of ["akde-decagon-pyramid", "akde-hex"]) {
    it(`${name}: cuts split, guided, rises into a low-strain 3D cone`, { timeout: 60_000 }, () => {
      const fold = JSON.parse(readFileSync(`public/examples/${name}.fkld`, "utf8")) as FoldFile;
      const inV = fold.vertices_coords!.length;
      const built = buildScene(fold);
      expect(built).not.toBeNull();
      expect(built!.mode).toBe("guided");
      expect(built!.sim).toBe("kirigami");
      const { model, solver } = built!.scene;

      // Kirigami cuts were split, so the model has more nodes than the flat pattern.
      expect(model.numNodes).toBeGreaterThan(inV);
      expect(Array.from(model.driven).some((d) => d === 1)).toBe(true);

      // No faces lost in preprocessing: every (triangular) FKLD face survives splitCuts +
      // removeRedundantVertices. Dropping the thin molecule-dart slivers punched holes in the
      // folded surface ("blank faces") — this guards that regression.
      expect(model.faces.count).toBe(fold.faces_vertices!.length);

      solver.solve(16000, 1);

      // Rises into a cone: z extent is a real fraction of the footprint, near-isometric interior.
      let zLo = Infinity, zHi = -Infinity, xLo = Infinity, xHi = -Infinity;
      for (let i = 0; i < model.numNodes; i++) {
        zLo = Math.min(zLo, model.position[3 * i + 2]);
        zHi = Math.max(zHi, model.position[3 * i + 2]);
        xLo = Math.min(xLo, model.position[3 * i]);
        xHi = Math.max(xHi, model.position[3 * i]);
      }
      expect(zHi - zLo).toBeGreaterThan(0.2 * (xHi - xLo));
      expect(freeBarStrain(model)).toBeLessThan(0.15);
      for (let i = 0; i < model.position.length; i++) expect(Number.isFinite(model.position[i])).toBe(true);
    });
  }
});
