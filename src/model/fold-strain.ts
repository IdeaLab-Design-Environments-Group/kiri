/**
 * **Model** — what folding does to copper stuck on the sheet.
 *
 * The router used to answer "is this crease dear to cross?" by looking at one letter: `M` and `C` cost a
 * fixed price, `V` was free unless the file said it folded past 170 degrees. That is a classification, not
 * a physical quantity, and it could not answer the two questions that actually decide whether a trace
 * survives — *how far* does this crease fold, and *how thick is the sheet under the copper*. A mountain
 * folded 30 degrees on a thin sheet and one folded 160 degrees on a thick one were charged the same.
 *
 * This computes the strain instead, and everything else here follows from it.
 *
 * ## The bend
 *
 * A crease in this system is not a knife line: it is a strip of bare substrate between two rigid tiles,
 * and the fold is taken up by bending that strip. A strip of width `w` bent through `θ` is an arc of
 * radius
 *
 *     R = w / θ                                             (θ in radians)
 *
 * so a wider hinge or a shallower fold is a gentler bend, which is the behaviour anyone who has folded a
 * sheet expects. `w` is measured, not assumed: it is the distance between the two tiles' pinched edge
 * midpoints, which {@link GapEdge.legA} and {@link GapEdge.legB} already carry.
 *
 * ## The strain
 *
 * Copper lies on one face of the substrate, so its outer fibre sits `h/2 + t` from the neutral plane —
 * half the substrate plus the foil's own thickness. Bent to radius `R`, that fibre is strained by
 *
 *     ε = (h/2 + t) / R = (h/2 + t) · θ / w                  (dimensionless)
 *
 * Both limits are the right way round: `θ → 0` gives `ε → 0`, and a hinge made wider or a sheet made
 * thinner strains the copper less. This is ordinary Euler–Bernoulli outer-fibre strain, and it is the same
 * quantity a flex-PCB bend-radius rule states in its own units.
 *
 * ## Why the sign is the whole story
 *
 * Nakaya et al., "4D Leaf Circuits" (SCF '25) measured a trace over a **mountain** fold rising in
 * resistance and fracturing inside a hundred folding cycles, while the same trace on a **valley** stayed
 * flat. The geometry does not distinguish them — |ε| is the same either way — so a model taking |θ| would
 * flatten that result away and charge both alike.
 *
 * What distinguishes them is which way the copper is loaded. On a mountain the copper is on the convex
 * side and goes into **tension**, which opens cracks and drives them across the trace. On a valley it is
 * on the concave side and goes into **compression**, which wrinkles and can delaminate the foil but does
 * not part it — the trace keeps conducting. So tension is charged against {@link SheetSpec.fatigueStrain}
 * and compression is not charged at all.
 *
 * Compression is not free forever, though: a valley folded back on itself brings the two banks of copper
 * face to face and can short across. That is what the old `> 170 degrees` test was reaching for, and
 * {@link closureFraction} replaces it with a ramp — a step at 170 says a 169-degree fold is perfectly safe
 * and a 171-degree one is ruinous, which is not true of any sheet.
 *
 * ## What is measured here and what is assumed
 *
 * The geometry is measured per pattern. The *material* numbers in {@link DEFAULT_SHEET} are stated
 * assumptions with sources given below, not measurements taken on this system, and
 * {@link SheetSpec.fatigueStrain} in particular is an order-of-magnitude figure. Anything reported from
 * this module should be read as "given a sheet of these properties", and the spec is a parameter for
 * exactly that reason.
 */

/** The sheet the copper is stuck to, and the copper itself. Millimetres and gigapascals. */
export interface SheetSpec {
  /** Substrate thickness under the copper at a hinge — the bending member, not the rigid tile. */
  substrateMm: number;
  /** Copper foil thickness. Adhesive copper tape is typically 0.03–0.07mm of foil plus adhesive. */
  foilMm: number;
  /** Young's modulus of the substrate. */
  substrateGPa: number;
  /** Young's modulus of the copper foil. */
  foilGPa: number;
  /**
   * Tensile strain at which copper starts to crack under repeated folding.
   *
   * An order of magnitude, not a measurement: rolled annealed copper foil in the low-cycle regime fails
   * around a per-cent of strain after a few hundred cycles, and 1% is the round figure that sits in that
   * band. It is here as a named parameter rather than buried as a literal precisely because a paper
   * quoting a number from this module has to be able to say where the number came from.
   */
  fatigueStrain: number;
  /**
   * Tensile strain above which a crease may not carry copper **at all**, or null to price it and allow it.
   *
   * The difference between a penalty and a limit, made explicit. {@link fatigueStrain} makes a crossing
   * dear; this makes it impossible, and an LED reachable only across such a crease is reported unreachable
   * rather than wired with copper that will crack. Null by default, because refusing every crease over the
   * fatigue strain refuses almost every mountain these patterns have — see the measurement in
   * `strain-limit.test.ts`. Set it when the sheet is going to be folded repeatedly and a dead trace is
   * worse than an unwired LED.
   */
  strainLimit: number | null;
  /**
   * How the tape's physical width is chosen.
   *
   * `"roll"` — always {@link TAPE_MM}, which is what this router has always done and what every recorded
   * measurement in the suite was taken against.
   *
   * `"area"` — the widest stocked roll the model's own surface can carry, from {@link tapeMmForTile}.
   * Wider tape is better copper: less resistance, easier to lay, harder to lift. What stops it is
   * crowding, and crowding is relative to the tile it is laid on — so the model's area and its face count
   * decide it, not a constant.
   *
   * `"roll"` by default because widening the tape moves every clearance in the router with it, and every
   * budget the suite records was measured at 3.25mm. Switching is a decision with numbers attached; see
   * `tape-width.test.ts` for what it does to each bundled pattern.
   */
  tapeChoice: "roll" | "area";
}

/**
 * A printed-kirigami sheet: rigid tiles bridged by a thin substrate hinge, wearing copper tape.
 *
 * `substrateMm` is the hinge bridge, deliberately not the 1.6mm rigid tile of the STL export — the tile
 * does not bend, so its thickness has nothing to do with the strain in the copper. `foilMm` and the two
 * moduli are handbook figures for adhesive copper tape and PLA.
 */
export const DEFAULT_SHEET: SheetSpec = {
  substrateMm: 0.4,
  foilMm: 0.035,
  substrateGPa: 3.5,
  foilGPa: 117,
  fatigueStrain: 0.01,
  // Off. A limit that refuses most of the corpus is a decision for whoever is folding the thing, not a
  // default — and shipping it on would turn "your LED is dear to reach" into "your LED is unreachable"
  // across every bundled pattern without anyone asking for it.
  strainLimit: null,
  tapeChoice: "roll",
};

/** Below this the fold is flat and nothing is strained — also what keeps {@link bendRadiusMm} finite. */
const FLAT_DEG = 0.01;

/**
 * Where a valley starts to close on itself, in degrees, and where it is fully shut.
 *
 * Two banks of copper brought face to face can short across, which is a fault of the layout rather than of
 * the copper, so it is charged separately from fatigue and only over this range.
 */
export const CLOSING_DEG = 150;
export const CLOSED_DEG = 180;

/**
 * Whether copper may cross this hinge at all.
 *
 * Tension only, like {@link fatigueFraction} and for the same reason: compression does not part a trace.
 * A closed fold is not refused here either — two banks of copper meeting is a layout fault the router
 * cannot fix by going somewhere else, and it is already priced.
 */
export function overStrainLimit(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
): boolean {
  if (spec.strainLimit == null) return false;
  return foldStrain(hingeMm, foldDeg, spec) > spec.strainLimit;
}

/** The bend radius a hinge of width `hingeMm` takes when folded through `foldDeg`, in mm. */
export function bendRadiusMm(hingeMm: number, foldDeg: number): number {
  const theta = (Math.max(Math.abs(foldDeg), FLAT_DEG) * Math.PI) / 180;
  return Math.max(hingeMm, 0) / theta;
}

/**
 * Outer-fibre strain in the copper over one hinge. **Positive is tension** — a mountain, where the copper
 * is on the outside of the bend — and negative is compression.
 *
 * `foldDeg` is signed the way {@link GapEdge.dihedral} is: mountain positive, valley negative.
 *
 * **A valley is not a promise of a fold.** Sixteen of the twenty-two `V` edges in the bundled corpus carry
 * a target of exactly 0 — akde-hex's six and akde-decagon's ten are all flat — so they strain nothing and
 * are priced at nothing, which is correct and is not the sign fix misfiring. Anything downstream that
 * reads "V" as "this folds" will be wrong on three quarters of the valleys we ship.
 */
export function foldStrain(hingeMm: number, foldDeg: number, spec: SheetSpec = DEFAULT_SHEET): number {
  if (!(hingeMm > 0)) return 0; // no bending member: not a bend, and not this function's business
  // Exactly zero for a flat facet, rather than the vanishing strain the radius floor would otherwise
  // return. `F` edges are the commonest kind on these patterns and a crease price of 1e-4 on every one of
  // them is not a small error, it is a toll on travelling in a straight line across a flat tile.
  if (Math.abs(foldDeg) < FLAT_DEG) return 0;
  const fibre = spec.substrateMm / 2 + spec.foilMm;
  const eps = fibre / bendRadiusMm(hingeMm, foldDeg);
  return foldDeg < 0 ? -eps : eps;
}

/**
 * How much of the copper's fatigue budget one crossing of this hinge spends: 0 for a fold that cannot
 * crack the trace, 1 at {@link SheetSpec.fatigueStrain}, clamped there.
 *
 * Tension only. Compression is left at zero here on purpose — see the header — and is charged by
 * {@link closureFraction} instead, which is a different failure with a different cause.
 */
export function fatigueFraction(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  const eps = foldStrain(hingeMm, foldDeg, spec);
  if (eps <= 0 || !(spec.fatigueStrain > 0)) return 0;
  return Math.min(1, eps / spec.fatigueStrain);
}

/**
 * How far a fold is toward closing on itself: 0 up to {@link CLOSING_DEG}, 1 at {@link CLOSED_DEG}.
 *
 * Unsigned, because a mountain folded flat brings its two banks together exactly as a valley does.
 */
export function closureFraction(foldDeg: number): number {
  const span = CLOSED_DEG - CLOSING_DEG;
  if (!(span > 0)) return Math.abs(foldDeg) >= CLOSED_DEG ? 1 : 0;
  return Math.min(1, Math.max(0, (Math.abs(foldDeg) - CLOSING_DEG) / span));
}

/**
 * What one crossing of a hinge costs, as a fraction of the full crease price: the worse of cracking the
 * trace and shorting it across a closed fold.
 *
 * The worse of the two rather than their sum: they are alternative ways to lose the same trace, and adding
 * them would say that a fold which is both is twice as lost.
 */
export function creaseCostFraction(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  return Math.max(fatigueFraction(hingeMm, foldDeg, spec), closureFraction(foldDeg));
}

/**
 * How much of the substrate's fraction of stiffness a trace across a hinge is allowed to add.
 *
 * A judgement, and a generous one: at 0.5 the copper may make the hinge half again as stiff before the
 * width is refused.
 */
const STIFFENING_SHARE = 0.5;

/**
 * The widest trace that may cross a hinge `hingeLenMm` long without splinting it, in mm.
 *
 * Copper is thirty times stiffer than the substrate, so a strip laid across a hinge resists the fold. Plate
 * bending stiffness goes as `E·h³` per unit width, so a strip of width `w` adds `E_cu·t³·w` against the
 * hinge's own `E_s·h³·L`, and holding the added share below {@link STIFFENING_SHARE} gives
 *
 *     w ≤ share · L · (E_s·h³) / (E_cu·t³)
 *
 * which is a length, as it must be. **This is the coupling that lets sheet thickness set trace width, and
 * on the sheets this system prints it does not bind**: 0.4mm of PLA against 0.035mm of copper foil puts
 * the bound two orders of magnitude above any tape on a roll. It is implemented rather than assumed away
 * because "the stocked width governs" is only worth saying if something checked.
 */
export function maxTraceWidthMm(hingeLenMm: number, spec: SheetSpec = DEFAULT_SHEET): number {
  const foil = spec.foilGPa * spec.foilMm ** 3;
  if (!(foil > 0)) return Infinity;
  const sheet = spec.substrateGPa * spec.substrateMm ** 3;
  return (STIFFENING_SHARE * Math.max(hingeLenMm, 0) * sheet) / foil;
}

/**
 * The reference sheet the weeding floor was set on, and the floor itself.
 *
 * {@link minWebMm} has to agree with the number this codebase already cut to at the thickness it already
 * assumed, or changing the sheet would silently re-cut every pattern that never named one.
 */
const WEB_REF_MM = 1.1375; // = TAPE_MM * LED_GAP_FRAC, the fixed figure this replaces
const WEB_REF_THICKNESS_MM = DEFAULT_SHEET.substrateMm;

/**
 * The narrowest strip of bare substrate that can be weeded out from between two runs of copper, in mm.
 *
 * A web is a beam of substrate lifted by the tweezers: what it can take before it tears goes with its
 * cross-section, so a thinner sheet needs a wider web and a thicker one can do with less. Hence the
 * inverse. Calibrated to leave the existing figure unchanged at the default thickness, so this is a
 * generalisation of that number rather than a replacement for it.
 */
export function minWebMm(spec: SheetSpec = DEFAULT_SHEET): number {
  if (!(spec.substrateMm > 0)) return WEB_REF_MM;
  return (WEB_REF_MM * WEB_REF_THICKNESS_MM) / spec.substrateMm;
}

/**
 * The copper tape widths worth planning for, narrowest first, in millimetres.
 *
 * A roll of tape is one width and you buy it that way; a router that plans for 4.1mm is planning for
 * something nobody stocks. 3.25 is what this project has always used and is the narrowest here; the rest
 * are ordinary shelf widths.
 */
export const STOCK_TAPE_MM = [3.25, 5, 6.5, 10] as const;

/**
 * The most tape a tile of characteristic size `tileMm` can carry without being swallowed by it.
 *
 * Measured, not guessed. Across the eight bundled patterns the tape-to-tile ratio at 3.25mm runs from
 * 0.079 (`kirigami-flap`, 41mm tiles) to 0.246 (`puffin`, 13mm tiles), and 3.25mm is known to work on all
 * of them while 6.5mm was found to "crowd these patterns, taking up most of a tile". So the ceiling sits
 * just above the worst case that is known good: at 0.25 every bundled pattern keeps the width it has
 * today, and a model with genuinely larger tiles is allowed a wider roll.
 */
export const TAPE_TILE_SHARE = 0.25;

/**
 * The widest stocked tape for a model whose mean tile is `tileMm` across.
 *
 * `tileMm` is `sqrt(totalArea / faceCount)` — the characteristic size of one tile, which is where the
 * total surface area of the model enters. Area alone would not do: the same area cut into 96 tiles
 * (`puffin`) and into 10 (`kirigami-flap`) are not the same sheet to lay tape on.
 *
 * Never returns less than the narrowest roll. A model with tiles too small for 3.25mm tape has a problem
 * this function cannot solve — there is nothing narrower to offer — and reporting the narrowest roll is
 * more useful than reporting a width nobody sells.
 */
export function tapeMmForTile(tileMm: number): number {
  const ceiling = Math.max(tileMm, 0) * TAPE_TILE_SHARE;
  let best: number = STOCK_TAPE_MM[0];
  for (const w of STOCK_TAPE_MM) if (w <= ceiling) best = w;
  return best;
}
