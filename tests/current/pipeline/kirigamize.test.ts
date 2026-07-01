import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  condition: vi.fn(),
  assertGenusZero: vi.fn(),
  cutHandles: vi.fn(),
  angleDefects: vi.fn(),
  emitFkld: vi.fn(),
  parseMesh: vi.fn(),
  buildTopology: vi.fn(),
  planCuts: vi.fn(),
  placeSheet: vi.fn(),
  seamedUnfold: vi.fn(),
  verifyFold: vi.fn(),
}));

vi.mock("../../../src/pipeline/conditioning.js", () => ({
  condition: mocks.condition,
  assertGenusZero: mocks.assertGenusZero,
}));

vi.mock("../../../src/pipeline/handle-cut.js", () => ({
  cutHandles: mocks.cutHandles,
}));

vi.mock("../../../src/pipeline/curvature.js", () => ({
  angleDefects: mocks.angleDefects,
}));

vi.mock("../../../src/pipeline/emit.js", () => ({
  emitFkld: mocks.emitFkld,
}));

vi.mock("../../../src/pipeline/import.js", () => ({
  parseMesh: mocks.parseMesh,
}));

vi.mock("../../../src/pipeline/mesh.js", () => ({
  buildTopology: mocks.buildTopology,
}));

vi.mock("../../../src/pipeline/plan-cuts.js", () => ({
  planCuts: mocks.planCuts,
}));

vi.mock("../../../src/pipeline/route-seams.js", () => ({
  placeSheet: mocks.placeSheet,
}));

vi.mock("../../../src/pipeline/unfold.js", () => ({
  seamedUnfold: mocks.seamedUnfold,
}));

vi.mock("../../../src/pipeline/verify.js", () => ({
  DEFAULT_VERIFY: { epsilonRel: 0.02, iterations: 10 },
  verifyFold: mocks.verifyFold,
}));

import { kirigamize, kirigamizeText } from "../../../src/pipeline/kirigamize.js";

const mesh = {
  vertices: Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2, z: i * 3 })),
  faces: [[0, 0, 0]],
};

const topo = {
  edges: [],
  edgeIndex: new Map(),
  vertexFaces: [],
  vertexEdges: [],
  boundaryVertices: new Set(),
};

const defects = {
  defects: [],
  classes: [],
  totalDefect: 0,
};

function makePlan(label: number) {
  return {
    cutEdges: [label],
    perVertexAction: ["none"],
    cost: { length: label, visibility: 0, lambda: 0 },
  };
}

function makeUnfold(sourceVertex: number) {
  return {
    flat: [],
    faces: [],
    patchOfFace: [],
    patchCount: 1,
    origVertex: [sourceVertex],
    goalPos: Array.from({ length: 50 }, (_, i) => ({ x: i + 0.5, y: i * 2 + 0.5, z: i * 3 + 0.5 })),
    lips: [],
    vents: [{
      sourceVertex,
      angle: 0.25,
      ventEdges: [[0, 0] as [number, number]],
    }],
    reliefEdges: [],
    reliefPruned: 0,
    totalCutLength: 0,
  };
}

function makeSheet(sourceVertex: number) {
  return {
    vertices: [],
    faces: [],
    edges: [],
    assignment: [],
    foldAngle: [],
    cutType: [],
    origVertex: [sourceVertex],
    goalPos: [{ x: 1, y: 2, z: 3 }],
    lips: [],
    vents: [],
    patchOfFace: [],
    sheetRect: { widthMm: 10, heightMm: 10, marginMm: 1 },
  };
}

function makeReport({
  dH,
  converged,
  worstSourceVertex = 0,
}: {
  dH: number;
  converged: boolean;
  worstSourceVertex?: number;
}) {
  const foldFromFlat = {
    dH,
    dHRel: dH / 100,
    meanStrain: 0.01,
    maxStrain: 0.02,
    creaseResidual: 0.03,
    iterations: 10,
    settled: converged,
    pathStrain: 0.04,
  };
  return {
    converged,
    epsilon: 1,
    foldFromFlat,
    equilibrium: foldFromFlat,
    worstSourceVertex,
  };
}

describe("pipeline/kirigamize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.condition.mockReturnValue({ mesh, reports: [{ pass: "weld", changed: 0 }] });
    mocks.cutHandles.mockReturnValue({ mesh, report: { pass: "handle-cut", changed: 0 } });
    mocks.buildTopology.mockReturnValue(topo);
    mocks.angleDefects.mockReturnValue(defects);
    mocks.planCuts.mockReturnValue(makePlan(1));
    mocks.seamedUnfold.mockReturnValue(makeUnfold(3));
    mocks.placeSheet.mockReturnValue(makeSheet(3));
    mocks.emitFkld.mockReturnValue({ file_creator: "Kiro" });
    mocks.parseMesh.mockReturnValue(mesh);
    mocks.verifyFold.mockReturnValue(makeReport({ dH: 0.5, converged: true, worstSourceVertex: 3 }));
  });

  it("skips verification entirely when verify=false", () => {
    const result = kirigamize(mesh as any, { verify: false });

    expect(result.report).toBeNull();
    expect(mocks.verifyFold).not.toHaveBeenCalled();
    expect(mocks.planCuts).toHaveBeenCalledWith(mesh, topo, defects, expect.objectContaining({
      extraTerminals: [],
      strategy: "dart",
    }));
  });

  it("returns a single-attempt report when the first verification converges", () => {
    const result = kirigamize(mesh as any, { verify: true, iterations: 12, epsilonRel: 0.05 });

    expect(mocks.verifyFold).toHaveBeenCalledTimes(1);
    expect(mocks.verifyFold.mock.calls[0]![2]).toMatchObject({
      epsilonRel: 0.05,
      iterations: 12,
      vents: [{ center: mesh.vertices[3], radiusMm: expect.any(Number) }],
    });
    expect(result.report).toMatchObject({
      converged: true,
      attempts: 1,
    });
  });

  it("uses the longer verification budget as attempt 2 when it improves dH", () => {
    mocks.verifyFold
      .mockReturnValueOnce(makeReport({ dH: 4, converged: false, worstSourceVertex: 7 }))
      .mockReturnValueOnce(makeReport({ dH: 2, converged: true, worstSourceVertex: 7 }));

    const result = kirigamize(mesh as any, { verify: true, iterations: 11 });

    expect(mocks.verifyFold).toHaveBeenCalledTimes(2);
    expect(mocks.verifyFold.mock.calls[0]![2]).toMatchObject({ iterations: 11 });
    expect(mocks.verifyFold.mock.calls[1]![2]).toMatchObject({ iterations: 33 });
    expect(result.report).toMatchObject({
      converged: true,
      attempts: 2,
      foldFromFlat: expect.objectContaining({ dH: 2 }),
    });
  });

  it("replans around the worst source vertex on attempt 3 and adopts the better retry", () => {
    mocks.planCuts
      .mockReturnValueOnce(makePlan(1))
      .mockReturnValueOnce(makePlan(9));
    mocks.seamedUnfold
      .mockReturnValueOnce(makeUnfold(3))
      .mockReturnValueOnce(makeUnfold(8));
    mocks.placeSheet
      .mockReturnValueOnce(makeSheet(3))
      .mockReturnValueOnce(makeSheet(8));
    mocks.emitFkld
      .mockReturnValueOnce({ file_creator: "Kiro", frame_title: "first" })
      .mockReturnValueOnce({ file_creator: "Kiro", frame_title: "retry" });
    mocks.verifyFold
      .mockReturnValueOnce(makeReport({ dH: 5, converged: false, worstSourceVertex: 42 }))
      .mockReturnValueOnce(makeReport({ dH: 6, converged: false, worstSourceVertex: 42 }))
      .mockReturnValueOnce(makeReport({ dH: 1, converged: true, worstSourceVertex: 42 }));

    const result = kirigamize(mesh as any, { verify: true, iterations: 9 });

    expect(mocks.planCuts).toHaveBeenCalledTimes(2);
    expect(mocks.planCuts.mock.calls[0]![3]).toMatchObject({ extraTerminals: [] });
    expect(mocks.planCuts.mock.calls[1]![3]).toMatchObject({ extraTerminals: [42] });
    expect(mocks.verifyFold).toHaveBeenCalledTimes(3);
    expect(result.plan.cutEdges).toEqual([9]);
    expect(result.fkld.frame_title).toBe("retry");
    expect(result.report).toMatchObject({
      converged: true,
      attempts: 3,
      foldFromFlat: expect.objectContaining({ dH: 1 }),
    });
  });

  it("parses text input before delegating to the main pipeline", () => {
    const result = kirigamizeText("solid test", "stl", { verify: false });

    expect(mocks.parseMesh).toHaveBeenCalledWith("solid test", "stl");
    expect(result.fkld.file_creator).toBe("Kiro");
  });
});
