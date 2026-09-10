import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveElectronicsTarget, resolveFoldedCopperOverlay } from "../../../src/services/electronics-service.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";
import { flatFaces, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import { foldAdjacency } from "../../../src/model/fold-adjacency.js";
import { tapeWidthFor } from "../../../src/model/electronics-routing.js";

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

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const SHEET_MM = 210;

const mid = (l: readonly [Vec2, Vec2]): Vec2 => ({ x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 });

describe("services/electronics-service › a circuit that is nothing but a jump", () => {
  /** desk-lamp-shade with one hand-drawn jump across a severed rim edge, and nothing else on it. */
  function jumpOnly(): { fold: FoldFile; circuit: Circuit } {
    const fold = JSON.parse(readFileSync(`${EXAMPLES}desk-lamp-shade.fkld`, "utf8")) as FoldFile;
    const faces = flatFaces(fold);
    const empty = { leds: [], parts: [] } as unknown as Circuit;
    const tapeW = tapeWidthFor(faces, SHEET_MM, undefined, empty);
    const pair = foldAdjacency(fold, faces).pairs.find((p) => {
      const d = { x: mid(p.lipA).x - mid(p.lipB).x, y: mid(p.lipA).y - mid(p.lipB).y };
      return Math.hypot(d.x, d.y) > 5 && p.faceA !== p.faceB;
    });
    expect(pair).toBeDefined();
    // Both ends set back off the lip toward their own face, which is where a land sits: within a tape of
    // the edge the fold brings the two of them together at, and far enough in that the land's own width
    // still lies on the material.
    const off = (l: readonly [Vec2, Vec2], f: number): Vec2 => {
      const m = mid(l), c = faces[f]!.centroid;
      const L = Math.hypot(c.x - m.x, c.y - m.y);
      return { x: m.x + ((c.x - m.x) / L) * tapeW * 0.6, y: m.y + ((c.y - m.y) / L) * tapeW * 0.6 };
    };
    return {
      fold,
      circuit: {
        ...empty,
        jumps: [{
          id: "j1",
          net: "n1",
          a: { kind: "free", ...off(pair!.lipA, pair!.faceA) },
          b: { kind: "free", ...off(pair!.lipB, pair!.faceB) },
        }],
      },
    };
  }

  it("plans it anyway, and shows the ribbon and both solder lands on the folded model", () => {
    // The old guard returned early for any circuit with no LED, no battery and no wire, which a
    // jump-only circuit is -- so the one thing the author had drawn was the one thing the model omitted.
    const { fold, circuit } = jumpOnly();
    const meshes = resolveFoldedCopperOverlay({ fold, circuit, tileGap: 0, sheetMm: SHEET_MM });
    expect(meshes.filter((m) => m.kind === "jump")).toHaveLength(1);
    // The lands are ordinary copper on the jump's net, one per end -- no branch anywhere downstream.
    expect(meshes.filter((m) => m.kind === "n1")).toHaveLength(2);
  }, 20_000);

  it("still draws nothing for a circuit with no jumps and nothing else either", () => {
    const { fold } = jumpOnly();
    const bare = { leds: [], parts: [] } as unknown as Circuit;
    expect(resolveFoldedCopperOverlay({ fold, circuit: bare, tileGap: 0, sheetMm: SHEET_MM })).toEqual([]);
  }, 20_000);
});
