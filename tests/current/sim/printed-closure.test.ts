import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyPrintedClosure,
  buildSceneFromFold,
  FoldRunner,
  ORIGAMI_PARAMS,
  PRINTED_PARAMS,
  printedThetaMax,
} from "../../../src/sim/index.js";
import { TILE_INSET_FRAC, TILE_THICK_FRAC } from "../../../src/model/tile-subdiv.js";
import { TILE_COLLIDE_SIGN } from "../../../src/sim/model.js";
import type { BarHingeModel } from "../../../src/sim/model.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

function loadExample(name: string): FoldFile {
  const url = new URL(`../../../public/examples/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FoldFile;
}

const printedModel = (name = "house.fkld"): BarHingeModel =>
  buildSceneFromFold(loadExample(name), PRINTED_PARAMS, { printed: true }).model;

/** Indices of the hinges between two tiles — the only ones the tile-collision limit applies to. */
function hinges(m: BarHingeModel): number[] {
  const c = m.creases;
  const out: number[] = [];
  for (let i = 0; i < c.count; i++) {
    if (c.seamPeer3 && c.seamPeer3[i] >= 0) continue;
    if (c.assignment[i] === "F") continue;
    out.push(i);
  }
  return out;
}

/**
 * The printed closure limit is a statement about the tiles that are drawn and printed, so these
 * check it against that geometry rather than against a fixed pair of millimetres. The bug they stand
 * against: every model's limit was 2·atan(1.0/1.2) = 79.6° whatever its tiles looked like, which cut
 * house.fkld's fold 12° short of the angles its pattern asks for while vinyl reached them exactly.
 */
describe("sim/printed closure follows the tiles", () => {
  it("reaches the pattern's own fold angles at the default gap, where the fixed 79.6° limit did not", () => {
    const m = printedModel();
    const c = m.creases;
    expect(c.designTheta).toBeDefined();
    let clipped = 0;
    for (let i = 0; i < c.count; i++) if (Math.abs(c.designTheta![i] - c.targetTheta[i]) > 1e-6) clipped++;
    expect(clipped).toBe(0);

    // The old constant clipped three of house's nine taped seams, which is where its 12° shortfall
    // against the vinyl fold came from: a seam is a joint in the tape, not two tiles pivoting apart,
    // so a tile-collision limit never applied to it in the first place.
    const fixed = printedThetaMax(1.0, 1.2);
    const wouldClip: number[] = [];
    for (let i = 0; i < c.count; i++) if (TILE_COLLIDE_SIGN * c.designTheta![i] > fixed) wouldClip.push(i);
    expect(wouldClip.length).toBeGreaterThan(0);
    expect(wouldClip.every((i) => c.seamPeer3![i] >= 0)).toBe(true);
  });

  it("θ_max = 2·atan(g/t) off the two tiles' inradii and the pattern's diagonal", () => {
    const m = printedModel();
    const c = m.creases;
    const r = m.rest;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.length; i += 3) {
      for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], r[i + d]); hi[d] = Math.max(hi[d], r[i + d]); }
    }
    const t = TILE_THICK_FRAC * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const inr = (a: number, b: number, cc: number): number => {
      const p = (n: number, d: number): number => r[3 * n + d];
      const u = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
      const v = [p(cc, 0) - p(a, 0), p(cc, 1) - p(a, 1), p(cc, 2) - p(a, 2)];
      const area2 = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      const peri = Math.hypot(...u) + Math.hypot(...v) + Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]);
      return area2 / peri;
    };
    for (const i of hinges(m)) {
      const g = TILE_INSET_FRAC * (inr(c.n3[i], c.n4[i], c.n1[i]) + inr(c.n3[i], c.n4[i], c.n2[i]));
      expect(c.thetaMax![i]).toBeCloseTo(2 * Math.atan(g / t), 5);
    }
  });

  it("a facet diagonal is one fused tile (θ_max 0) and a taped seam carries no tile limit", () => {
    const m = printedModel("puffin.fkld");
    const c = m.creases;
    let sawFacet = false, sawSeam = false;
    for (let i = 0; i < c.count; i++) {
      if (c.seamPeer3 && c.seamPeer3[i] >= 0) { expect(c.thetaMax![i]).toBeCloseTo(Math.PI, 6); sawSeam = true; }
      else if (c.assignment[i] === "F") { expect(c.thetaMax![i]).toBe(0); sawFacet = true; }
    }
    expect(sawFacet).toBe(true);
    expect(sawSeam).toBe(true);
  });

  it("a wider gap closes further, a narrower one less — and neither ratchets on re-application", () => {
    const m = printedModel();
    const c = m.creases;
    const at = (gapFrac: number): number[] => {
      applyPrintedClosure(m, { gapFrac, thickFrac: TILE_THICK_FRAC });
      return hinges(m).map((i) => c.thetaMax![i]);
    };
    const narrow = at(0.04);
    const wide = at(0.4);
    for (let k = 0; k < narrow.length; k++) expect(wide[k]).toBeGreaterThan(narrow[k]);

    // Going back to a narrow gap and out again returns the SAME limits and the SAME targets: the
    // clip is re-derived from the pattern's own angles, never from the already-clipped ones.
    const wideTargets = hinges(m).map((i) => c.targetTheta[i]);
    at(0.04);
    at(0.4);
    expect(hinges(m).map((i) => c.thetaMax![i])).toEqual(wide);
    expect(hinges(m).map((i) => c.targetTheta[i])).toEqual(wideTargets);
  });

  it("thicker tiles close less; targets stay clipped on the tile side only", () => {
    const m = printedModel();
    const c = m.creases;
    applyPrintedClosure(m, { gapFrac: TILE_INSET_FRAC, thickFrac: TILE_THICK_FRAC });
    const thin = hinges(m).map((i) => c.thetaMax![i]);
    applyPrintedClosure(m, { gapFrac: TILE_INSET_FRAC, thickFrac: 4 * TILE_THICK_FRAC });
    const thick = hinges(m).map((i) => c.thetaMax![i]);
    for (let k = 0; k < thin.length; k++) expect(thick[k]).toBeLessThan(thin[k]);

    // one-sided: nothing on the tile side exceeds its limit, and the fabric side is untouched
    let sawFreeSide = false;
    for (const i of hinges(m)) {
      expect(TILE_COLLIDE_SIGN * c.targetTheta[i]).toBeLessThanOrEqual(c.thetaMax![i] + 1e-4);
      if (c.targetTheta[i] === c.designTheta![i] && Math.abs(c.targetTheta[i]) > c.thetaMax![i] + 1e-4) sawFreeSide = true;
    }
    expect(sawFreeSide).toBe(true);
  });

  it("folds to the pattern's own angles as closely as the vinyl sheet does", { timeout: 60000 }, () => {
    const fold = loadExample("house.fkld");
    const worstError = (printed: boolean): number => {
      const scene = buildSceneFromFold(fold, printed ? PRINTED_PARAMS : ORIGAMI_PARAMS, { printed });
      const runner = new FoldRunner(scene.model, scene.solver);
      runner.setTarget(1);
      for (let i = 0; i < 2000 && !runner.settled(); i++) runner.frame();
      const c = scene.model.creases;
      let worst = 0;
      for (let i = 0; i < c.count; i++) worst = Math.max(worst, Math.abs(scene.solver.theta[i] - c.targetTheta[i]));
      return worst * (180 / Math.PI);
    };
    // Under the fixed 79.6° limit this landed 12.1° out against vinyl's 0.0°: the printed model
    // visibly stopped short of the fold the same pattern made in vinyl.
    expect(worstError(true)).toBeLessThan(worstError(false) + 1);
  });
});
