import { describe, it, expect } from "vitest";
import { bstSurfaceFit } from "../../../src/pipeline/bst/index.js";
import { projectToMesh } from "../../../src/pipeline/bst/mesh-project.js";
import { buildScene } from "../../../src/sim/scene.js";
import { DEFAULT_BST } from "../../../src/pipeline/bst/types.js";
import type { TriMesh } from "../../../src/pipeline/types.js";

/** A triangulated grid patch over [-A,A]² with height z=f(x,y). */
function patch(A: number, n: number, f: (x: number, y: number) => number): TriMesh {
  const vertices = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -A + (2 * A * i) / n, y = -A + (2 * A * j) / n;
    vertices.push({ x, y, z: f(x, y) });
  }
  const faces: [number, number, number][] = [];
  const id = (i: number, j: number): number => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  }
  return { vertices, faces };
}

const params = { ...DEFAULT_BST, grid: { nx: 6, ny: 6 }, relaxIters: 600 };
const zSpan = (vs: { z: number }[]): number => {
  let lo = Infinity, hi = -Infinity; for (const v of vs) { lo = Math.min(lo, v.z); hi = Math.max(hi, v.z); } return hi - lo;
};
const maxSurfDist = (vs: { x: number; y: number; z: number }[], m: TriMesh): number =>
  vs.reduce((mx, v) => Math.max(mx, projectToMesh(v, m).dist), 0);

describe("BST surface fit — flat target", () => {
  it("a flat patch fits with ~zero residual and a planar deployed state", () => {
    const flat = patch(100, 6, () => 0);
    const { result, diag } = bstSurfaceFit(flat, params);
    expect(diag.converged).toBe(true);
    expect(diag.residual).toBeLessThan(0.01);
    expect(zSpan(result.expandedCurved)).toBeLessThan(0.5); // stays flat
    expect(maxSurfDist(result.expandedCurved, flat)).toBeLessThan(0.5);
  });
});

describe("BST surface fit — paraboloid dome", () => {
  const A = 100, H = 30;
  const dome = patch(A, 8, (x, y) => H * Math.max(0, 1 - (x * x + y * y) / (A * A)));

  it("deploys onto the dome: vertices land on the surface and the shape rises", { timeout: 30000 }, () => {
    const { result, fkld, diag } = bstSurfaceFit(dome, params);
    // deployed vertices lie on the dome (faceted approximation → small distance)
    expect(maxSurfDist(result.expandedCurved, dome)).toBeLessThan(0.1 * H);
    // it actually rises toward the dome (not left flat)
    expect(zSpan(result.expandedCurved)).toBeGreaterThan(0.4 * H);
    // tiles stayed reasonably rigid (residual bounded — flat tiles can't perfectly lie on curvature)
    expect(diag.residual).toBeLessThan(0.25);
    // and the FKLD deploys through the real sim
    const built = buildScene(fkld);
    expect(built).not.toBeNull();
    expect(built!.mode).toBe("guided");
    expect([...built!.scene.model.position].every((x) => Number.isFinite(x))).toBe(true);
  });
});
