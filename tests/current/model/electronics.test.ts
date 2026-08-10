import { describe, expect, it } from "vitest";
import {
  type Vec2,
  flatFaces,
  gapGraph,
  pointInFace,
  segInsidePolygon,
  segsProperlyIntersect,
  tapeQuads,
  tapeRibbon,
} from "../../../src/model/electronics.js";
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

describe("model/electronics: segsProperlyIntersect", () => {
  const p = (x: number, y: number): Vec2 => ({ x, y });

  it("is true only for a strict interior crossing", () => {
    expect(segsProperlyIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toBe(true);
  });

  it("is false for a shared endpoint, collinear overlap, or disjoint segments", () => {
    // A routing chord legitimately starts/ends on a polygon vertex and may run along an edge, so
    // neither case may count as a crossing.
    expect(segsProperlyIntersect(p(0, 0), p(10, 0), p(0, 0), p(0, 10))).toBe(false);
    expect(segsProperlyIntersect(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toBe(false);
    expect(segsProperlyIntersect(p(0, 0), p(1, 0), p(5, 5), p(6, 6))).toBe(false);
  });
});

describe("model/electronics: segInsidePolygon", () => {
  /**
   * A 10×10 tile whose RIGHT edge is pinched inward to (8.4,5) — the shape of a real gray tile beside
   * a gap. The notch makes the ring non-convex, which is exactly what the straightener must respect.
   */
  const pinched: Vec2[] = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 8.4, y: 5 },
    { x: 10, y: 10 }, { x: 5, y: 10 }, { x: 0, y: 10 },
    { x: 0, y: 5 },
  ];
  const seg = (ax: number, ay: number, bx: number, by: number) =>
    segInsidePolygon({ x: ax, y: ay }, { x: bx, y: by }, pinched);

  it("accepts a chord that stays on the tile", () => {
    expect(seg(1, 1, 1, 9)).toBe(true);
    expect(seg(1, 5, 8, 5)).toBe(true); // across the interior, short of the notch tip
  });

  it("rejects a chord spanning the gap opening (the notch)", () => {
    // Corner-to-corner down the pinched edge: the tile is not there — that space is the gap an LED
    // bridges, so tape laid along it would be unsupported.
    expect(seg(10, 0, 10, 10)).toBe(false);
  });

  it("rejects a chord that leaves the tile even when its midpoint is inside", () => {
    // Midpoint (8.5,3) IS inside, so the crossing test — not the containment test — has to catch this.
    expect(seg(5, 3, 12, 3)).toBe(false);
  });

  it("rejects a chord entirely outside, and a degenerate ring", () => {
    expect(seg(20, 20, 30, 30)).toBe(false);
    expect(segInsidePolygon({ x: 0, y: 0 }, { x: 1, y: 1 }, [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
  });
});

describe("model/electronics: tapeRibbon", () => {
  /** Is some polygon in `polys` the triangle with exactly these three corners (any order)? */
  const hasTriangle = (polys: Vec2[][], want: Vec2[]): boolean =>
    polys.some(
      (q) =>
        q.length === 3 &&
        want.every((w) => q.some((p) => Math.abs(p.x - w.x) < 1e-9 && Math.abs(p.y - w.y) < 1e-9)),
    );

  it("matches tapeQuads when there is no bend to fill", () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    expect(tapeRibbon(pts, 2)).toEqual(tapeQuads(pts, 2));
    // Collinear polyline: still no wedges, just the two rectangles.
    expect(tapeRibbon([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], 2)).toHaveLength(2);
  });

  it("fills the outside of a bend that tapeQuads leaves notched", () => {
    // 90° left turn at (10,0) with width 2. tapeQuads gives x∈[0,10]×y∈[-1,1] and x∈[9,11]×y∈[0,10]:
    // the square x∈[10,11], y∈[-1,0] on the OUTSIDE of the corner is covered by neither, so the tape
    // reads as notched there. The ribbon adds a bevel triangle over it.
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const quads = tapeQuads(pts, 2);
    const ribbon = tapeRibbon(pts, 2);
    expect(quads).toHaveLength(2);
    expect(ribbon).toHaveLength(4); // the 2 rectangles + one wedge per side of the joint
    expect(quads.every((q) => q.length === 4)).toBe(true); // no triangles at all before
    // The outer bevel: corner → outer edge of the incoming run → outer edge of the outgoing run.
    expect(hasTriangle(ribbon, [{ x: 10, y: 0 }, { x: 10, y: -1 }, { x: 11, y: 0 }])).toBe(true);
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
