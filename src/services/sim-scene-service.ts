/**
 * **Service** — resolves which model the 3D Sim should fold and builds its
 * scene. Pure over its inputs (no store, no DOM), so it is trivially
 * unit-testable in Node: the policy is "fold exactly what the VIEWER is
 * showing, falling back to the loaded fold model" — keeping
 * "what you see is what gets simulated" true even when the viewer and the
 * convert panel differ.
 */
import { buildScene } from "../sim/index.js";
import type { FoldScene, SimMaterial } from "../sim/index.js";
import type { FoldFile, LoadedModel } from "../model/fold-file.js";

export interface ShownModel {
  object: FoldFile;
  name: string;
}

export function resolveSimScene(
  model: LoadedModel | null,
  shown: ShownModel | null,
  material: SimMaterial = "vinyl",
): { scene: FoldScene; title: string } | null {
  const src = shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
  if (!src) return null;
  const built = buildScene(src.object, material);
  return built
    ? { scene: built.scene, title: `${src.name} — ${built.material} · ${built.sim} sim (${built.mode})` }
    : null;
}
