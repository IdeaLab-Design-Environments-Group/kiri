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
  /** Called with {@link PLANNING_ROUTES} while the plan for these inputs runs elsewhere (overlay empty). */
  onBusy?: (message: string) => void;
  /** Called when a plan that ran elsewhere has landed and is still current: ask again to get it. */
  onPlanned?: () => void;
}

/**
 * Turns a circuit into folded copper: on the spot ({@link resolveFoldedCopperOverlay}), or later, off the
 * page (a Web Worker, see `folded-overlay-worker.ts`). A later plan reports a failed plan's warning through
 * `onWarning` before it resolves; a rejection is a plan that never finished.
 */
export type FoldedOverlayPlanner = (input: FoldedOverlayInput) => AnchoredMesh[] | Promise<AnchoredMesh[]>;

/** The data half of {@link FoldedOverlayInput}: what a plan reads, and all of it structured-cloneable. */
export type FoldedOverlayJob = Pick<FoldedOverlayInput, "fold" | "circuit" | "tileGap" | "sheetMm" | "sheet">;

/** What a plan run elsewhere sends back. */
export interface FoldedOverlayReply {
  traces: AnchoredMesh[];
  warning: string | null;
}

/** The status line while the folded copper is being planned off the page. */
export const PLANNING_ROUTES = "Planning routes…";

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
 *  its own last plan. Planned on the page unless `plan` is a background planner (the browser app passes a
 *  Web Worker's; tests and Node have no Worker and keep the synchronous default). */
export function createElectronicsPlanning(
  plan: FoldedOverlayPlanner = resolveFoldedCopperOverlay,
): ElectronicsPlanningAdapter {
  return { foldedOverlay: memoizeFoldedOverlay(plan) };
}

/** Same inputs, by identity — see {@link memoizeFoldedOverlay}. */
function sameInputs(a: FoldedOverlayInput, b: FoldedOverlayInput): boolean {
  return a.fold === b.fold
    && a.circuit === b.circuit
    && a.tileGap === b.tileGap
    && a.sheetMm === b.sheetMm
    && a.sheet === b.sheet;
}

/** Whether `circuit` puts any copper on the sheet. Parts count: a netlist of parts alone routes copper
 *  with no LED or battery on the sheet. */
function hasCopper(circuit: Circuit | null): boolean {
  return !!circuit && (!!circuit.leds.length || !!circuit.battery || !!circuit.wires?.length || !!circuit.parts?.length);
}

/** The warning for copper that could not be planned. */
function copperWarning(err: unknown): string {
  return `Copper could not be placed on the folded model: ${err instanceof Error ? err.message : String(err)}`;
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
 *
 * A `plan` that returns a promise runs elsewhere. Until it lands, asking with the same inputs reports
 * `onBusy` and returns nothing; once it lands, the caller that started it hears `onPlanned` and the next
 * ask returns it. Only the latest inputs count: asking with different ones abandons the running plan, and
 * its result is dropped when it arrives rather than painting one circuit's copper over another's.
 */
export function memoizeFoldedOverlay(
  plan: FoldedOverlayPlanner,
): (input: FoldedOverlayInput) => AnchoredMesh[] {
  let last: { input: FoldedOverlayInput; traces: AnchoredMesh[]; warning: string | null } | null = null;
  let running: { input: FoldedOverlayInput } | null = null;
  return (input) => {
    if (running && !sameInputs(running.input, input)) running = null;
    if (!(last && sameInputs(last.input, input))) {
      if (running) {
        input.onBusy?.(PLANNING_ROUTES);
        return [];
      }
      const leds = input.circuit?.leds.length ?? 0;
      if (!input.force && leds >= DEFERRED_OVERLAY_LEDS) {
        input.onDeferred?.(`${leds} LEDs: routing them takes a while, so the folded copper is planned on request. Press Folded form in Electronics to see it.`);
        return [];
      }
      let warning: string | null = null;
      // Nothing to route is answered here: not worth a trip to a worker, nor a "planning" line.
      const result = input.fold && hasCopper(input.circuit)
        ? plan({ ...input, onWarning: (message) => (warning = message) })
        : [];
      if (!Array.isArray(result)) {
        const job = { input };
        running = job;
        const land = (traces: AnchoredMesh[], warned: string | null) => {
          if (running !== job) return; // overtaken while it ran
          running = null;
          last = { input, traces, warning: warned };
          input.onPlanned?.();
        };
        result.then((traces) => land(traces, warning), (err) => land([], copperWarning(err)));
        input.onBusy?.(PLANNING_ROUTES);
        return [];
      }
      last = { input, traces: result, warning };
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
  if (!fold || !hasCopper(circuit)) return [];
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
    onWarning?.(copperWarning(err));
    return [];
  }
}

/** The data a plan reads, without the callbacks riding on `input`: a function does not survive
 *  `postMessage`. */
export function foldedOverlayJob({ fold, circuit, tileGap, sheetMm, sheet }: FoldedOverlayInput): FoldedOverlayJob {
  return { fold, circuit, tileGap, sheetMm, sheet };
}

/** Plan a job on this thread and package the result to be posted back: what the worker module runs. */
export function runFoldedOverlayJob(job: FoldedOverlayJob): FoldedOverlayReply {
  let warning: string | null = null;
  const traces = resolveFoldedCopperOverlay({ ...job, onWarning: (message) => (warning = message) });
  return { traces, warning };
}
