import { describe, expect, it } from "vitest";
import * as gpu from "../../../src/sim/gpu/index.js";

describe("sim/gpu/index barrel", () => {
  it("re-exports the GPU solver entry point", () => {
    expect(typeof gpu.GpuFoldSolver).toBe("function");
  });
});
