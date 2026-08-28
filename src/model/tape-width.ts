/**
 * **Model** — how wide the copper is, and how much bare substrate has to survive beside it.
 *
 * ## Why this is its own file
 *
 * Two questions, and they are the same question twice: how wide is the tape, and how narrow may the gap
 * next to it get before the sheet cannot be weeded. Every clearance in the router is derived from the
 * first, and every refusal to seat a part from the second, so both have to have exactly one answer. When
 * they lived among the routing code, {@link netlist} and {@link net-routing} had to import the router to
 * ask, and the router imported them back.
 *
 * The rule to keep: a width is either a physical millimetre or a length in the pattern's own units, and
 * the two are converted in one place ({@link tapeWidthFor}, {@link weedGapFor}). A number that silently
 * changes unit is how the canvas, the folded preview and the cut file come to disagree while each stays
 * internally consistent.
 */
import type { Circuit, FlatFace } from "./electronics.js";
import { DEFAULT_PRINT_SIZE } from "./stl-export.js";
import {
  DEFAULT_SHEET,
  maxTraceWidthMm,
  minWebMm,
  type SheetSpec,
} from "./fold-strain.js";
import { CALIBRATED_DEMAND, tapeMmForDemand, traceDemand } from "./tape-demand.js";

/**
 * What crossing a mountain fold, a cut, or a valley folded past 170 degrees costs, as a fraction of the
 * pattern's bounding-box diagonal.
 *
 * Nakaya et al. use the whole diagonal, chosen to exceed any single step so a crease is crossed only when a
 * tile is reachable no other way. Their graph is one node per face; ours is many nodes per face, so the same
 * figure bites harder here.
 *
 * Swept: at the full diagonal, akde-decagon's mountain crossings fall 39 -> 23 but puffin gains a chip
 * violation, and a chip violation is destructive where a mountain crossing is only fragile. At half, nothing
 * regresses and most of the gain remains: akde-decagon 39 -> 25 with a third less copper, akde-hex's valley
 * crossings 13 -> 11.
 *
 * The penalty saturates: above some fraction every route is identical to the full-diagonal plan, so this
 * value only has to sit at or above that knee. **The knee was 0.15 and is 0.5 as of 2026-08-28**, when
 * `TAPE_MM` fell to 1.5 — narrower tape opens routes that a larger price is still needed to reject, so the
 * knee follows the tape down and now coincides exactly with this constant. There is no margin left: narrow
 * the tape again and this value may need raising. `crease-price.test.ts` pins the knee for that reason.
 */
export const FOLD_PENALTY_FRAC = 0.5;

/** How much dearer each previous use of a waypoint by the other net makes it, so the two nets take genuinely
 *  different routes instead of one shadowing the other.
 *
 *  Swept: 2 is the best value measured (overlap 7/3/2/2/2/2/24% across the bundled patterns). Removing it
 *  entirely doubles overlap on akde-decagon (7% -> 17%) and puffin (24% -> 36%), while raising it to 20 buys
 *  nothing further. It only became effective once a face could be crossed by a chord: with every path forced
 *  through the face centre there was no second route to divert onto, and the toll did nothing at any value. */

/**
 * Tape width in millimetres — the width of the copper tape actually being laid.
 *
 * The one definition. Every clearance in the router is derived from it, the preview draws it, and both export
 * files cut it — so widening the tape widens the keep-outs with it, instead of leaving the router planning for
 * a hairline while the cutter is asked for a real strip.
 *
 * Absolute, not a fraction of the pattern: a roll of copper tape is one width whatever it is stuck to, so the
 * strip the cutter is asked for has to be that width or it cannot be cut from the roll. The consequence is that
 * a pattern must be at a real physical scale for routing to mean anything — on a flat pattern only a few mm
 * across the tape is wider than the model and the keep-outs swallow it. Scale the pattern before routing.
 *
 * **1.5mm since 2026-08-28**, down from 3.25 (which was itself half the 6.5mm this started at). Two reasons,
 * and the second is why it moved again. 3.25mm strips still crowd these patterns — they take most of a tile
 * and leave the router little room — and against SMD parts they are simply the wrong size: an LED_1206's pad
 * is 1.40mm across and a XIAO's pins sit on a 2.54mm pitch, so full-width tape arriving at a pin is wider
 * than the pin and its neighbour's gap together. Narrower tape is also less of the surface stiffened, which
 * matters on a sheet meant to fold.
 *
 * 1.5mm is a stocked width, which is the constraint that matters: this is a roll of copper tape, not a line
 * width, and the cut file has to be cuttable from something you can buy.
 *
 * Not to be confused with `fold-strain.ts › STOCK_TAPE_MM`, whose floor is 3.25. That ladder is consulted
 * only under the opt-in `tapeChoice === "area"`, where a width is chosen per tile from crowding; its floor is
 * a calibration of that rule and not a claim about what rolls exist. The default path returns this constant
 * and never looks at the ladder.
 */
export const TAPE_MM = 1.5;

/**
 * The sheet a scale-less pattern is assumed to be cut at. Shared with the STL export's
 * `DEFAULT_PRINT_SIZE`, so a pattern printed for folding and a pattern taped for wiring agree on how big
 * "the model" is.
 */
export const PRINT_SHEET_MM = DEFAULT_PRINT_SIZE;

/**
 * Tape width **in the pattern's own units**.
 *
 * A pattern at or above sheet size is taken at its word: the file says how big the model is, so the tape is
 * the literal {@link TAPE_MM}. A pattern smaller than the sheet on BOTH axes carries no usable scale — it is
 * kirigamize output at unit scale, nominally "mm" — so it is read as though it will be cut at
 * {@link PRINT_SHEET_MM}, and the tape takes the matching fraction of its coordinates.
 *
 * Floor, never a normalisation: a pattern larger than the sheet is left alone. Shrinking it to sheet size
 * would make the tape coarser than the file intends, which measurably degrades routing on the large
 * patterns (akde-decagon picks up crossing tabs, puffin picks up copper over a chip).
 *
 * `circuit` is optional and is read only for how many runs it needs — see {@link widthMmFor}. **Every
 * caller that has a circuit should pass it**, because a site that omits it while another passes it gets a
 * different width for the same sheet, and the canvas, the folded preview and the cut file then disagree
 * silently, each internally consistent. Omitting it is right only where there is genuinely no circuit yet.
 */
export function tapeWidthFor(
  faces: FlatFace[],
  sheetMm: number = PRINT_SHEET_MM,
  sheet: SheetSpec = DEFAULT_SHEET,
  circuit?: Circuit,
): number {
  return tapeMmFor(faces, sheetMm, sheet, circuit) * unitsPerMm(faces, sheetMm);
}

/**
 * The tape's width in **millimetres** — the roll the cutter is actually asked for.
 *
 * The companion to {@link tapeWidthFor}, and the two must always be read together: every millimetre
 * figure in this codebase is converted to pattern units by the ratio between them. Using {@link TAPE_MM}
 * as that denominator while this returns something else is the one way to get a plan that looks right and
 * is the wrong size — the mistake this file's header warns about, made systematic.
 */
export function tapeMmFor(
  faces: FlatFace[],
  sheetMm: number = PRINT_SHEET_MM,
  sheet: SheetSpec = DEFAULT_SHEET,
  circuit?: Circuit,
): number {
  return widthMmFor(faces, unitsPerMm(faces, sheetMm), sheet, circuit);
}

/**
 * Pattern units per millimetre.
 *
 * A pattern at or above sheet size is taken at its word: the file says how big the model is, so a
 * millimetre is a unit. A pattern smaller than the sheet on BOTH axes carries no usable scale — it is
 * kirigamize output at unit scale, nominally "mm" — so it is read as though it will be cut at `sheetMm`.
 *
 * Floor, never a normalisation: a pattern larger than the sheet is left alone. Shrinking it to sheet size
 * would make the tape coarser than the file intends, which measurably degrades routing on the large
 * patterns (akde-decagon picks up crossing tabs, puffin picks up copper over a chip).
 *
 * **The longest axis, deliberately, because that is how the model is exported.** `buildStlExport` scales
 * the pattern so its longest XY dimension is the print size; deriving the router's scale any other way —
 * from area, say — would have the router and the cutter disagree about how big the model is.
 */
function unitsPerMm(faces: FlatFace[], sheetMm: number): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const p of f.poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return 1;
  const longest = Math.max(maxX - minX, maxY - minY);
  if (!(longest > 0)) return 1;
  return longest < sheetMm ? longest / sheetMm : 1;
}

/**
 * Which roll to plan for, in millimetres.
 *
 * Two ceilings, and the narrower wins.
 *
 * **The tile, and how much has to fit on it.** Under `tapeChoice: "area"` the model's own surface picks
 * the width: wider tape is better copper — less resistance, easier to lay, harder to lift — and what stops
 * it is crowding, which is relative to the tile it sits on rather than absolute. `sqrt(area / faces)` is
 * that tile, and it is where the total surface area of the model enters. Area alone would not do: the same
 * area cut into 96 tiles and into 10 are not the same sheet to lay tape on.
 *
 * The tile is only half the question, though, and `tape-demand.ts › tapeMmForDemand` is the other half:
 * a 40mm tile carrying one run and a 40mm tile carrying six are not the same tile either. `circuit` is how
 * the demand gets here, and it is **the circuit rather than a count** on purpose — a caller cannot pass a
 * stale demand, only a stale circuit, and a stale circuit is the thing every site that computes a width is
 * already written to avoid. Left out, the demand is `CALIBRATED_DEMAND`, which reproduces the tile-only
 * answer exactly.
 *
 * Under the default `"roll"` none of this is consulted and the answer is {@link TAPE_MM}, as it always was.
 *
 * **The hinge.** A strip splints the hinge it crosses, and the substrate's thickness bounds how much of
 * that it may add — {@link maxTraceWidthMm}, measured against the shortest crease, which is the one a
 * given width splints hardest. This does not bind on the sheets this system prints: 0.4mm of substrate
 * against 0.035mm of foil leaves it two orders of magnitude above any roll. It is computed anyway,
 * because "the roll governs" is only worth saying if something checked, and because a thin-film substrate
 * brings it down under the roll and this same code then routes differently with nobody editing it. The
 * bound goes as the cube of the substrate, so how thin that film has to be depends on the roll: at 3.25mm
 * tape 0.05mm of substrate was enough, and at 1.5mm it takes about 0.03mm. See `fold-strain.test.ts ›
 * narrows the tape itself when the sheet is too thin to carry it`.
 */
function widthMmFor(
  faces: FlatFace[],
  perMm: number,
  sheet: SheetSpec,
  circuit?: Circuit,
): number {
  let shortest = Infinity;
  let area2 = 0;
  for (const f of faces) {
    const n = f.poly.length;
    for (let i = 0; i < n; i++) {
      const a = f.poly[i]!, b = f.poly[(i + 1) % n]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > 0 && d < shortest) shortest = d;
      area2 += a.x * b.y - b.x * a.y; // shoelace, twice the signed area
    }
  }
  if (!Number.isFinite(shortest) || !(perMm > 0)) return TAPE_MM;
  const roll = sheet.tapeChoice === "area" && faces.length > 0
    ? tapeMmForDemand(
        Math.sqrt(Math.abs(area2) / 2 / faces.length) / perMm,
        circuit ? traceDemand(circuit) : CALIBRATED_DEMAND,
        sheet,
      )
    : TAPE_MM;
  return Math.min(roll, maxTraceWidthMm(shortest / perMm, sheet));
}


/**
 * Bare gap wanted between the two nets' copper under an LED, as a fraction of the tape width.
 *
 * A vinyl cutter has to be able to weed the strip between the pads, and the chip has to sit on bare substrate
 * rather than bridging its own two legs. Where the LED's legs are closer together than the tape is wide -- which
 * they are on the denser patterns, by up to 0.7mm -- the copper of the two nets would otherwise overlap under
 * the part and short it.
 */
export const LED_GAP_FRAC = 0.35;


/**
 * The weeding gap in a pattern's own units — {@link MIN_WEED_MM} converted by the tape's two widths.
 *
 * The one conversion, so that the floor a landing leaves and the floor a part is refused for are the same
 * physical strip of substrate. They were not: {@link MIN_WEED_MM} moved to the sheet on 2026-08-28 while
 * {@link padRoomFor} went on subtracting `tapeW * LED_GAP_FRAC`, and at 1.5mm tape that is 0.53mm against a
 * floor of 1.14mm — so a footprint could be refused as unweedable and, had it been accepted, given a landing
 * that left less than half the gap the refusal demanded.
 */
export function weedGapFor(tapeW: number, tapeMm: number, sheet: SheetSpec = DEFAULT_SHEET): number {
  if (!(tapeMm > 0) || !(tapeW > 0)) return tapeW * LED_GAP_FRAC;
  return (minWebMm(sheet) * tapeW) / tapeMm;
}

/**
 * The narrowest copper worth cutting, as a fraction of the tape width.
 *
 * Named rather than written as a bare `0.35` in two places. It is the same number as {@link LED_GAP_FRAC}
 * by coincidence of calibration, not by derivation — one is the bare gap to leave, the other the floor a
 * strip may be cut to — so they are separate constants and must stay separate.
 */
export const MIN_LAND_FRAC = 0.35;


/**
 * The narrowest strip of bare substrate this process can produce, in millimetres.
 *
 * The same 1.14mm this codebase has always cut to, said in millimetres rather than in tape widths, because a
 * footprint is in millimetres and the comparison has to happen in one unit or the other.
 *
 * **From the SHEET since 2026-08-28, not from the tape.** It used to read `TAPE_MM * LED_GAP_FRAC`, while
 * this docblock argued in the same breath that it "is not tape-relative in truth: a vinyl cutter's blade
 * does not know how wide the roll is". Both cannot be true, and the narrowing of `TAPE_MM` to 1.5mm is what
 * made the disagreement bite: the weeding floor followed the roll down to 0.53mm, which is a claim that a
 * thinner tape makes the substrate easier to weed.
 *
 * `fold-strain.ts › minWebMm` is the honest source — a web is a beam of substrate and what it can take goes
 * with its thickness — and it is anchored on `WEB_REF_MM = 1.1375`, recorded there as "= TAPE_MM *
 * LED_GAP_FRAC, the fixed figure this replaces". So the number is unchanged at the default sheet; only what
 * it depends on is.
 */
export const MIN_WEED_MM = minWebMm();

/** The part an LED is when its circuit does not say — every LED saved before they had a choice. */
