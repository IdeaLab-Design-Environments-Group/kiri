import { describe, expect, it } from "vitest";
import * as sim from "../../../src/sim/index.js";

describe("sim/index barrel", () => {
  it("re-exports the simulation-core entry points", () => {
    expect(typeof sim.buildFoldNet).toBe("function");
    expect(typeof sim.foldNetFromMesh).toBe("function");
    expect(typeof sim.buildModel).toBe("function");
    expect(typeof sim.computeFaceNormals).toBe("function");
    expect(typeof sim.FoldSolver).toBe("function");
    expect(typeof sim.buildFoldScene).toBe("function");
  });

  it("re-exports the vec3 namespace helpers", () => {
    expect(sim.vec3.vec3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    expect(sim.vec3.length({ x: 3, y: 4, z: 0 })).toBe(5);
  });
});
