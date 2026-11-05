import { describe, expect, it } from "vitest";
import { computeState } from "@kirigami/model/geometry.js";
import { buildFoldNet, foldNetFromMesh } from "../../../src/sim/foldnet.js";
import { vec3 } from "../../../src/sim/vec3.js";

describe("sim/foldnet", () => {
  it("builds the analytical kirigami net with expected topology markers", () => {
    const state = computeState({
      edgeCount: 6,
      edgeLength: 100,
      totalCurvature: 100,
      materialThickness: 1,
    });
    const net = buildFoldNet(state);

    expect(net.basePairs).toHaveLength(6);
    expect(net.valleyOuter).toHaveLength(6);
    expect(net.tips).toHaveLength(6);
    expect(new Set(net.edges.map((edge) => edge.assignment))).toEqual(
      new Set(["B", "C", "F", "M", "V"]),
    );
    expect(net.meta.scale).toBeGreaterThan(0);
    expect(net.meta.R).toBeLessThanOrEqual(1);
  });

  it("winds every face counterclockwise in the flat net, as FoldNet.faces promises", () => {
    // Mixed winding made a crease between a lateral face and its molecule read ±π on the flat sheet,
    // so a fold measured from flat (the declared-form sim path) started half a turn off.
    for (const edgeCount of [4, 6, 10]) {
      const net = buildFoldNet(
        computeState({ edgeCount, edgeLength: 100, totalCurvature: 100, materialThickness: 1 }),
      );
      const v = net.vertices;
      for (const [a, b, c] of net.faces) {
        const area2 = (v[b].x - v[a].x) * (v[c].y - v[a].y) - (v[b].y - v[a].y) * (v[c].x - v[a].x);
        expect(area2).toBeGreaterThan(0);
      }
    }
  });

  it("tiles the flat net without overlapping triangles", () => {
    // Issue #14: fanning each molecule half from its valley node put the rim triangle
    // (innerMid, tip, innerRim) inside its neighbour (innerMid, outerCorner, tip), so the flat sheet
    // covered that sliver twice.
    for (const edgeCount of [4, 6, 10]) {
      const net = buildFoldNet(
        computeState({ edgeCount, edgeLength: 100, totalCurvature: 100, materialThickness: 1 }),
      );
      const v = net.vertices;
      const cross = (o: number, a: number, b: number): number =>
        (v[a].x - v[o].x) * (v[b].y - v[o].y) - (v[a].y - v[o].y) * (v[b].x - v[o].x);
      // Two faces sharing an edge overlap iff their third vertices lie on the same side of it.
      for (const e of net.edges) {
        if (e.faces.length !== 2) continue;
        const [w1, w2] = e.faces.map((f) => net.faces[f].find((i) => i !== e.a && i !== e.b)!);
        expect(Math.sign(cross(e.a, e.b, w1))).toBe(-Math.sign(cross(e.a, e.b, w2)));
      }
    }
  });

  it("derives mesh edges from arbitrary triangle meshes", () => {
    const net = foldNetFromMesh(
      [vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 1, 0), vec3(0, 1, 0)],
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
      () => "M",
      { N: 4, scale: 1, R: 1, s: 1, H: 1, gamma: 1, theta: 1, rApex: 0.1 },
    );

    expect(net.faces).toHaveLength(2);
    expect(net.edges).toHaveLength(5);
    expect(net.edges.filter((edge) => edge.faces.length === 2)).toHaveLength(1);
    expect(net.edges.find((edge) => edge.faces.length === 2)?.assignment).toBe("M");
  });
});
