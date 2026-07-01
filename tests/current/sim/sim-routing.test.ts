/**
 * Sim routing by file type: plain FOLD → Neil's normal origami sim; FKLD → the kirigami sim.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const tri = (extra: Partial<FoldFile> = {}): FoldFile => ({
  vertices_coords: [
    [0, 0],
    [100, 0],
    [0, 100],
  ],
  faces_vertices: [[0, 1, 2]],
  edges_vertices: [
    [0, 1],
    [1, 2],
    [2, 0],
  ],
  ...extra,
});

const load = (n: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${n}`, import.meta.url)), "utf8"));

describe("sim routing by file type", () => {
  it("plain FOLD → Neil's normal origami sim", () => {
    const built = buildScene(tri());
    expect(built?.sim).toBe("origami");
    expect(built?.mode).toBe("free");
  });

  it("FKLD (any fkld: key) → kirigami sim", () => {
    const built = buildScene(tri({ "fkld:edges_cutType": [null, null, null] }));
    expect(built?.sim).toBe("kirigami");
  });

  it("FKLD with a folded goal frame folds guided (kirigami)", () => {
    const built = buildScene(load("akde-hex.fkld"));
    expect(built?.sim).toBe("kirigami");
    expect(built?.mode).toBe("guided");
  });
});
