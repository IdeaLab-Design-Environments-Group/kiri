/**
 * The corridor: where tape may go, and the search over it.
 *
 * The fixtures are hand-built folds small enough to reason about by eye. A bridge over an opening is
 * `gap-bridge.test.ts`'s and a zero-width seam is `cut-crossing.test.ts`'s; this file is the rest.
 */
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { buildCorridor, reachableFaces, searchCorridor, tapeOffBodyAt, tapeOnBody } from "../../../src/model/corridor.js";
import { batteryTerminals, patternDiag, planRoutes, tapeMmFor, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { segNearSeg, segPointDist } from "../../../src/model/trace-geometry.js";

/** A FOLD of the given face outlines, with vertices shared wherever two outlines meet at a corner. */
function fold(polys: [number, number][][]): FoldFile {
  const verts: [number, number][] = [];
  const idx = (p: [number, number]): number => {
    const k = verts.findIndex((v) => Math.abs(v[0] - p[0]) < 1e-9 && Math.abs(v[1] - p[1]) < 1e-9);
    if (k >= 0) return k;
    verts.push(p);
    return verts.length - 1;
  };
  return { vertices_coords: verts, faces_vertices: polys.map((poly) => poly.map(idx)) } as unknown as FoldFile;
}

describe("model/corridor › a strip of tape", () => {
  it("is off the body when its centreline runs along a slit narrower than the tape", () => {
    // Two tiles half a unit apart, tape 1.5 wide. Laid lengthwise down the slit, both edges of the strip
    // are on material and the middle of it is over nothing.
    const faces = flatFaces(fold([
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[10.5, 0], [20, 0], [20, 10], [10.5, 10]],
    ]));
    const a = { x: 10.25, y: 1 }, b = { x: 10.25, y: 9 };
    expect(tapeOnBody(faces, 1.5, a, b)).toBe(false);
    expect(tapeOffBodyAt(faces, 1.5, a, b)).not.toBeNull();
    // The controls: wholly on one tile is fine, across the slit is not.
    expect(tapeOnBody(faces, 1.5, { x: 2, y: 5 }, { x: 8, y: 5 })).toBe(true);
    expect(tapeOnBody(faces, 1.5, { x: 5, y: 5 }, { x: 15, y: 5 })).toBe(false);
  });
});

/** Four unit tiles in a square: 0 bottom-left, 1 bottom-right, 2 top-left, 3 top-right. */
const GRID = fold([
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[1, 0], [2, 0], [2, 1], [1, 1]],
  [[0, 1], [1, 1], [1, 2], [0, 2]],
  [[1, 1], [2, 1], [2, 2], [1, 2]],
]);

function corridorOf(f: FoldFile) {
  const faces = flatFaces(f);
  const gaps = gapGraph(f, faces).gaps;
  const c = buildCorridor(faces, gaps, 0, tapeWidthFor(faces), undefined, tapeMmFor(faces));
  return { faces, c };
}

describe("model/corridor › the strict search", () => {
  it("does not step onto the other net's tape, even where it only touches it", () => {
    // The other net runs along the hinge between tiles 0 and 1, joining its two waypoints: it crosses
    // nothing, so a chord ending on either waypoint only touches it -- and touching is copper on copper.
    // The strict pass has to go round through tiles 2 and 3.
    const { c } = corridorOf(GRID);
    const onHinge = [...c.point.entries()]
      .filter(([k]) => { const f = c.faceOf.get(k)!; return f.includes(0) && f.includes(1); })
      .map(([, p]) => p);
    expect(onHinge).toHaveLength(2);
    const theirs: Vec2[][] = [onHinge];
    const origin = { x: 0.5, y: 0.5 };
    const path = searchCorridor(c, 0, 1, new Set(), new Map(), null, true, origin, null, null, theirs);
    expect(path.length).toBeGreaterThan(0);
    path.unshift(origin);
    for (let i = 1; i < path.length; i++) {
      expect(segNearSeg(path[i - 1]!, path[i]!, onHinge[0]!, onHinge[1]!)).toBeGreaterThan(1e-6);
    }
  });

  it("does not set off past the other net's terminal", () => {
    // Two squares joined by a short neck. GND leaves its terminal for the far side, and the nearest way into
    // the neck runs straight past the PWR terminal. Chords near it were refused; the first leg out of the
    // terminal was not, because it is not a chord.
    const NECK = fold([
      [[0, 0], [10, 0], [10, 4], [10, 6], [10, 10], [0, 10]],
      [[10, 4], [11, 4], [11, 6], [10, 6]],
      [[11, 0], [16, 0], [16, 10], [11, 10], [11, 6], [11, 4]],
      [[16, 0], [21, 0], [21, 10], [16, 10]],
    ]);
    const { faces, c } = corridorOf(NECK);
    const tapeW = tapeWidthFor(faces);
    const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeW);
    const forbid = { at: term.pwr, r: term.half + tapeW / 2 };
    const onBody = (a: Vec2, b: Vec2): boolean => tapeOnBody(faces, tapeW, a, b);
    const path = searchCorridor(c, 0, 2, new Set(), new Map(), forbid, true, term.gnd, onBody, null, null);
    // Either a way round or nothing, which sends the caller to the tolled pass -- never a leg across it.
    if (path.length) expect(segPointDist(term.gnd, path[0]!, term.pwr)).toBeGreaterThanOrEqual(forbid.r);
  });
});

describe("model/corridor › reachability", () => {
  /** Two big tiles joined by a neck `h` wide, then a fourth tile beyond; the LED sits on the last hinge. */
  const neck = (h: number): FoldFile => {
    const lo = 5 - h / 2, hi = 5 + h / 2;
    return fold([
      [[0, 0], [10, 0], [10, lo], [10, hi], [10, 10], [0, 10]],
      [[10, lo], [11, lo], [11, hi], [10, hi]],
      [[11, 0], [16, 0], [16, 10], [11, 10], [11, hi], [11, lo]],
      [[16, 0], [21, 0], [21, 10], [16, 10]],
    ]);
  };

  it("agrees with the search: a tile no chord leads to is out of reach", () => {
    // The neck is narrower than the tape, so no chord through it stays on the material. The tiles beyond
    // were still called reachable because they share an edge node with the neck.
    const { c } = corridorOf(neck(0.2));
    const reach = reachableFaces(c, 0);
    expect(searchCorridor(c, 0, 2, new Set(), new Map(), null, false, null, null, null, null)).toEqual([]);
    expect(reach.has(2)).toBe(false);
    expect(reach.has(3)).toBe(false);
    // And a wide neck is a way through.
    const wide = corridorOf(neck(2));
    expect(reachableFaces(wide.c, 0).has(3)).toBe(true);
  });

  it("does not count a tile reachable when no first leg out of the origin stays on the material", () => {
    const { c } = corridorOf(neck(2));
    const nowhere = (): boolean => false;
    expect([...reachableFaces(c, 0, { x: 5, y: 5 }, nowhere)]).toEqual([0]);
  });

  it("reports an LED beyond the neck unreachable instead of drawing a straight line to it", () => {
    const f = neck(0.2);
    const faces = flatFaces(f);
    const gaps = gapGraph(f, faces).gaps;
    const r = planRoutes(faces, gaps, { leds: [{ a: 2, b: 3 }], battery: { face: 0 } });
    expect(r.unreachable).toEqual([0]);
    const tapeW = tapeWidthFor(faces);
    for (const t of r.traces) {
      for (let i = 1; i < t.pts.length; i++) {
        expect(tapeOnBody(faces, tapeW, t.pts[i - 1]!, t.pts[i]!), `${t.net} segment ${i}`).toBe(true);
      }
    }
  });
});
