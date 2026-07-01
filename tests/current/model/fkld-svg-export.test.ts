/**
 * FKLD → vinyl-cutter SVG export: cut (black: B+C) / score (blue: M+V) layers, registered in mm,
 * zipped — the AKDE Cricut export generalized to any FKLD flat pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFkldSvgExport } from "../../../src/model/fkld-svg-export.js";
import { kirigamizeText } from "../../../src/pipeline/kirigamize.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const load = (n: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${n}`, import.meta.url)), "utf8")) as FoldFile;
const loadText = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../public/examples/${n}`, import.meta.url)), "utf8");

const viewBoxOf = (svg: string): string | null => /viewBox="([^"]+)"/.exec(svg)?.[1] ?? null;

describe("buildFkldSvgExport — layer mapping (synthetic)", () => {
  it("routes B+C to the black cut layer, M+V to the blue score layer, and drops F", () => {
    // unit square (4 boundary edges = a closed loop) + a mountain diagonal + a facet edge
    const fold: FoldFile = {
      frame_unit: "mm",
      vertices_coords: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [0, 2], // mountain diagonal
        [1, 3], // facet — must be excluded
      ],
      edges_assignment: ["B", "B", "B", "B", "M", "F"],
    };
    const out = buildFkldSvgExport(fold, "sq")!;
    expect(out).not.toBeNull();
    const cut = out.files.find((f) => f.filename === "sq-cut.svg")!.svg;
    const score = out.files.find((f) => f.filename === "sq-score.svg")!.svg;

    expect(cut).toContain("#000000");
    expect(cut).toContain("Z"); // the 4 boundary edges assembled into a closed loop
    expect(score).toContain("#0000ff");
    expect((score.match(/M /g) ?? []).length).toBe(1); // exactly one score segment (the M diagonal; F dropped)
    // registered: cut and score share the same viewBox + mm size
    expect(viewBoxOf(cut)).toBe(viewBoxOf(score));
    expect(cut).toContain("mm");
    // previews carry non-scaling strokes
    expect(out.previews.both).toContain("non-scaling-stroke");
  });

  it("strokes interior C cuts on top of the filled B silhouette (no cut hidden by the fill)", () => {
    // unit square (4 B edges = silhouette loop) + an interior C slit between two inner vertices.
    const fold: FoldFile = {
      frame_unit: "mm",
      vertices_coords: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [3, 5],
        [7, 5],
      ],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5], // interior cut slit
      ],
      edges_assignment: ["B", "B", "B", "B", "C"],
    };
    const cut = buildFkldSvgExport(fold, "slit")!.files.find((f) => f.filename === "slit-cut.svg")!.svg;
    expect(cut).toContain('fill="#000000"'); // B silhouette filled
    expect(cut).toContain("Z"); // …as a closed loop
    expect(cut).toContain('stroke="#000000"'); // C slit stroked on top, separately — not swallowed
  });

  it("returns null when there's nothing to cut", () => {
    expect(buildFkldSvgExport({ vertices_coords: [], edges_vertices: [] }, "x")).toBeNull();
  });
});

describe("buildFkldSvgExport — real patterns", () => {
  it("exports the bundled AKDE hex FKLD as registered cut+score SVGs in a zip", () => {
    const out = buildFkldSvgExport(load("akde-hex.fkld"), "akde-hex")!;
    expect(out).not.toBeNull();
    expect(out.files.map((f) => f.filename).sort()).toEqual(["akde-hex-cut.svg", "akde-hex-score.svg"]);
    const [cut, score] = ["akde-hex-cut.svg", "akde-hex-score.svg"].map(
      (n) => out.files.find((f) => f.filename === n)!.svg,
    );
    expect(viewBoxOf(cut)).toBe(viewBoxOf(score)); // registered
    expect(cut).toContain("#000000");
    expect(score).toContain("#0000ff");
    // the zip carries both files under the base folder (names appear in the archive bytes)
    const bytes = Buffer.from(out.archive.bytes).toString("latin1");
    expect(bytes).toContain("akde-hex/akde-hex-cut.svg");
    expect(bytes).toContain("akde-hex/akde-hex-score.svg");
    expect(out.archive.bytes.length).toBeGreaterThan(0);
  });

  it("exports a kirigamized STL's emitted FKLD", () => {
    const fkld = kirigamizeText(loadText("sample-cube.stl"), "stl").fkld as FoldFile;
    const out = buildFkldSvgExport(fkld, "cube")!;
    expect(out).not.toBeNull();
    expect(out.files.length).toBe(2);
    expect(out.combined.svg).toContain("#000000");
    expect(out.combined.svg).toContain("#0000ff");
  });
});
