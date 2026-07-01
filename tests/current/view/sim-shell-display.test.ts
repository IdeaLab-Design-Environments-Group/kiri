import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildScene } from "../../../src/sim/scene.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function load(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

describe("sim mesh display contract", () => {
  // The faithful 1:1 port folds the file's OWN geometry. A preset that declares a folded-form
  // footprint (akde-hex) takes the faithful path: a real triangulated mesh with the cuts split
  // open — NOT a recomputed pyramid shell. So meta.N = 0 and sim-canvas renders the full mesh.
  it("akde-hex (declared footprint): faithful full mesh, cuts split, not a recomputed shell", () => {
    const fold = load("akde-hex.fkld");
    const inV = fold.vertices_coords!.length;
    const { net, model } = buildScene(fold)!.scene;
    expect(net.meta.N).toBe(0); // not a recomputed pyramid net → sim-canvas draws the full mesh
    expect(net.tips.length).toBe(0);
    expect(model.numNodes).toBeGreaterThan(inV); // cuts were split open
    // Split cut lips (relabeled "B" for the solver) are re-tagged "C" in the net so sim-canvas
    // draws them as black cut lines on the flat full sheet, not as gray boundary.
    expect(net.edges.some((e) => e.assignment === "C")).toBe(true);
  });

  // A legacy pyramid preset with NO declared footprint (akde-square-pyramid) falls back to the
  // buildFoldScene recompute, which DOES produce the uniform 7N shell net (N lateral + 6N molecule
  // tris) and N distinct apex tips that sim-canvas weld-displays.
  it("akde-square-pyramid (no footprint): recomputed 7N shell net, N distinct tips", () => {
    const built = buildScene(load("akde-square-pyramid.fkld"))!;
    expect(built.mode).toBe("guided");
    const { net } = built.scene;
    expect(net.meta.N).toBe(4);
    expect(net.faces.length).toBe(7 * net.meta.N);
    expect(net.tips.length).toBe(4);
    expect(new Set(net.tips).size).toBe(4);
  });
});
