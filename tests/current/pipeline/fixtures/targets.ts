/**
 * Programmatic target-mesh fixtures (pattern: fixture factory functions).
 * All return TriMesh in mm; no file I/O in unit tests. Grown per milestone:
 * M1 cube/tetrahedron/icosphere; M2 saddle fan/octahedron/pyramid;
 * M5 saddle roof/Enneper patch.
 */

import type { TriMesh, Vec3 } from "../../../../src/pipeline/types.js";

/** Axis-aligned cube, CCW-out winding, triangulated. V=8 E=18 F=12 χ=2. */
export function makeCube(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: -s, y: -s, z: -s }, // 0
    { x: s, y: -s, z: -s }, // 1
    { x: s, y: s, z: -s }, // 2
    { x: -s, y: s, z: -s }, // 3
    { x: -s, y: -s, z: s }, // 4
    { x: s, y: -s, z: s }, // 5
    { x: s, y: s, z: s }, // 6
    { x: -s, y: s, z: s }, // 7
  ];
  // Quads with outward CCW winding, fan-triangulated.
  const quads: [number, number, number, number][] = [
    [0, 3, 2, 1], // z = -s (bottom, normal -z)
    [4, 5, 6, 7], // z = +s (top, normal +z)
    [0, 1, 5, 4], // y = -s
    [2, 3, 7, 6], // y = +s
    [1, 2, 6, 5], // x = +s
    [3, 0, 4, 7], // x = -s
  ];
  const faces: [number, number, number][] = [];
  for (const [a, b, c, d] of quads) faces.push([a, b, c], [a, c, d]);
  return { vertices, faces };
}

/** Regular tetrahedron. V=4 E=6 F=4 χ=2; δ(v) = π at every vertex. */
export function makeTetrahedron(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: s, y: s, z: s },
    { x: s, y: -s, z: -s },
    { x: -s, y: s, z: -s },
    { x: -s, y: -s, z: s },
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  return { vertices, faces };
}

/**
 * Icosphere: icosahedron with `subdiv` rounds of midpoint subdivision,
 * vertices projected to radius. subdiv=1: V=42 E=120 F=80 χ=2.
 */
export function makeIcosphere(subdiv = 1, radius = 50): TriMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let vertices: Vec3[] = [
    { x: -1, y: t, z: 0 }, { x: 1, y: t, z: 0 }, { x: -1, y: -t, z: 0 }, { x: 1, y: -t, z: 0 },
    { x: 0, y: -1, z: t }, { x: 0, y: 1, z: t }, { x: 0, y: -1, z: -t }, { x: 0, y: 1, z: -t },
    { x: t, y: 0, z: -1 }, { x: t, y: 0, z: 1 }, { x: -t, y: 0, z: -1 }, { x: -t, y: 0, z: 1 },
  ];
  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const project = (v: Vec3): Vec3 => {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: (v.x / l) * radius, y: (v.y / l) * radius, z: (v.z / l) * radius };
  };
  vertices = vertices.map(project);
  for (let r = 0; r < subdiv; r++) {
    const midCache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      let id = midCache.get(key);
      if (id === undefined) {
        const va = vertices[a];
        const vb = vertices[b];
        id = vertices.length;
        vertices.push(project({ x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: (va.z + vb.z) / 2 }));
        midCache.set(key, id);
      }
      return id;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { vertices, faces };
}

/**
 * Saddle fan: one interior vertex with δ < 0 — a hexagonal fan whose ring
 * alternates ±zAmp so the apex angle sum exceeds 2π. Disk (χ=1), ring is
 * boundary, center (vertex 0) is the negative-curvature terminal.
 */
export function makeSaddleFan(ringR = 50, zAmp = 20): TriMesh {
  const vertices: Vec3[] = [{ x: 0, y: 0, z: 0 }];
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    vertices.push({ x: ringR * Math.cos(a), y: ringR * Math.sin(a), z: i % 2 === 0 ? zAmp : -zAmp });
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < N; i++) faces.push([0, 1 + i, 1 + ((i + 1) % N)]);
  return { vertices, faces };
}

/** Regular octahedron. V=6 F=8 E=12 χ=2; δ(v) = 2π/3 > 0 at every vertex. */
export function makeOctahedron(size = 100): TriMesh {
  const s = size / 2;
  const vertices: Vec3[] = [
    { x: s, y: 0, z: 0 },
    { x: -s, y: 0, z: 0 },
    { x: 0, y: s, z: 0 },
    { x: 0, y: -s, z: 0 },
    { x: 0, y: 0, z: s },
    { x: 0, y: 0, z: -s },
  ];
  const faces: [number, number, number][] = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  return { vertices, faces };
}

/**
 * Open N-gon pyramid (lateral faces only, no base): apex (vertex 0) carries
 * the positive defect; the base ring is boundary.
 */
export function makePyramid(N = 4, L = 50, H = 30): TriMesh {
  const R = L / (2 * Math.sin(Math.PI / N));
  const vertices: Vec3[] = [{ x: 0, y: 0, z: H }];
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    vertices.push({ x: R * Math.cos(a), y: R * Math.sin(a), z: 0 });
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < N; i++) faces.push([0, 1 + i, 1 + ((i + 1) % N)]);
  return { vertices, faces };
}

/** Flat planar grid patch: every interior vertex flat; only boundary remains. */
export function makeGrid(nx = 4, ny = 4, cell = 25): TriMesh {
  const vertices: Vec3[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      vertices.push({ x: i * cell, y: j * cell, z: 0 });
    }
  }
  const id = (i: number, j: number): number => j * (nx + 1) + i;
  const faces: [number, number, number][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces };
}

/**
 * Saddle roof: coarse hyperbolic paraboloid z = (x² − y²)/c over a square —
 * every interior vertex has δ < 0 (M5 acceptance target).
 */
export function makeSaddleRoof(n = 4, size = 100, c = 100): TriMesh {
  const vertices: Vec3[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = (i / n - 0.5) * size;
      const y = (j / n - 0.5) * size;
      vertices.push({ x, y, z: (x * x - y * y) / c });
    }
  }
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const faces: [number, number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces };
}

/**
 * Enneper minimal-surface patch (K < 0 everywhere):
 *   x = u − u³/3 + uv²,  y = v − v³/3 + u²v,  z = u² − v²
 * sampled on a coarse grid over [−r, r]², scaled to mm (M5 acceptance target).
 */
export function makeEnneper(n = 4, r = 0.8, scaleMm = 50): TriMesh {
  const vertices: Vec3[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = (i / n - 0.5) * 2 * r;
      const v = (j / n - 0.5) * 2 * r;
      vertices.push({
        x: scaleMm * (u - (u * u * u) / 3 + u * v * v),
        y: scaleMm * (v - (v * v * v) / 3 + u * u * v),
        z: scaleMm * (u * u - v * v),
      });
    }
  }
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const faces: [number, number, number][] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces };
}

/**
 * Tent (prism roof): a grid folded along a raised middle ridge. Interior
 * ridge vertices are intrinsically FLAT (a fold is an isometry → δ = 0), so
 * the planner cuts nothing and they stay FREE in the sim — the fold must
 * actually lift them. The e2e target that exercises real relaxation.
 */
export function makeTent(nx = 4, width = 100, depth = 50, height = 30): TriMesh {
  const vertices: Vec3[] = [];
  const ys = [0, depth / 2, depth];
  const zs = [0, height, 0];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i <= nx; i++) {
      vertices.push({ x: (i / nx) * width, y: ys[j], z: zs[j] });
    }
  }
  const id = (i: number, j: number): number => j * (nx + 1) + i;
  const faces: [number, number, number][] = [];
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < nx; i++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
      faces.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  }
  return { vertices, faces };
}

/**
 * Double saddle fan: TWO interior δ<0 vertices sharing faces — the K1
 * multi-vent / dynamic-excess regression target. Vertex 0 (left) at
 * (−sep, 0, 0) and vertex 1 (right) at (+sep, 0, 0) sit inside an 8-vertex
 * ring of radius `ringR` whose z alternates ±zAmp (the saddle waves). Each
 * half of the ring fans to its nearest interior vertex; two bridge faces
 * across the interior edge 0–1 (apexed at the top and bottom ring vertices)
 * are shared by BOTH interior vertices. Disk (χ=1); ring is boundary; at the
 * defaults δ ≈ −1.124 rad at each interior vertex (verified in vents.test.ts).
 */
export function makeDoubleSaddleFan(sep = 25, ringR = 60, zAmp = 20): TriMesh {
  const A = 0; // left interior vertex
  const B = 1; // right interior vertex
  const vertices: Vec3[] = [
    { x: -sep, y: 0, z: 0 },
    { x: sep, y: 0, z: 0 },
  ];
  const N = 8;
  const r = (i: number): number => 2 + (((i % N) + N) % N);
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    vertices.push({ x: ringR * Math.cos(a), y: ringR * Math.sin(a), z: i % 2 === 0 ? zAmp : -zAmp });
  }
  // Ring index 2 sits at 90° (top), index 6 at 270° (bottom).
  const faces: [number, number, number][] = [
    // right fan (apex B): ring edges whose midpoint has x > 0
    [B, r(6), r(7)],
    [B, r(7), r(0)],
    [B, r(0), r(1)],
    [B, r(1), r(2)],
    // bridge faces sharing the interior edge A–B (top and bottom)
    [A, B, r(2)],
    [B, A, r(6)],
    // left fan (apex A): ring edges whose midpoint has x < 0
    [A, r(2), r(3)],
    [A, r(3), r(4)],
    [A, r(4), r(5)],
    [A, r(5), r(6)],
  ];
  return { vertices, faces };
}

/** Serialize a TriMesh as minimal OBJ text (round-trip test helper). */
export function toObj(mesh: TriMesh): string {
  const lines: string[] = [];
  for (const v of mesh.vertices) lines.push(`v ${v.x} ${v.y} ${v.z}`);
  for (const [i, j, k] of mesh.faces) lines.push(`f ${i + 1} ${j + 1} ${k + 1}`);
  return lines.join("\n") + "\n";
}

/** Serialize a TriMesh as ASCII STL (triangle soup — exercises welding). */
export function toAsciiStl(mesh: TriMesh): string {
  const lines: string[] = ["solid fixture"];
  for (const [i, j, k] of mesh.faces) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (const v of [mesh.vertices[i], mesh.vertices[j], mesh.vertices[k]]) {
      lines.push(`      vertex ${v.x} ${v.y} ${v.z}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid fixture");
  return lines.join("\n") + "\n";
}
