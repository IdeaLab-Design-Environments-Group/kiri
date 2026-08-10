/**
 * **Service** — resolves the LED electronics for the displayed pattern. Pure over
 * its inputs (no store, no DOM): same "what you see is what you route" policy as the
 * sim/SVG services — operate on the VIEWER's model, falling back to the loaded fold
 * model. The 2D interface gets a {@link RoutedCircuit} to draw; the SVG export gets
 * the same traces as a copper layer (see `svg-export-service`).
 */
import { planRoutes } from "../model/electronics-routing.js";
import type { Circuit, RoutedCircuit } from "../model/electronics.js";
import type { LoadedModel } from "../model/fold-file.js";
import type { ShownModel } from "./sim-scene-service.js";

/** The flat pattern the electronics tool currently targets, or null if none is shown. */
export function resolveElectronicsTarget(
  model: LoadedModel | null,
  shown: ShownModel | null,
): ShownModel | null {
  return shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
}

/** Plan the routed circuit for the displayed pattern, or null if nothing is shown. */
export function resolveRoutedCircuit(
  model: LoadedModel | null,
  shown: ShownModel | null,
  circuit: Circuit,
): RoutedCircuit | null {
  const src = resolveElectronicsTarget(model, shown);
  if (!src) return null;
  return planRoutes(src.object, circuit);
}
