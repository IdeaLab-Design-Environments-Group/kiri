/**
 * **Model** — how big a flat pattern actually is.
 *
 * A FOLD pattern carries coordinates but no units. Some of ours are authored at a physical size (puffin is
 * 182mm across); others are pure shape, a few units wide, and mean nothing in millimetres — house is 4.
 *
 * The rest of the app already agreed on what to do about that: a pattern with no scale of its own is the size
 * the STL export prints it, {@link DEFAULT_PRINT_SIZE}. The router relies on it — that is how it knows 3.25mm
 * copper tape is 0.1 of a unit wide on house — and the STL export relies on it, so a model printed for folding
 * and the same model taped for wiring come out the same size.
 *
 * The SVG exports did not, and declared house's sheet as 20mm: an 8mm margin and a 5mm carrier border around a
 * 4mm circuit, cut from strips a tenth of a millimetre wide. This is the missing conversion.
 */
import type { FoldFile } from "./fold-file.js";
import { DEFAULT_PRINT_SIZE } from "./stl-export.js";

/**
 * Pattern units per millimetre of cut: what to multiply flat coordinates by to get the sheet.
 *
 * `1` for a pattern already at a physical size — those are taken at their word, and a pattern larger than the
 * sheet is never shrunk to fit, since that would quietly cut it at a size nobody asked for.
 */
export function printScale(fold: FoldFile, sheetMm: number = DEFAULT_PRINT_SIZE): number {
  const coords = (fold.vertices_coords ?? []) as unknown[][];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of coords) {
    const x = Number(c[0]) || 0;
    const y = Number(c[1]) || 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return 1;
  const longest = Math.max(maxX - minX, maxY - minY);
  if (!(longest > 0)) return 1;
  // The same test the router's tape width uses, so the two cannot disagree about which patterns are
  // scale-less: both axes under the sheet is the same thing as the longer of them being under it.
  return longest < sheetMm ? sheetMm / longest : 1;
}
