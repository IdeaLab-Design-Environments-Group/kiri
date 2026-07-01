/**
 * Shared fold-adaptive tile subdivision — the single source the STL export and the 3D-printed sim
 * render both use, so what you see matches what you print.
 */
import { describe, it, expect } from "vitest";
import { foldDepths, subdivBary, DEFAULT_MAX_SUBDIV, MIN_FOLD } from "../../../src/model/tile-subdiv.js";

describe("tile-subdiv: subdivBary", () => {
  it("produces 4^depth sub-triangles", () => {
    expect(subdivBary(0)).toHaveLength(1);
    expect(subdivBary(1)).toHaveLength(4);
    expect(subdivBary(2)).toHaveLength(16);
    expect(subdivBary(3)).toHaveLength(64);
  });

  it("returns valid barycentric weights (each corner sums to 1, all ≥ 0)", () => {
    for (const tri of subdivBary(2)) {
      for (const w of tri) {
        expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 10);
        for (const c of w) expect(c).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("depth 0 is the identity triangle (the three pure corners)", () => {
    expect(subdivBary(0)).toEqual([[[1, 0, 0], [0, 1, 0], [0, 0, 1]]]);
  });
});

describe("tile-subdiv: foldDepths", () => {
  it("gives more depth to harder-folding faces, normalised to the sharpest fold", () => {
    // peak = 1.0 → ratios 1.0/0.5/0.0 at cap 2 → depths 2/1/0
    expect(foldDepths([1.0, 0.5, 0.0], 2)).toEqual([2, 1, 0]);
  });

  it("cap 0 (or negative) → no subdivision anywhere", () => {
    expect(foldDepths([2, 1, 0.3], 0)).toEqual([0, 0, 0]);
  });

  it("an essentially-flat model (peak < MIN_FOLD) → no subdivision", () => {
    expect(foldDepths([MIN_FOLD / 2, 0, 0], 4)).toEqual([0, 0, 0]);
  });

  it("scales with the cap on the sharpest face", () => {
    expect(foldDepths([1, 0], 1)[0]).toBe(1);
    expect(foldDepths([1, 0], 3)[0]).toBe(3);
  });

  it("DEFAULT_MAX_SUBDIV is the shared default detail LEVEL (0 → 2 subdivisions via DETAIL_OFFSET)", () => {
    expect(DEFAULT_MAX_SUBDIV).toBe(0);
  });
});
