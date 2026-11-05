/**
 * Sheet connectivity: face labeling over shared edges.
 */

import { describe, expect, it } from "vitest";
import { labelComponents } from "../../../src/pipeline/sheet-components.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeGrid } from "./fixtures/targets.js";

const pts = (n: number): TriMesh["vertices"] => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0 }));

describe("labelComponents", () => {
  it("no faces: zero components", () => {
    expect(labelComponents({ vertices: [], faces: [] })).toEqual({ count: 0, label: [] });
  });

  it("faces sharing an edge join; labels number components by their lowest face", () => {
    // faces 1 and 3 share edge 4-5; faces 0 and 2 share edge 1-2.
    const faces: [number, number, number][] = [[0, 1, 2], [4, 5, 6], [2, 1, 3], [5, 4, 7]];
    expect(labelComponents({ vertices: pts(8), faces })).toEqual({ count: 2, label: [0, 1, 0, 1] });
  });

  it("faces meeting at a single vertex (bowtie) stay apart", () => {
    const faces: [number, number, number][] = [[0, 1, 2], [0, 3, 4]];
    expect(labelComponents({ vertices: pts(5), faces }).count).toBe(2);
  });

  it("a chain joined only through its last face is still one component", () => {
    // 0-1-2 and 6-5-8 only reach the rest through faces listed after them (edges 1-2, 3-4, 5-6).
    const faces: [number, number, number][] = [[0, 1, 2], [3, 4, 5], [6, 5, 8], [2, 1, 3], [3, 1, 4], [5, 4, 6]];
    expect(labelComponents({ vertices: pts(9), faces })).toEqual({ count: 1, label: [0, 0, 0, 0, 0, 0] });
  });

  it("a grid is one component", () => {
    const grid = makeGrid(4, 4);
    const { count, label } = labelComponents(grid);
    expect(count).toBe(1);
    expect(label.every((l) => l === 0)).toBe(true);
  });
});
