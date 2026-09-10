/**
 * **Model** — the carrier cut file's annotation layer: what the copper's outline cannot say.
 *
 * The carrier is one piece of copper, so it is one layer of one colour, and black outlines alone do not
 * say where a part goes or which way round it faces. This draws that on top of the cut, in its own SVG
 * group, from the same {@link drawnParts} list both cut files number their designators from — so a part is
 * the same R1 on the strips file and on the carrier.
 *
 * **Nothing here is meant to be cut.** It is kept out of the `carrier` group precisely so it can be
 * switched off or deleted in the cutting software; a cutter set to follow every path in the file would cut
 * these too, which would sever the traces they are drawn on top of.
 *
 * It has its own file rather than living in `copper-svg-export.ts` because it is the layer that grows: it
 * is where anything the author needs told about the sheet ends up, and each addition otherwise lands in the
 * middle of the outline and tab code. {@link annotationLayer} is the only entry point, and it returns
 * markup — sheet millimetres throughout, like the rest of the cut files.
 */
import type { Vec2 } from "./electronics.js";
import type { Trace2D } from "./electronics-routing.js";
import type { Jump } from "./trace-types.js";
import { jumpLabels } from "./manual-jump.js";
import { PCB_COLOURS } from "./part-render.js";
import { type LedPads, type PlacedPartMark, drawnParts, partsLayer } from "./part-shapes.js";

/** Three decimals, the precision every cut file is written to. */
const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");

/**
 * How a jump is marked on the sheet, in sheet millimetres.
 *
 * The label is the designator size `part-render.ts` uses, so `J1` reads as the same class of annotation as
 * `R1` beside it, and it stands off its land the way a designator stands off its part. The ring is the one
 * size that follows the copper: it marks the land, which is cut a tape wide, so a fixed radius would sit
 * inside the land on a coarse pattern and swamp it on a fine one. The floor keeps it visible when the tape
 * is a fraction of a millimetre — which {@link CopperSvgExport.tooNarrow} says happens routinely.
 */
const JUMP_LABEL_MM = 1.5;
const JUMP_LABEL_OFF_MM = 1.2;
const JUMP_RING_TAPES = 0.75;
const JUMP_RING_MIN_MM = 0.6;
/** The dash, in millimetres: long enough to read as a link, short enough not to look like a cut line. */
const JUMP_DASH_MM = 1.2;

/**
 * The jumps: what has to be soldered once the sheet is folded, and which end goes with which.
 *
 * A jump is the one connection in the design that is **not** on this sheet. Its two solder lands are —
 * they are plain {@link Trace2D}s and are cut with the rest of the copper — but the wire between them
 * exists only in the folded artifact, across a cut whose lips the flat pattern may put 300mm apart. So
 * nothing in the cut file says the two lands belong together, and without that the file hands someone two
 * unexplained stubs of tape.
 *
 * Hence all three marks, and hence all three in the annotation layer rather than the cut: a dashed line
 * between the ends, which is the pairing (dashed, like the canvas's ratsnest, because it is a connection
 * that does not exist in the plane and must never read as tape); a ring on each land, because the land is
 * copper like any other run and nothing otherwise distinguishes it; and `J<n>` at both ends, which is the
 * name to look for with the soldering iron. The labels come from {@link jumpLabels}, the same function the
 * editor's canvas draws with, so a seam is `J1` on the screen and `J1` on the file.
 *
 * `scale` converts the pattern's units to sheet millimetres; `T` maps a flat point onto the sheet.
 */
export function jumpMarks(jumps: Jump[], tapeW: number, scale: number, T: (p: Vec2) => Vec2): string[] {
  const labels = jumpLabels(jumps);
  const ring = Math.max(tapeW * scale * JUMP_RING_TAPES, JUMP_RING_MIN_MM);
  const colour = PCB_COLOURS.componentLabel;
  const out: string[] = [];
  for (const [i, j] of jumps.entries()) {
    const a = T(j.a), b = T(j.b);
    out.push(
      `<path d="M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(b.x)} ${fmt(b.y)}" fill="none" stroke="${colour}" ` +
        `stroke-width="${fmt(JUMP_DASH_MM / 4)}" stroke-dasharray="${fmt(JUMP_DASH_MM)} ${fmt(JUMP_DASH_MM)}" />`,
    );
    for (const c of [a, b]) {
      out.push(
        `<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(ring)}" fill="none" stroke="${colour}" ` +
          `stroke-width="${fmt(JUMP_DASH_MM / 4)}" />`,
      );
      out.push(
        `<text x="${fmt(c.x + JUMP_LABEL_OFF_MM)}" y="${fmt(c.y - JUMP_LABEL_OFF_MM)}" fill="${colour}" ` +
          `font-family="sans-serif" font-size="${fmt(JUMP_LABEL_MM)}" text-anchor="middle" ` +
          `dominant-baseline="central">${labels[i] ?? ""}</text>`,
      );
    }
  }
  return out;
}

/**
 * The annotation layer: everything the editor's canvas shows that a cut line cannot say.
 *
 * The strips file separates PWR from GND by colour, so opening it tells you which strip is which and where
 * the parts go. The carrier could not: it is one piece of copper, which means one layer of one colour, and
 * black outlines alone do not say which run is positive, where the LED sits, or which way round it goes.
 *
 * So the strips file is drawn on top of it: each run filled in its net's colour, at the width it is cut, and
 * nothing else. The carrier is solid copper underneath, so the file reads as the strips export with the frame
 * and its tabs added — the same shapes, in the same colours, in the same places, on the piece they arrive on.
 *
 * Only the copper. Pad and terminal markers were tried here and taken out again: drawn over the strip they
 * merge with it into one red blob wider than the tape, and the cut line, which follows the strip alone, then
 * reads as an outline that does not fit its own shape.
 *
 * **This layer is not meant to be cut.** It is kept out of `carrier` precisely so it can be switched off or
 * deleted in the cutting software; a cutter set to follow every path in the file would cut these too, which
 * would sever the traces they are drawn on top of.
 */
export function annotationLayer(
  traces: Trace2D[],
  pads: LedPads[],
  resistors: { a: Vec2; b: Vec2 }[],
  switches: { a: Vec2; b: Vec2; flip?: boolean }[],
  tapeW: number,
  scale: number,
  T: (p: Vec2) => Vec2,
  parts: PlacedPartMark[] = [],
  /** The jumps to be soldered after folding — see {@link jumpMarks}. Their lands are copper and arrive in
   *  `traces`; what is drawn here is only which land goes with which. */
  jumps: Jump[] = [],
): string {
  const marks: string[] = [];

  // No copper here. The carrier IS the copper -- frame, tabs and traces are one piece, drawn as one filled
  // shape -- so redrawing each run on top of it in its net's colour said nothing the shape did not already
  // say and made the file read as though the nets were separate pieces laid over the frame. Only the parts
  // are left: where they go, and which way round.
  // The resistors, over the breaks they bridge. Drawn after the copper so a part reads as sitting on top of
  // the tape, which is how it goes down.
  marks.push(...partsLayer(drawnParts(resistors, switches, parts, pads), T));
  // After the parts: a jump's link crosses the sheet and would otherwise be drawn under a footprint it
  // happens to pass over.
  marks.push(...jumpMarks(jumps, tapeW, scale, T));

  if (!marks.length) return "";
  return `  <g id="annotation" stroke-linejoin="round">\n    ${marks.join("\n    ")}\n  </g>\n`;
}
