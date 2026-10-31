import { describe, expect, it, vi } from "vitest";
import { resolveElectronicsTarget, resolveFoldedCopperOverlay } from "../../../src/services/electronics-service.js";
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

  it("warns instead of failing silently when the copper cannot be planned", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onWarning = vi.fn();
    const circuit = { leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 } as never;
    const out = resolveFoldedCopperOverlay({ fold: twoTri(), circuit, tileGap: 0.16, sheetMm: 100, onWarning });
    expect(out).toEqual([]);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]![0]).toContain("Copper could not be placed");
    errSpy.mockRestore();
  });
});
