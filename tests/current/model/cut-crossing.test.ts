/**
 * Copper must not span a cut.
 *
 * The router has no rule against it and never has. What keeps copper off a cut is **containment**: a cut
 * that has opened is a hole in the silhouette, and every chord is sampled against `pointInFace`. That
 * covers seven of the eight bundled patterns completely — measured at zero crossings against 12 to 98 cut
 * edges each.
 *
 * It does not cover a cut whose two lips still sit on the same line. There the material is severed and the
 * flat pattern looks whole: every point on both sides is inside a face, and containment has nothing to
 * catch. `kirigami-flap` has three such edges and was routed straight across two of them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type FlatFace, type Led, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  planRoutes,
  seamCrossing,
  segsCross,
  tapeOnBody,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string): FoldFile {
  return JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8")) as FoldFile;
}

/** Every edge of the flat pattern that another edge lies exactly on top of — a cut that has not opened. */
function zeroWidthCuts(fold: FoldFile): [Vec2, Vec2][] {
  const co = (fold.vertices_coords ?? []) as number[][];
  const ev = (fold.edges_vertices ?? []) as number[][];
  const key = (p: number[]): string => `${Math.round(p[0]! * 1e6)}_${Math.round(p[1]! * 1e6)}`;
  const byLine = new Map<string, number[]>();
  ev.forEach((e, i) => {
    const a = key(co[e[0]!]!), b = key(co[e[1]!]!);
    const line = a < b ? `${a}|${b}` : `${b}|${a}`;
    byLine.set(line, [...(byLine.get(line) ?? []), i]);
  });
  return [...byLine.values()]
    .filter((v) => v.length > 1)
    .map((v) => {
      const e = ev[v[0]!]!;
      return [
        { x: co[e[0]!]![0]!, y: co[e[0]!]![1]! },
        { x: co[e[1]!]![0]!, y: co[e[1]!]![1]! },
      ] as [Vec2, Vec2];
    });
}

function ledsOn(gaps: { faceA: number; faceB: number }[], max: number): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(l);
    if (leds.length >= max) break;
  }
  return leds;
}

/** Two unit squares side by side. `slit` splits the shared edge into two coincident edges. */
function twoTiles(slit: boolean): FoldFile {
  return slit
    ? ({
        // Vertices 1,4 and 6,7 are two pairs at the same coordinates: the cut is there and has not opened.
        vertices_coords: [[0, 0], [1, 0], [0, 1], [1, 1], [1, 0], [2, 0], [1, 1], [2, 1]],
        faces_vertices: [[0, 1, 3, 2], [4, 5, 7, 6]],
        edges_vertices: [[1, 3], [4, 6]],
        edges_assignment: ["C", "C"],
      } as unknown as FoldFile)
    : ({
        vertices_coords: [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1]],
        faces_vertices: [[0, 1, 3, 2], [1, 4, 5, 3]],
        edges_vertices: [[1, 3]],
        edges_assignment: ["M"],
      } as unknown as FoldFile);
}

describe("model/cut-crossing", () => {
  it("does not lay copper across a cut whose lips have not opened", () => {
    // The regression. `kirigami-flap` carries three coincident cut edges; with the battery on face 2 the
    // router used to lay two runs straight over them, and nothing anywhere reported it.
    const fold = load("kirigami-flap.fkld");
    const cuts = zeroWidthCuts(fold);
    expect(cuts, "the fixture no longer has a zero-width cut to test").toHaveLength(3);

    const faces = flatFaces(fold);
    const { gaps } = gapGraph(fold, faces);
    const leds = ledsOn(gaps, 6);
    for (const face of [0, 1, 2]) {
      const r = planRoutes(faces, gaps, { leds, battery: { face } });
      let crossings = 0;
      for (const t of r.traces) {
        for (let i = 1; i < t.pts.length; i++) {
          for (const [p, q] of cuts) if (segsCross(t.pts[i - 1]!, t.pts[i]!, p, q)) crossings++;
        }
      }
      expect(crossings, `battery on face ${face} spanned a cut`).toBe(0);
    }
  });

  it("refuses a strip laid over an unopened cut, and allows one that stays on its own side", () => {
    const faces: FlatFace[] = flatFaces(twoTiles(true));
    const tapeW = tapeWidthFor(faces);
    expect(tapeOnBody(faces, tapeW, { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 })).toBe(false);
    expect(tapeOnBody(faces, tapeW, { x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 })).toBe(true);
  });

  it("still lets copper cross a hinge, which looks identical in coordinates", () => {
    // The detection has to tell a fold from a cut, and geometry alone cannot: both are two faces meeting
    // along one line. The difference is that a hinge is ONE edge — both faces name the same two vertices —
    // while a cut is two edges that coincide. Get this wrong and every pattern loses every crossing it has.
    const faces: FlatFace[] = flatFaces(twoTiles(false));
    const tapeW = tapeWidthFor(faces);
    expect(tapeOnBody(faces, tapeW, { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 })).toBe(true);
  });

  describe("reporting where the cut was spanned", () => {
    it("hands back the crossing point, which nothing downstream could recover", () => {
      // The usual way to report a strip off the sheet is to sample it for a point outside the material.
      // On an unopened cut BOTH sides are material, so that sampler finds nothing and any point it named
      // would be invented. `wire-rules` needs the real one to say where the wire spans the cut.
      const faces: FlatFace[] = flatFaces(twoTiles(true));
      const at = seamCrossing(faces, { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 });
      expect(at, "a chord straight over the cut reported no crossing").toBeTruthy();
      expect(at!.x).toBeCloseTo(1, 9); // the cut runs up x = 1
      expect(at!.y).toBeCloseTo(0.5, 9);
    });

    it("reports nothing for a strip that stays on its own side", () => {
      const faces: FlatFace[] = flatFaces(twoTiles(true));
      expect(seamCrossing(faces, { x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 })).toBeNull();
    });

    it("reports nothing for a hinge, which is the same geometry and not a cut", () => {
      const faces: FlatFace[] = flatFaces(twoTiles(false));
      expect(seamCrossing(faces, { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 })).toBeNull();
    });

    it("agrees with the refusal, so the two can never drift apart", () => {
      // One reading, not two. The refusal is defined as "seamCrossing found something", so a case where
      // they disagreed would be a case where one of them was not asked.
      const faces: FlatFace[] = flatFaces(twoTiles(true));
      const tapeW = tapeWidthFor(faces);
      for (const [a, b] of [
        [{ x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 }],
        [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 }],
        [{ x: 1.2, y: 0.2 }, { x: 1.8, y: 0.8 }],
      ] as [Vec2, Vec2][]) {
        expect(tapeOnBody(faces, tapeW, a, b)).toBe(seamCrossing(faces, a, b) === null);
      }
    });
  });

  it("leaves the patterns that have no unopened cut exactly as they were", () => {
    // Seven of the eight carry none, so the new refusal must be inert on them. Asserted through the
    // detection rather than by re-routing all seven, which is minutes of work for the same statement.
    for (const name of [
      "house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld",
      "akde-decagon-pyramid.fkld", "akde-square-pyramid.fkld", "bistable-star-tiling.fkld",
    ]) {
      expect(zeroWidthCuts(load(name)), `${name} has an unopened cut`).toHaveLength(0);
    }
  });
});
