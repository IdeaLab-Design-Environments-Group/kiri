/**
 * Sheet placement & classification (M4/K3): the flattened single-sheet
 * kirigami → one placed, classified pattern inside its paper rectangle.
 *
 * Pattern: functional core — placement is a pure translation (the K2 planner
 * guarantees ONE connected piece; multi-patch shelf packing is gone), and
 * classification is a deterministic mapping pinned by tests.
 *
 * Fold-angle targets are measured on the GOAL POSE (sheet faces + goalPos)
 * rather than looked up on source edges — uniform for synthesized vent
 * vertices (origVertex −1) and exactly the dihedral the crease must reach.
 *
 * Cut-subtype mapping (deterministic):
 *   vent-boundary edges (from K1 VentRecords)        → "vent"
 *   lip edges with a δ>0 endpoint                    → "dart"
 *   remaining lip edges (zero-width slits that seal) → "seam"
 * The ∂Q-derived outline stays "B". ("minor"/"major" are retired from the
 * general pipeline — they remain AKDE-pyramid vocabulary.)
 */

import { buildTopology, edgeKey } from "./mesh.js";
import { FLAT_EPS, signedDihedral } from "./curvature.js";
import {
  PipelineError,
  type CutType,
  type DefectReport,
  type MeshTopology,
  type Sheet,
  type TriMesh,
  type UnfoldResult,
  type Vec2,
} from "./types.js";

export interface PackContext {
  /** Conditioned source mesh Q (mm). */
  mesh: TriMesh;
  /** Topology of Q. */
  topo: MeshTopology;
  /** Defect report of Q (drives cut subtypes). */
  defects: DefectReport;
}

/**
 * Place the single-sheet pattern in the positive quadrant with `marginMm` of
 * paper around it, derive sheet edges, classify (M/V/F/B/C + subtypes), and
 * attach goal-pose fold targets.
 */
export function placeSheet(unfold: UnfoldResult, ctx: PackContext, marginMm = 5): Sheet {
  const { topo, defects } = ctx;
  if (unfold.patchCount !== 1) {
    throw new PipelineError("route-seams", `expected one connected sheet, got ${unfold.patchCount} pieces`);
  }

  // --- placement: translate the pattern into the paper rectangle -----------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of unfold.flat) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const offX = marginMm - minX;
  const offY = marginMm - minY;
  const vertices: Vec2[] = unfold.flat.map((p) => ({ x: p.x + offX, y: p.y + offY }));
  const sheetRect = {
    widthMm: maxX - minX + 2 * marginMm,
    heightMm: maxY - minY + 2 * marginMm,
    marginMm,
  };

  // --- sheet edges (index-based; coincident slit lips stay distinct) -------
  const sheetTopo = buildTopology({
    vertices: vertices.map((p) => ({ x: p.x, y: p.y, z: 0 })),
    faces: unfold.faces,
  });

  // Goal-pose mesh: fold targets are dihedrals measured where the sheet must
  // land — well-defined for every interior edge incl. vent-split sub-edges.
  const goalMesh: TriMesh = { vertices: unfold.goalPos, faces: unfold.faces };

  // Edge-key lookups for classification.
  const lipKeys = new Map<string, number>(); // key → source edge id
  for (const lip of unfold.lips) {
    lipKeys.set(edgeKey(lip.lipA[0], lip.lipA[1]), lip.sourceEdge);
    lipKeys.set(edgeKey(lip.lipB[0], lip.lipB[1]), lip.sourceEdge);
  }
  const ventKeys = new Set<string>();
  for (const vent of unfold.vents) {
    for (const [a, b] of vent.ventEdges) ventKeys.add(edgeKey(a, b));
  }

  const assignment: Sheet["assignment"] = [];
  const foldAngle: Sheet["foldAngle"] = [];
  const cutType: Sheet["cutType"] = [];

  for (let e = 0; e < sheetTopo.edges.length; e++) {
    const edge = sheetTopo.edges[e];
    const key = edgeKey(edge.a, edge.b);
    if (edge.faces.length === 1) {
      if (ventKeys.has(key)) {
        assignment.push("C");
        foldAngle.push(null);
        cutType.push("vent");
      } else if (lipKeys.has(key)) {
        assignment.push("C");
        foldAngle.push(null);
        cutType.push(lipSubtype(topo, defects, lipKeys.get(key)!));
      } else {
        assignment.push("B"); // original ∂Q boundary (cut from the sheet rect)
        foldAngle.push(null);
        cutType.push(null);
      }
    } else {
      const theta = signedDihedral(goalMesh, sheetTopo, e);
      assignment.push(theta > FLAT_EPS ? "M" : theta < -FLAT_EPS ? "V" : "F");
      foldAngle.push(theta);
      cutType.push(null);
    }
  }

  return {
    vertices,
    faces: unfold.faces,
    edges: sheetTopo.edges,
    assignment,
    foldAngle,
    cutType,
    origVertex: unfold.origVertex,
    goalPos: unfold.goalPos,
    lips: unfold.lips,
    vents: unfold.vents,
    patchOfFace: unfold.patchOfFace,
    sheetRect,
  };
}

/** Lip subtype: dart (δ>0 endpoint) or seam (zero-width slit that seals). */
export function lipSubtype(topo: MeshTopology, defects: DefectReport, sourceEdge: number): CutType {
  const { a, b } = topo.edges[sourceEdge];
  if (Math.max(defects.defects[a], defects.defects[b]) > FLAT_EPS) return "dart";
  return "seam";
}
