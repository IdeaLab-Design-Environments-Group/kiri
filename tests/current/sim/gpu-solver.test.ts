import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const computeDt = vi.fn(() => 0.125);
const packModel = vi.fn(() => ({
  dim: [2, 1] as [number, number],
  position: new Float32Array(8),
  velocity: new Float32Array(8),
  mass: new Float32Array(8),
  goal: new Float32Array(8),
  nodeMeta: new Float32Array(8),
  nodeMeta2: new Float32Array(8),
  beamDim: [1, 1] as [number, number],
  beamMeta: new Float32Array(4),
  creaseListDim: [1, 1] as [number, number],
  creaseList: new Float32Array(4),
  creaseDim: [1, 1] as [number, number],
  creaseNodes: new Float32Array(4),
  creaseParams: new Float32Array(4),
  creaseFace1: new Float32Array(4),
  creaseFace2: new Float32Array(4),
  faceListDim: [1, 1] as [number, number],
  faceList: new Float32Array(4),
  faceDim: [1, 1] as [number, number],
  faceNodes: new Float32Array(4),
  faceAngles: new Float32Array(4),
}));

class MockDataTexture {
  image: { data: Float32Array };
  needsUpdate = false;
  constructor(data: Float32Array) {
    this.image = { data };
  }
}

class MockVector2 {
  constructor(public x: number, public y: number) {}
}

class MockShaderMaterial {
  uniforms: Record<string, { value: unknown }> = {};
}

let initError: string | null = null;
let computeCalls = 0;

class MockGPUComputationRenderer {
  constructor(public w: number, public h: number, public renderer: any) {}
  createTexture() {
    return { image: { data: new Float32Array(this.w * this.h * 4) } };
  }
  addVariable(name: string, _shader: string, _tex: any) {
    return { name, material: new MockShaderMaterial() };
  }
  setVariableDependencies() {}
  init() {
    return initError;
  }
  compute() {
    computeCalls++;
  }
  getCurrentRenderTarget(variable: any) {
    return { kind: variable.name };
  }
}

vi.mock("three", () => ({
  DataTexture: MockDataTexture,
  Vector2: MockVector2,
  RGBAFormat: "rgba",
  FloatType: "float",
  ShaderMaterial: MockShaderMaterial,
}));

vi.mock("three/examples/jsm/misc/GPUComputationRenderer.js", () => ({
  GPUComputationRenderer: MockGPUComputationRenderer,
}));

vi.mock("../../../src/sim/forces.js", () => ({
  computeDt,
}));

vi.mock("../../../src/sim/gpu/pack.js", () => ({
  packModel,
}));

vi.mock("../../../src/sim/gpu/shaders.js", () => ({
  POSITION_SHADER: "position shader",
  VELOCITY_SHADER: "velocity shader",
}));

describe("sim/gpu/gpu-solver", () => {
  beforeEach(() => {
    vi.resetModules();
    initError = null;
    computeCalls = 0;
    computeDt.mockClear();
    packModel.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a solver, advances it, relaxes it, resets settling, and reads positions back", async () => {
    const { GpuFoldSolver } = await import("../../../src/sim/gpu/gpu-solver.js");
    const renderer = {
      readRenderTargetPixels: vi.fn((target: any, _x: number, _y: number, _w: number, _h: number, out: Float32Array) => {
        if (target.kind === "textureVelocity") {
          out.set([1, 2, 3, 0, 4, 5, 6, 0]);
        } else {
          out.set([10, 11, 12, 0, 20, 21, 22, 0]);
        }
      }),
    } as any;
    const model = {
      numNodes: 2,
      params: { zeta: 0.4, kFace: 0.2 },
      position: new Float32Array(6),
    } as any;

    const solver = GpuFoldSolver.create(model, renderer)!;
    expect(solver).not.toBeNull();
    expect(computeDt).toHaveBeenCalledWith(model);
    expect(packModel).toHaveBeenCalledWith(model, 0.4);

    solver.foldPercent = 0.75;
    solver.step(2);
    expect(computeCalls).toBe(2);

    solver.relax();
    expect(computeCalls).toBe(3);

    solver.resetSettle();
    solver.readInto(model);
    expect(Array.from(model.position)).toEqual([10, 11, 12, 20, 21, 22]);
  });

  it("returns null when GPU initialization fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    initError = "bad init";
    const { GpuFoldSolver } = await import("../../../src/sim/gpu/gpu-solver.js");

    const out = GpuFoldSolver.create(
      { numNodes: 1, params: { zeta: 0.4, kFace: 0.2 }, position: new Float32Array(3) } as any,
      { readRenderTargetPixels: vi.fn() } as any,
    );

    expect(out).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
