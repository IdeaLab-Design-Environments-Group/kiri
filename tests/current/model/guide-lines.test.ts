import { describe, expect, it } from "vitest";
import { centreLines, GUIDE_KEY, guideSegments } from "../../../src/model/guide-lines.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const square: FoldFile = {
  vertices_coords: [[0, 0], [4, 0], [4, 2], [0, 2]],
  edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]],
};

describe("model/guide-lines", () => {
  it("reads the flagged edges as segments", () => {
    const fold = { ...square, [GUIDE_KEY]: [false, false, false, false, true] };
    expect(guideSegments(fold)).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 2 }]]);
  });

  it("returns nothing without flags, or with flags that are not true", () => {
    expect(guideSegments(square)).toEqual([]);
    expect(guideSegments({ ...square, [GUIDE_KEY]: "yes" })).toEqual([]);
    expect(guideSegments({ ...square, [GUIDE_KEY]: [1, "true", null, 0, false] })).toEqual([]);
  });

  it("skips a flagged edge whose vertices are missing", () => {
    const fold = { ...square, edges_vertices: [[0, 9]] as [number, number][], [GUIDE_KEY]: [true] };
    expect(guideSegments(fold)).toEqual([]);
  });

  it("crosses the middle of the bounding box", () => {
    const polys = [[{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 3 }], [{ x: 2, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 4 }]];
    expect(centreLines(polys)).toEqual([
      [{ x: 4, y: 1 }, { x: 4, y: 5 }],
      [{ x: 2, y: 3 }, { x: 6, y: 3 }],
    ]);
  });

  it("draws no centre lines for nothing, or for a pattern with no area", () => {
    expect(centreLines([])).toEqual([]);
    expect(centreLines([[{ x: 0, y: 1 }, { x: 5, y: 1 }]])).toEqual([]);
  });
});
