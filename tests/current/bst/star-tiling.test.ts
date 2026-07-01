import { describe, it, expect } from "vitest";
import { scaleFactor, tileSpacing, buildTiling } from "../../../src/pipeline/bst/star-tiling.js";
import { DEFAULT_BST, type BstParams } from "../../../src/pipeline/bst/types.js";
import type { Vec2 } from "../../../src/pipeline/types.js";

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("BST star-tiling kinematics (Eq 1)", () => {
  it("square tiling (γ=1) max scale factor is √2 at θ: 0→π/2", () => {
    expect(scaleFactor(1, 0, Math.PI / 2)).toBeCloseTo(Math.SQRT2, 6);
  });

  it("star tiling (γ=√2) reaches scale up to 1+√2 as the paper states", () => {
    // contracted at α<0; deployed at β=π/2. With γ=√2 and α=−π/4 the ratio approaches 1+√2.
    const s = scaleFactor(Math.SQRT2, -Math.PI / 4, Math.PI / 2);
    expect(s).toBeGreaterThan(Math.SQRT2); // wider than a square kirigami
    expect(s).toBeCloseTo(1 + Math.SQRT2, 1);
  });

  it("tileSpacing matches the closed form and is monotonic in θ", () => {
    expect(tileSpacing(1, 0)).toBeCloseTo(Math.SQRT2, 6); // √(1+1+0)
    expect(tileSpacing(1, Math.PI / 2)).toBeCloseTo(2, 6); // √(1+1+2)
    expect(tileSpacing(1, Math.PI / 4)).toBeGreaterThan(tileSpacing(1, 0));
  });
});

describe("BST square tiling geometry", () => {
  const params: BstParams = { ...DEFAULT_BST, grid: { nx: 4, ny: 4 } };

  it("merges shared pivot corners (deduped vertex count < 4·tiles)", () => {
    const t = buildTiling(params, Math.PI / 3);
    expect(t.vertices.length).toBeLessThan(4 * params.grid.nx * params.grid.ny);
    expect(t.vertices.length).toBeGreaterThan(0);
  });

  it("tiles are rigid: every tile edge stays unit length across θ", () => {
    for (const theta of [0.2, Math.PI / 4, Math.PI / 3, (80 * Math.PI) / 180]) {
      const t = buildTiling(params, theta);
      for (const tile of t.tiles) {
        for (let k = 0; k < 4; k++) {
          const a = t.vertices[tile[k]], b = t.vertices[tile[(k + 1) % 4]];
          expect(dist(a, b)).toBeCloseTo(1, 4); // unit square side, invariant under θ
        }
      }
    }
  });

  it("expands auxetically: overall size grows by the scale factor as θ opens", () => {
    const bbox = (t: ReturnType<typeof buildTiling>): number => {
      let lo = Infinity, hi = -Infinity;
      for (const v of t.vertices) { lo = Math.min(lo, v.x); hi = Math.max(hi, v.x); }
      return hi - lo;
    };
    const closed = buildTiling(params, 0.02);
    const open = buildTiling(params, Math.PI / 2);
    // square-case lattice spacing grows by cos+sin: P(π/2)/P(0) = √2 (the auxetic isotropic expansion).
    expect(bbox(open) / bbox(closed)).toBeCloseTo(Math.SQRT2, 1);
  });
});
