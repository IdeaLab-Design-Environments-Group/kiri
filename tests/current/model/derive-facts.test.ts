import { describe, expect, it } from "vitest";
import { deriveFacts } from "../../../src/model/derive-facts.js";

describe("model/derive-facts", () => {
  it("summarizes plain FOLD files", () => {
    const rows = deriveFacts({
      kind: "fold",
      name: "simple.fold",
      object: {
        vertices_coords: [[0, 0], [1, 0], [0, 1]],
        faces_vertices: [[0, 1, 2]],
        edges_vertices: [[0, 1], [1, 2], [2, 0]],
        frame_unit: "mm",
      },
    });

    expect(rows).toEqual([
      ["File", "simple.fold"],
      ["Format", "FOLD"],
      ["Vertices", "3"],
      ["Faces", "1"],
      ["Edges", "3"],
      ["Unit", "mm"],
    ]);
  });

  it("labels FKLD files distinctly and falls back to em dash for missing units", () => {
    const rows = deriveFacts({
      kind: "fold",
      name: "simple.fkld",
      object: {
        vertices_coords: [[0, 0]],
        faces_vertices: [],
        edges_vertices: [],
        "fkld:meta_architecture": {},
      },
    });

    expect(rows[1]).toEqual(["Format", "FKLD"]);
    expect(rows.at(-1)).toEqual(["Unit", "—"]);
  });

  it("summarizes mesh files by extension and line count", () => {
    const rows = deriveFacts({
      kind: "mesh",
      name: "shape.obj",
      ext: "obj",
      text: "v 0 0 0\nv 1 0 0\nf 1 2 3",
    });

    expect(rows).toEqual([
      ["File", "shape.obj"],
      ["Type", "OBJ mesh"],
      ["Lines", "3"],
    ]);
  });
});
