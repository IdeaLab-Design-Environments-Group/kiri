/**
 * **View helper** — turning a planned side into a cutting file, and into the sentence said about it.
 *
 * Split out of `electronics-modal.ts` when the editor gained a second side (see {@link ExportRequest}):
 * four export buttons rather than two, and the two builders sat six hundred lines apart in a file already
 * over its size budget. Nothing here touches the DOM or the modal — a request in, a {@link ExportResult}
 * out — so the wording of every export line can be tested without standing up an editor, which is the same
 * reason `electronics-presenters.ts` exists next door.
 *
 * The *choice* of side stays in the modal: this module is told which one it is building for and says so in
 * the filename and the message, but knows nothing about how the editor holds two of them.
 */
import type { FoldFile } from "../model/fold-file.js";
import type { Vec2 } from "../model/electronics.js";
import type { Trace2D } from "../model/electronics-routing.js";
import type { LedPads, Mirror, PlacedPartMark } from "../model/copper-svg-export.js";
import type { ElectronicsDesignAdapter } from "../model/electronics-design.js";

/** Everything a cutting file is built from, gathered by the modal for one side. */
export interface ExportRequest {
  design: ElectronicsDesignAdapter;
  /** Null before a pattern is loaded — an export with no pattern is refused, not built empty. */
  fold: FoldFile | null;
  traces: Trace2D[];
  tapeW: number;
  /** Names the file and every sentence about it, so two files in a downloads folder are told apart. */
  side: string;
  mirror: Mirror;
  sheetMm?: number;
  pads?: LedPads[];
  resistors?: { a: Vec2; b: Vec2 }[];
  switches?: { a: Vec2; b: Vec2; flip?: boolean }[];
  parts?: PlacedPartMark[];
  keepOff?: Vec2[];
  /** Drawn wires on neither rail, which the strips file cannot carry — see {@link stripsExport}. */
  unlayeredWires?: number;
}

/**
 * A file to save and a line to say, or — when there was nothing to build — only the line.
 *
 * One shape for both outcomes rather than a null and a separate message, because every caller has to say
 * something either way: a refused export that printed nothing would look like a button that does not work.
 */
export interface ExportResult {
  filename?: string;
  svg?: string;
  message: string;
}

/** Says so when the file just saved is a mirror image, since the shape alone will not tell you. */
export function mirrorNote(mirror: Mirror): string {
  if (!mirror.x && !mirror.y) return "";
  const axes = [mirror.x ? "left-right" : "", mirror.y ? "top-bottom" : ""].filter(Boolean);
  return ` — mirrored ${axes.join(" and ")}`;
}

/** Two decimal places, the width a cut file is quoted to. */
function mm(widthMm: number): number {
  return Math.round(widthMm * 100) / 100;
}

/** Named so the refusal says which side is empty — with two of them, "nothing to export" alone is a puzzle. */
function nothingToExport(side: string): ExportResult {
  return { message: `Nothing to export on the ${side} — place a battery and at least one LED, or draw a wire` };
}

/**
 * The copper as separate strips to cut, one cut layer per rail.
 *
 * Hand-drawn copper counts toward "is there anything here": a sheet carrying only wires the author drew has
 * real copper on it, and refusing to export one while telling them to place a battery was blaming them for
 * a file we simply were not building.
 */
export function stripsExport(req: ExportRequest): ExportResult {
  if (!req.fold || !req.traces.length) return nothingToExport(req.side);
  const out = req.design.strips({
    fold: req.fold, traces: req.traces, tapeW: req.tapeW, baseName: `kiri-${req.side}`, pads: req.pads,
    mirror: req.mirror, sheetMm: req.sheetMm, resistors: req.resistors, switches: req.switches,
    parts: req.parts,
  });
  const { pwr, gnd } = out.counts;
  let message =
    `Exported ${out.filename} — ${pwr} PWR strip${pwr === 1 ? "" : "s"}, ` +
    `${gnd} GND strip${gnd === 1 ? "" : "s"}, ${mm(out.widthMm)}mm wide${mirrorNote(req.mirror)}`;
  // The strip width follows the pattern, and a flat pattern need not be at a physical scale.
  if (out.tooNarrow) message += " — too narrow to cut; scale the pattern up before cutting";
  // And the drawn wires this file could not take. The strips file cuts two layers, PWR and GND, and a wire
  // on neither is left out of it. Said out loud, with the way out, because the canvas has already shown the
  // author that copper and they would otherwise find it missing on the mat.
  const missed = req.unlayeredWires ?? 0;
  if (missed > 0) {
    message +=
      ` — warning: ${missed} drawn wire${missed === 1 ? " is" : "s are"} not in this file;` +
      ` the strips file cuts PWR and GND only, so draw a wire from a battery terminal to put it on a rail` +
      ` (the carrier file carries them all)`;
  }
  return { filename: out.filename, svg: out.svg, message };
}

/**
 * One carrier frame holding every trace in place: align it, stick the traces down, snip the tabs.
 *
 * Takes every trace, drawn ones included, whatever net they are on — unlike the strips file it holds runs
 * in a frame rather than sorting them onto two cut layers, so it has no rail to leave a wire off.
 */
export function carrierExport(req: ExportRequest): ExportResult {
  if (!req.fold || !req.traces.length) return nothingToExport(req.side);
  const out = req.design.carrier({
    fold: req.fold, traces: req.traces, tapeW: req.tapeW, baseName: `kiri-${req.side}`,
    keepOff: req.keepOff, mirror: req.mirror, sheetMm: req.sheetMm, pads: req.pads,
    resistors: req.resistors, switches: req.switches, parts: req.parts,
  });
  const { traces, tabs } = out.counts;
  let message =
    `Exported ${out.filename} — one frame holding ${traces} trace${traces === 1 ? "" : "s"}, ` +
    `${tabs} tab${tabs === 1 ? "" : "s"} to snip, ${mm(out.widthMm)}mm wide${mirrorNote(req.mirror)}`;
  if (out.padTabs > 0) {
    message += ` — ${out.padTabs} tab${out.padTabs === 1 ? "" : "s"} grip a pad (run too short to grip elsewhere)`;
  }
  if (out.componentTabs > 0) {
    message += ` — warning: ${out.componentTabs} tab${out.componentTabs === 1 ? "" : "s"} pass over a component`;
  }
  if (out.crossingTabs > 0) {
    message += ` — warning: ${out.crossingTabs} tab${out.crossingTabs === 1 ? "" : "s"} cross another trace`;
  }
  if (out.unclosedCuts > 0) {
    // The carrier is cut as a solid shape. Where a stretch of its edge would not close into a loop it is
    // drawn as a plain line instead: it still cuts, but that part arrives as line art rather than copper,
    // and in software that reads shapes it will look like an outline. Worth saying, since the file opens
    // looking almost right.
    message +=
      ` — ${out.unclosedCuts} cut${out.unclosedCuts === 1 ? "" : "s"} could not be closed into a shape` +
      ` and ${out.unclosedCuts === 1 ? "is" : "are"} drawn as ${out.unclosedCuts === 1 ? "a line" : "lines"}`;
  }
  if (out.tooNarrow) message += " — too narrow to cut; scale the pattern up before cutting";
  return { filename: out.filename, svg: out.svg, message };
}
