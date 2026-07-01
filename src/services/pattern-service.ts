/**
 * **Service** — the single facade over BOTH pattern-creation paths:
 *   1. the general mesh→pattern pipeline (M1–M5, `src/pipeline/`), and
 *   2. the transferred AKDE creation pipeline (`@kirigami/model`).
 *
 * Both return the same narrow `PatternOutcome`, so the controller (and any
 * future caller) never touches `KirigamizeResult`'s stage intermediates —
 * that shape stays a pipeline/test contract, narrowed here.
 */
import { AppError } from "../core/errors.js";
import type { FoldFile } from "../model/fold-file.js";
// General mesh→pattern pipeline (M1–M5).
import { kirigamizeText } from "../pipeline/kirigamize.js";
// Transferred AKDE creation pipeline: inputs → KirigamiState → FKLD pattern.
import { computeState, defaultInputs } from "@kirigami/model/geometry.js";
import { buildFkldFile } from "@kirigami/model/fkld-export.js";
// Secondary "draw a crease pattern" path: a painted lattice → triangulated FOLD draft.
import { gridToFold, type FoldDraft, type PatternGrid } from "../model/pattern-grid.js";
import { KEYS, serializeFkld } from "@dayangac/fkld";

export interface PatternOutcome {
  fkld: FoldFile;
  name: string;
  /** Human-readable result line for the status channel. */
  summary: string;
  /** False when verification ran and did NOT converge. */
  ok: boolean;
}

/**
 * Run the general pipeline on mesh text: condition → curvature → plan cuts →
 * seamed unfold → pack/classify → emit FKLD → fold in the sim and verify d_H.
 * Throws PipelineError (an AppError) on stage failure.
 */
export function kirigamizeMesh(text: string, ext: "obj" | "stl", sourceName: string): PatternOutcome {
  const result = kirigamizeText(text, ext, { verify: true });
  const name = sourceName.replace(/\.(obj|stl)$/i, "") + ".fkld";
  const r = result.report;
  const cuts = result.plan.cutEdges.length + result.unfold.reliefEdges.length;
  const vents = result.unfold.vents.length;
  // A pattern that doesn't free-fold is still usable: the viewer shows it at its folded GOAL pose
  // (a "guided" model). So that case is informational, not an error — only an outright verify/pipeline
  // failure (no report) is a problem.
  const verdict = r
    ? r.converged
      ? `folds from flat (d_H = ${r.foldFromFlat.dH.toFixed(2)} mm, ε = ${r.epsilon.toFixed(2)} mm)`
      : `shown at its folded form — guided (won't self-fold from flat; d_H = ${r.foldFromFlat.dH.toFixed(2)} mm)`
    : "unverified";
  return {
    fkld: result.fkld,
    name,
    summary:
      `Kirigamized "${sourceName}" → ${cuts} cuts${vents ? `, ${vents} vent(s)` : ""}, ` +
      `${result.sheet.faces.length} faces — ${verdict}.`,
    ok: true,
  };
}

/**
 * Generate an AKDE uniform-molecule pyramid via the transferred creation
 * pipeline: default inputs → KirigamiState → FKLD crease+cut pattern. The
 * result loads exactly like an imported FKLD (its `frame_title` carries the
 * N/L/H/T the guided sim recovers). Throws AppError("create") on failure.
 */
export function createAkdePyramid(): PatternOutcome {
  const fkld = buildFkldFile(computeState(defaultInputs())) as FoldFile | null;
  if (!fkld) throw new AppError("create", "Could not create the pyramid pattern.");
  return {
    fkld,
    name: "akde-pyramid.fkld",
    summary: "Created AKDE pyramid via the transferred creation pipeline. Open 3D Sim to fold it.",
    ok: true,
  };
}

// ---- secondary path: pattern editor (a painted lattice → FKLD) -------------

/**
 * Wrap a pattern-editor lattice into a canonical FKLD `FoldFile`: the
 * triangulated FOLD draft from {@link gridToFold} plus the `fkld:` extensions
 * the rest of the shell understands (cut subtype on C edges, a minimal
 * architecture block). The standard FOLD subset is exactly what the viewer and
 * the free-fold 3D Sim consume — M/V default to ∓π, so it folds as drawn.
 */
export function fkldFromPatternGrid(grid: PatternGrid): PatternOutcome {
  const draft = gridToFold(grid);
  const stem = `pattern-${grid.cols}x${grid.rows}`;
  const fkld = patternDraftToFkld(draft, grid, stem);
  const { M, V, B, C, F } = draft.counts;
  return {
    fkld,
    name: `${stem}.fkld`,
    ok: true,
    summary:
      `Pattern editor → ${grid.cols}×${grid.rows} grid: ${M} mountain, ${V} valley, ` +
      `${C} cut, ${B} boundary, ${F} facet edges over ${draft.faces_vertices.length} faces. ` +
      `Open 3D Sim to fold it.`,
  };
}

/** Serialize the editor's pattern to a downloadable `.fkld` payload (filename + JSON text). */
export function serializePatternGrid(grid: PatternGrid): { filename: string; text: string } {
  const draft = gridToFold(grid);
  const stem = `pattern-${grid.cols}x${grid.rows}`;
  return { filename: `${stem}.fkld`, text: serializeFkld(patternDraftToFkld(draft, grid, stem)) };
}

function patternDraftToFkld(
  draft: FoldDraft,
  grid: PatternGrid,
  title: string,
  foldAngleDeg?: (number | null)[],
): FoldFile {
  const out: FoldFile = {
    file_spec: 1.2,
    file_creator: "Kiro pattern editor",
    file_classes: ["singleModel"],
    frame_title: title,
    frame_classes: ["creasePattern"],
    frame_unit: "mm",
    vertices_coords: draft.vertices_coords,
    edges_vertices: draft.edges_vertices,
    edges_assignment: draft.edges_assignment,
    faces_vertices: draft.faces_vertices,
  };
  // Explicit target fold angles (deg) — e.g. some walls fold to ±90°, not the
  // M/V default of ±180°. The sim reads `edges_foldAngle` over the assignment default.
  if (foldAngleDeg && foldAngleDeg.some((a) => a != null)) out.edges_foldAngle = foldAngleDeg;
  // Only emit the cut-subtype array when there are cuts to describe.
  if (draft.cutType.some((c) => c != null)) out[KEYS.edges.cutType] = draft.cutType;
  out[KEYS.meta.architecture] = {
    scaleMeters: 0.001,
    materialThickness: 0.3,
    sourcePattern: { cols: grid.cols, rows: grid.rows, cellLength: grid.cellMm },
  };
  return out;
}
