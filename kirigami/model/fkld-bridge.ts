/**
 * FoldNet + KirigamiState → FKLD JSON object.
 *
 * App glue ported 1:1 from the former `fkld/bridge.coffee`. It lives in the app
 * (not in the `@dayangac/fkld` package) because it is coupled to AKDE's runtime
 * FoldNet / KirigamiState types, not to the FKLD format itself — only the FKLD
 * *keys* come from the package; the geometry comes from `@kirigami`.
 *
 * Writes standard FOLD (vertices_coords mm, edges_vertices, edges_assignment,
 * faces_vertices) plus FKLD Step 2/3/6 extensions: edges_cutType (major/minor),
 * edges_moleculeTheta/Width on the V edges, edges_dihedralTarget per crease, and
 * a minimal meta_architecture block.
 */
import { KEYS } from "@dayangac/fkld";
import type { EdgeAssignment, FoldNet, FoldNetEdge } from "../sim/foldnet.js";
import type { KirigamiState } from "./types.js";

/**
 * Plain FKLD JSON object — a strict superset of FOLD 1.2. The standard FOLD
 * arrays are typed; the `fkld:*` extensions come through the index signature as
 * `unknown` (each is defined/validated by its module in `@dayangac/fkld`).
 */
export interface FkldFile {
  file_spec?: number;
  file_creator?: string;
  file_classes?: string[];
  vertices_coords: number[][];
  edges_vertices: [number, number][];
  edges_assignment: string[];
  faces_vertices: number[][];
  [fkldKey: string]: unknown;
}

/**
 * A "C" edge in the AKDE pyramid is either part of the apex-hole rim (major
 * cut absorbing positive curvature) or a molecule dart-mouth slit (minor cut).
 * Same threshold (1.4·rApex) and "both endpoints inside the rim" rule the
 * FoldNet builder used, so the subtype matches the topology that produced the
 * assignment in the first place.
 */
function classifyCutEdge(net: FoldNet, edge: FoldNetEdge): "major" | "minor" {
  const rApex = net.meta.rApex;
  if (!(rApex > 0)) return "minor";
  const threshold = rApex * 1.4;
  const a = net.vertices[edge.a];
  const b = net.vertices[edge.b];
  if (!a || !b) return "minor";
  const distA = Math.hypot(a.x, a.y);
  const distB = Math.hypot(b.x, b.y);
  return distA <= threshold && distB <= threshold ? "major" : "minor";
}

/**
 * Per-assignment fold target. M (mountain) → the interior dihedral γ that
 * brings the pyramid up; V (valley) → 0 (the molecule folds onto itself);
 * F/B/C → null (no driven crease).
 */
function dihedralTargetFor(assignment: EdgeAssignment, gamma: number): number | null {
  switch (assignment) {
    case "M":
      return gamma;
    case "V":
      return 0;
    default:
      return null;
  }
}

export interface FoldNetToFkldOptions {
  /** Overrides the default `file_creator = "AKDE"`. */
  creator?: string;
}

/**
 * Build the FKLD JSON object for the given FoldNet + KirigamiState pair.
 * Returns a plain object (not stringified) — `serializeFkld` from
 * `@dayangac/fkld` handles JSON encoding.
 */
export function foldNetToFkld(
  net: FoldNet,
  state: KirigamiState,
  options: FoldNetToFkldOptions = {},
): FkldFile {
  if (!net) throw new TypeError("foldNetToFkld: net is required");
  if (!state) throw new TypeError("foldNetToFkld: state is required");

  const creator = options.creator ?? "AKDE";

  // FoldNet coords were divided by the bounding-sphere radius for solver
  // conditioning; undo that here so exported coords are in mm.
  const scale = net.meta.scale;
  const invScale = scale > 0 ? 1 / scale : 1;

  // Flat pattern (z = 0) → emit 2D coords to keep the file compact.
  const vertices_coords = net.vertices.map((v) => [v.x * invScale, v.y * invScale]);
  const edges_vertices = net.edges.map((e) => [e.a, e.b] as [number, number]);
  const edges_assignment = net.edges.map((e) => e.assignment);
  const faces_vertices = net.faces.map((f) => [f[0], f[1], f[2]]);

  const cutType = net.edges.map((e) => (e.assignment === "C" ? classifyCutEdge(net, e) : null));

  // Uniform-pyramid: every molecule shares (θ, w), stored on the V edges so
  // future per-edge variation changes only the value, not the layout.
  const theta = net.edges.map((e) => (e.assignment === "V" ? state.theta : null));
  const width = net.edges.map((e) => (e.assignment === "V" ? state.w : null));
  const dihedralTarget = net.edges.map((e) => dihedralTargetFor(e.assignment, state.gamma));

  const out: FkldFile = {
    file_spec: 1.2,
    file_creator: creator,
    file_classes: ["creasePattern"],
    vertices_coords,
    edges_vertices,
    edges_assignment,
    faces_vertices,
  };

  // FKLD extension keys, dynamically keyed off the spec registry.
  out[KEYS.edges.cutType] = cutType;
  out[KEYS.edges.moleculeTheta] = theta;
  out[KEYS.edges.moleculeWidth] = width;
  out[KEYS.edges.dihedralTarget] = dihedralTarget;

  // Minimum architecture block — scale + material thickness external tools
  // need to interpret the millimetre coords.
  out[KEYS.meta.architecture] = {
    scaleMeters: 0.001,
    materialThickness: state.inputs.materialThickness,
    sourcePyramid: {
      edgeCount: state.inputs.edgeCount,
      edgeLength: state.inputs.edgeLength,
      apexHeight: state.H,
      slantLength: state.s,
    },
  };

  return out;
}
