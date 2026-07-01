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
