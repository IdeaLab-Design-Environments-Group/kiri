/**
 * FKLD export — bridges AKDE's KirigamiState to a downloadable .fkld
 * file. Sits alongside `svg-export.ts`: the SVG path is what the cutter
 * consumes, the FKLD path is what the architect archives, version-
 * controls, and re-loads later (or hands off to an external FOLD/CAD
 * tool, which sees the standard FOLD subset and ignores the `fkld:*`
 * extensions).
 *
 * Two public entry points:
 *
 *   `buildFkldFile(state)`     — builds the in-memory FKLD object.
 *                                Used by the on-screen metadata view
 *                                that treats FKLD as the canonical
 *                                description of the displayed pattern.
 *   `buildFkldDownload(state)` — wraps the file object in a serialized
 *                                download payload (filename + text).
 *
 * Splitting them lets the controller compute the FKLD object once per
 * recompute and reuse it for both display and export, instead of
 * rebuilding the FoldNet twice.
 */

import type { KirigamiState } from "./types.js";
import { buildFoldNet } from "../sim/foldnet.js";
import { foldNetToFkld, type FkldFile } from "./fkld-bridge.js";
import { serializeFkld } from "@dayangac/fkld";

/** A downloadable FKLD payload — filename + serialized JSON text. */
export interface FkldDownload {
  filename: string;
  text: string;
}

export type { FkldFile };

/**
 * Build the canonical FKLD object for a computed kirigami state. Returns
 * null when the state is missing so callers can use the same "nothing to
 * render" check as the rest of the pipeline.
 */
export function buildFkldFile(state: KirigamiState | null): FkldFile | null {
  if (!state) return null;
  const net = buildFoldNet(state);
  return foldNetToFkld(net, state);
}

/**
 * Build the FKLD download — serializes the FKLD object built by
 * `buildFkldFile` and stamps a filename. Accepts a precomputed FkldFile
 * (preferred path — the controller already cached one for display) or
 * falls back to building from state.
 *
 * `baseName` is the filename stem; the helper appends `.fkld`. Default
 * matches the SVG export so the two files sit together when extracted.
 */
export function buildFkldDownload(
  source: KirigamiState | FkldFile | null,
  baseName = "akde-kirigami",
): FkldDownload | null {
  const file: FkldFile | null = isFkldFile(source)
    ? source
    : buildFkldFile(source);
  if (!file) return null;
  return {
    filename: `${baseName}.fkld`,
    text: serializeFkld(file),
  };
}

function isFkldFile(value: unknown): value is FkldFile {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { vertices_coords?: unknown }).vertices_coords)
  );
}
