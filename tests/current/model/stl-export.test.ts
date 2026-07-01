/**
 * FKLD → STL export: the 3D-printed tiles (`printed-joinery.ts`), matched to the 3D-Sim render. Each
 * face is a hexagonal tile `[A, mAB, B, mBC, C, mCA]` extruded to a closed prism; corners stay full
 * (neighbours meet there), every non-boundary edge midpoint pinches inward (interior folds AND "C"
 * cuts open the diamond), and outer-boundary edges stay straight. What you see in the sim is what you cut.
 */
import { describe, it, expect } from "vitest";
import { buildStlExport } from "../../../src/model/stl-export.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

type V3 = [number, number, number];
const countFacets = (stl: string): number => (stl.match(/facet normal/g) ?? []).length;
const verts = (stl: string): V3[] =>
  [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
const zSet = (vs: V3[]): number[] => [...new Set(vs.map((v) => Math.round(v[2] * 1e4) / 1e4))].sort((a, b) => a - b);
const hasXY = (vs: V3[], x: number, y: number): boolean => vs.some((v) => Math.abs(v[0] - x) < 1e-6 && Math.abs(v[1] - y) < 1e-6);

/** A single tile is a closed solid: every directed edge used once and its reverse once. */
function isClosed(vs: V3[]): boolean {
  const dir = new Map<string, number>();
  const key = (p: V3): string => p.map((n) => Math.round(n * 1e3)).join(",");
  for (let i = 0; i < vs.length; i += 3)
    for (let e = 0; e < 3; e++) dir.set(`${key(vs[i + e])}|${key(vs[i + (e + 1) % 3])}`, (dir.get(`${key(vs[i + e])}|${key(vs[i + (e + 1) % 3])}`) ?? 0) + 1);
  for (const [e, n] of dir) {
    const [a, b] = e.split("|");
    if (n !== 1 || (dir.get(`${b}|${a}`) ?? 0) !== 1) return false;
  }
  return true;
}

describe("buildStlExport — printed tiles (sim-matched pinched hexagons)", () => {
  it("wraps the tiles in solid/endsolid and names the file", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8]], faces_vertices: [[0, 1, 2]] };
    const out = buildStlExport(fold, "sq", 3)!;
    expect(out.filename).toBe("sq.stl");
    expect(out.text.startsWith("solid sq")).toBe(true);
    expect(out.text.trimEnd().endsWith("endsolid sq")).toBe(true);
    expect(out.maxSubdiv).toBe(0);
  });

  it("a lone all-boundary triangle: closed hex prism, corners full, midpoints unpinched, z=0..height", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [10, 0], [5, 8]], faces_vertices: [[0, 1, 2]] };
    const out = buildStlExport(fold, "t", 4)!;
    const vs = verts(out.text);
    expect(isClosed(vs)).toBe(true);
    expect(zSet(vs)).toEqual([0, 4]);
    expect(countFacets(out.text)).toBe(24); // hex prism: 6 top + 6 bottom + 6 walls × 2 tris
    // corners stay full; with no pinch the edge midpoints sit on their true positions
    for (const [x, y] of [[0, 0], [10, 0], [5, 8], [5, 0], [7.5, 4], [2.5, 4]]) expect(hasXY(vs, x, y)).toBe(true);
  });

  it("PINCHES a 'C' cut edge inward, leaving boundary edges straight (corners stay full)", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
      edges_vertices: [[0, 1], [1, 2], [2, 0]],
      edges_assignment: ["C", "B", "B"], // base 0–1 is a cut → pinched; the others are boundary
    };
    const vs = verts(buildStlExport(fold, "t", 2)!.text);
    expect(hasXY(vs, 5, 0)).toBe(false); // the cut midpoint left its true position (5,0), pinched inward (y>0)
    expect(vs.some(([x, y]) => Math.abs(x - 5) < 1e-6 && y > 0.1 && y < 4)).toBe(true);
    expect(hasXY(vs, 7.5, 4)).toBe(true); // boundary midpoints stay straight
    expect(hasXY(vs, 2.5, 4)).toBe(true);
    for (const [x, y] of [[0, 0], [10, 0], [5, 8]]) expect(hasXY(vs, x, y)).toBe(true); // corners full
  });

  it("PINCHES interior fold edges too (matches the sim): a shared M/V/F edge opens", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]], // share interior edge 0–2
      edges_vertices: [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]],
      edges_assignment: ["B", "B", "M", "B", "B"], // 0–2 is an interior mountain fold → pinched
    };
    const vs = verts(buildStlExport(fold, "t", 2)!.text);
    expect(hasXY(vs, 5, 5)).toBe(false); // the shared interior edge's true midpoint (5,5) is pinched away on both tiles
    expect(hasXY(vs, 0, 0)).toBe(true); // shared corners stay full (the pivots)
    expect(hasXY(vs, 10, 10)).toBe(true);
  });

  it("a wider Gap pinches the cut midpoint further inward", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
      edges_vertices: [[0, 1], [1, 2], [2, 0]],
      edges_assignment: ["C", "B", "B"],
    };
    // the pinched cut midpoint is the vertex at x=5 with 0 < y < centroid (8/3≈2.67); exclude the centroid
    const midY = (gap: number): number => Math.max(...verts(buildStlExport(fold, "t", 1, null, gap)!.text).filter(([x, y]) => Math.abs(x - 5) < 1e-6 && y > 0.01 && y < 2.6).map(([, y]) => y));
    expect(midY(0.3)).toBeGreaterThan(midY(0.05)); // bigger gap → deeper pinch
  });

  it("uses a size-relative default height when none is given (≈ 2% of the bbox diagonal)", () => {
    const fold: FoldFile = { vertices_coords: [[0, 0], [100, 0], [0, 100]], faces_vertices: [[0, 1, 2]] };
    const out = buildStlExport(fold)!;
    expect(out.height).toBeCloseTo(0.02 * Math.hypot(100, 100), 4);
    expect(zSet(verts(out.text))).toContain(0);
  });

  it("reports the unit label from frame_unit, defaulting to \"units\"", () => {
    const base = { vertices_coords: [[0, 0], [1, 0], [1, 1]], faces_vertices: [[0, 1, 2]] } as FoldFile;
    expect(buildStlExport(base)!.unit).toBe("units");
    expect(buildStlExport({ ...base, frame_unit: "mm" })!.unit).toBe("mm");
  });

  it("always uses the flat pattern (z base = 0), ignoring any declared foldedForm frame", () => {
    const fold = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
      file_frames: [{ frame_classes: ["foldedForm"], vertices_coords: [[0, 0, 0], [10, 0, 0], [5, 4, 7]] }],
    } as unknown as FoldFile;
    expect(zSet(verts(buildStlExport(fold, "t", 2)!.text))).toEqual([0, 2]);
  });

  it("returns null when there are no faces", () => {
    expect(buildStlExport({ vertices_coords: [[0, 0]] })).toBeNull();
    expect(buildStlExport({ faces_vertices: [], vertices_coords: [[0, 0]] })).toBeNull();
  });
});
