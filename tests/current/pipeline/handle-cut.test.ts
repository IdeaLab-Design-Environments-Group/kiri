/**
 * Handle-loop cutting (conditioning v1 scope extension): a genus>0 mesh is slit
 * along its handle loops so it becomes a genus-0 surface the pipeline can fold.
 */
import { describe, expect, it } from "vitest";
import { condition } from "../../../src/pipeline/conditioning.js";
import { cutHandles } from "../../../src/pipeline/handle-cut.js";
import { buildTopology, countBoundaryLoops, eulerCharacteristic } from "../../../src/pipeline/mesh.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeCube } from "./fixtures/targets.js";

/** Closed torus — genus 1 (χ=0, no boundary). */
function torus(R = 50, r = 20, nu = 16, nv = 8): TriMesh {
  const vertices: TriMesh["vertices"] = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const u = (2 * Math.PI * i) / nu, v = (2 * Math.PI * j) / nv;
      vertices.push({ x: (R + r * Math.cos(v)) * Math.cos(u), y: (R + r * Math.cos(v)) * Math.sin(u), z: r * Math.sin(v) });
    }
  const idx = (i: number, j: number) => (i % nu) * nv + (j % nv);
  const faces: [number, number, number][] = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      faces.push([a, b, c], [a, c, d]);
    }
  return { vertices, faces };
}

const genus = (m: TriMesh): number => {
  const t = buildTopology(m);
  return (2 - countBoundaryLoops(m, t) - eulerCharacteristic(m, t)) / 2;
};

describe("cutHandles — handle-loop cutting", () => {
  it("slits a genus-1 torus down to genus 0 (no faces lost)", () => {
    const t = condition(torus()).mesh;
    expect(genus(t)).toBe(1); // reproduces the old "genus 1 unsupported" rejection

    const { mesh, report } = cutHandles(t);
    expect(report.changed).toBeGreaterThan(0); // at least one handle cut
    expect(genus(mesh)).toBe(0); // now passes the genus-0 gate
    expect(mesh.faces.length).toBe(t.faces.length); // cutting only splits vertices
    expect(mesh.vertices.length).toBeGreaterThan(t.vertices.length); // lips split open
  });

  it("is a no-op on a genus-0 mesh (cube)", () => {
    const cube = condition(makeCube()).mesh;
    expect(genus(cube)).toBe(0);
    const { mesh, report } = cutHandles(cube);
    expect(report.changed).toBe(0);
    expect(mesh.vertices.length).toBe(cube.vertices.length);
    expect(mesh.faces.length).toBe(cube.faces.length);
  });
});
