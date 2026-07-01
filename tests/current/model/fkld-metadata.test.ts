import { describe, expect, it } from "vitest";
import { summarizeFkldForDisplay } from "../../../src/model/fkld-metadata.js";

describe("model/fkld-metadata", () => {
  it("returns no sections for null input", () => {
    expect(summarizeFkldForDisplay(null)).toEqual([]);
  });

  it("renders stable sections with counts, formatting, and flattened architecture metadata", () => {
    const sections = summarizeFkldForDisplay({
      file_spec: 1.1,
      file_creator: "tester",
      file_classes: ["singleModel", "creasePattern"],
      frame_title: "Example",
      vertices_coords: [[0, 0], [1, 0], [0, 1]],
      edges_vertices: [[0, 1], [1, 2], [2, 0]],
      faces_vertices: [[0, 1, 2]],
      edges_assignment: ["M", "V", "C", "U", "M"],
      "fkld:edges_cutType": ["major", "dart", null, "tab", "major"],
      "fkld:edges_moleculeTheta": [null, Math.PI / 6],
      "fkld:edges_moleculeWidth": [12.34567, null],
      "fkld:meta_architecture": {
        shell: { material: "paper", thickness: 1.25 },
        flags: [1, 2],
        active: true,
      },
    });

    expect(sections.map((section) => section.title)).toEqual([
      "File header",
      "Topology",
      "edges_assignment",
      "fkld:edges_cutType",
      "Molecules",
      "fkld:meta_architecture",
    ]);

    expect(sections[0]?.rows).toEqual([
      { term: "file_spec", value: "1.1" },
      { term: "file_creator", value: "tester" },
      { term: "frame_title", value: "Example" },
      { term: "file_classes", value: "singleModel, creasePattern" },
    ]);

    expect(sections[2]?.rows[0]).toEqual({ term: "M  mountain", value: "2" });
    expect(sections[2]?.rows[4]).toEqual({ term: "C  cut", value: "1" });
    expect(sections[3]?.rows.at(-1)).toEqual({ term: "null  (non-cut edges)", value: "1" });
    expect(sections[4]?.rows).toEqual([
      { term: "edges carrying (θ, w)", value: "1" },
      { term: "θ (sample)", value: "30°" },
      { term: "w (sample, mm)", value: "12.3457" },
    ]);
    expect(sections[5]?.rows).toEqual([
      { term: "shell.material", value: "paper" },
      { term: "shell.thickness", value: "1.25" },
      { term: "flags", value: "[1,2]" },
      { term: "active", value: "true" },
    ]);
  });

  it("emits empty-section messages for absent FKLD-only metadata", () => {
    const sections = summarizeFkldForDisplay({
      vertices_coords: [],
      edges_vertices: [],
      faces_vertices: [],
    });

    expect(sections[3]).toEqual({
      title: "fkld:edges_cutType",
      rows: [],
      emptyMessage: "Not present.",
    });
    expect(sections[5]).toEqual({
      title: "fkld:meta_architecture",
      rows: [],
      emptyMessage: "Not present.",
    });
  });
});
