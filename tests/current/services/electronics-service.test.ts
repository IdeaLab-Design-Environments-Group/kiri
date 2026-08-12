import { describe, expect, it } from "vitest";
import { resolveElectronicsTarget } from "../../../src/services/electronics-service.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";

function twoTri(): FoldFile {
  return {
    vertices_coords: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    faces_vertices: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 0],
    ],
    edges_assignment: ["B", "B", "M", "B", "B"],
  };
}

describe("services/electronics-service", () => {
  it("prefers the shown viewer model over the loaded fold model", () => {
    const model: LoadedModel = { kind: "fold", name: "loaded.fold", object: { vertices_coords: [], faces_vertices: [] } };
    const shown = { object: twoTri(), name: "viewer.fkld" };
    expect(resolveElectronicsTarget(model, shown)?.object).toBe(shown.object);
  });

  it("falls back to the loaded fold model, and is null when nothing is shown", () => {
    const model: LoadedModel = { kind: "fold", name: "loaded.fold", object: twoTri() };
    expect(resolveElectronicsTarget(model, null)?.object).toBe(model.object);
    expect(resolveElectronicsTarget(null, null)).toBeNull();
  });
});
