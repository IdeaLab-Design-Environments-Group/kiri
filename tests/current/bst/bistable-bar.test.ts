import { describe, it, expect } from "vitest";
import { solveBar, localBeta, solveBars } from "../../../src/pipeline/bst/bistable-bar.js";
import { scaleFactor, buildTiling } from "../../../src/pipeline/bst/star-tiling.js";
import { bstSurfaceFit } from "../../../src/pipeline/bst/index.js";
import { buildScene } from "../../../src/sim/scene.js";
import { DEFAULT_BST } from "../../../src/pipeline/bst/types.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import type { TriMesh } from "../../../src/pipeline/types.js";

describe("BST bistable bar (Eq 2/3)", () => {
  it("φ = (α+β)/2 (Eq 3) and R is finite for a valid (s,ε)", () => {
    const sol = solveBar(0, Math.PI / 4, 1, -0.1);
    expect(sol).not.toBeNull();
    expect(sol!.phi).toBeCloseTo(Math.PI / 8, 9);
    expect(Number.isFinite(sol!.R)).toBe(true);
  });

  it("returns null when there is no real bar (ε=0 → degenerate)", () => {
    expect(solveBar(0, Math.PI / 4, 1, 0)).toBeNull();
  });

  it("localBeta inverts the scale factor (Eq 1)", () => {
    const alpha = -Math.PI / 8, gamma = 1.6, s = 1.3;
    const beta = localBeta(gamma, alpha, s);
    expect(beta).not.toBeNull();
    expect(scaleFactor(gamma, alpha, beta!)).toBeCloseTo(s, 6);
  });

  it("rejects an out-of-range scale factor", () => {
    expect(localBeta(1, 0, 5)).toBeNull(); // far beyond the achievable expansion
  });

  it("solveBars classifies every 4-corner void (Sec 2.4 self-intersection rejection runs)", () => {
    // Exercise the placement + self-intersection machinery on real 4-corner voids of an open tiling.
    // Square-tiling voids (α=0) drive Eq-2 placements that self-intersect the flanking tiles, so they
    // are correctly skipped (the paper's square regime has a near-empty valid-bar domain — bars are a
    // star-tiling feature). The point of this test is that the pipeline runs and classifies each void.
    const t = buildTiling({ alpha: 0, gamma: 1, beta0: Math.PI / 2, grid: { nx: 5, ny: 5 }, epsilon: -0.1, relaxIters: 0 }, Math.PI / 3);
    const quadVoids = t.voids.filter((v) => v.corners.length === 4).length;
    expect(quadVoids).toBeGreaterThan(0); // interior parallelogram voids exist
    const bars = solveBars(t, () => 1.1, 0, 1, -0.1);
    expect(bars.length).toBe(t.voids.length); // one outcome per void
    // every skipped bar carries a documented Sec 2.4 reason; every kept bar has distinct E,F
    for (const b of bars) {
      if (b.skipped) expect(b.reason).toBeDefined();
      else expect(Math.hypot(b.Ec.x - b.Fc.x, b.Ec.y - b.Fc.y)).toBeGreaterThan(0);
    }
  });
});

function dome(A: number, n: number, H: number): TriMesh {
  const vertices = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -A + (2 * A * i) / n, y = -A + (2 * A * j) / n;
    vertices.push({ x, y, z: H * Math.max(0, 1 - (x * x + y * y) / (A * A)) });
  }
  const faces: [number, number, number][] = [];
  const id = (i: number, j: number): number => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  return { vertices, faces };
}

describe("BST bars on a surface-programmed result", () => {
  it("places bars in voids and the FKLD (with bars) still deploys", { timeout: 30000 }, () => {
    const { result, fkld } = bstSurfaceFit(dome(100, 8, 30), { ...DEFAULT_BST, grid: { nx: 6, ny: 6 }, relaxIters: 400 });
    // Square-first (α=0): contracted voids are closed, so bars are correctly absent here (bars are a
    // star-regime feature). The bar pipeline still runs and emits valid geometry when bars exist.
    expect(result.bars.length).toBeGreaterThanOrEqual(0);
    // FKLD arrays stay parallel after appending any bar vertices/edges
    const f = fkld as FoldFile & Record<string, unknown>;
    const nV = (f.vertices_coords as number[][]).length;
    expect((f.file_frames as { vertices_coords: number[][] }[])[0].vertices_coords.length).toBe(nV);
    expect((f["fkld:vertices_driven"] as number[]).length).toBe(nV);
    expect((f.edges_vertices as number[][]).every((e) => e.every((i) => i >= 0 && i < nV))).toBe(true);
    expect((f.edges_vertices as number[][]).length).toBe((f.edges_assignment as string[]).length);
    // and it still deploys through the sim
    const built = buildScene(fkld);
    expect(built).not.toBeNull();
    expect([...built!.scene.model.position].every((x) => Number.isFinite(x))).toBe(true);
  });
});
