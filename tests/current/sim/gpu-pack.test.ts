import { describe, expect, it } from "vitest";
import { foldNetFromMesh } from "../../../src/sim/foldnet.js";
import { buildModel } from "../../../src/sim/model.js";
import { packModel, texDim } from "../../../src/sim/gpu/pack.js";
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
  return buildModel(net);
}

describe("sim/gpu/pack", () => {
  it("chooses square-ish texture dimensions that hold all texels", () => {
    expect(texDim(0)).toEqual([1, 1]);
    expect(texDim(1)).toEqual([1, 1]);
    expect(texDim(2)).toEqual([2, 1]);
    expect(texDim(5)[0] * texDim(5)[1]).toBeGreaterThanOrEqual(5);
  });

  it("packs node, beam, crease, and face data into texture-friendly arrays", () => {
    const model = makeModel();
    model.fixed[0] = 1;
    model.driven[1] = 1;
    model.goal[3] = 3;
    const packed = packModel(model, model.params.zeta);

    expect(packed.numNodes).toBe(model.numNodes);
    expect(packed.dim[0] * packed.dim[1]).toBeGreaterThanOrEqual(model.numNodes);
    expect(packed.position[0]).toBeCloseTo(model.position[0], 6);
    expect(packed.mass[1]).toBe(1);
    expect(packed.mass[6]).toBe(1);
    expect(packed.goal[4]).toBeCloseTo(3, 6);

    const beamEntries = Array.from({ length: model.numNodes }, (_, i) => packed.nodeMeta[4 * i + 1])
      .reduce((sum, count) => sum + count, 0);
    const creaseEntries = Array.from({ length: model.numNodes }, (_, i) => packed.nodeMeta[4 * i + 3])
      .reduce((sum, count) => sum + count, 0);
    const faceEntries = Array.from({ length: model.numNodes }, (_, i) => packed.nodeMeta2[4 * i + 1])
      .reduce((sum, count) => sum + count, 0);

    expect(beamEntries).toBe(2 * model.beams.count);
    expect(creaseEntries).toBe(4 * model.creases.count);
    expect(faceEntries).toBe(3 * model.faces.count);
    expect(packed.creaseParams[0]).toBeCloseTo(model.creases.k[0], 6);
    expect(packed.creaseParams[1]).toBeCloseTo(model.creases.targetTheta[0], 6);
  });

  it("stores face and crease node ids in the expected packing order", () => {
    const model = makeModel();
    const packed = packModel(model, model.params.zeta);

    expect(Array.from(packed.creaseNodes.slice(0, 4))).toEqual([
      model.creases.n1[0],
      model.creases.n2[0],
      model.creases.n3[0],
      model.creases.n4[0],
    ]);
    expect(Array.from(packed.faceNodes.slice(0, 3))).toEqual([
      model.faces.a[0],
      model.faces.b[0],
      model.faces.c[0],
    ]);
  });
});
