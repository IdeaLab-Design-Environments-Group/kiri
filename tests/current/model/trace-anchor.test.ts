import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anchorTraces } from "../../../src/model/trace-anchor.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import { planRoutes } from "../../../src/model/electronics-routing.js";

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
});
