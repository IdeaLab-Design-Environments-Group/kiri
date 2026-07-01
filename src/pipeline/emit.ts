/**
 * FKLD emission (M4): classified sheet → FKLD file the viewer renders and
 * the simulator folds.
 *
 * Pattern: builder over the FKLD KEYS registry — `KEYS` from fkld/spec is
 * the single source of truth for every extension key (exactly how
 * fkld/bridge.coffee writes) — plus adapter at the TS/Coffee boundary: the
 * pipeline stays pure TS and only calls the published fkld validators.
 * (Rejected: extending bridge.foldNetToFkld — it is hard-coupled to the
 * pyramid KirigamiState.)
 *
 * The guided-fold contract (M5's linchpin): the file carries
 *   file_frames: [{ frame_classes: ["foldedForm"], vertices_coords: goal3D }]
 *   fkld:vertices_driven[i] = 1 for every sheet-boundary vertex (lips + ∂Q)
 * with goal3D[i] = Q.vertices[origVertex[i]] (mm) — exactly what
 * src/sim/fold-adapter.ts#applyGuidedFold consumes; this is the DETC
 * driven-boundary forward process from the algorithm spec.
 *
 * Verification semantics (honest scope): on coarse targets most sheet
 * vertices sit on a lip or ∂Q, so the driven fold positions them
 * kinematically and d_H alone would be trivial. Stage-5 therefore verifies
 * through residuals the drive cannot fake: bar STRAIN at the settled pose
 * (the isometry oracle — a non-isometric unfold/packing strains bars) and
 * the CREASE-ANGLE residual (measured θ from actual face normals vs the
 * goal dihedral — catches M/V misassignment), plus d_H over any free
 * interior vertices. (A free-lip mechanical fold was tried and reverted:
 * without collision handling the explicit solver settles in frustrated
 * mirror equilibria — future work.)
 *
 * Tuck annotation (metadata-only, honest scope): tucked δ>0 vertices get
 * Tachi molecule parameters θ = δ(v)/N and w = 2·s̄·sin(θ/2) on their
 * incident interior edges; full Origamizer Voronoi tuck crease generation
 * is deferred.
 */

import { KEYS, validateEdgeCutTypes, validateMoleculeArrays } from "@dayangac/fkld";
import { computeTheta, computeW } from "@kirigami/model/geometry.js";
import type { FoldFile } from "../model/fold-file.js";
import { edgeLength } from "./mesh.js";
import {
  PipelineError,
  type CutPlan,
  type DefectReport,
  type MeshTopology,
  type Sheet,
  type TriMesh,
} from "./types.js";

/** Per-vertex driven flag key (consumed by src/sim/fold-adapter.ts). */
export const DRIVEN_KEY = "fkld:vertices_driven";

export interface EmitOptions {
  creator?: string;
  /** Source (Q) vertex ids handled by molecule tucking instead of cuts. */
  tuckSet?: number[];
  defects: DefectReport;
  /** Conditioned target Q (mm) — supplies the foldedForm goal frame. */
  target: TriMesh;
  /** Topology of Q (tuck math: vertex degree, mean incident edge length). */
  topo: MeshTopology;
  /** planCuts per-vertex actions → fkld:vertices_reliefStrategy. */
  actions?: CutPlan["perVertexAction"];
  lambda?: number;
  strategy?: string;
}


export function emitFkld(sheet: Sheet, opts: EmitOptions): FoldFile {
  const { defects, target, topo } = opts;
  const nV = sheet.vertices.length;
  const nE = sheet.edges.length;

  // --- standard FOLD arrays -------------------------------------------------
  const vertices_coords = sheet.vertices.map((p) => [p.x, p.y]);
  const edges_vertices = sheet.edges.map((e) => [e.a, e.b] as [number, number]);
  const edges_assignment = [...sheet.assignment];
  // FOLD edges_foldAngle is in DEGREES; AKDE sign convention (M+, V−).
  const edges_foldAngle = sheet.foldAngle.map((t) => (t === null ? null : (t * 180) / Math.PI));
  const faces_vertices = sheet.faces.map((f) => [...f]);

  // --- FKLD per-vertex arrays (provenance through origVertex; synthesized
  // vent vertices carry origVertex −1 → defect 0 / class "boundary") --------
  const angleDefect = sheet.origVertex.map((src) => (src >= 0 ? defects.defects[src] : 0));
  const curvatureClass = sheet.origVertex.map((src) => (src >= 0 ? defects.classes[src] : "boundary"));
  const reliefStrategy = sheet.origVertex.map((src) => {
    const action = src >= 0 ? (opts.actions?.[src] ?? "none") : "none";
    return action === "tuck" ? "molecule" : action === "none" ? "none" : "cut";
  });

  // --- molecule tuck annotation ---------------------------------------------
  const moleculeTheta = new Array<number | null>(nE).fill(null);
  const moleculeWidth = new Array<number | null>(nE).fill(null);
  for (const v of opts.tuckSet ?? []) {
    const degree = topo.vertexEdges[v].length;
    if (degree === 0) continue;
    const theta = computeTheta(defects.defects[v], degree);
    const sBar = topo.vertexEdges[v].reduce((acc, e) => acc + edgeLength(target, topo, e), 0) / degree;
    const width = computeW(sBar, theta);
    for (let e = 0; e < nE; e++) {
      if (sheet.assignment[e] === "B" || sheet.assignment[e] === "C") continue;
      const srcA = sheet.origVertex[sheet.edges[e].a];
      const srcB = sheet.origVertex[sheet.edges[e].b];
      if (srcA === v || srcB === v) {
        moleculeTheta[e] = theta;
        moleculeWidth[e] = width;
      }
    }
  }

  // --- guided-fold goal frame (goalPos carries synthesized vent vertices) ---
  const goal3D = sheet.goalPos.map((p) => [p.x, p.y, p.z]);
  // Every sheet-boundary vertex (lips + ∂Q) is driven — the DETC forward
  // process. Interior vertices stay free and relax (see module doc for why
  // verification leans on strain + crease residuals rather than d_H alone).
  const driven = new Array<number>(nV).fill(0);
  for (let e = 0; e < nE; e++) {
    if (sheet.assignment[e] === "B" || sheet.assignment[e] === "C") {
      driven[sheet.edges[e].a] = 1;
      driven[sheet.edges[e].b] = 1;
    }
  }

  const file: FoldFile = {
    file_spec: 1.2,
    file_creator: opts.creator ?? "Kiro",
    file_classes: ["creasePattern"],
    frame_title: "Kirigamize output",
    frame_classes: ["creasePattern"],
    frame_attributes: ["2D"],
    frame_unit: "mm",
    vertices_coords,
    edges_vertices,
    edges_assignment,
    edges_foldAngle,
    faces_vertices,
    [KEYS.edges.cutType]: [...sheet.cutType],
    [KEYS.edges.dihedralTarget]: [...sheet.foldAngle],
    [KEYS.edges.moleculeTheta]: moleculeTheta,
    [KEYS.edges.moleculeWidth]: moleculeWidth,
    [KEYS.vertices.angleDefect]: angleDefect,
    [KEYS.vertices.curvatureClass]: curvatureClass,
    [KEYS.vertices.reliefStrategy]: reliefStrategy,
    [KEYS.meta.architecture]: {
      scaleMeters: 0.001,
      source: "kirigamize",
      lambda: opts.lambda ?? 0,
      strategy: opts.strategy ?? "dart",
      // The rectangle of paper this kirigami is cut from (K3).
      sheet: { ...sheet.sheetRect },
    },
    [DRIVEN_KEY]: driven,
    file_frames: [
      {
        frame_classes: ["foldedForm"],
        frame_attributes: ["3D"],
        frame_unit: "mm",
        vertices_coords: goal3D,
      },
    ],
  };

  // --- self-validation before return -----------------------------------------
  const cutRes = validateEdgeCutTypes(edges_assignment, file[KEYS.edges.cutType]);
  if (!cutRes.ok) {
    throw new PipelineError("emit", `cut-subtype validation failed: ${cutRes.errors[0]?.message}`, cutRes.errors);
  }
  const molRes = validateMoleculeArrays(edges_vertices, {
    theta: moleculeTheta,
    width: moleculeWidth,
  });
  if (!molRes.ok) {
    throw new PipelineError("emit", `molecule validation failed: ${molRes.errors[0]?.message}`, molRes.errors);
  }

  return file;
}
