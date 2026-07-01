import { describe, it, expect } from "vitest";
import { bstUniform } from "../../../src/pipeline/bst/index.js";
import { buildScene } from "../../../src/sim/scene.js";
import { DEFAULT_BST } from "../../../src/pipeline/bst/types.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const params = { ...DEFAULT_BST, grid: { nx: 4, ny: 4 } };

function bboxX(pos: Float32Array): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
  return hi - lo;
}

describe("BST emit → valid loadable FKLD", () => {
  it("produces a creasePattern FKLD with parallel arrays + a foldedForm goal", () => {
    const { fkld } = bstUniform(params);
    const f = fkld as FoldFile & Record<string, unknown>;
    expect((f.faces_vertices as number[][]).length).toBeGreaterThan(0);
    expect((f.edges_vertices as number[][]).length).toBe((f.edges_assignment as string[]).length);
    expect((f.edges_vertices as number[][]).length).toBe((f.edges_foldAngle as (number | null)[]).length);
    const ff = (f.file_frames as { frame_classes: string[]; vertices_coords: number[][] }[])[0];
    expect(ff.frame_classes).toContain("foldedForm");
    expect(ff.vertices_coords.length).toBe((f.vertices_coords as number[][]).length);
    expect((f["fkld:vertices_driven"] as number[]).length).toBe((f.vertices_coords as number[][]).length);
    // every face index is in range
    const nV = (f.vertices_coords as number[][]).length;
    expect((f.faces_vertices as number[][]).every((face) => face.every((i) => i >= 0 && i < nV))).toBe(true);
  });
});

describe("BST deploys (auxetic expansion) through the real sim", () => {
  it("buildScene takes the guided path and the morph expands by ~the scale factor", () => {
    const { fkld } = bstUniform(params);
    const built = buildScene(fkld);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("guided"); // driven foldedForm
    const { solver, model } = built!.scene;
    const flat = bboxX(model.position);
    for (let frame = 0; frame < 60; frame++) {
      solver.foldPercent += (1 - solver.foldPercent) * 0.08;
      for (let i = 0; i < 40; i++) solver.step();
    }
    const deployed = bboxX(model.position);
    expect([...model.position].every((x) => Number.isFinite(x))).toBe(true);
    // β0=80° vs α=0° → expansion ratio = √(1+sin80°)/√(1+sin0°) ≈ √1.985 ≈ 1.41 (≈√2 here)
    expect(deployed / flat).toBeGreaterThan(1.2);
  });
});
