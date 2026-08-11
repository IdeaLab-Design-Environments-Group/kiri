/**
 * **Service** — resolves which flat pattern the LED electronics tool targets. Pure over its inputs (no
 * store, no DOM): same "what you see is what you get" policy as the sim/SVG services — operate on the
 * VIEWER's model, falling back to the loaded fold model.
 */
import type { LoadedModel } from "../model/fold-file.js";
import type { ShownModel } from "./sim-scene-service.js";

/** The flat pattern the electronics tool currently targets, or null if none is shown. */
export function resolveElectronicsTarget(
  model: LoadedModel | null,
  shown: ShownModel | null,
): ShownModel | null {
  return shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
}
