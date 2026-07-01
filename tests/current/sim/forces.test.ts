import { describe, expect, it } from "vitest";
import { foldNetFromMesh } from "../../../src/sim/foldnet.js";
import {
  accumulateForces,
  computeDt,
  computeFaceNormals,
  computeThetas,
  integrate,
} from "../../../src/sim/forces.js";
import { buildModel } from "../../../src/sim/model.js";
import { vec3 } from "../../../src/sim/vec3.js";

function makeModel() {
  const net = foldNetFromMesh(
    [
      vec3(0, 0, 0),
      vec3(1, 0, 0),
      vec3(0.5, 1, 0),
      vec3(0.5, -1, 0),
    ],
    [
      [0, 1, 2],
      [1, 0, 3],
    ],
    () => "V",
    { N: 2, scale: 1, R: 1, s: 1, H: 1, gamma: 1, theta: 1, rApex: 0.1 },
  );
  return buildModel(net, { ...buildModel(net).params, kFace: 0 });
}

describe("sim/forces", () => {
  it("computes unit face normals for a flat hinge", () => {
    const model = makeModel();
    computeFaceNormals(model);

    const n0 = Array.from(model.faces.normal.slice(0, 3));
    const n1 = Array.from(model.faces.normal.slice(3, 6));
    expect(Math.hypot(...n0)).toBeCloseTo(1, 6);
    expect(Math.hypot(...n1)).toBeCloseTo(1, 6);
  });

  it("tracks continuous dihedral angles and accumulates nonzero crease forces", () => {
    const model = makeModel();
    const theta = new Float32Array(model.creases.count);
    model.creases.targetTheta[0] = 1.2;

    computeFaceNormals(model);
    computeThetas(model, theta);
    accumulateForces(model, theta, 1);

    const total = Array.from(model.force).reduce((sum, value) => sum + Math.abs(value), 0);
    expect(total).toBeGreaterThan(0);
  });

  it("keeps fixed-node forces at zero and integrates only free nodes", () => {
    const model = makeModel();
    model.force.fill(0);
    model.force[9] = 2;
    model.fixed[0] = 1;
    model.fixed[1] = 1;
    model.fixed[2] = 1;

    integrate(model, 0.5);
    expect(model.position[9]).toBeGreaterThan(0.5);
    expect(model.position[0]).toBe(0);
    expect(model.position[3]).toBe(1);
  });

  it("produces a positive stable timestep", () => {
    expect(computeDt(makeModel())).toBeGreaterThan(0);
  });
});
