import { describe, expect, it } from "vitest";
import { resolveElectronicsTarget, resolveRoutedCircuit } from "../../../src/services/electronics-service.js";
import { resolveSvgExport } from "../../../src/services/svg-export-service.js";
import type { Circuit } from "../../../src/model/electronics.js";
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

const circuit: Circuit = { battery: { face: 0 }, leds: [{ a: 0, b: 1 }] };

describe("services/electronics-service", () => {
  it("prefers the shown viewer model over the loaded fold model", () => {
    const model: LoadedModel = { kind: "fold", name: "loaded.fold", object: { vertices_coords: [], faces_vertices: [] } };
    const shown = { object: twoTri(), name: "viewer.fkld" };
    const target = resolveElectronicsTarget(model, shown);
    expect(target?.object).toBe(shown.object);

    const routed = resolveRoutedCircuit(model, shown, circuit);
    expect(routed).not.toBeNull();
    expect(routed!.ledPoints).toHaveLength(1);
    expect(routed!.traces.length).toBeGreaterThan(0);
  });

  it("returns null when no pattern is shown", () => {
    expect(resolveRoutedCircuit(null, null, circuit)).toBeNull();
  });
});

describe("services/svg-export-service: copper layer", () => {
  const shown = { object: twoTri(), name: "tile.fkld" };

  it("adds a red copper layer file when a circuit with LEDs is present", () => {
    const payload = resolveSvgExport(null, shown, circuit);
    expect(payload).not.toBeNull();
    expect(payload!.files.some((f) => f.filename.endsWith("-copper.svg"))).toBe(true);
    expect(payload!.combined.svg).toContain("#ff0000");
  });

  it("omits the copper layer when there is no circuit", () => {
    const payload = resolveSvgExport(null, shown, null);
    expect(payload).not.toBeNull();
    expect(payload!.files.some((f) => f.filename.endsWith("-copper.svg"))).toBe(false);
  });

  it("omits the copper layer when the circuit has no LEDs", () => {
    const payload = resolveSvgExport(null, shown, { battery: { face: 0 }, leds: [] });
    expect(payload!.files.some((f) => f.filename.endsWith("-copper.svg"))).toBe(false);
  });
});
