import { describe, expect, it } from "vitest";
import { computeState, defaultInputs } from "@kirigami/model/geometry.js";
import { buildFkldFile } from "@kirigami/model/fkld-export.js";
import {
  summarizeFkldForDisplay,
  type SummarySection,
} from "@kirigami/view/fkld-metadata-summary.js";

function defaultSummary(): SummarySection[] {
  const state = computeState(defaultInputs());
  const file = buildFkldFile(state);
  expect(file).not.toBeNull();
  return summarizeFkldForDisplay(file);
}

function sectionByTitle(
  sections: SummarySection[],
  title: string,
): SummarySection {
  const found = sections.find((s) => s.title === title);
  if (!found) throw new Error(`section "${title}" not found`);
  return found;
}

function rowValue(section: SummarySection, term: string): string {
  const row = section.rows.find((r) => r.term === term);
  if (!row) throw new Error(`row "${term}" not found in section "${section.title}"`);
  return row.value;
}

describe("summarizeFkldForDisplay — null input", () => {
  it("returns an empty section list", () => {
    expect(summarizeFkldForDisplay(null)).toEqual([]);
  });
});

describe("summarizeFkldForDisplay — File header", () => {
  it("surfaces spec, creator, classes from the FKLD object", () => {
    const header = sectionByTitle(defaultSummary(), "File header");
    expect(rowValue(header, "file_spec")).toBe("1.2");
    expect(rowValue(header, "file_creator")).toBe("AKDE");
    expect(rowValue(header, "file_classes")).toBe("creasePattern");
  });
});

describe("summarizeFkldForDisplay — Topology", () => {
  it("counts vertices/edges/faces from FKLD primary arrays", () => {
    const state = computeState(defaultInputs());
    const file = buildFkldFile(state)!;
    const topology = sectionByTitle(
      summarizeFkldForDisplay(file),
      "Topology",
    );
    expect(rowValue(topology, "vertices_coords")).toBe(
      String(file.vertices_coords.length),
    );
    expect(rowValue(topology, "edges_vertices")).toBe(
      String(file.edges_vertices.length),
    );
    expect(rowValue(topology, "faces_vertices")).toBe(
      String(file.faces_vertices.length),
    );
  });
});

describe("summarizeFkldForDisplay — edges_assignment", () => {
  it("breaks down counts per FOLD letter; counts sum to total edges", () => {
    const state = computeState(defaultInputs());
    const file = buildFkldFile(state)!;
    const section = sectionByTitle(
      summarizeFkldForDisplay(file),
      "edges_assignment",
    );
    const totalFromRows = section.rows.reduce(
      (acc, r) => acc + Number(r.value),
      0,
    );
    expect(totalFromRows).toBe(file.edges_assignment.length);
    // The default pyramid must have mountains, valleys, facets, and cuts.
    expect(Number(rowValue(section, "M  mountain"))).toBeGreaterThan(0);
    expect(Number(rowValue(section, "V  valley"))).toBeGreaterThan(0);
    expect(Number(rowValue(section, "F  facet (flat)"))).toBeGreaterThan(0);
    expect(Number(rowValue(section, "C  cut"))).toBeGreaterThan(0);
  });
});

describe("summarizeFkldForDisplay — fkld:edges_cutType", () => {
  it("breaks cuts into major/minor; null count matches non-C edges", () => {
    const state = computeState(defaultInputs());
    const file = buildFkldFile(state)!;
    const section = sectionByTitle(
      summarizeFkldForDisplay(file),
      "fkld:edges_cutType",
    );
    const cuts = file["fkld:edges_cutType"] as (string | null)[];
    const expectedNull = cuts.filter((v) => v == null).length;
    expect(Number(rowValue(section, "null  (non-cut edges)"))).toBe(
      expectedNull,
    );
    expect(Number(rowValue(section, "major"))).toBeGreaterThan(0);
    expect(Number(rowValue(section, "minor"))).toBeGreaterThan(0);
  });

  it("renders an empty-state message when the extension is absent", () => {
    const section = sectionByTitle(
      summarizeFkldForDisplay({
        vertices_coords: [[0, 0]],
        edges_vertices: [],
        edges_assignment: [],
        faces_vertices: [],
      }),
      "fkld:edges_cutType",
    );
    expect(section.rows).toEqual([]);
    expect(section.emptyMessage).toBe("Not present.");
  });
});

describe("summarizeFkldForDisplay — Molecules", () => {
  it("surfaces θ in degrees and w in mm from the FKLD V-edge values", () => {
    const state = computeState(defaultInputs());
    const file = buildFkldFile(state)!;
    const section = sectionByTitle(
      summarizeFkldForDisplay(file),
      "Molecules",
    );
    const theta = file["fkld:edges_moleculeTheta"] as (number | null)[];
    const populated = theta.filter((v) => v != null).length;
    expect(rowValue(section, "edges carrying (θ, w)")).toBe(String(populated));
    // θ shown as degrees with a trailing °.
    expect(rowValue(section, "θ (uniform sample)")).toMatch(/°$/);
    // w is in mm, a number.
    expect(Number(rowValue(section, "w (uniform sample, mm)"))).toBeGreaterThan(
      0,
    );
  });
});

describe("summarizeFkldForDisplay — fkld:meta_architecture", () => {
  it("flattens nested architecture metadata into dotted rows", () => {
    const state = computeState(defaultInputs());
    const file = buildFkldFile(state)!;
    const section = sectionByTitle(
      summarizeFkldForDisplay(file),
      "fkld:meta_architecture",
    );
    expect(rowValue(section, "scaleMeters")).toBe("0.001");
    expect(rowValue(section, "materialThickness")).toBe(
      String(state.inputs.materialThickness),
    );
    // Nested sourcePyramid is flattened with dotted keys.
    expect(rowValue(section, "sourcePyramid.edgeCount")).toBe(
      String(state.inputs.edgeCount),
    );
    expect(rowValue(section, "sourcePyramid.edgeLength")).toBe(
      String(state.inputs.edgeLength),
    );
  });
});
