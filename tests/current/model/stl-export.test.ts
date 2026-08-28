/**
 * FKLD → STL export: the 3D-printed tiles (`printed-joinery.ts`), matched to the 3D-Sim render. Each
 * face is a hexagonal tile `[A, mAB, B, mBC, C, mCA]` extruded to a closed prism; corners stay full
 * (neighbours meet there), an edge with a tile on BOTH sides pinches its midpoint inward to open the
 * diamond, and every free rim stays straight. A "C" on a free rim is a rim: FKLD's "C" names the
 * cutter layer, not material on the far side, and a closed shape is cut open along its whole
 * silhouette to flatten it. What you see in the sim is what you cut.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildStlExport } from "../../../src/model/stl-export.js";
import { edgeRole } from "../../../src/model/printed-joinery.js";
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

  it("PINCHES a 'C' slit that has a tile on both sides", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]],
      edges_vertices: [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]],
      edges_assignment: ["B", "B", "C", "B", "B"], // 0–2 is a real slit: material on both sides
    };
    const vs = verts(buildStlExport(fold, "t", 2)!.text);
    expect(hasXY(vs, 5, 5)).toBe(false); // the slit midpoint pinched inward on both tiles
    expect(hasXY(vs, 5, 0)).toBe(true); // rim midpoints stay straight
    for (const [x, y] of [[0, 0], [10, 0], [10, 10]]) expect(hasXY(vs, x, y)).toBe(true); // corners full
  });

  it("leaves a 'C' on a FREE RIM straight — the cut-open silhouette is not a joint", () => {
    // A closed shape unfolds by cutting itself open, so its whole outline is "C" (house.fkld: C×18,
    // B×0). Those edges have no tile behind them; pinching them scallops the outline the SVG export
    // cuts straight. Identical geometry to the all-boundary tile above.
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [5, 8]],
      faces_vertices: [[0, 1, 2]],
      edges_vertices: [[0, 1], [1, 2], [2, 0]],
      edges_assignment: ["C", "C", "C"],
    };
    const vs = verts(buildStlExport(fold, "t", 4)!.text);
    for (const [x, y] of [[0, 0], [10, 0], [5, 8], [5, 0], [7.5, 4], [2.5, 4]]) expect(hasXY(vs, x, y)).toBe(true);
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

  it("a wider Gap pinches the joint midpoint further inward", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2], [0, 2, 3]],
      edges_vertices: [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]],
      edges_assignment: ["B", "B", "C", "B", "B"],
    };
    // the two pinched lips of the shared edge sit either side of its true midpoint (5,5)
    const lipOffset = (gap: number): number =>
      Math.min(...verts(buildStlExport(fold, "t", 1, null, gap)!.text).map(([x, y]) => Math.hypot(x - 5, y - 5)));
    expect(lipOffset(0.3)).toBeGreaterThan(lipOffset(0.05)); // bigger gap → deeper pinch
  });

  it("house.fkld — a closed shape's whole outline is 'C', and none of it is a joint", () => {
    // The real case the rim rule exists for: unfolding a closed solid cuts it open along its
    // silhouette, so house.fkld carries C×18 / B×0 with every one of those edges on the outline.
    // The SVG export cuts them as a clean outline; the printed tiles must not scallop it.
    const url = new URL("../../../public/examples/house.fkld", import.meta.url);
    const fold = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
    const key = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const faceCount = new Map<string, number>();
    for (const f of fold.faces_vertices!) {
      for (let i = 0; i < f.length; i++) faceCount.set(key(f[i], f[(i + 1) % f.length]), (faceCount.get(key(f[i], f[(i + 1) % f.length])) ?? 0) + 1);
    }
    const cuts = fold.edges_vertices!.filter((_e, i) => fold.edges_assignment![i] === "C");
    expect(cuts.length).toBe(18);
    for (const [a, b] of cuts) {
      const n = faceCount.get(key(a, b)) ?? 0;
      expect(n).toBe(1); // one face behind it → the silhouette, not a slit
      expect(edgeRole("C", n)).toBe("boundary");
    }
    expect(edgeRole("C", 2)).toBe("cut"); // a genuine slit still opens
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
