/**
 * Discrete curvature (M2): the single source of truth for angle defects.
 *
 * Pattern: pure functions, single source of truth (AKDE geometry.ts
 * precedent) — δ(v) is computed here and nowhere else; every later stage
 * (planning, emit, verify) consumes the DefectReport.
 *
 * Formulas:
 *   δ(v) = 2π − Σᵢ αᵢ(v)                      (angle defect, discrete K)
 *   Σ_v δ(v) = 2πχ(Q)                          (Gauss–Bonnet budget)
 *   θ_e = atan2((n₁×ê)·n₂, n₁·n₂)              (signed dihedral, DETC Eq. 5;
 *                                               mountain positive, branch-safe)
 */

import { cross, dot, length, normalize, sub, type Vec3 } from "../core/vec3.js";
import { faceAngles } from "./mesh.js";
import type { DefectReport, MeshTopology, TriMesh } from "./types.js";

/** |δ| ≤ FLAT_EPS counts as flat (rad). */
export const FLAT_EPS = 1e-6;

/** Angle defect per vertex with curvature classification. */
export function angleDefects(mesh: TriMesh, topo: MeshTopology): DefectReport {
  const TAU = 2 * Math.PI;
  const sums = new Array<number>(mesh.vertices.length).fill(0);
  for (let f = 0; f < mesh.faces.length; f++) {
    const angles = faceAngles(mesh, f);
    for (let c = 0; c < 3; c++) sums[mesh.faces[f][c]] += angles[c];
  }
  const defects: number[] = [];
  const classes: DefectReport["classes"] = [];
  let totalDefect = 0;
  for (let v = 0; v < mesh.vertices.length; v++) {
    if (topo.boundaryVertices.has(v)) {
      // Defect sign is meaningless at a boundary; report 0 / "boundary".
      defects.push(0);
      classes.push("boundary");
      continue;
    }
    const d = TAU - sums[v];
    defects.push(d);
    totalDefect += d;
    classes.push(d > FLAT_EPS ? "positive" : d < -FLAT_EPS ? "negative" : "flat");
  }
  return { defects, classes, totalDefect };
}

function faceNormal(mesh: TriMesh, f: number): Vec3 {
  const [i, j, k] = mesh.faces[f];
  const p = mesh.vertices;
  return normalize(cross(sub(p[j], p[i]), sub(p[k], p[i])));
}

/**
 * Signed dihedral fold angle at interior edge e (rad): θ = atan2((n₁×ê)·n₂, n₁·n₂),
 * with ê oriented a→b as f₁ traverses it. Mountain (convex, normals splaying
 * outward) is positive — the AKDE solver convention. Returns 0 at flat edges.
 */
export function signedDihedral(mesh: TriMesh, topo: MeshTopology, e: number): number {
  const edge = topo.edges[e];
  if (edge.faces.length !== 2) {
    throw new Error(`signedDihedral: edge ${e} is not interior`);
  }
  const [f1, f2] = edge.faces;
  // Orient ê in the direction f1 traverses (a,b) so the sign is well defined.
  const [i, j, k] = mesh.faces[f1];
  const dir =
    (i === edge.a && j === edge.b) || (j === edge.a && k === edge.b) || (k === edge.a && i === edge.b);
  const pa = mesh.vertices[dir ? edge.a : edge.b];
  const pb = mesh.vertices[dir ? edge.b : edge.a];
  const eHat = normalize(sub(pb, pa));
  const n1 = faceNormal(mesh, f1);
  const n2 = faceNormal(mesh, f2);
  // Convert the geometric face-normal orientation into the solver convention:
  // mountain folds are positive, valley folds negative.
  return -Math.atan2(dot(cross(n1, eHat), n2), dot(n1, n2));
}

/**
 * Per-edge target fold angle for the flat pattern: the signed dihedral the
 * crease must reach so the sheet folds back into Q. Null on boundary edges.
 */
export function targetFoldAngles(mesh: TriMesh, topo: MeshTopology): (number | null)[] {
  return topo.edges.map((edge, e) => (edge.faces.length === 2 ? signedDihedral(mesh, topo, e) : null));
}
