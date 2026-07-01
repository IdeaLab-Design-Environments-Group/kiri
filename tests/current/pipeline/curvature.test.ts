import { describe, expect, it } from "vitest";
import { angleDefects, signedDihedral, targetFoldAngles, FLAT_EPS } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { makeCube, makeGrid, makeOctahedron, makeSaddleFan, makeTetrahedron } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

describe("angleDefects", () => {
  it("cube corners: δ = π/2 each, Σδ = 4π, all positive", () => {
    const cube = makeCube();
    const report = angleDefects(cube, buildTopology(cube));
    for (let v = 0; v < 8; v++) {
      expect(report.defects[v]).toBeCloseTo(Math.PI / 2, 12);
      expect(report.classes[v]).toBe("positive");
    }
    expect(report.totalDefect).toBeCloseTo(2 * TAU, 9); // Gauss–Bonnet, χ=2
  });

  it("tetrahedron: δ = π each; octahedron: δ = 2π/3 each", () => {
    const tetra = makeTetrahedron();
    const rt = angleDefects(tetra, buildTopology(tetra));
    for (const d of rt.defects) expect(d).toBeCloseTo(Math.PI, 12);

    const octa = makeOctahedron();
    const ro = angleDefects(octa, buildTopology(octa));
    for (const d of ro.defects) expect(d).toBeCloseTo((2 * Math.PI) / 3, 12);
    expect(ro.totalDefect).toBeCloseTo(2 * TAU, 9);
  });

  it("saddle fan: center vertex negative, ring classified boundary", () => {
    const saddle = makeSaddleFan();
    const report = angleDefects(saddle, buildTopology(saddle));
    expect(report.classes[0]).toBe("negative");
    expect(report.defects[0]).toBeLessThan(-FLAT_EPS);
    for (let v = 1; v <= 6; v++) expect(report.classes[v]).toBe("boundary");
  });

  it("flat grid: interior vertices flat with δ ≈ 0", () => {
    const grid = makeGrid();
    const report = angleDefects(grid, buildTopology(grid));
    const interiorCount = report.classes.filter((c) => c === "flat").length;
    expect(interiorCount).toBe(3 * 3); // 5x5 grid → 3x3 interior
    for (let v = 0; v < report.defects.length; v++) {
      if (report.classes[v] === "flat") expect(Math.abs(report.defects[v])).toBeLessThanOrEqual(FLAT_EPS);
    }
  });
});

describe("signedDihedral / targetFoldAngles", () => {
  it("cube: every interior edge is a mountain (θ > 0) of π/2 or flat diagonal", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    const targets = targetFoldAngles(cube, topo);
    let mountains = 0;
    let flats = 0;
    for (let e = 0; e < topo.edges.length; e++) {
      const t = targets[e]!;
      expect(t).not.toBeNull();
      if (Math.abs(t) <= FLAT_EPS) {
        flats++; // triangulation diagonal inside a square face
      } else {
        expect(t).toBeCloseTo(Math.PI / 2, 9); // mountain positive (AKDE convention)
        mountains++;
      }
    }
    expect(mountains).toBe(12); // the cube's 12 real edges
    expect(flats).toBe(6); // one diagonal per face
  });

  it("valley test: a V-shaped hinge has θ < 0 when folded toward the normals", () => {
    // Two triangles over edge (0,1): wings at z>0 → fold is a valley w.r.t. +z normals.
    const mesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0.5, y: 1, z: 0.5 }, // lifted wing
        { x: 0.5, y: -1, z: 0.5 }, // lifted wing
      ],
      faces: [
        [0, 1, 2],
        [1, 0, 3],
      ] as [number, number, number][],
    };
    const topo = buildTopology(mesh);
    const eHinge = topo.edgeIndex.get("0_1")!;
    expect(signedDihedral(mesh, topo, eHinge)).toBeLessThan(0);
  });

  it("boundary edges get null targets", () => {
    const grid = makeGrid(2, 2);
    const topo = buildTopology(grid);
    const targets = targetFoldAngles(grid, topo);
    for (let e = 0; e < topo.edges.length; e++) {
      if (topo.edges[e].faces.length === 1) expect(targets[e]).toBeNull();
    }
  });
});
