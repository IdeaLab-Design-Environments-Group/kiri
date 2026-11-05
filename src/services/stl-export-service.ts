/**
 * **Service** — resolves which mesh the STL export targets and builds its payload. Pure over its
 * inputs (no store, no DOM), so it is unit-testable in Node. Same "what you see is what you cut"
 * policy as the SVG export: export what the VIEWER is showing, falling back to the loaded fold.
 */
import { buildStlExport, type StlExport } from "../model/stl-export.js";
import type { LoadedModel } from "../model/fold-file.js";
import type { ShownModel } from "./sim-scene-service.js";
import { exportBaseName } from "./export-base-name.js";

export function resolveStlExport(
  model: LoadedModel | null,
  shown: ShownModel | null,
  heightUnits?: number | null,
  maxSubdiv?: number | null,
  inset?: number | null,
  printSize?: number | null,
): StlExport | null {
  const src = shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
  if (!src) return null;
  return buildStlExport(src.object, exportBaseName(src.name), heightUnits, maxSubdiv, inset, printSize);
}
