/**
 * **Model facade** — planning and export operations used by the electronics UI.
 *
 * The view owns gestures and rendering. This facade is the small adapter-shaped
 * contract for the heavy model work it asks for: route, measure tape, and build
 * cutter files. Tests can replace it without importing the router into the UI.
 */
import type { FoldFile } from "./fold-file.js";
import type { Circuit, FlatFace, GapEdge, Vec2 } from "./electronics.js";
import {
  batteryTerminals,
  patternDiag,
  planRoutes,
  tapeMmFor,
  tapeWidthFor,
  type PartPlacement,
  type RoutedCircuit,
  type Terminals,
  type Trace2D,
} from "./electronics-routing.js";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  type CopperCarrierExport,
  type CopperSvgExport,
  type LedPads,
  type Mirror,
  type PlacedPartMark,
} from "./copper-svg-export.js";
import type { Jump } from "./trace-types.js";
import type { SheetSpec } from "./fold-strain.js";
import type { FoldAdjacency } from "./fold-adjacency.js";

export interface ElectronicsDesignAdapter {
  route(input: RouteCircuitInput): RoutedCircuit;
  tapeWidth(input: TapeMeasureInput): number;
  tapeMm(input: TapeMeasureInput): number;
  batteryTerminals(input: BatteryTerminalInput): Terminals;
  patternDiag(faces: FlatFace[]): number;
  strips(input: CopperExportInput): CopperSvgExport;
  carrier(input: CarrierExportInput): CopperCarrierExport;
}

export interface RouteCircuitInput {
  faces: FlatFace[];
  gaps: GapEdge[];
  circuit: Circuit;
  sheetMm?: number;
  sheet?: SheetSpec;
  /** Which cuts the folded artifact rejoins, so the declared nets may cross one. Absent routes without
   *  jumps, exactly as before — see `electronics-routing.ts › planRoutes`. */
  adjacency?: FoldAdjacency;
}

export interface TapeMeasureInput {
  faces: FlatFace[];
  sheetMm?: number;
  sheet?: SheetSpec;
  circuit?: Circuit;
}

export interface BatteryTerminalInput {
  centre: Vec2;
  diag: number;
  poly?: Vec2[];
  tapeW: number;
}

export interface CopperExportInput {
  fold: FoldFile;
  traces: Trace2D[];
  tapeW: number;
  baseName?: string;
  /** Deliberately the export's own parameter types, not the router's result types. `routedParts()` in
   *  the UI merges routed parts with FREE ones, which carry no net, so narrowing these to
   *  {@link PartPlacement} would reject a call the underlying function accepts. */
  pads?: LedPads[];
  mirror?: Mirror;
  sheetMm?: number;
  resistors?: { a: Vec2; b: Vec2 }[];
  switches?: { a: Vec2; b: Vec2; flip?: boolean }[];
  parts?: PlacedPartMark[];
  /** The jumps on this side. The carrier marks them; both files count them, since the count is the only
   *  place a file says there is copper still to be joined by hand. */
  jumps?: Jump[];
}

export interface CarrierExportInput extends CopperExportInput {
  keepOff?: Vec2[];
}

export const defaultElectronicsDesign: ElectronicsDesignAdapter = {
  route: ({ faces, gaps, circuit, sheetMm, sheet, adjacency }) =>
    planRoutes(faces, gaps, circuit, sheetMm, sheet, undefined, undefined, undefined, adjacency ?? null),
  tapeWidth: ({ faces, sheetMm, sheet, circuit }) => tapeWidthFor(faces, sheetMm, sheet, circuit),
  tapeMm: ({ faces, sheetMm, sheet, circuit }) => tapeMmFor(faces, sheetMm, sheet, circuit),
  batteryTerminals: ({ centre, diag, poly, tapeW }) => batteryTerminals(centre, diag, poly, tapeW),
  patternDiag,
  strips: ({ fold, traces, tapeW, baseName, pads, mirror, sheetMm, resistors, switches, parts, jumps }) =>
    buildCopperSvgExport(fold, traces, tapeW, baseName, pads, mirror, sheetMm, resistors, switches, parts, jumps),
  carrier: ({ fold, traces, tapeW, baseName, keepOff, mirror, sheetMm, pads, resistors, switches, parts, jumps }) =>
    buildCopperCarrierExport(
      fold, traces, tapeW, baseName, keepOff, mirror, sheetMm, pads, resistors, switches, parts, jumps,
    ),
};
