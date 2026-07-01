import { describe, expect, it } from "vitest";
import { buildSceneFromFold, isFoldable } from "../../../src/sim/fold-adapter.js";

// Two explicit triangle faces sharing one mountain crease (edge 0-2). (A quad face WITH an
// explicit interior diagonal is degenerate — the OS-faithful triangulator adds a second
// coincident diagonal — so the canonical form is pre-triangulated, as here.)
const foldable = {
  vertices_coords: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  faces_vertices: [
    [0, 1, 2],
    [0, 2, 3],
  ],
  edges_vertices: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 2],
  ] as [number, number][],
  edges_assignment: ["B", "B", "B", "B", "M"],
  edges_foldAngle: [0, 0, 0, 0, 180],
};

describe("sim/fold-adapter", () => {
  it("recognizes foldable crease-pattern data", () => {
    expect(isFoldable({})).toBe(false);
    expect(isFoldable(foldable)).toBe(true);
  });

  it("builds a normalized free-fold scene; plain FOLD keeps the exact fold angle", () => {
    const { net, model, solver } = buildSceneFromFold(foldable);

    expect(net.faces).toHaveLength(2);
    expect(model.creases.count).toBe(1); // only the M edge (0,2) is a crease
    // Paper-exact path (Ghassaei et al. §2.3): the file's angle passes through
    // unclamped — 180° stays π, signed per the FOLD spec.
    expect(Math.abs(model.creases.targetTheta[0])).toBeCloseTo(Math.PI, 6);
    expect(solver.theta.length).toBe(1);
  });

  it("explicit FKLD fold angles are NOT clamped (uniform engine; the ±2.7 FKLD clamp is retired)", () => {
    const { model } = buildSceneFromFold({
      ...foldable,
      "fkld:edges_cutType": [null, null, null, null, null],
    });
    expect(Math.abs(model.creases.targetTheta[0])).toBeCloseTo(Math.PI, 6);
  });

  it("uses guided FKLD frames when folded-form and driven metadata are present", () => {
    const { model } = buildSceneFromFold({
      ...foldable,
      file_frames: [
        {
          frame_classes: ["foldedForm"],
          vertices_coords: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1],
          ],
        },
      ],
      "fkld:vertices_driven": [1, 0, 0, 1],
    });

    expect(Array.from(model.driven)).toEqual([1, 0, 0, 1]);
    expect(Array.from(model.fixed)).toEqual([1, 0, 0, 1]);
    // Policy-independent contract (what pipeline/verify.ts relies on): the
    // goal frame is mapped by ONE uniform affine transform sim = mm·s + t —
    // whatever alignment policy the adapter currently uses. Recover (s, t)
    // from two vertices and check every vertex agrees.
    const mm = [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ];
    const s = (model.goal[3] - model.goal[0]) / (mm[1][0] - mm[0][0]);
    const t = [model.goal[0] - mm[0][0] * s, model.goal[1] - mm[0][1] * s, model.goal[2] - mm[0][2] * s];
    for (let i = 0; i < 4; i++) {
      for (let a = 0; a < 3; a++) {
        expect(model.goal[3 * i + a]).toBeCloseTo(mm[i][a] * s + t[a], 5);
      }
    }
    for (let i = 0; i < model.goal.length; i++) expect(Number.isFinite(model.goal[i])).toBe(true);
  });

  it("throws on non-foldable input", () => {
    expect(() => buildSceneFromFold({ vertices_coords: [[0, 0, 0]] })).toThrow(
      /lacks vertices\/faces\/edges/i,
    );
  });
});
