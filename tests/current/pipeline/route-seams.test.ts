import { describe, expect, it } from "vitest";
import { FLAT_EPS, angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { lipSubtype, placeSheet } from "../../../src/pipeline/route-seams.js";
import { seamedUnfold } from "../../../src/pipeline/unfold.js";
import type {
  DefectReport,
  MeshTopology,
  TriMesh,
  UnfoldResult,
} from "../../../src/pipeline/types.js";
import { makeCube, makeSaddleFan } from "./fixtures/targets.js";

function pipelineTo(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart") {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy });
  const unfold = seamedUnfold(mesh, topo, plan, defects);
  const sheet = placeSheet(unfold, { mesh, topo, defects });
  return { topo, defects, plan, unfold, sheet };
}

describe("placeSheet — cube", () => {
  it("carries all 12 faces; lips → C/dart; goal-pose fold targets on interior edges", () => {
    const cube = makeCube();
    const { sheet } = pipelineTo(cube);
    expect(sheet.faces.length).toBe(12);

    const cCount = sheet.assignment.filter((a) => a === "C").length;
    expect(cCount).toBe(14); // 7 cut edges × 2 lips
    for (let e = 0; e < sheet.edges.length; e++) {
      if (sheet.assignment[e] === "C") {
        expect(sheet.cutType[e]).toBe("dart"); // all cube tree vertices δ>0
        expect(sheet.foldAngle[e]).toBeNull();
      } else if (sheet.assignment[e] === "M") {
        expect(sheet.foldAngle[e]!).toBeCloseTo(Math.PI / 2, 9); // cube ridges (goal pose)
      } else if (sheet.assignment[e] === "F") {
        expect(Math.abs(sheet.foldAngle[e]!)).toBeLessThanOrEqual(FLAT_EPS); // face diagonals
      } else {
        expect(sheet.assignment[e]).not.toBe("V"); // a convex solid has no valleys
      }
    }
    // closed cube: no B edges (every boundary edge of the sheet is a lip)
    expect(sheet.assignment.filter((a) => a === "B").length).toBe(0);
    // edge counts: 5 fold ridges (M, uncut) + 6 diagonals (F) + 14 lips (C)
    expect(sheet.assignment.filter((a) => a === "M").length).toBe(5);
    expect(sheet.assignment.filter((a) => a === "F").length).toBe(6);
  });

  it("places the pattern inside its paper rectangle: bbox + 2×margin, all vertices ≥ margin", () => {
    const cube = makeCube();
    const { sheet } = pipelineTo(cube);
    const xs = sheet.vertices.map((p) => p.x);
    const ys = sheet.vertices.map((p) => p.y);
    const m = sheet.sheetRect.marginMm;
    expect(m).toBe(5); // default margin
    expect(Math.min(...xs)).toBeCloseTo(m, 9);
    expect(Math.min(...ys)).toBeCloseTo(m, 9);
    expect(sheet.sheetRect.widthMm).toBeCloseTo(Math.max(...xs) - Math.min(...xs) + 2 * m, 9);
    expect(sheet.sheetRect.heightMm).toBeCloseTo(Math.max(...ys) - Math.min(...ys) + 2 * m, 9);
    for (const p of sheet.vertices) {
      expect(p.x).toBeGreaterThanOrEqual(m - 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(m - 1e-9);
      expect(p.x).toBeLessThanOrEqual(sheet.sheetRect.widthMm - m + 1e-9);
      expect(p.y).toBeLessThanOrEqual(sheet.sheetRect.heightMm - m + 1e-9);
    }
    // goal frame provenance carried through placement
    expect(sheet.goalPos.length).toBe(sheet.vertices.length);
  });

  it("honors a custom margin", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    const defects = angleDefects(cube, topo);
    const plan = planCuts(cube, topo, defects, { lambda: 0, strategy: "dart" });
    const unfold = seamedUnfold(cube, topo, plan, defects);
    const sheet5 = placeSheet(unfold, { mesh: cube, topo, defects });
    const sheet12 = placeSheet(unfold, { mesh: cube, topo, defects }, 12);
    expect(sheet12.sheetRect.marginMm).toBe(12);
    expect(sheet12.sheetRect.widthMm).toBeCloseTo(sheet5.sheetRect.widthMm + 2 * 7, 9);
    expect(sheet12.sheetRect.heightMm).toBeCloseTo(sheet5.sheetRect.heightMm + 2 * 7, 9);
  });
});

describe("placeSheet — saddle fan", () => {
  it("single sheet: vent boundary tagged 'vent', surviving slit lips 'seam', ring stays B", () => {
    const saddle = makeSaddleFan();
    const { sheet, unfold } = pipelineTo(saddle);
    expect(unfold.patchCount).toBe(1);

    const cEdges = sheet.assignment
      .map((a, e) => ({ a, e }))
      .filter((x) => x.a === "C");
    expect(cEdges.length).toBeGreaterThanOrEqual(1);
    // every cut edge of a δ<0 relief is either the vent boundary or a sealing seam
    for (const { e } of cEdges) {
      expect(["vent", "seam"]).toContain(sheet.cutType[e]);
      expect(sheet.foldAngle[e]).toBeNull();
    }
    // the K1 vent boundary is present and tagged
    expect(sheet.cutType.filter((c) => c === "vent").length).toBeGreaterThanOrEqual(1);
    // surviving slit lips (a vent may have consumed one pair) classify as seam
    const lipEdgeKeys = new Set<string>();
    for (const lip of sheet.lips) {
      lipEdgeKeys.add(edgeKey(lip.lipA[0], lip.lipA[1]));
      lipEdgeKeys.add(edgeKey(lip.lipB[0], lip.lipB[1]));
    }
    sheet.edges.forEach((edge, e) => {
      if (lipEdgeKeys.has(edgeKey(edge.a, edge.b))) expect(sheet.cutType[e]).toBe("seam");
    });
    // outer ring (∂Q) stays B
    expect(sheet.assignment.filter((a) => a === "B").length).toBeGreaterThanOrEqual(1);
  });
});

describe("lipSubtype — the deterministic mapping", () => {
  const syntheticTopo = (a: number, b: number): MeshTopology =>
    ({
      edges: [{ a, b, faces: [0, 1] }],
      edgeIndex: new Map([[edgeKey(a, b), 0]]),
      vertexFaces: [],
      vertexEdges: [],
      boundaryVertices: new Set(),
    }) as unknown as MeshTopology;
  const report = (defects: number[]): DefectReport =>
    ({
      defects,
      classes: defects.map((d) => (d > FLAT_EPS ? "positive" : d < -FLAT_EPS ? "negative" : "flat")),
      totalDefect: 0,
    }) as DefectReport;

  it("a δ>0 endpoint → dart; flat or negative endpoints → seam", () => {
    expect(lipSubtype(syntheticTopo(0, 1), report([0.8, 0]), 0)).toBe("dart");
    expect(lipSubtype(syntheticTopo(0, 1), report([-0.5, 0.8]), 0)).toBe("dart"); // dart endpoint wins
    expect(lipSubtype(syntheticTopo(0, 1), report([0, 0]), 0)).toBe("seam");
    expect(lipSubtype(syntheticTopo(0, 1), report([-0.5, 0]), 0)).toBe("seam"); // zero-width slit seals
    expect(lipSubtype(syntheticTopo(0, 1), report([-0.5, -0.3]), 0)).toBe("seam");
  });
});

describe("placeSheet — single-sheet gate", () => {
  it("throws on a multi-patch unfold (proper kirigami is one connected sheet)", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    const defects = angleDefects(cube, topo);
    const fake: UnfoldResult = {
      flat: [],
      faces: [],
      patchOfFace: [],
      patchCount: 2,
      origVertex: [],
      goalPos: [],
      lips: [],
      vents: [],
      reliefEdges: [],
      reliefPruned: 0,
      totalCutLength: 0,
    };
    expect(() => placeSheet(fake, { mesh: cube, topo, defects })).toThrow(/one connected sheet/);
  });
});

describe("sheet isometry survives placement", () => {
  it("translation only: every sheet edge keeps its flat length", () => {
    const saddle = makeSaddleFan();
    const { unfold, sheet } = pipelineTo(saddle);
    for (const e of sheet.edges) {
      const flatLen = Math.hypot(
        unfold.flat[e.a].x - unfold.flat[e.b].x,
        unfold.flat[e.a].y - unfold.flat[e.b].y,
      );
      const sheetLen = Math.hypot(
        sheet.vertices[e.a].x - sheet.vertices[e.b].x,
        sheet.vertices[e.a].y - sheet.vertices[e.b].y,
      );
      expect(sheetLen).toBeCloseTo(flatLen, 9);
    }
  });
});
