import { describe, expect, it } from "vitest";
import { foldNetFromMesh } from "../../../src/sim/foldnet.js";
import { buildModel, DEFAULT_PARAMS, setFixed } from "../../../src/sim/model.js";
import { vec3 } from "../../../src/sim/vec3.js";

function makeSingleHingeNet() {
  return foldNetFromMesh(
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
}

describe("sim/model", () => {
  it("builds beams, creases, and face angles from the fold net", () => {
    const model = buildModel(makeSingleHingeNet());

    expect(model.numNodes).toBe(4);
    expect(model.beams.count).toBe(5);
    expect(model.creases.count).toBe(1);
    expect(model.faces.count).toBe(2);
    expect(model.creases.assignment[0]).toBe("V");
    expect(model.creases.targetTheta[0]).toBeCloseTo(-DEFAULT_PARAMS.foldValley, 6);
  });

  it("applies cutRatio as a direct reduction on crease stiffness", () => {
    const full = buildModel(makeSingleHingeNet(), DEFAULT_PARAMS, () => 0);
    const weakened = buildModel(makeSingleHingeNet(), DEFAULT_PARAMS, () => 0.25);

    expect(weakened.creases.k[0]).toBeCloseTo(full.creases.k[0] * 0.75, 6);
  });

  it("pins and unpins node ids through setFixed", () => {
    const model = buildModel(makeSingleHingeNet());
    setFixed(model, [0, 2], true);
    expect(Array.from(model.fixed)).toEqual([1, 0, 1, 0]);
    setFixed(model, [2], false);
    expect(Array.from(model.fixed)).toEqual([1, 0, 0, 0]);
  });
});
