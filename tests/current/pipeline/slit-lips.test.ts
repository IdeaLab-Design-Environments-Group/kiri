/**
 * Slit-lip geometry helpers behind the vent carve: boundary neighbours of a
 * cut sheet, slit depth from the boundary, lip polylines, and the region test.
 */

import { describe, expect, it } from "vitest";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import {
  boundaryNeighbours,
  clearLength,
  extendLip,
  followLip,
  insideRing,
  slitDepths,
} from "../../../src/pipeline/slit-lips.js";
import type { Vec2 } from "../../../src/pipeline/types.js";
import { makeGrid } from "./fixtures/targets.js";

describe("boundaryNeighbours", () => {
  it("a quad of two triangles: the shared diagonal is not a boundary edge", () => {
    const nb = boundaryNeighbours([[0, 1, 2], [0, 2, 3]]);
    expect([...nb.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect(nb.get(0)!.sort()).toEqual([1, 3]);
    expect(nb.get(2)!.sort()).toEqual([1, 3]);
  });

  it("removed (null) faces are skipped, opening their edges", () => {
    const nb = boundaryNeighbours([[0, 1, 2], null, [0, 2, 3]]);
    expect(nb.get(1)!.sort()).toEqual([0, 2]);
    expect(boundaryNeighbours([null]).size).toBe(0);
  });
});

describe("slitDepths", () => {
  // 3×3-vertex grid: ids row-major, only vertex 4 is interior.
  const grid = makeGrid(2, 2, 10);
  const topo = buildTopology(grid);
  const e14 = topo.edgeIndex.get(edgeKey(1, 4))!;

  it("boundary vertices are depth 0, a one-edge slit's tip depth 1", () => {
    const d = slitDepths(topo, (e) => e === e14);
    expect(d.get(1)).toBe(0);
    expect(d.get(4)).toBe(1);
  });

  it("an interior vertex no cut reaches has no depth", () => {
    expect(slitDepths(topo, () => false).has(4)).toBe(false);
  });
});

describe("followLip", () => {
  // Boundary chain 0 – 1 – 2 – 3 – 4 (each vertex lists its two neighbours).
  const nbrs = new Map<number, number[]>([
    [0, [1, 9]],
    [1, [0, 2]],
    [2, [1, 3]],
    [3, [2, 4]],
    [4, [3, 9]],
  ]);
  const flat: Vec2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 }, // collinear with 0 and 1
    { x: 3, y: 1 }, // bend
    { x: 4, y: 2 }, // collinear with 2 and 3
  ];

  it("drops collinear points and keeps the bend", () => {
    const lip = followLip(flat, nbrs, 0, 1, (c) => c < 4);
    expect(lip).toEqual([flat[0], flat[2], flat[4]]);
  });

  it("stops at the first copy that does not pass", () => {
    expect(followLip(flat, nbrs, 0, 1, () => false)).toEqual([flat[0], flat[1]]);
    expect(followLip(flat, nbrs, 0, 1, (c) => c < 3)).toEqual([flat[0], flat[2], flat[3]]);
  });
});

describe("extendLip and clearLength", () => {
  it("extends along the last segment", () => {
    const p = extendLip([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 3 }], 4);
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.y).toBeCloseTo(7, 12);
  });

  it("is four bbox diagonals plus one", () => {
    expect(clearLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 1, y: 1 }])).toBeCloseTo(21, 12);
    expect(clearLength([{ x: 5, y: 5 }])).toBeCloseTo(1, 12);
  });
});

describe("insideRing", () => {
  const square: Vec2[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];

  it("inside, outside, and the boundary counted inside", () => {
    expect(insideRing(square, { x: 1, y: 1 })).toBe(true);
    expect(insideRing(square, { x: 3, y: 1 })).toBe(false);
    expect(insideRing(square, { x: -1e-3, y: 1 })).toBe(false);
    expect(insideRing(square, { x: 2, y: 1 })).toBe(true); // on an edge
    expect(insideRing(square, { x: 0, y: 0 })).toBe(true); // a corner
  });

  it("a non-convex ring: the notch is outside", () => {
    const notched: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 1 },
      { x: 0, y: 4 },
    ];
    expect(insideRing(notched, { x: 2, y: 3 })).toBe(false);
    expect(insideRing(notched, { x: 2, y: 0.5 })).toBe(true);
  });
});
