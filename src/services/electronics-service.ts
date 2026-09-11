/**
 * **Service** — resolves which flat pattern the LED electronics tool targets. Pure over its inputs (no
 * store, no DOM): same "what you see is what you get" policy as the sim/SVG services — operate on the
 * VIEWER's model, falling back to the loaded fold model.
 */
import type { LoadedModel } from "../model/fold-file.js";
import type { ShownModel } from "./sim-scene-service.js";
import {
  EMPTY_CIRCUIT,
  flatFaces,
  gapGraph,
  type Circuit,
} from "../model/electronics.js";
import {
  anchorOverlay,
  type AnchoredMesh,
} from "../model/trace-anchor.js";
import {
  batteryTerminals,
  patternDiag,
  planRoutes,
  tapeWidthFor,
} from "../model/electronics-routing.js";
import { DEFAULT_SHEET, type SheetSpec } from "../model/fold-strain.js";
import { manualTraces } from "../model/manual-wire.js";

/** The flat pattern the electronics tool currently targets, or null if none is shown. */
export function resolveElectronicsTarget(
  model: LoadedModel | null,
  shown: ShownModel | null,
): ShownModel | null {
  return shown ?? (model?.kind === "fold" ? { object: model.object, name: model.name } : null);
}

export interface ElectronicsPlanningAdapter {
  foldedOverlay(input: FoldedOverlayInput): AnchoredMesh[];
}

export interface FoldedOverlayInput {
  fold: ShownModel["object"] | null;
  circuit: Circuit | null;
  tileGap: number;
  sheetMm: number;
  sheet?: SheetSpec;
}

export const defaultElectronicsPlanning: ElectronicsPlanningAdapter = {
  foldedOverlay: resolveFoldedCopperOverlay,
};

/**
 * Planned and hand-drawn copper, pinned to the mesh for the folded preview.
 *
 * Pure over its inputs: the controller supplies state and the current print
 * size; this service owns the policy for turning a circuit into overlay meshes.
 */
export function resolveFoldedCopperOverlay({
  fold,
  circuit: stored,
  tileGap,
  sheetMm,
  sheet = DEFAULT_SHEET,
}: FoldedOverlayInput): AnchoredMesh[] {
  const circuit = stored ?? EMPTY_CIRCUIT;
  if (!fold || (!circuit.leds.length && !circuit.battery && !circuit.wires?.length)) return [];
  try {
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces, tileGap).gaps;
    const routed = planRoutes(faces, gaps, circuit, sheetMm, sheet);
    const tapeW = tapeWidthFor(faces, sheetMm, sheet, circuit);
    const face = circuit.battery ? faces[circuit.battery.face] : null;
    const term = face
      ? batteryTerminals(face.centroid, patternDiag(faces), face.poly, tapeW)
      : null;
    const drawn = manualTraces({ faces, gaps, circuit, tapeW });
    return anchorOverlay([...drawn, ...routed.traces], routed.pads, term, tapeW, faces);
  } catch {
    return [];
  }
}
