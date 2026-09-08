/**
 * **Service** — resolves which model the 3D Sim should fold and builds its
 * scene. Pure over its inputs (no store, no DOM), so it is trivially
 * unit-testable in Node: the policy is "fold exactly what the VIEWER is
 * showing, falling back to the loaded fold model" — keeping
 * "what you see is what gets simulated" true even when the viewer and the
 * convert panel differ.
 */
import { buildScene } from "../sim/index.js";
import type { BuiltScene, FoldScene, SimMaterial } from "../sim/index.js";
import type { FoldFile, LoadedModel } from "../model/fold-file.js";

/**
 * Building a scene includes cut splitting, triangulation, solver allocation and collision setup. On a
 * large pattern that is far more expensive than swapping the Three.js meshes, and the Vinyl/Printed
 * tabs used to repeat all of it on every click. Keep one scene per source object and material; FoldFile
 * objects are replaced (rather than mutated) when a different model is loaded, so a WeakMap gives the
 * cache exactly the same lifetime as the model without retaining old uploads.
 */
const sceneCache = new WeakMap<FoldFile, Map<SimMaterial, BuiltScene | null>>();

function cachedScene(fold: FoldFile, material: SimMaterial): BuiltScene | null {
  let byMaterial = sceneCache.get(fold);
  if (!byMaterial) {
    byMaterial = new Map();
    sceneCache.set(fold, byMaterial);
  }
  if (!byMaterial.has(material)) byMaterial.set(material, buildScene(fold, material));
  const built = byMaterial.get(material) ?? null;
  if (!built) return null;

  // A scene is mutable while it is being simulated. Reusing its expensive topology/collision data is
  // safe only after restoring the dynamic buffers, and also preserves the old Reset/tab semantics.
  const { model, solver } = built.scene;
  model.position.set(model.rest);
  model.velocity.fill(0);
  model.force.fill(0);
  model.collide?.hash.clear();
  if (model.guideWeight !== undefined) model.guideWeight = 1;
  model.guideScratchFold = undefined;
  solver.foldPercent = 0;
  solver.theta.fill(0);
  return built;
}

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
  const built = cachedScene(src.object, material);
  return built
    ? { scene: built.scene, title: `${src.name} — ${built.material} · ${built.sim} sim (${built.mode})` }
    : null;
}
