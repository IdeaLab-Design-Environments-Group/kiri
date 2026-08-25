/**
 * **Model** — how wide the copper may be, given how much of it has to fit.
 *
 * The router's width used to be one number for the whole system: {@link TAPE_MM}, 3.25mm, a roll you buy.
 * `fold-strain.ts › tapeMmForTile` made it depend on the *model* — a large tile can carry a wider strip
 * than a small one — and this file adds the other half of the same question: **how many runs have to share
 * that tile.** A 40mm tile carrying one run and a 40mm tile carrying six are not the same tile to lay tape
 * on, and until now the router could not tell them apart.
 *
 * Two functions, kept apart because they answer questions of different kinds:
 *
 * - {@link traceDemand} reads a circuit and says how many runs it will take. Bookkeeping, no geometry.
 * - {@link tapeMmForDemand} reads a tile and a demand and says how wide a run may be. Geometry, no circuit.
 *
 * **Why demand is counted from the circuit and never from the plan.** The width sets every clearance the
 * router works to — `overlapTol`, the weeding bound, the corridor's own spacing all derive from it — so a
 * width read off the finished plan would be a width that changed the plan it was read from. The count has
 * to be available before a single route is planned, which means counting nets and wires, not runs.
 */
import { GND_NET_ID, PWR_NET_ID } from "./net-palette.js";
import { STOCK_TAPE_MM, TAPE_TILE_SHARE, minWebMm, type SheetSpec, DEFAULT_SHEET } from "./fold-strain.js";
import type { Circuit } from "./electronics.js";

/**
 * The demand the existing width was calibrated at.
 *
 * `TAPE_TILE_SHARE` was set by measuring the bundled patterns at 3.25mm — and every one of those patterns
 * carries the two-rail bus, PWR and GND. So "a quarter of a tile" is known good for **two** runs, not for
 * one, and two is where {@link tapeMmForDemand} has to reproduce it exactly. Anchoring at one instead would
 * halve the width of every pattern in the corpus while claiming to preserve the calibration.
 */
export const CALIBRATED_DEMAND = 2;

/**
 * How many runs of copper a circuit will need, before any of them is planned.
 *
 * **A deliberate over-estimate, and the docblock is where that is admitted.** This counts every run as
 * though it crosses a typical tile. On `kirigami-flap` — ten faces, everything crossing everything — that
 * is about right. On `puffin`, ninety-six faces where a net may live in one corner and never come near the
 * far side, it is pessimistic, and the tape comes out narrower than it strictly needs to be. Being wrong
 * in that direction costs a little copper conductance; being wrong in the other direction plans strips
 * that do not fit on the tile they were planned for, which is not recoverable at the cutter.
 *
 * What is counted:
 *
 * - **The bus, as two, whenever there is a battery** — and deliberately not when there are only LEDs.
 *   PWR and GND are separate pieces of tape that must both reach across the sheet, and they are the reason
 *   {@link CALIBRATED_DEMAND} is two. Without a battery there is nothing for them to leave from: the
 *   router marks every LED unreachable and lays no rails at all, so counting two there would narrow the
 *   tape for copper that is never planned.
 * - **Each declared net carrying two or more terminals.** One terminal is not a net, it is an authoring
 *   mistake `resolveNetlist` already reports; it gets no copper, so it must not narrow anyone else's.
 *   PWR and GND are skipped here when the bus already counted them, or a plain LED circuit would read four.
 * - **Each hand-drawn wire.** Author-placed copper is copper: it occupies the tile whether or not the
 *   router put it there.
 *
 * Never below one. A width computed for zero runs is a division by zero dressed up as a wide strip.
 */
export function traceDemand(circuit: Circuit): number {
  const bus = circuit.battery ? 2 : 0;
  const terminals = circuit.terminals ?? [];
  let declared = 0;
  for (const net of circuit.nets ?? []) {
    // Two or more, because that is the same bar `resolveNetlist` sets before it will route a net at all.
    if (terminals.filter((t) => t.net === net.id).length < 2) continue;
    // The bus has already paid for these two. Counting them again would read a battery-and-one-LED
    // circuit as four runs and halve its tape for copper that is not there.
    if (bus > 0 && (net.id === PWR_NET_ID || net.id === GND_NET_ID)) continue;
    declared++;
  }
  return Math.max(1, bus + declared + (circuit.wires ?? []).length);
}

/**
 * The widest run, in millimetres, when `demand` of them share a tile `tileMm` across.
 *
 * `tileMm` is `sqrt(area / faceCount)` — the characteristic size of one tile, and where the model's
 * surface area enters. See `fold-strain.ts › tapeMmForTile`, whose ceiling this generalises.
 *
 * **The rule, and why it is anchored rather than invented.** The existing ceiling says one run may take
 * `TAPE_TILE_SHARE` of a tile, and it was measured on patterns carrying {@link CALIBRATED_DEMAND} runs.
 * Treat that as a corridor budget across the tile — the copper, plus the webs of bare substrate that have
 * to be weeded out from between the strips — and hold the budget fixed as the demand varies:
 *
 *     k·w + (k−1)·web  ≤  k₀·share·tile + (k₀−1)·web        (k₀ = CALIBRATED_DEMAND)
 *
 *     w  =  (k₀·share·tile + (k₀−1−k+1)·web) / k
 *        =  (k₀·share·tile − (k−k₀)·web) / k
 *
 * At `k = k₀` this is `share·tile` exactly, so every pattern in the corpus keeps the width it has today
 * and no recorded routing budget moves. Below it a lone run is allowed to be fatter; above it the strips
 * narrow and the webs between them are still paid for, which is the whole point — the substrate between
 * two runs has to survive being lifted out with tweezers, and that width does not shrink just because
 * there are more runs wanting the space.
 *
 * `web` comes from {@link minWebMm}, so a thinner substrate needs wider webs and crowds sooner. That is
 * the sheet's thickness reaching the trace width through a second, independent path.
 *
 * **Continuous, and deliberately not snapped to a stocked roll — this is where it parts company with
 * `tapeMmForTile`, on purpose.** That function answers "which roll do I buy", and a roll is one width. This
 * one answers "how wide do I cut the strip", and the two are not the same question here: the strips are cut
 * as closed outlines from the copper, and `copper-svg-export.ts › outlineStrip` already takes a width **per
 * point** so a run can narrow where it passes between an LED's legs. Non-stock widths are therefore already
 * being cut, and rounding this answer to a roll would throw away most of the range for a constraint the
 * cutting file does not have. Snapping also flattens the whole rule in practice: the ladder has four rungs
 * and tops out at 10mm, so every tile past about 40mm gives the same answer whatever the demand.
 *
 * Clamped at both ends, and the two ends are constraints of different kinds. The floor is
 * {@link TAPE_FLOOR_MM} — a process limit, what a blade will track and what can still be weeded, NOT what
 * is sold. The ceiling is the widest stocked roll, and that one really is a catalogue fact: a strip is cut
 * from stock and cannot be cut wider than the stock it comes from. {@link tapeFitsDemand} is how a caller
 * asks whether the floor was hit, because hitting it means the sheet is too crowded rather than that the
 * answer is 3.25.
 */
export function tapeMmForDemand(
  tileMm: number,
  demand: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  const want = continuousMmForDemand(tileMm, demand, spec);
  const widest = STOCK_TAPE_MM[STOCK_TAPE_MM.length - 1]!;
  return Math.min(widest, Math.max(TAPE_FLOOR_MM, want));
}

/**
 * Whether the narrowest roll actually fits, at this tile and this demand.
 *
 * {@link tapeMmForDemand} floors at the narrowest stocked width, which means it answers "3.25mm" both when
 * 3.25 is what fits and when nothing does. Those are different situations for whoever is holding the
 * cutter, so the difference is available rather than buried: false means the strips will be closer than a
 * weedable web, and the sheet wants fewer nets or a bigger model rather than a different roll.
 */
export function tapeFitsDemand(
  tileMm: number,
  demand: number,
  spec: SheetSpec = DEFAULT_SHEET,
): boolean {
  return continuousMmForDemand(tileMm, demand, spec) >= TAPE_FLOOR_MM;
}

/**
 * The narrowest strip this rule will plan, in millimetres.
 *
 * **A process limit, not a catalogue one, and the distinction is load-bearing.** It is tempting to say
 * "nothing narrower than 3.25 is sold", and that was this number's reason while the answer was rounded to
 * a stocked roll. It stopped being true the moment the answer went continuous: a strip is an outline cut
 * from stock, so a 2mm strip cuts perfectly well from a 3.25mm roll, and `copper-svg-export.ts ›
 * widthsFor` is already pinching runs to **1.14mm** beneath an LED pad. The catalogue does not bound a cut.
 *
 * What bounds it is the blade tracking the line and the weeding lifting the waste, which is what
 * `copper-svg-export.ts › MIN_CUTTABLE_MM` records at 3mm. This sits above that with a margin, and the
 * margin is a judgement rather than a measurement: a planned width is applied along a whole run, over
 * bends and across hinges, where the per-point narrowing that reaches 1.14mm is a local pinch at a pad
 * with full-width tape either side of it. Planning the whole corpus at the very edge of what a blade can
 * follow is not a trade this rule should make on the author's behalf.
 *
 * `tape-demand.test.ts` pins `TAPE_FLOOR_MM >= MIN_CUTTABLE_MM`, so the two cannot cross silently. They
 * stay in separate files deliberately — this one is about planning, that one is about emitting — and the
 * test is what keeps them ordered without merging them.
 */
export const TAPE_FLOOR_MM = 3.25;

/** The rule itself, unsnapped and unclamped — shared so the two exported readings cannot disagree. */
function continuousMmForDemand(tileMm: number, demand: number, spec: SheetSpec): number {
  const k = Math.max(1, Math.floor(demand));
  const web = minWebMm(spec);
  const budget = CALIBRATED_DEMAND * TAPE_TILE_SHARE * Math.max(tileMm, 0);
  return (budget - (k - CALIBRATED_DEMAND) * web) / k;
}
