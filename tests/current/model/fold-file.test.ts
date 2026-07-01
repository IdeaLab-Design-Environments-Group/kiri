import { describe, expect, it } from "vitest";
import { isFkld, type FoldFile } from "../../../src/model/fold-file.js";

describe("model/fold-file", () => {
  it("detects FKLD files by namespace-prefixed keys", () => {
    const fold: FoldFile = {
      vertices_coords: [[0, 0]],
      "fkld:edges_cutType": ["major"],
    };
    expect(isFkld(fold)).toBe(true);
  });

  it("returns false for plain FOLD objects", () => {
    const fold: FoldFile = {
      file_spec: 1.2,
      vertices_coords: [[0, 0]],
      edges_vertices: [[0, 0]],
    };
    expect(isFkld(fold)).toBe(false);
  });
});
