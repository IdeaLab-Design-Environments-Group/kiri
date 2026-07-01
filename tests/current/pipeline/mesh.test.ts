import { describe, expect, it } from "vitest";
import {
  buildTopology,
  countBoundaryLoops,
  eulerCharacteristic,
  faceAngles,
} from "../../../src/pipeline/mesh.js";
import { PipelineError, type TriMesh } from "../../../src/pipeline/types.js";
import { makeCube, makeIcosphere, makeTetrahedron } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

/** Inline Gauss–Bonnet audit: Σδ(v) over interior vertices = 2πχ. */
function totalDefect(mesh: TriMesh): number {
  const sums = new Array<number>(mesh.vertices.length).fill(0);
  for (let f = 0; f < mesh.faces.length; f++) {
    const angles = faceAngles(mesh, f);
    for (let c = 0; c < 3; c++) sums[mesh.faces[f][c]] += angles[c];
  }
  return sums.reduce((acc, s) => acc + (TAU - s), 0);
}

describe("buildTopology", () => {
  it("cube: V=8, E=18, F=12, χ=2, closed", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    expect(cube.vertices.length).toBe(8);
    expect(topo.edges.length).toBe(18);
    expect(cube.faces.length).toBe(12);
    expect(eulerCharacteristic(cube, topo)).toBe(2);
    expect(topo.boundaryVertices.size).toBe(0);
    expect(countBoundaryLoops(cube, topo)).toBe(0);
  });

  it("cube fans: every vertex fan covers its incident faces in adjacency order", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    for (let v = 0; v < cube.vertices.length; v++) {
      const fan = topo.vertexFaces[v];
      expect(fan.length).toBeGreaterThanOrEqual(4); // cube corners: 4 or 5 triangles
      // Consecutive fan faces share an edge through v.
      for (let i = 0; i < fan.length; i++) {
        const f1 = cube.faces[fan[i]];
        const f2 = cube.faces[fan[(i + 1) % fan.length]];
        const shared = f1.filter((x) => f2.includes(x));
        expect(shared).toContain(v);
        expect(shared.length).toBe(2);
      }
    }
  });

  it("icosphere(1): V=42, E=120, F=80, χ=2; every edge interior", () => {
    const sphere = makeIcosphere(1);
    const topo = buildTopology(sphere);
    expect(sphere.vertices.length).toBe(42);
    expect(topo.edges.length).toBe(120);
    expect(sphere.faces.length).toBe(80);
    expect(eulerCharacteristic(sphere, topo)).toBe(2);
    for (const e of topo.edges) expect(e.faces.length).toBe(2);
  });

  it("open mesh: boundary vertices and one boundary loop detected", () => {
    // Single quad (2 triangles) — a disk: χ = 1, one boundary loop.
    const quad: TriMesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      faces: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    };
    const topo = buildTopology(quad);
    expect(eulerCharacteristic(quad, topo)).toBe(1);
    expect(countBoundaryLoops(quad, topo)).toBe(1);
    expect(topo.boundaryVertices.size).toBe(4);
  });

  it("rejects inconsistent winding (duplicated directed edge)", () => {
    const bad: TriMesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ],
      faces: [
        [0, 1, 2],
        [0, 1, 3], // traverses 0->1 again — same direction
      ],
    };
    expect(() => buildTopology(bad)).toThrow(PipelineError);
  });

  it("rejects a bowtie (non-manifold) vertex", () => {
    // Two triangles sharing only vertex 0.
    const bowtie: TriMesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: -1, y: -1, z: 0 },
      ],
      faces: [
        [0, 1, 2],
        [0, 3, 4],
      ],
    };
    expect(() => buildTopology(bowtie)).toThrow(/bowtie|fan/);
  });
});

describe("faceAngles", () => {
  it("equilateral triangle: all angles π/3", () => {
    const tri: TriMesh = {
      vertices: [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0.5, y: Math.sqrt(3) / 2, z: 0 },
      ],
      faces: [[0, 1, 2]],
    };
    const angles = faceAngles(tri, 0);
    for (const a of angles) expect(a).toBeCloseTo(Math.PI / 3, 12);
    expect(angles[0] + angles[1] + angles[2]).toBeCloseTo(Math.PI, 12);
  });
});

describe("Gauss–Bonnet audit (Σδ = 2πχ)", () => {
  it("holds on cube, tetrahedron, icosphere within 1e-9", () => {
    for (const mesh of [makeCube(), makeTetrahedron(), makeIcosphere(1)]) {
      expect(totalDefect(mesh)).toBeCloseTo(2 * TAU, 9); // χ=2 ⇒ 4π
    }
  });
});
