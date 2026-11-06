/**
 * The ASCII-STL reader the Export dialog's 3D preview draws from: it must give back exactly the triangles the
 * writers put in, so the preview shows the file that will be downloaded.
 */
import { describe, expect, it } from "vitest";
import { facet, quad, readStlTriangles } from "../../../src/model/stl-ascii.js";
import { buildStlExport } from "../../../src/model/stl-export.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const solid = (body: string[]): string => ["solid t", ...body, "endsolid t"].join("\n");

describe("readStlTriangles", () => {
  it("gives back the corners of every facet, in order", () => {
    const out: string[] = [];
    facet(out, [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    facet(out, [2, 3, 4], [5.5, -6, 7], [8, 9, 1e-3]);
    expect(Array.from(readStlTriangles(solid(out)))).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 3, 4, 5.5, -6, 7, 8, 9, expect.closeTo(1e-3, 9),
    ]);
  });

  it("reads one triangle per facet the writers made", () => {
    const out: string[] = [];
    quad(out, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    expect(readStlTriangles(solid(out)).length).toBe(2 * 9);
  });

  it("reads nothing from an empty or facet-less file", () => {
    expect(readStlTriangles("").length).toBe(0);
    expect(readStlTriangles("solid empty\nendsolid empty").length).toBe(0);
  });

  it("reads exponents, and drops a facet left incomplete at the end", () => {
    const text = "facet normal 0 0 1\nouter loop\nvertex 1e2 -2.5E-1 0\nvertex 1 1 1\nvertex 2 2 2\nendloop\nendfacet\n" +
      "facet normal 0 0 1\nouter loop\nvertex 9 9 9\n";
    expect(Array.from(readStlTriangles(text))).toEqual([100, -0.25, 0, 1, 1, 1, 2, 2, 2]);
  });

  it("matches the facet count of a real tile export", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8], [15, 8]], faces_vertices: [[0, 1, 2], [1, 3, 2]] };
    const stl = buildStlExport(fold, "t", 2, null, null, 130)!;
    const facets = (stl.text.match(/facet normal/g) ?? []).length;
    expect(facets).toBeGreaterThan(0);
    expect(readStlTriangles(stl.text).length).toBe(facets * 9);
  });
});
