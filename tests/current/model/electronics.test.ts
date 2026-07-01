import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, pointInFace, tapeQuads } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** A unit square split into two triangles sharing the (0,2) diagonal. */
function twoTri(diagonal = "M"): FoldFile {
  return {
    vertices_coords: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    faces_vertices: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 0],
    ],
    edges_assignment: ["B", "B", diagonal, "B", "B"],
  };
}

const near = (a: { x: number; y: number }, x: number, y: number, eps = 1e-9) =>
  Math.abs(a.x - x) < eps && Math.abs(a.y - y) < eps;

describe("model/electronics: flatFaces", () => {
  it("computes a centroid per face aligned with faces_vertices", () => {
    const faces = flatFaces(twoTri());
    expect(faces).toHaveLength(2);
    expect(near(faces[0]!.centroid, 20 / 3, 10 / 3)).toBe(true);
    expect(near(faces[1]!.centroid, 10 / 3, 20 / 3)).toBe(true);
  });
});

describe("model/electronics: gapGraph", () => {
  it("makes a traversable gap across an M fold, at the shared edge midpoint", () => {
    const g = gapGraph(twoTri("M"));
    expect(g.faceCount).toBe(2);
    expect(g.gaps).toHaveLength(1);
    expect(near(g.gaps[0]!.point, 5, 5)).toBe(true);
    // both face centroids connect to the gap midpoint node
    expect(g.adj[0]!.some((e) => e.to === g.gaps[0]!.mid)).toBe(true);
    expect(g.adj[1]!.some((e) => e.to === g.gaps[0]!.mid)).toBe(true);
  });

  it("treats V and C edges as gaps too", () => {
    expect(gapGraph(twoTri("V")).gaps).toHaveLength(1);
    expect(gapGraph(twoTri("C")).gaps).toHaveLength(1);
  });

  it("does NOT route across a facet (F) or boundary (B) interior edge", () => {
    expect(gapGraph(twoTri("F")).gaps).toHaveLength(0);
    expect(gapGraph(twoTri("B")).gaps).toHaveLength(0);
  });
});

describe("model/electronics: tapeQuads", () => {
  it("builds one width-W rectangle per straight segment, perpendicular to it", () => {
    // A horizontal segment from (0,0) to (10,0), width 2 → a 10×2 rectangle centred on the x-axis.
    const quads = tapeQuads([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
    expect(quads).toHaveLength(1);
    const q = quads[0]!;
    expect(q).toHaveLength(4);
    // corners are offset ±1 (half-width) in y; x spans 0..10
    const ys = q.map((p) => p.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-1);
    expect(ys[3]).toBeCloseTo(1);
    expect(Math.min(...q.map((p) => p.x))).toBeCloseTo(0);
    expect(Math.max(...q.map((p) => p.x))).toBeCloseTo(10);
  });

  it("emits a quad per polyline segment and skips zero-length hops", () => {
    const quads = tapeQuads([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], 1);
    expect(quads).toHaveLength(2); // the repeated point produces no rectangle
  });
});

describe("model/electronics: pointInFace", () => {
  it("locates the face under a point, or -1 outside the pattern", () => {
    const faces = flatFaces(twoTri());
    expect(pointInFace(faces, { x: 7, y: 2 })).toBe(0); // below the diagonal
    expect(pointInFace(faces, { x: 2, y: 7 })).toBe(1); // above the diagonal
    expect(pointInFace(faces, { x: 50, y: 50 })).toBe(-1);
  });
});
