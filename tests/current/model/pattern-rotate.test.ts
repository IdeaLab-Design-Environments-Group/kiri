import { describe, expect, it } from "vitest";
import type { Circuit } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  edgeAlignAngle,
  patternCentre,
  rotateCircuit,
  rotateFold,
  rotatePoint,
} from "../../../src/model/pattern-rotate.js";

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

const fold = (): FoldFile => ({
  vertices_coords: [[0, 0, 5], [4, 0, 5], [4, 2, 5], [0, 2, 5], [1, 1]],
  edges_vertices: [[0, 1], [1, 2], [0, 4], [3, 3], [0, 2]],
  file_frames: [{ vertices_coords: [[9, 9, 9]] }],
});

describe("model/pattern-rotate", () => {
  it("turns a point anticlockwise about a centre", () => {
    near(rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 1 });
    near(rotatePoint({ x: 3, y: 1 }, { x: 2, y: 1 }, -90), { x: 2, y: 0 });
    near(rotatePoint({ x: 3, y: 4 }, { x: 1, y: 1 }, 0), { x: 3, y: 4 });
    near(rotatePoint({ x: 3, y: 4 }, { x: 1, y: 1 }, 360), { x: 3, y: 4 });
  });

  it("finds the middle of the bounding box", () => {
    near(patternCentre(fold()), { x: 2, y: 1 });
    near(patternCentre({}), { x: 0, y: 0 });
  });

  it("turns the flat coordinates about the centre, keeping z, the folded frames and the original", () => {
    const f = fold();
    const r = rotateFold(f, 180);
    expect(r.vertices_coords![0]![0]).toBeCloseTo(4, 9);
    expect(r.vertices_coords![0]![1]).toBeCloseTo(2, 9);
    expect(r.vertices_coords![0]![2]).toBe(5);
    expect(r.vertices_coords![4]).toHaveLength(2);
    expect(r.file_frames).toBe(f.file_frames);
    expect(r.edges_vertices).toBe(f.edges_vertices);
    expect(f.vertices_coords![0]).toEqual([0, 0, 5]);
  });

  it("keeps every edge length", () => {
    const f = fold();
    const r = rotateFold(f, 37);
    const len = (g: FoldFile, e: number) => {
      const [a, b] = g.edges_vertices![e]!.map((v) => g.vertices_coords![v]!);
      return Math.hypot(b![0]! - a![0]!, b![1]! - a![1]!);
    };
    for (let e = 0; e < 5; e++) expect(len(r, e)).toBeCloseTo(len(f, e), 9);
  });

  it("copes with a file that has no coordinates", () => {
    expect(rotateFold({ frame_title: "x" }, 90)).toEqual({ frame_title: "x" });
  });

  it("turns every stored point of a circuit and the parts' own direction, and leaves indices alone", () => {
    const c: Circuit = {
      leds: [{ a: 1, b: 2 }],
      battery: { face: 3 },
      parts: [{ component: "R", x: 3, y: 1, rot: 300 }, { component: "C", x: 2, y: 1 }],
      resistors: [{ x: 3, y: 1, flip: true }],
      switches: [{ x: 1, y: 1 }],
      wires: [{ id: "w", pts: [{ kind: "free", x: 3, y: 1 }, { kind: "pad", part: 0, pad: "1" }] }],
    };
    const r = rotateCircuit(c, { x: 2, y: 1 }, 90);
    near(r.parts![0]!, { x: 2, y: 2 });
    expect(r.parts![0]!.rot).toBeCloseTo(30, 9);
    expect(r.parts![1]!.rot).toBeCloseTo(90, 9);
    near(r.resistors![0]!, { x: 2, y: 2 });
    expect(r.resistors![0]!.flip).toBe(true);
    near(r.switches![0]!, { x: 2, y: 0 });
    near(r.wires![0]!.pts[0] as { x: number; y: number }, { x: 2, y: 2 });
    expect(r.wires![0]!.pts[1]).toEqual({ kind: "pad", part: 0, pad: "1" });
    expect(r.leds).toBe(c.leds);
    expect(r.battery).toBe(c.battery);
    expect(c.parts![0]!.x).toBe(3);
  });

  it("leaves out lists the circuit does not have", () => {
    const r = rotateCircuit({ leds: [], battery: null }, { x: 0, y: 0 }, 45);
    expect(r).toEqual({ leds: [], battery: null });
  });

  it("gives the smallest turn that lays an edge along x or y", () => {
    const f = fold();
    expect(edgeAlignAngle(f, 0, "x")).toBeCloseTo(0, 9);
    expect(edgeAlignAngle(f, 0, "y")).toBeCloseTo(90, 9);
    expect(edgeAlignAngle(f, 1, "x")).toBeCloseTo(90, 9);
    expect(edgeAlignAngle(f, 2, "x")).toBeCloseTo(-45, 9); // (0,0)→(1,1)
    expect(edgeAlignAngle(f, 2, "y")).toBeCloseTo(45, 9);
    for (const axis of ["x", "y"] as const) {
      const d = edgeAlignAngle(f, 4, axis)!;
      expect(d).toBeGreaterThan(-90);
      expect(d).toBeLessThanOrEqual(90);
      const r = rotateFold(f, d);
      const [a, b] = r.edges_vertices![4]!.map((v) => r.vertices_coords![v]!);
      const i = axis === "x" ? 1 : 0;
      expect(a![i]).toBeCloseTo(b![i]!, 9);
    }
  });

  it("has no turn for a missing or zero-length edge", () => {
    const f = fold();
    expect(edgeAlignAngle(f, 99, "x")).toBeNull();
    expect(edgeAlignAngle(f, 3, "x")).toBeNull();
    expect(edgeAlignAngle({}, 0, "x")).toBeNull();
  });
});
