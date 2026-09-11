import { describe, expect, it } from "vitest";
import { KEYS, parseFkld, serializeFkld } from "@dayangac/fkld";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { DRIVEN_KEY, emitFkld } from "../../../src/pipeline/emit.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { placeSheet } from "../../../src/pipeline/route-seams.js";
import { seamedUnfold } from "../../../src/pipeline/unfold.js";
import { isFkld, type FoldFile } from "../../../src/model/fold-file.js";
import { isFoldable } from "../../../src/sim/fold-adapter.js";
import { buildScene, canSimulate } from "../../../src/sim/scene.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeCube, makeOctahedron, makeSaddleFan } from "./fixtures/targets.js";

function emitFor(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart", tuckSet: number[] = []) {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy });
  const unfold = seamedUnfold(mesh, topo, plan, defects);
  const sheet = placeSheet(unfold, { mesh, topo, defects });
  const fkld = emitFkld(sheet, {
    defects,
    target: mesh,
    topo,
    tuckSet,
    actions: plan.perVertexAction,
    strategy,
  });
  return { topo, defects, plan, unfold, sheet, fkld };
}

describe("emitFkld — cube", () => {
  const { sheet, fkld } = emitFor(makeCube());

  it("is FKLD, parallel arrays aligned, and round-trips through io", () => {
    expect(isFkld(fkld)).toBe(true);
    const nE = (fkld.edges_vertices as unknown[]).length;
    const nV = (fkld.vertices_coords as unknown[]).length;
    for (const key of [
      "edges_assignment",
      "edges_foldAngle",
      KEYS.edges.cutType,
      KEYS.edges.dihedralTarget,
      KEYS.edges.moleculeTheta,
      KEYS.edges.moleculeWidth,
    ]) {
      expect((fkld[key] as unknown[]).length).toBe(nE);
    }
    for (const key of [KEYS.vertices.angleDefect, KEYS.vertices.curvatureClass, KEYS.vertices.reliefStrategy, DRIVEN_KEY]) {
      expect((fkld[key] as unknown[]).length).toBe(nV);
    }
    const round = parseFkld(serializeFkld(fkld)) as FoldFile;
    expect(round).toEqual(JSON.parse(JSON.stringify(fkld)));
  });

  it("fold angles are degrees with the AKDE M+ convention", () => {
    const fa = fkld.edges_foldAngle as (number | null)[];
    const ea = fkld.edges_assignment as string[];
    for (let e = 0; e < ea.length; e++) {
      if (ea[e] === "M") expect(fa[e]!).toBeCloseTo(90, 6);
      if (ea[e] === "C" || ea[e] === "B") expect(fa[e]).toBeNull();
    }
  });

  it("loads in the sim/viewer path (isFoldable + buildScene)", () => {
    expect(isFoldable(fkld)).toBe(true);
    expect(canSimulate(fkld)).toBe(true);
    expect(buildScene(fkld)).not.toBeNull();
  });

  it("fkld:meta_architecture carries the placeSheet paper rectangle", () => {
    const meta = fkld[KEYS.meta.architecture] as { sheet: Record<string, number> };
    expect(meta.sheet).toEqual(sheet.sheetRect);
    expect(meta.sheet.marginMm).toBe(5);
  });

  it("carries the guided-fold contract: foldedForm goal frame + driven boundary", () => {
    const frames = fkld.file_frames as { frame_classes: string[]; vertices_coords: number[][] }[];
    expect(frames.length).toBe(1);
    expect(frames[0].frame_classes).toContain("foldedForm");
    const goal = frames[0].vertices_coords;
    expect(goal.length).toBe((fkld.vertices_coords as unknown[]).length);
    for (const g of goal) expect(g.length).toBe(3);
    // the goal frame is exactly the sheet's goalPos (folded-target positions)
    goal.forEach((g, i) => {
      expect(g[0]).toBeCloseTo(sheet.goalPos[i].x, 12);
      expect(g[1]).toBeCloseTo(sheet.goalPos[i].y, 12);
      expect(g[2]).toBeCloseTo(sheet.goalPos[i].z, 12);
    });
    // ... which for the (vent-free) cube are exactly Q vertices (±50 mm corners)
    for (const g of goal) for (const c of g) expect(Math.abs(c)).toBeCloseTo(50, 9);

    const driven = fkld[DRIVEN_KEY] as number[];
    // driven = every sheet-boundary vertex (lips + ∂Q) — the DETC forward
    // process; verification leans on strain + crease residuals (see emit.ts).
    const expected = new Set<number>();
    sheet.edges.forEach((e, i) => {
      if (sheet.assignment[i] === "C" || sheet.assignment[i] === "B") {
        expected.add(e.a);
        expected.add(e.b);
      }
    });
    driven.forEach((d, v) => expect(d).toBe(expected.has(v) ? 1 : 0));
    expect(driven.some((d) => d === 1)).toBe(true);
  });

  it("Σ source-distinct angle defects = 4π (Gauss–Bonnet through provenance)", () => {
    const defect = fkld[KEYS.vertices.angleDefect] as number[];
    const seen = new Map<number, number>(); // source vertex → defect
    (fkld[KEYS.vertices.curvatureClass] as string[]).forEach((_, i) => {
      if (sheetSource(i) >= 0) seen.set(sheetSource(i), defect[i]); // skip synthesized −1
    });
    const sum = [...seen.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(4 * Math.PI, 9);
  });

  const sheetSource = (i: number): number => sheet.origVertex[i];
});

describe("emitFkld — saddle fan (vents and synthesized vertices)", () => {
  const { sheet, fkld } = emitFor(makeSaddleFan());

  it("origVertex −1 vertices carry defect 0 / class 'boundary'; vent edges emitted as C/vent", () => {
    const defect = fkld[KEYS.vertices.angleDefect] as number[];
    const cls = fkld[KEYS.vertices.curvatureClass] as string[];
    const synthesized = sheet.origVertex
      .map((src, i) => ({ src, i }))
      .filter((x) => x.src === -1)
      .map((x) => x.i);
    expect(synthesized.length).toBeGreaterThanOrEqual(1); // the vent split point
    for (const i of synthesized) {
      expect(defect[i]).toBe(0);
      expect(cls[i]).toBe("boundary");
    }
    const cutTypes = fkld[KEYS.edges.cutType] as (string | null)[];
    expect(cutTypes.filter((c) => c === "vent").length).toBeGreaterThanOrEqual(1);
    expect(isFkld(fkld)).toBe(true);
  });

  it("driven flags follow the sheet-boundary rule (B or C edge endpoints)", () => {
    const driven = fkld[DRIVEN_KEY] as number[];
    const expected = new Set<number>();
    sheet.edges.forEach((e, i) => {
      if (sheet.assignment[i] === "C" || sheet.assignment[i] === "B") {
        expected.add(e.a);
        expected.add(e.b);
      }
    });
    driven.forEach((d, v) => expect(d).toBe(expected.has(v) ? 1 : 0));
  });
});

describe("emitFkld — tuck annotation (octahedron)", () => {
  it("tucked vertices carry θ = δ/deg and paired widths; validators pass", () => {
    // Cut with dart strategy so it unfolds, but annotate vertex 4 as a tuck —
    // a pure unit test of the metadata path (full tuck creases deferred).
    const octa = makeOctahedron();
    const { fkld, defects, topo } = emitFor(octa, "dart", [4]);
    const theta = fkld[KEYS.edges.moleculeTheta] as (number | null)[];
    const width = fkld[KEYS.edges.moleculeWidth] as (number | null)[];
    const expected = defects.defects[4] / topo.vertexEdges[4].length;
    let annotated = 0;
    for (let e = 0; e < theta.length; e++) {
      if (theta[e] !== null) {
        expect(theta[e]!).toBeCloseTo(expected, 12);
        expect(width[e]).not.toBeNull();
        annotated++;
      } else {
        expect(width[e]).toBeNull();
      }
    }
    expect(annotated).toBeGreaterThan(0);
  });
});
