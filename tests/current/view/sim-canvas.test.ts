import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gpuCreate = vi.fn();
const kineticDamp = vi.fn((model, prev) => prev);
const removeRigidBodyMotion = vi.fn();

class MockOrbitControls {
  target = { set: vi.fn() };
  enableDamping = false;
  update = vi.fn();
  dispose = vi.fn();
  constructor(public camera: any, public domElement: any) {}
}

class MockObject3D {
  children: any[] = [];
  position = { set: vi.fn() };
  add = vi.fn((...items: any[]) => {
    this.children.push(...items);
  });
  clear = vi.fn(() => {
    this.children = [];
  });
}

class MockScene extends MockObject3D {
  background: any = null;
}

class MockGroup extends MockObject3D {}

class MockPerspectiveCamera {
  position = { set: vi.fn() };
  up = { set: vi.fn() };
  aspect: number;
  near: number;
  far: number;
  updateProjectionMatrix = vi.fn();
  constructor(_fov: number, aspect: number, near: number, far: number) {
    this.aspect = aspect;
    this.near = near;
    this.far = far;
  }
}

class MockOrthographicCamera {
  position = { set: vi.fn() };
  up = { set: vi.fn() };
  left = 0; right = 0; top = 0; bottom = 0; near = 0; far = 0;
  lookAt = vi.fn();
  updateProjectionMatrix = vi.fn();
}

class MockWebGLRenderer {
  domElement = {
    remove: vi.fn(),
    addEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
  setSize = vi.fn();
  setPixelRatio = vi.fn();
  setClearColor = vi.fn();
  render = vi.fn();
  dispose = vi.fn();
}

class MockBufferAttribute {
  needsUpdate = false;
  usage: any = null;
  constructor(public array: Float32Array, public itemSize: number) {}
  setUsage(usage: any) {
    this.usage = usage;
  }
}

class MockBufferGeometry {
  attributes = new Map<string, any>();
  index: any = null;
  setAttribute = vi.fn((name: string, value: any) => {
    this.attributes.set(name, value);
  });
  setIndex = vi.fn((value: any) => {
    this.index = value;
  });
  computeVertexNormals = vi.fn();
  dispose = vi.fn();
}

class MockMaterial {
  constructor(public options: any) {}
}

class MockMesh {
  constructor(public geometry: any, public material: any) {}
}

class MockLineSegments {
  constructor(public geometry: any, public material: any) {}
}

class MockLight extends MockObject3D {
  constructor(public color: any, public intensity: any) {
    super();
  }
}

class MockColor {
  constructor(public value: any) {}
}

vi.mock("three", () => ({
  Scene: MockScene,
  PerspectiveCamera: MockPerspectiveCamera,
  OrthographicCamera: MockOrthographicCamera,
  WebGLRenderer: MockWebGLRenderer,
  Group: MockGroup,
  AmbientLight: MockLight,
  DirectionalLight: MockLight,
  BufferAttribute: MockBufferAttribute,
  BufferGeometry: MockBufferGeometry,
  MeshStandardMaterial: MockMaterial,
  LineBasicMaterial: MockMaterial,
  Mesh: MockMesh,
  LineSegments: MockLineSegments,
  Color: MockColor,
  DynamicDrawUsage: "dynamic",
  DoubleSide: "double",
}));

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: MockOrbitControls,
}));

vi.mock("../../../src/sim/index.js", async () => {
  const actual = await vi.importActual<any>("../../../src/sim/index.js");
  return {
    ...actual,
    kineticDamp,
    removeRigidBodyMotion,
  };
});

vi.mock("../../../src/sim/gpu/index.js", () => ({
  GpuFoldSolver: {
    create: gpuCreate,
  },
}));

function makeScene({ driven = false }: { driven?: boolean } = {}) {
  const position = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  const model = {
    position,
    velocity: new Float32Array(position.length),
    driven: new Uint8Array(driven ? [1, 0, 0] : [0, 0, 0]),
  } as any;
  const solver = { foldPercent: 0, step: vi.fn(), enableCollision: vi.fn() } as any;
  return {
    net: {
      faces: [[0, 1, 2]],
      edges: [
        { a: 0, b: 1, assignment: "M", faces: [0, 1] },
        { a: 1, b: 2, assignment: "B", faces: [0] },
      ],
      meta: { s: 10, H: 8, rApex: 1 },
    },
    model,
    solver,
  } as any;
}

describe("view/sim-canvas", () => {
  const raf = vi.fn();

  beforeEach(() => {
    gpuCreate.mockReset();
    kineticDamp.mockClear();
    removeRigidBodyMotion.mockClear();
    (globalThis as any).window = { devicePixelRatio: 2 };
    (globalThis as any).requestAnimationFrame = raf;
    raf.mockReset();
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).requestAnimationFrame;
  });

  it("uses the CPU solver for guided and free scenes", { timeout: 15000 }, async () => {
    const { SimCanvas } = await import("../../../src/view/sim-canvas.js");
    const container = {
      clientWidth: 500,
      clientHeight: 400,
      appendChild: vi.fn(),
    } as any;
    const canvas = new SimCanvas(container);

    canvas.setScene(makeScene({ driven: true }));
    expect(canvas.backend()).toBe("cpu");

    canvas.setScene(makeScene({ driven: false }));
    expect(canvas.backend()).toBe("cpu");
  });

  it("updates fold target, resizes, starts, stops, and disposes renderer resources", async () => {
    const { SimCanvas } = await import("../../../src/view/sim-canvas.js");
    const container = {
      clientWidth: 480,
      clientHeight: 360,
      appendChild: vi.fn(),
    } as any;
    const canvas = new SimCanvas(container);
    const scene = makeScene({ driven: false });
    gpuCreate.mockReturnValueOnce(null);
    canvas.setScene(scene);

    canvas.setFoldPercent(0.25);
    expect(canvas.getFoldPercent()).toBe(0.25);

    canvas.resize(800, 600);
    const renderer = (canvas as any).renderer as MockWebGLRenderer;
    expect(renderer.setSize).toHaveBeenCalledWith(800, 600);

    canvas.start();
    expect(raf).toHaveBeenCalled();
    canvas.stop();

    canvas.dispose();
    expect(renderer.dispose).toHaveBeenCalled();
    expect(renderer.domElement.remove).toHaveBeenCalled();
  });

  it("advances CPU folds and calls settle helpers during animation frames", async () => {
    const { SimCanvas } = await import("../../../src/view/sim-canvas.js");
    const container = {
      clientWidth: 400,
      clientHeight: 300,
      appendChild: vi.fn(),
    } as any;
    const canvas = new SimCanvas(container);
    const scene = makeScene({ driven: false });
    gpuCreate.mockReturnValueOnce(null);
    canvas.setScene(scene);
    canvas.setFoldPercent(1);
    canvas.start();

    const loop = raf.mock.calls[0]?.[0] as (() => void) | undefined;
    expect(loop).toBeTypeOf("function");
    loop?.();

    expect(scene.solver.step).toHaveBeenCalled();
    expect(removeRigidBodyMotion).toHaveBeenCalled();
  });
});
