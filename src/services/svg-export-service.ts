/**
 * **Service** — resolves which pattern the SVG export targets and builds its payload. Pure over its
 * inputs (no store, no DOM), so it is unit-testable in Node. Policy mirrors the 3D Sim: export
 * exactly what the VIEWER is showing, falling back to the loaded fold model — "what you see is what
 * you cut".
 */
import { buildFkldSvgExport, type SvgExportPayload } from "../model/fkld-svg-export.js";
import type { LoadedModel } from "../model/fold-file.js";
import type { ShownModel } from "./sim-scene-service.js";

export function resolveSvgExport(
  model: LoadedModel | null,
  shown: ShownModel | null,
): SvgExportPayload | null {
  const src = shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
  if (!src) return null;
  return buildFkldSvgExport(src.object, baseName(src.name));
}

function baseName(name: string): string {
  return name.replace(/\.(fkld|fold|json)$/i, "") || "kirigami";
}
