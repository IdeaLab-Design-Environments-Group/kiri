/**
 * Shared fold-adaptive tile subdivision — the single source the STL export and the 3D-printed sim
 * render both use, so what you see matches what you print.
 */
import { describe, it, expect } from "vitest";
import {
  fitDepths,
  foldDepths,
  planSubTiles,
  subdivBary,
  DEFAULT_MAX_SUBDIV,
  MIN_FOLD,
} from "../../../src/model/tile-subdiv.js";

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

  it("the default detail level leaves every face a single tile — the base layout", () => {
    // The sample designs are read against one tile per face, with gaps only where the pattern has a
    // joint. The slider adds tiles from there; it must not start out having already split anything.
    expect(DEFAULT_MAX_SUBDIV).toBe(0);
    expect(foldDepths([1, 0.9, 0.2], DEFAULT_MAX_SUBDIV)).toEqual([0, 0, 0]);
  });
});

describe("tile-subdiv: fitDepths", () => {
  it("keeps the asked-for cap when the plan fits the budget", () => {
    expect(fitDepths([1, 0.5, 0], 2, 1000)).toEqual(foldDepths([1, 0.5, 0], 2));
  });

  it("steps the cap down until the plan fits, rather than returning a plan that does not", () => {
    // 200 faces all folding equally: cap 3 asks for 200·64 tiles, cap 2 for 200·16, cap 1 for 800.
    const scores = new Array(200).fill(1);
    const depths = fitDepths(scores, 3, 1000);
    expect(depths.every((d) => d === 1)).toBe(true);
    expect(depths.reduce((n, d) => n + 4 ** d, 0)).toBeLessThanOrEqual(1000);
  });

  it("falls back to no subdivision when even one level over-runs the budget", () => {
    expect(fitDepths(new Array(100).fill(1), 4, 10)).toEqual(new Array(100).fill(0));
  });
});

describe("tile-subdiv: planSubTiles", () => {
  const flat: [boolean, boolean, boolean] = [true, true, true];

  it("paves a hard-folding face with 4^depth tiles and leaves a flat one whole", () => {
    const { depths, tiles } = planSubTiles([1, 0], [flat, flat], 2);
    expect(depths).toEqual([2, 0]);
    expect(tiles.filter((t) => t.face === 0)).toHaveLength(16);
    expect(tiles.filter((t) => t.face === 1)).toHaveLength(1);
  });

  it("the default level leaves every face a single tile carrying the parent's own gap flags", () => {
    const parent: [boolean, boolean, boolean] = [true, false, true];
    const { tiles } = planSubTiles([1], [parent], DEFAULT_MAX_SUBDIV);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].bary).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(tiles[0].pinch).toEqual(parent);
  });

  it("a sub-edge on the parent's boundary inherits that edge's flag", () => {
    // Only edge AB (index 0) of the parent opens a gap; BC and CA are merged flat facets.
    const { tiles } = planSubTiles([1], [[true, false, false]], 1);
    const onAB = (t: { bary: number[][] }, k: number): boolean =>
      t.bary[k][2] === 0 && t.bary[(k + 1) % 3][2] === 0;
    const onBC = (t: { bary: number[][] }, k: number): boolean =>
      t.bary[k][0] === 0 && t.bary[(k + 1) % 3][0] === 0;
    for (const t of tiles) {
      for (let k = 0; k < 3; k++) {
        if (onAB(t, k)) expect(t.pinch[k]).toBe(true);
        if (onBC(t, k)) expect(t.pinch[k]).toBe(false); // the merged facet stays merged after the split
      }
    }
  });

  it("opens a gap on every sub-edge interior to the face — that is what the split buys", () => {
    // With NO parent edge opening a gap, any true flag can only be an interior sub-edge.
    const { tiles } = planSubTiles([1], [[false, false, false]], 1);
    const middle = tiles.find((t) => t.pinch.every((p) => p));
    expect(middle, "the centre sub-tile touches no parent edge, so all three of its edges are joints")
      .toBeDefined();
    expect(tiles.some((t) => t.pinch.some((p) => !p))).toBe(true); // corner tiles still touch the boundary
  });

  it("keeps every corner inside the parent triangle", () => {
    const { tiles } = planSubTiles([1, 0.4], [flat, flat], 3);
    for (const t of tiles) {
      for (const w of t.bary) {
        expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 10);
        for (const c of w) expect(c).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
