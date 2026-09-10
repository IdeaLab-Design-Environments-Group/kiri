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
import { jumpLandTraces, manualJumps } from "../model/manual-jump.js";
import { foldAdjacency } from "../model/fold-adjacency.js";

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
  // Nothing to draw is nothing to plan for: the guard is what keeps an empty circuit from paying for a
  // route on every frame. A jump counts as content in its own right — it puts two solder lands on the
  // sheet and a ribbon across the seam — so a circuit whose only content is a jump must get past here,
  // or the one thing the author drew would be the one thing the folded model never shows.
  const bare =
    !circuit.leds.length && !circuit.battery && !circuit.wires?.length && !circuit.jumps?.length;
  if (!fold || bare) return [];
  try {
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces, tileGap).gaps;
    // Read once and shared by everything below: the pairing is a property of the pattern, not of the
    // circuit, and welding the goal frame is the expensive half of resolving a jump.
    const adjacency = foldAdjacency(fold, faces);
    const routed = planRoutes(faces, gaps, circuit, sheetMm, sheet, undefined, undefined, undefined, adjacency);
    const tapeW = tapeWidthFor(faces, sheetMm, sheet, circuit);
    const face = circuit.battery ? faces[circuit.battery.face] : null;
    const term = face
      ? batteryTerminals(face.centroid, patternDiag(faces), face.poly, tapeW)
      : null;
    const drawn = manualTraces({ faces, gaps, circuit, tapeW });
    const jumps = manualJumps({ faces, gaps, circuit, tapeW, adjacency });
    // The lands go in as ordinary copper (D8) so the overlay needs no branch for them; only the ribbon
    // between the two lips, which exists nowhere in the plane, is passed as a jump.
    const lands = jumpLandTraces(jumps, tapeW, faces);
    // The router's own jumps go over beside the author's: both are ribbons across a seam, and the overlay
    // has no reason to tell them apart. Their lands are already in `routed.traces` — `routeDeclaredNets`
    // lays them — so only the drawn ones are added here.
    return anchorOverlay(
      [...drawn, ...lands, ...routed.traces], routed.pads, term, tapeW, faces,
      [...jumps, ...(routed.jumps ?? [])],
    );
  } catch {
    return [];
  }
}
