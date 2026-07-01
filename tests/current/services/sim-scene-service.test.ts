import { describe, expect, it } from "vitest";
import { resolveSimScene } from "../../../src/services/sim-scene-service.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";

const fold: FoldFile = {
  vertices_coords: [[0, 0], [1, 0], [1, 1], [0, 1]],
  faces_vertices: [[0, 1, 2], [0, 2, 3]],
  edges_vertices: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 0]],
  edges_assignment: ["B", "B", "V", "B", "B"],
};

describe("services/sim-scene-service", () => {
  it("returns null with nothing loaded", () => {
    expect(resolveSimScene(null, null)).toBeNull();
  });

  it("returns null for mesh models (nothing foldable)", () => {
    const mesh: LoadedModel = { kind: "mesh", name: "m.obj", ext: "obj", text: "v 0 0 0" };
    expect(resolveSimScene(mesh, null)).toBeNull();
  });

  it("prefers what the viewer shows over the loaded model", () => {
    const loaded: LoadedModel = { kind: "fold", name: "store-A.fold", object: fold };
    const built = resolveSimScene(loaded, { object: fold, name: "viewer-B.fold" });
    expect(built?.title).toContain("viewer-B.fold");
  });

  it("falls back to the loaded fold model when the viewer is empty", () => {
    const loaded: LoadedModel = { kind: "fold", name: "store-A.fold", object: fold };
    const built = resolveSimScene(loaded, null);
    expect(built?.title).toContain("store-A.fold");
    expect(built?.scene.net.faces.length).toBeGreaterThan(0);
  });
});
