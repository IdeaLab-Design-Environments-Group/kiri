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
  type PadPair,
  type PartPlacement,
  type PartSpan,
  type RoutedCircuit,
  type Terminals,
  type Trace2D,
} from "./electronics-routing.js";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  type CopperCarrierExport,
  type CopperSvgExport,
  type Mirror,
} from "./copper-svg-export.js";
import type { SheetSpec } from "./fold-strain.js";

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
  pads?: PadPair[];
  mirror?: Mirror;
  sheetMm?: number;
  resistors?: PartSpan[];
  switches?: PartSpan[];
  parts?: PartPlacement[];
}

export interface CarrierExportInput extends CopperExportInput {
  keepOff?: Vec2[];
}

export const defaultElectronicsDesign: ElectronicsDesignAdapter = {
  route: ({ faces, gaps, circuit, sheetMm, sheet }) => planRoutes(faces, gaps, circuit, sheetMm, sheet),
  tapeWidth: ({ faces, sheetMm, sheet, circuit }) => tapeWidthFor(faces, sheetMm, sheet, circuit),
  tapeMm: ({ faces, sheetMm, sheet, circuit }) => tapeMmFor(faces, sheetMm, sheet, circuit),
  batteryTerminals: ({ centre, diag, poly, tapeW }) => batteryTerminals(centre, diag, poly, tapeW),
  patternDiag,
  strips: ({ fold, traces, tapeW, baseName, pads, mirror, sheetMm, resistors, switches, parts }) =>
    buildCopperSvgExport(fold, traces, tapeW, baseName, pads, mirror, sheetMm, resistors, switches, parts),
  carrier: ({ fold, traces, tapeW, baseName, keepOff, mirror, sheetMm, pads, resistors, switches, parts }) =>
    buildCopperCarrierExport(fold, traces, tapeW, baseName, keepOff, mirror, sheetMm, pads, resistors, switches, parts),
};
