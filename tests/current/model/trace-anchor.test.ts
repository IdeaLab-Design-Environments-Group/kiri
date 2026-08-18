import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anchorOverlay, anchorTraces } from "../../../src/model/trace-anchor.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import {
  batteryTerminals,
  patternDiag,
  planRoutes,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function planned(name: string, n = 6) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(l);
    if (leds.length >= n) break;
  }
  const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } } as Circuit);
  return { fold, faces, traces: r.traces };
}

describe("model/trace-anchor", () => {
  it("rebuilds the flat position exactly from the flat corners", () => {
    // The weights are the whole point: applied to the *unfolded* corners they must give back the point the
    // router planned, or the copper will sit somewhere else on the model.
    const { fold, faces, traces } = planned("house.fkld");
    const coords = fold.vertices_coords as number[][];
    const anchored = anchorTraces(traces, faces);
    expect(anchored.length).toBeGreaterThan(0);

    let checked = 0;
    anchored.forEach((t, ti) => {
      t.points.forEach((pt, k) => {
        const [a, b, c] = pt.tri;
        const [wa, wb, wc] = pt.bary;
        const x = coords[a]![0]! * wa + coords[b]![0]! * wb + coords[c]![0]! * wc;
        const y = coords[a]![1]! * wa + coords[b]![1]! * wb + coords[c]![1]! * wc;
        const want = traces[ti]!.pts[k]!;
        expect(x).toBeCloseTo(want.x, 9);
        expect(y).toBeCloseTo(want.y, 9);
        checked++;
      });
    });
    expect(checked).toBeGreaterThan(20);
  });

  it("keeps every trace, and every point of it", () => {
    const { faces, traces } = planned("church.fkld");
    const anchored = anchorTraces(traces, faces);
    expect(anchored).toHaveLength(traces.length);
    anchored.forEach((t, i) => {
      expect(t.points).toHaveLength(traces[i]!.pts.length);
      expect(t.net).toBe(traces[i]!.net);
    });
  });

  it("uses the right triangle of a many-sided face", () => {
    // A quad fanned from its first corner is two triangles; a point in the far one must not be pinned to the
    // near one, or it lands outside the face once the model folds.
    const faces = flatFaces({
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
      faces_vertices: [[0, 1, 2, 3]],
      edges_vertices: [],
      edges_assignment: [],
    } as never);
    const near = anchorTraces([{ net: "pwr", pts: [{ x: 8, y: 1 }, { x: 1, y: 8 }] }], faces)[0]!;
    // (8,1) is in triangle 0-1-2; (1,8) is in triangle 0-2-3.
    expect(near.points[0]!.tri).toEqual([0, 1, 2]);
    expect(near.points[1]!.tri).toEqual([0, 2, 3]);
    for (const p of near.points) {
      for (const w of p.bary) expect(w).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("drops points that are not on the pattern at all", () => {
    // A stale circuit against a changed pattern. Better to draw less than to pin copper to a guessed face.
    const faces = flatFaces({
      vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
      faces_vertices: [[0, 1, 2, 3]],
      edges_vertices: [],
      edges_assignment: [],
    } as never);
    const out = anchorTraces([{ net: "gnd", pts: [{ x: 0.5, y: 0.5 }, { x: 99, y: 99 }] }], faces);
    expect(out).toHaveLength(0); // one point left is not a run
  });

  describe("the whole layer", () => {
    it("draws copper at the tape's width, plus LED footprints and battery pads", () => {
      const { fold, faces, traces } = planned("house.fkld");
      const gaps = gapGraph(fold, faces).gaps;
      const leds: Led[] = [];
      const seen = new Set<string>();
      for (const g of gaps) {
        const l = ledOf(g.faceA, g.faceB);
        const k = `${l.a}_${l.b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        leds.push(l);
        if (leds.length >= 6) break;
      }
      const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } } as Circuit);
      const tapeW = tapeWidthFor(faces);
      const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeW);
      const meshes = anchorOverlay(r.traces, r.pads, term, tapeW, faces);

      const kinds = new Set(meshes.map((m) => m.kind));
      expect(kinds.has("pwr") || kinds.has("gnd")).toBe(true);
      expect(kinds.has("led-pwr")).toBe(true);
      expect(kinds.has("led-gnd")).toBe(true);
      expect(kinds.has("led-body")).toBe(true);
      expect(kinds.has("batt-pwr")).toBe(true);
      expect(kinds.has("batt-gnd")).toBe(true);
      // Triangles, in threes.
      for (const m of meshes) expect(m.tris.length % 3).toBe(0);
      void traces;
    });

    it("gives the copper the real tape width, not a hairline", () => {
      // The width is the whole point of drawing a ribbon rather than a line. On a single flat face the
      // anchored corners rebuild exactly, so the strip can be measured across.
      const faces = flatFaces({
        vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10]],
        faces_vertices: [[0, 1, 2, 3]],
        edges_vertices: [],
        edges_assignment: [],
      } as never);
      const coords = [[0, 0], [10, 0], [10, 10], [0, 10]];
      const meshes = anchorOverlay(
        [{ net: "pwr", pts: [{ x: 2, y: 5 }, { x: 8, y: 5 }] }], [], null, 1.5, faces,
      );
      expect(meshes).toHaveLength(1);
      const ys = meshes[0]!.tris.map((pt) => {
        const [a, b, c] = pt.tri;
        const [wa, wb, wc] = pt.bary;
        return coords[a]![1]! * wa + coords[b]![1]! * wb + coords[c]![1]! * wc;
      });
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1.5, 9);
    });
    it("marks which pad is positive and which is negative", () => {
      // Colour says it in the layout, where the legend is beside it. On a model turned to any angle, the shape
      // has to say it: a bar on the negative pad, a cross on the positive one.
      const faces = flatFaces({
        vertices_coords: [[0, 0], [20, 0], [20, 20], [0, 20]],
        faces_vertices: [[0, 1, 2, 3]],
        edges_vertices: [],
        edges_assignment: [],
      } as never);
      const meshes = anchorOverlay(
        [], [{ pwr: { x: 6, y: 10 }, gnd: { x: 14, y: 10 } }], null, 2, faces,
      );
      const marks = meshes.filter((m) => m.kind === "mark");
      expect(marks).toHaveLength(1);
      // Three bars in all: one for the minus, two crossed for the plus. Two triangles each.
      expect(marks[0]!.tris).toHaveLength(3 * 6);
    });

  });
});
