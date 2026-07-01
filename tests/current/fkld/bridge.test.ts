import { describe, expect, it } from "vitest";
import { computeState, defaultInputs } from "@kirigami/model/geometry.js";
import { buildFoldNet } from "@kirigami/sim/foldnet.js";
import * as bridge from "@kirigami/model/fkld-bridge.js";
import * as spec from "@dayangac/fkld/spec";
import * as cutTypes from "@dayangac/fkld/cut-types";
import * as molecule from "@dayangac/fkld/molecule";
import * as io from "@dayangac/fkld/io";

const { foldNetToFkld } = bridge as {
  foldNetToFkld: (
    net: ReturnType<typeof buildFoldNet>,
    state: ReturnType<typeof computeState>,
    options?: { creator?: string },
  ) => Record<string, unknown> & {
    vertices_coords: number[][];
    edges_vertices: [number, number][];
    edges_assignment: string[];
    faces_vertices: number[][];
  };
};
const { KEYS } = spec as { KEYS: typeof spec.KEYS };
const { validateEdgeCutTypes, CUT_TYPES } = cutTypes as typeof cutTypes;
const { validateMoleculeArrays } = molecule as typeof molecule;
const { serializeFkld, parseFkld } = io as {
  serializeFkld: (file: unknown, indent?: number | null) => string;
  parseFkld: (text: string) => unknown;
};

function buildDefaultFkld(): {
  net: ReturnType<typeof buildFoldNet>;
  state: ReturnType<typeof computeState>;
  fkld: ReturnType<typeof foldNetToFkld>;
} {
  const state = computeState(defaultInputs());
  const net = buildFoldNet(state);
  return { net, state, fkld: foldNetToFkld(net, state) };
}

describe("fkld/bridge — standard FOLD fields", () => {
  it("emits creasePattern metadata with the AKDE creator stamp", () => {
    const { fkld } = buildDefaultFkld();
    expect(fkld.file_spec).toBe(1.2);
    expect(fkld.file_creator).toBe("AKDE");
    expect(fkld.file_classes).toEqual(["creasePattern"]);
  });

  it("honours a custom creator override", () => {
    const state = computeState(defaultInputs());
    const net = buildFoldNet(state);
    const fkld = foldNetToFkld(net, state, { creator: "test-fixture" });
    expect(fkld.file_creator).toBe("test-fixture");
  });

  it("parallel arrays match edges_vertices length", () => {
    const { net, fkld } = buildDefaultFkld();
    const n = net.edges.length;
    expect(fkld.edges_vertices.length).toBe(n);
    expect(fkld.edges_assignment.length).toBe(n);
    expect((fkld[KEYS.edges.cutType] as unknown[]).length).toBe(n);
    expect((fkld[KEYS.edges.moleculeTheta] as unknown[]).length).toBe(n);
    expect((fkld[KEYS.edges.moleculeWidth] as unknown[]).length).toBe(n);
    expect((fkld[KEYS.edges.dihedralTarget] as unknown[]).length).toBe(n);
  });

  it("emits 2D coordinates in millimetres (un-normalises FoldNet's bounding-sphere scale)", () => {
    const { net, state, fkld } = buildDefaultFkld();
    expect(fkld.vertices_coords.length).toBe(net.vertices.length);
    for (const coord of fkld.vertices_coords) {
      expect(coord).toHaveLength(2);
      expect(Number.isFinite(coord[0])).toBe(true);
      expect(Number.isFinite(coord[1])).toBe(true);
    }
    // Default pyramid has slant s ≈ 100 mm; the outer ring should reach
    // about that radius once we undo the bounding-sphere normalization.
    const maxRadius = Math.max(
      ...fkld.vertices_coords.map((c) => Math.hypot(c[0], c[1])),
    );
    expect(maxRadius).toBeGreaterThan(state.s * 0.5);
    expect(maxRadius).toBeLessThan(state.s * 1.5);
  });
});

describe("fkld/bridge — cut subtype classification", () => {
  it("tags every C edge with a registered subtype, others null", () => {
    const { fkld } = buildDefaultFkld();
    const cuts = fkld[KEYS.edges.cutType] as (string | null)[];
    fkld.edges_assignment.forEach((assignment, i) => {
      if (assignment === "C") {
        expect(cuts[i]).not.toBeNull();
        expect(CUT_TYPES).toContain(cuts[i]!);
      } else {
        expect(cuts[i]).toBeNull();
      }
    });
  });

  it("classifies apex-rim cuts as major and dart-mouth slits as minor", () => {
    const { fkld } = buildDefaultFkld();
    const cuts = fkld[KEYS.edges.cutType] as (string | null)[];
    const major = cuts.filter((t) => t === "major").length;
    const minor = cuts.filter((t) => t === "minor").length;
    expect(major).toBeGreaterThan(0);
    expect(minor).toBeGreaterThan(0);
  });

  it("output satisfies validateEdgeCutTypes", () => {
    const { fkld } = buildDefaultFkld();
    const result = validateEdgeCutTypes(
      fkld.edges_assignment,
      fkld[KEYS.edges.cutType],
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("fkld/bridge — per-edge molecule parameters", () => {
  it("tags V edges with the uniform-pyramid (theta, w); other edges null", () => {
    const { state, fkld } = buildDefaultFkld();
    const theta = fkld[KEYS.edges.moleculeTheta] as (number | null)[];
    const width = fkld[KEYS.edges.moleculeWidth] as (number | null)[];
    fkld.edges_assignment.forEach((assignment, i) => {
      if (assignment === "V") {
        expect(theta[i]).toBeCloseTo(state.theta, 10);
        expect(width[i]).toBeCloseTo(state.w, 10);
      } else {
        expect(theta[i]).toBeNull();
        expect(width[i]).toBeNull();
      }
    });
  });

  it("output satisfies validateMoleculeArrays", () => {
    const { fkld } = buildDefaultFkld();
    const result = validateMoleculeArrays(fkld.edges_vertices, {
      theta: fkld[KEYS.edges.moleculeTheta] as (number | null)[],
      width: fkld[KEYS.edges.moleculeWidth] as (number | null)[],
      dihedral: fkld[KEYS.edges.dihedralTarget] as (number | null)[],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("assigns sensible dihedral targets per assignment", () => {
    const { state, fkld } = buildDefaultFkld();
    const dihedral = fkld[KEYS.edges.dihedralTarget] as (number | null)[];
    fkld.edges_assignment.forEach((assignment, i) => {
      switch (assignment) {
        case "M":
          expect(dihedral[i]).toBeCloseTo(state.gamma, 10);
          break;
        case "V":
          expect(dihedral[i]).toBe(0);
          break;
        default:
          // F (facet, stays flat), B (boundary), C (cut): no fold target.
          expect(dihedral[i]).toBeNull();
      }
    });
  });
});

describe("fkld/bridge — architecture metadata", () => {
  it("emits a minimal architecture block with scale and material thickness", () => {
    const { state, fkld } = buildDefaultFkld();
    const arch = fkld[KEYS.meta.architecture] as Record<string, unknown>;
    expect(arch.scaleMeters).toBe(0.001);
    expect(arch.materialThickness).toBe(state.inputs.materialThickness);
    expect(arch.sourcePyramid).toMatchObject({
      edgeCount: state.inputs.edgeCount,
      edgeLength: state.inputs.edgeLength,
    });
  });
});

describe("fkld/bridge — round-trip through io", () => {
  it("serialize → parse preserves the FKLD object verbatim", () => {
    const { fkld } = buildDefaultFkld();
    const reparsed = parseFkld(serializeFkld(fkld));
    expect(reparsed).toEqual(fkld);
  });
});
