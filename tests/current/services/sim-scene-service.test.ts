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

  it("reuses each material scene and resets its dynamic state", () => {
    const loaded: LoadedModel = { kind: "fold", name: "store-A.fold", object: fold };
    const vinyl = resolveSimScene(loaded, null, "vinyl")!;
    vinyl.scene.model.position[0] = 99;
    vinyl.scene.model.velocity[0] = 42;
    vinyl.scene.solver.foldPercent = 0.8;

    const printed = resolveSimScene(loaded, null, "printed")!;
    const vinylAgain = resolveSimScene(loaded, null, "vinyl")!;

    expect(printed.scene).not.toBe(vinyl.scene);
    expect(vinylAgain.scene).toBe(vinyl.scene);
    expect(vinylAgain.scene.model.position[0]).toBe(vinylAgain.scene.model.rest[0]);
    expect(vinylAgain.scene.model.velocity[0]).toBe(0);
    expect(vinylAgain.scene.solver.foldPercent).toBe(0);
  });
});
