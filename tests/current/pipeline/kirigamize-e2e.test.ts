/**
 * The integration gate: full pipeline (condition → plan → unfold+vents →
 * place → emit → verify) on the acceptance targets, under proper-kirigami
 * semantics. The simulator is the oracle and the primary gate is
 * FOLD-FROM-FLAT: the sheet starts at the flat rest pose and must travel the
 * whole fold path (phase A kinematic transport with a tensile path-strain
 * audit, phase B release-and-settle stability), Kabsch-aligned d_H ≤ ε with
 * declared vent holes excluded from coverage (open kirigami). The
 * equilibrium mode is reported as a secondary metric.
 */
import { describe, expect, it } from "vitest";
import { kirigamize, kirigamizeText } from "../../../src/pipeline/kirigamize.js";
import { PipelineError } from "../../../src/pipeline/types.js";
import {
  makeCube,
  makeEnneper,
  makeOctahedron,
  makePyramid,
  makeSaddleFan,
  makeSaddleRoof,
  makeTent,
  toAsciiStl,
} from "./fixtures/targets.js";

const E2E = { timeout: 180_000 };

function expectConverged(result: ReturnType<typeof kirigamize>, label: string): void {
  const r = result.report!;
  const fff = r.foldFromFlat;
  expect(
    r.converged,
    `${label}: dH=${fff.dH.toFixed(3)}mm ε=${r.epsilon.toFixed(3)}mm strain=${fff.meanStrain.toFixed(4)} ` +
      `pathStrain=${(fff.pathStrain ?? 0).toFixed(4)} res=${fff.creaseResidual.toFixed(4)} attempts=${r.attempts}`,
  ).toBe(true);
  expect(fff.dHRel).toBeLessThanOrEqual(0.05);
  // single connected sheet, always
  expect(result.unfold.patchCount).toBe(1);
}

describe("kirigamize end-to-end (proper kirigami, fold-from-flat as oracle)", () => {
  it("cube: classic 7-cut net, no vents", E2E, () => {
    const result = kirigamize(makeCube(), { verify: true });
    expect(result.plan.cutEdges.length).toBe(7); // spanning-tree floor
    expect(result.unfold.vents.length).toBe(0);
    expectConverged(result, "cube");
  });

  it("open pyramid: a single slit, no vents", E2E, () => {
    const result = kirigamize(makePyramid(4, 50, 30), { verify: true });
    expect(result.plan.cutEdges.length).toBe(1);
    expect(result.unfold.vents.length).toBe(0);
    expectConverged(result, "openPyr");
  });

  it("closed pyramid via STL text: minimal cuts (frame-map regression)", E2E, () => {
    const L = 100;
    const H = 70.7;
    const A = { x: L / 2, y: L / 2, z: H };
    const c = [
      { x: 0, y: 0, z: 0 },
      { x: L, y: 0, z: 0 },
      { x: L, y: L, z: 0 },
      { x: 0, y: L, z: 0 },
    ];
    const closed = {
      vertices: [c[0], c[1], c[2], c[3], A],
      faces: [
        [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4],
        [0, 2, 1], [0, 3, 2],
      ] as [number, number, number][],
    };
    const result = kirigamizeText(toAsciiStl(closed), "stl", { verify: true });
    expect(result.plan.cutEdges.length).toBe(4); // V−1 spanning tree of 5 defect vertices
    expect(result.unfold.reliefEdges.length).toBe(0);
    expectConverged(result, "closedPyr");
  });

  it("tent: no cuts; free ridge transported and held (two-phase fold)", E2E, () => {
    const result = kirigamize(makeTent(), { verify: true });
    expect(result.plan.cutEdges.length).toBe(0);
    expect(result.unfold.vents.length).toBe(0);
    expectConverged(result, "tent");
  });

  it("saddle fan (acceptance): ONE sheet, one slit + one vent", E2E, () => {
    const result = kirigamize(makeSaddleFan(), { verify: true });
    expect(result.unfold.vents.length).toBe(1);
    expect(result.sheet.cutType.filter((t) => t === "vent").length).toBeGreaterThan(0);
    expectConverged(result, "saddleFan");
  });

  it("saddle roof (acceptance): single vented sheet folds from flat", E2E, () => {
    const result = kirigamize(makeSaddleRoof(), { verify: true });
    expect(result.unfold.vents.length).toBeGreaterThanOrEqual(7); // 9 δ<0 vertices (dynamic excess may merge a few)
    expectConverged(result, "saddleRoof");
  });

  it("Enneper patch (acceptance): single vented sheet folds from flat", E2E, () => {
    const result = kirigamize(makeEnneper(), { verify: true });
    expect(result.unfold.vents.length).toBeGreaterThanOrEqual(7);
    expectConverged(result, "enneper");
  });

  it("tuck-all on a non-developable target throws the honest deferral error", () => {
    expect(() => kirigamize(makeOctahedron(), { strategy: "tuck-all", verify: false })).toThrow(
      /tuck-all.*deferred/,
    );
    try {
      kirigamize(makeOctahedron(), { strategy: "tuck-all", verify: false });
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as PipelineError).stage).toBe("unfold");
    }
  });

  it("verify:false emits the pattern without a report", () => {
    const result = kirigamize(makeCube(), { verify: false });
    expect(result.report).toBeNull();
    expect(result.fkld.file_creator).toBe("Kiro");
    expect(result.plan.cutEdges.length).toBe(7);
  });
});
