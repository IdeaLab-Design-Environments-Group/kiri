import { describe, expect, it } from "vitest";
import { createAkdePyramid, kirigamizeMesh } from "../../../src/services/pattern-service.js";

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
  it("createAkdePyramid returns a loadable FKLD outcome", () => {
    const out = createAkdePyramid();
    expect(out.ok).toBe(true);
    expect(out.name).toBe("akde-pyramid.fkld");
    expect(out.summary).toContain("Created AKDE pyramid");
    expect(Array.isArray(out.fkld.vertices_coords)).toBe(true);
  });

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
});
