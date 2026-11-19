import { describe, expect, it } from "vitest";
import { buildFkldSvgExport } from "../../../src/model/fkld-svg-export.js";
import { GUIDE_KEY, guideSegments } from "../../../src/model/guide-lines.js";
import { PatternGrid } from "../../../src/model/pattern-grid.js";
import { fkldFromPatternGrid, kirigamizeMesh } from "../../../src/services/pattern-service.js";

// A tiny valid OBJ tetrahedron — enough for the full M1–M5 pipeline.
const TETRA_OBJ = [
  "v 0 0 0",
  "v 1 0 0",
  "v 0.5 0.866 0",
  "v 0.5 0.289 0.816",
  "f 1 3 2",
  "f 1 2 4",
  "f 2 3 4",
  "f 3 1 4",
].join("\n");

describe("services/pattern-service", () => {
  it("kirigamizeMesh runs the general pipeline and narrows to a PatternOutcome", () => {
    const out = kirigamizeMesh(TETRA_OBJ, "obj", "tetra.obj");
    expect(out.name).toBe("tetra.fkld");
    expect(out.summary).toContain('Kirigamized "tetra.obj"');
    expect(out.summary).toMatch(/\d+ cuts, \d+ faces/);
    // verification ran: verdict mentions d_H either way
    expect(out.summary).toMatch(/d_H|unverified/);
    expect(Array.isArray(out.fkld.faces_vertices)).toBe(true);
  });

  it("kirigamizeMesh flags a multi-shell mesh whose extra shells were dropped", () => {
    // Two disjoint tetrahedra: the pipeline keeps the larger shell only.
    const second = [
      "v 10 0 0",
      "v 11 0 0",
      "v 10.5 0.866 0",
      "v 10.5 0.289 0.816",
      "f 5 7 6",
      "f 5 6 8",
      "f 6 7 8",
      "f 7 5 8",
    ];
    const out = kirigamizeMesh([TETRA_OBJ, ...second].join("\n"), "obj", "pair.obj");
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/only the largest shell was kirigamized/);
    expect(out.summary).toMatch(/kept largest of 2 components \(4 faces\); dropped 1 \(4 faces\)/);
  });

  it("kirigamizeMesh throws (PipelineError) on garbage input", () => {
    expect(() => kirigamizeMesh("not a mesh", "obj", "junk.obj")).toThrowError(/import|no vertices/i);
  });

  it("fkldFromPatternGrid carries painted guides, and leaves the key out when there are none", () => {
    const g = new PatternGrid(3, 3, 10);
    expect(fkldFromPatternGrid(g).fkld[GUIDE_KEY]).toBeUndefined();
    g.set(g.vid(1, 0), g.vid(1, 1), "G");
    g.set(g.vid(1, 1), g.vid(1, 2), "G");
    const out = fkldFromPatternGrid(g);
    const flags = out.fkld[GUIDE_KEY] as boolean[];
    expect(flags).toHaveLength(out.fkld.edges_vertices!.length);
    expect(guideSegments(out.fkld)).toEqual([
      [{ x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 10, y: 10 }, { x: 10, y: 20 }],
    ]);
    expect(out.summary).toContain("2 of them guides");
  });

  it("keeps guides out of the cut and score files", () => {
    const plain = new PatternGrid(3, 3, 10);
    plain.set(plain.vid(1, 0), plain.vid(1, 1), "M");
    const guided = new PatternGrid(3, 3, 10);
    guided.set(guided.vid(1, 0), guided.vid(1, 1), "M");
    for (let j = 0; j < 3; j++) guided.set(guided.vid(2, j), guided.vid(2, j + 1), "G");
    const a = buildFkldSvgExport(fkldFromPatternGrid(plain).fkld, "k")!;
    const b = buildFkldSvgExport(fkldFromPatternGrid(guided).fkld, "k")!;
    expect(b.files.map((f) => f.svg)).toEqual(a.files.map((f) => f.svg));
  });
});
