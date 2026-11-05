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
  /** Called with a short message when the copper could not be planned (the overlay is then empty). */
  onWarning?: (message: string) => void;
  /** Plan even a board of {@link DEFERRED_OVERLAY_LEDS} or more LEDs: the author asked for it. */
  force?: boolean;
  /** Called with a short message when a big board's plan is left until it is asked for (overlay empty). */
  onDeferred?: (message: string) => void;
}

/**
 * LED count from which the folded overlay is planned only on request, not on every render.
 *
 * Measured in issue #21 (one `planRoutes` call, one LED per hinge): at 4 LEDs no example pattern takes a
 * second, at 8 the hex already takes about 4.5 s, and by 12 puffin takes 28 s. Render runs on every store
 * update, so from 8 a status line or a slider move could freeze the page. The same count is where the
 * Electronics editor's Route button starts painting "routing…" first (`BUSY_FEEDBACK_LEDS`), so "slow"
 * means one thing in the app. House and church have fewer hinges than this and are never deferred.
 */
export const DEFERRED_OVERLAY_LEDS = 8;

/** The app's planning: the folded overlay, remembered between renders. One per controller, so each keeps
 *  its own last plan. */
export function createElectronicsPlanning(): ElectronicsPlanningAdapter {
  return { foldedOverlay: memoizeFoldedOverlay(resolveFoldedCopperOverlay) };
}

/**
 * `plan`, re-run only when one of its inputs is replaced.
 *
 * The controller asks on every store update, and most updates (a status line, the sim's detail) leave the
 * copper's inputs alone; a big board takes seconds to route. Inputs are compared by identity, which is
 * exact here because the store replaces a circuit or pattern on every change rather than mutating it. A
 * plan that failed is remembered with its warning, and the warning is repeated on every reuse, so a caller
 * sees the same thing whether or not the plan was re-run.
 *
 * A board of {@link DEFERRED_OVERLAY_LEDS} or more LEDs is not planned unless `force` is set; it reports
 * through `onDeferred` and returns nothing. That is not remembered, so the forced plan that follows is,
 * and later unforced calls with the same inputs reuse it.
 */
export function memoizeFoldedOverlay(
  plan: (input: FoldedOverlayInput) => AnchoredMesh[],
): (input: FoldedOverlayInput) => AnchoredMesh[] {
  let last: { input: FoldedOverlayInput; traces: AnchoredMesh[]; warning: string | null } | null = null;
  return (input) => {
    const same = last
      && last.input.fold === input.fold
      && last.input.circuit === input.circuit
      && last.input.tileGap === input.tileGap
      && last.input.sheetMm === input.sheetMm
      && last.input.sheet === input.sheet;
    if (!same) {
      const leds = input.circuit?.leds.length ?? 0;
      if (!input.force && leds >= DEFERRED_OVERLAY_LEDS) {
        input.onDeferred?.(`${leds} LEDs: routing them takes a while, so the folded copper is planned on request. Press Folded form in Electronics to see it.`);
        return [];
      }
      let warning: string | null = null;
      const traces = plan({ ...input, onWarning: (message) => (warning = message) });
      last = { input, traces, warning };
    }
    if (last!.warning !== null) input.onWarning?.(last!.warning);
    return last!.traces;
  };
}

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
  onWarning,
}: FoldedOverlayInput): AnchoredMesh[] {
  const circuit = stored ?? EMPTY_CIRCUIT;
  // Parts count: a netlist of parts alone routes copper with no LED or battery on the sheet.
  if (!fold || (!circuit.leds.length && !circuit.battery && !circuit.wires?.length && !circuit.parts?.length)) return [];
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
  } catch (err) {
    console.error(err);
    onWarning?.(`Copper could not be placed on the folded model: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
