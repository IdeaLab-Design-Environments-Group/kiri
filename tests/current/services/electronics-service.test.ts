import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { memoizeFoldedOverlay, resolveElectronicsTarget, resolveFoldedCopperOverlay } from "../../../src/services/electronics-service.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";
import { flatFaces, type Circuit } from "../../../src/model/electronics.js";
import { TILE_INSET_FRAC } from "../../../src/model/tile-subdiv.js";

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

  it("puts a declared net's copper on the folded model when the circuit has only parts", () => {
    // No hinge LED, no battery, no hand wire: the netlist still routes the two pads together, and the
    // editor draws that copper, so the folded model has to carry it too.
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    ) as FoldFile;
    const faces = flatFaces(fold);
    const at = (f: number) => faces[f]!.centroid;
    const circuit: Circuit = {
      leds: [],
      battery: null,
      nets: [{ id: "a", name: "A" }],
      parts: [
        { component: "R_1206", x: at(0).x, y: at(0).y, free: true, rot: 0 },
        { component: "R_1206", x: at(1).x, y: at(1).y, free: true, rot: 0 },
      ],
      terminals: [{ part: 0, pad: "1", net: "a" }, { part: 1, pad: "1", net: "a" }],
    };
    const overlay = resolveFoldedCopperOverlay({ fold, circuit, tileGap: TILE_INSET_FRAC, sheetMm: 200 });
    expect(overlay.length).toBeGreaterThan(0);
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

  it("re-plans the overlay only when an input is replaced", () => {
    const plan = vi.fn((_input: unknown) => []);
    const overlay = memoizeFoldedOverlay(plan);
    const fold = twoTri();
    const circuit: Circuit = { leds: [], battery: { face: 0 } };
    const input = { fold, circuit, tileGap: 0.16, sheetMm: 100 };
    const first = overlay(input);
    expect(overlay({ ...input })).toBe(first); // a fresh input object holding the same things
    expect(plan).toHaveBeenCalledTimes(1);

    overlay({ ...input, circuit: { ...circuit } }); // an edit replaces the circuit
    overlay({ ...input, circuit: { ...circuit }, tileGap: 0.2 });
    overlay({ ...input, fold: twoTri() });
    overlay({ ...input, sheetMm: 200 });
    expect(plan).toHaveBeenCalledTimes(5);
  });

  it("repeats a remembered failure's warning on every reuse", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const plan = vi.fn(resolveFoldedCopperOverlay);
    const overlay = memoizeFoldedOverlay(plan);
    const input = { fold: twoTri(), circuit: { leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 } as never, tileGap: 0.16, sheetMm: 100 };
    const first = vi.fn();
    const again = vi.fn();
    expect(overlay({ ...input, onWarning: first })).toEqual([]);
    expect(overlay({ ...input, onWarning: again })).toEqual([]);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(again).toHaveBeenCalledWith(first.mock.calls[0]![0]);
    errSpy.mockRestore();
  });
});
