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
 * Copper lies on one face of the hinge member, so its outer fibre sits `c` from the neutral plane. Bent
 * to radius `R`, that fibre is strained by
 *
 *     ε = c / R = c · θ / w                                  (dimensionless)
 *
 * with `c = h/2 + a + t` — half the hinge member, the adhesive that stands the foil off it, and the foil
 * itself. See {@link outerFibreMm}, which is where the two assumptions in that expression are written
 * down: the neutral plane sits at mid-member, and the stack bends as one.
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
 * not part it — the trace keeps conducting. So tension is charged against {@link SheetSpec.routingThresholdStrain}
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
 * {@link SheetSpec.routingThresholdStrain} in particular is an order-of-magnitude figure. Anything reported from
 * this module should be read as "given a sheet of these properties", and the spec is a parameter for
 * exactly that reason.
 */

/** The sheet the copper is stuck to, and the copper itself. Millimetres and gigapascals. */
export interface SheetSpec {
  /** Substrate thickness under the copper at a hinge — the bending member, not the rigid tile. */
  substrateMm: number;
  /**
   * Copper foil thickness -- the metal alone, not the tape.
   *
   * 0.050 mm for the tape this project uses: Kunshan MeiLe ML-Cu-80-50-S, "50micron Conductive Adhesive
   * Copper Foil Tape", sold by SparkFun, whose datasheet gives *Thickness of basing material (a)*
   * 0.050 ± 10% mm, *Adhesive thickness (b)* 0.035 ± 10% mm, total 0.085 ± 10% mm.
   *
   * This field read 0.035 until that datasheet was checked, which is the **adhesive's** figure, not the
   * copper's. (0.035 mm is also one-ounce PCB copper, so the wrong number was a plausible one.)
   */
  foilMm: number;
  /**
   * Thickness of the adhesive between the hinge member and the foil, which stands the copper off it.
   *
   * It carries no load worth counting -- an acrylic PSA is four orders of magnitude softer than either
   * neighbour -- but it moves the copper further from the neutral plane, and that is a strain term. From
   * the same datasheet: 0.035 ± 10% mm.
   */
  adhesiveMm: number;
  /** Young's modulus of the substrate. */
  substrateGPa: number;
  /** Young's modulus of the copper foil. */
  foilGPa: number;
  /**
   * **A routing threshold, not a validated fatigue limit.** The tensile strain above which this router
   * stops treating a crossing as ordinary and starts treating it as damage.
   *
   * It has never been measured on this stack, and nothing here establishes the strain at which copper
   * tape on these hinges cracks. What changed on 2026-09-09 is that it is no longer *chosen*: it is
   * computed by {@link thresholdStrainFor} from the foil's own ductility at a stated service life, and
   * every input is named, sourced and adjustable. See that function for the derivation and its limits.
   *
   * The value it returns at the shipped {@link DESIGN_FOLD_CYCLES} is **0.03**, and the two ends of the
   * literature bracket it sits in are worth keeping here, because they are what says it is the right
   * order:
   *
   *  - **~0.5% is an endurance-regime strain**, and two independent measurements put it in the same
   *    place. Wu et al., *Nanomaterials* 16(1):11, doi:10.3390/nano16010011, cycled 24 µm copper foil
   *    over a fixed 2.5 mm radius -- an outer-fibre strain of t/(2R + t) = 0.48% -- for a life of
   *    ~8x10^4 cycles. Kim et al., *Materials* 12(15):2490 (2019), doi:10.3390/ma12152490, cycled Cu on
   *    polyimide to 10^5 cycles and found resistance unchanged at 0.7% strain and up 600% at 1.5%.
   *  - **Several per cent is the single-fold end**: elongation at break, 3% for 1 oz electrodeposited
   *    foil and 13% for 1 oz rolled annealed (Rogers Corporation, *Copper Foils for High Frequency
   *    Circuit Materials*, Table 2). See {@link FOIL_ELONGATION} for why 3% is the figure taken.
   *
   * **The 1% this module shipped until 2026-09-09 was not a low-cycle figure at all.** On the same curve
   * it corresponds to 1.8-2.8 x 10^4 folds -- an endurance-grade threshold, ~200x stricter than the
   * service life these objects are built for -- and this file described it as "the low-cycle regime",
   * which it was not.
   *
   * Changing it does not rescale the router's behaviour uniformly. At 1% some 88% of the bundled corpus's
   * tensile creases were over the line, so the threshold acted as the normaliser of the graded price
   * rather than as a discriminator; at 3% that is 73% and the saturation angle (15.4 degrees at the
   * median hinge) finally sits inside the corpus's own fold angles. `scripts/_strain-audit.ts` prints it.
   */
  routingThresholdStrain: number;
  /**
   * Tensile strain above which a crease may not carry copper **at all**, or null to price it and allow it.
   *
   * The difference between a penalty and a limit, made explicit. {@link routingThresholdStrain} makes a crossing
   * dear; this makes it impossible, and an LED reachable only across such a crease is reported unreachable
   * rather than wired with copper that will crack. Null by default, because refusing every crease over the
   * routing threshold refuses almost every mountain these patterns have — see the measurement in
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
 * The one strain-life measurement on copper foil this project could retrieve in full.
 *
 * Wu et al., *Nanomaterials* 16(1):11, doi:10.3390/nano16010011 (retrieved 2026-09-09), cycled 24 µm
 * rolled copper foil over a fixed 2.5 mm radius until the circuit opened, and report ~8.0x10^4 cycles.
 * The strain that radius imposes on a free foil's outer fibre is `t/(2R + t)` = 0.024/5.024 = **0.478%**.
 *
 * It is one point on a curve, on a foil half the thickness of ours, and it is the anchor rather than the
 * answer. What makes it usable is that the conclusion drawn from it below is insensitive to the slope.
 */
export const FOIL_ENDURANCE = { strain: 0.00478, cycles: 8.0e4 } as const;

/**
 * Fatigue ductility exponent for the plastic branch of the strain-life law, `ε_a ∝ N^c`.
 *
 * −0.6 is corroborated by two independent sources that were read for this, not recalled:
 *
 *  - Anand & Parks, *Defect-Free Fatigue* (supplementary notes, 2.002 Mechanics and Materials II, MIT,
 *    Spring 2004; MIT OpenCourseWare): "Numerical values of the fatigue ductility exponent are usually in
 *    the range −.5 ≥ c ≥ −.7 for many metals, **with c = −.6 as typical**."
 *  - Wu et al. (the anchor paper) quote the same −0.5 to −0.7 range for ductile FCC metals.
 *
 * Every conclusion here is reported across that whole range, because a single `c` fitted to one point
 * would be a fit to nothing — and as it happens the shipped value does not depend on `c` at all
 * ({@link thresholdStrainFor}).
 */
export const COFFIN_MANSON_C = -0.6;

/**
 * Elongation at break of the foil — the strain a single fold may not exceed, whatever the cycle count.
 *
 * Rogers Corporation, *Copper Foils for High Frequency Circuit Materials*, Table 2 ("Typical Foil
 * Properties", values after lamination): **3%** for 1 oz electrodeposited foil, **13%** for 1 oz rolled
 * annealed, 27% for 2 oz RA.
 *
 * Those are measurements by a standard method, not marketing: elongation of copper foil is defined by
 * IPC-TM-650 method **2.4.18B** (8/80), a constant-strain-rate pull on five 1/2 x 6 inch specimens with
 * the cross-section computed from the specimen's weight and copper's density — read for this note.
 *
 * **3% is used, deliberately, because our tape's temper is unknown.** Its datasheet (Kunshan MeiLe
 * ML-Cu-80-50-S) says "Copper foil" and stops there. That silence spans a wider range than RA-vs-ED:
 * Yin et al., *Rare Metals* (2016), doi:10.1007/s12598-016-0806-4, find commercial **as-rolled** foil
 * has *higher* strength and **lower** ductility than electrodeposited, so the three tempers rank
 * as-rolled < ED < rolled-annealed. Taking the ED figure is a middle reading of that silence, not the
 * floor of it, and a single tensile pull on the actual tape would replace this line with a measurement.
 *
 * Using a tensile elongation as a *bending* limit is the standard bendability criterion, not an analogy:
 * failure in bending is the exhaustion of tensile ductility at the outer fibre, and "a higher total
 * elongation helps sustain a larger outer fibre stretch of the bend before surface fracture, thereby
 * permitting a smaller bend radius" (AHSS Guidelines, *Bending*, retrieved 2026-09-09).
 */
export const FOIL_ELONGATION = 0.03;

/**
 * How many times a Kiri object is assumed to be folded over its life.
 *
 * A **design decision, stated rather than derived**: an object is folded once on assembly, and then
 * some tens of times in handling, flat-packing and demonstration. 100 is generous for that and is also
 * the figure the only cycling experiment in this literature uses (Nakaya et al., *4D Leaf Circuits*,
 * SCF '25, folded 0-180 degrees for 100 cycles), which makes the two comparable.
 *
 * This is the number to change if the artefact is a hinge that gets worked, not a model that gets built.
 */
export const DESIGN_FOLD_CYCLES = 100;

/**
 * The tensile strain a trace may take, if it must survive `cycles` folds.
 *
 *     ε(N) = min( elongation at break , ε_ref · (N / N_ref)^c )
 *
 * Two branches, and **which one binds is the whole point**:
 *
 *  - **Below ~2x10^3 folds the ductility binds.** Extrapolating the fatigue branch back to N = 100 gives
 *    13% to 52% across c ∈ [−0.5, −0.7] — above the strain that breaks the foil in a single pull, so the
 *    fatigue branch has left its regime and the material's ductility is the real ceiling. At the shipped
 *    {@link DESIGN_FOLD_CYCLES} = 100 this returns {@link FOIL_ELONGATION} exactly.
 *
 *    This is the documented behaviour of the strain-life law and not an improvisation. Anand & Parks
 *    (op. cit.): "At short lives ... plastic strain will predominate, and **ductility will control the
 *    fatigue performance**." And in the extremely-low-cycle regime the law stops applying altogether:
 *    Kim & Hwang, *Materials* 12(24):4111 (2019), doi:10.3390/ma12244111, define ELCF as lives "less
 *    than 100 cycles", describe it as the "rapid reduction and exhaustion of the residual ductility at
 *    very large strain amplitudes", and report that their highest-amplitude specimens "showed no cyclic
 *    damage behavior, but instead showed features similar to monotonic tensile conditions". A fold count
 *    of 100 is squarely in that regime, which is why the ductility branch is the operative one here.
 *  - **Above that, fatigue binds**, and the value falls steeply: ~1.7% at 10^4 folds, ~0.5% at 10^5.
 *
 * The one number worth carrying away: **1% strain corresponds to 1.8-2.8 x 10^4 folds** across the whole
 * exponent range. So the 1% this module used until 2026-09-09 was not a low-cycle figure at all — it was
 * an endurance-grade threshold, some 200x stricter than the service life these objects are built for, and
 * it was described in this file as "the low-cycle regime", which it is not.
 *
 * **What this is not.** It is not a measurement on this stack. It is one retrieved anchor, one documented
 * exponent range, and one retrieved ductility figure for a temper we are guessing at, combined
 * arithmetically. It is a *derived* threshold rather than a chosen one, which is a real improvement in
 * provenance and is not the same thing as a validated fatigue limit.
 */
export function thresholdStrainFor(
  cycles: number = DESIGN_FOLD_CYCLES,
  exponent: number = COFFIN_MANSON_C,
  ductility: number = FOIL_ELONGATION,
): number {
  const n = Math.max(cycles, 1);
  const fatigue = FOIL_ENDURANCE.strain * (n / FOIL_ENDURANCE.cycles) ** exponent;
  return Math.min(ductility, fatigue);
}

/**
 * A printed-kirigami sheet: rigid tiles on a flexible backing, wearing copper tape.
 *
 * `substrateMm` is the **hinge member**, deliberately not the rigid tile of the STL export — the tile does
 * not bend, so its thickness has nothing to do with the strain in the copper. On the printed build the
 * tiles meet only at their corners and the pinched edge opens an empty diamond (`printed-joinery.ts`), so
 * what spans a hinge is the backing the tiles are bonded to, not PLA: 0.4 mm is a **stated assumption**
 * for that backing and has not been measured on a built one.
 *
 * `foilMm` and `adhesiveMm` are from the tape's datasheet and are the only two numbers here that are.
 * The moduli are handbook figures for copper and PLA; `substrateGPa` is used by {@link maxTraceWidthMm}
 * and by nothing in the strain path, so the strain does not depend on it.
 */
export const DEFAULT_SHEET: SheetSpec = {
  substrateMm: 0.4,
  foilMm: 0.05,
  adhesiveMm: 0.035,
  substrateGPa: 3.5,
  foilGPa: 117,
  routingThresholdStrain: thresholdStrainFor(),
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
/** Band width for {@link strainBand}: a detour is worth taking for a halving of strain, not a trim. */
export const STRAIN_BAND_RATIO = 2;
/** Bands above this are one band — past it the copper is failing either way. See {@link strainBand}. */
export const STRAIN_BAND_CAP = 2;

export const CLOSING_DEG = 150;
export const CLOSED_DEG = 180;

/**
 * Whether copper may cross this hinge at all.
 *
 * Tension only, like {@link thresholdFraction} and for the same reason: compression does not part a trace.
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
 * Distance from the neutral plane to the copper's outer surface, in mm — the `c` in `ε = c·θ/w`.
 *
 *     c = h/2 + a + t
 *
 * **Both terms of that are assumptions, and they pull opposite ways.**
 *
 * `h/2` puts the neutral plane at the middle of the hinge member, which is where it sits for a member
 * bending on its own. The copper is not on its own: 0.05 mm of copper at 117 GPa against 0.4 mm of a
 * backing at ~3.5 GPa carries four times the axial stiffness of what it is stuck to, so if the adhesive
 * transferred shear perfectly the neutral plane would move almost to the copper — a transformed-section
 * calculation puts it 0.410 mm out, leaving the copper's outer fibre **0.075 mm** from it rather than
 * 0.285 mm. That is a factor of 3.8 less strain for the same fold.
 *
 * The shipped model is the **conservative** end of that range and is kept deliberately, because the
 * composite end assumes a 35 µm acrylic pressure-sensitive adhesive transfers shear as if it were a
 * bond line, which is not established, and because a fully-composite hinge would put 25% strain in the
 * backing at a 90° fold on the corpus's median 2.55 mm hinge — the backing would fail first, which it observably does not.
 * The true `c` is somewhere between the two and nothing here measures it. `scripts/_strain-audit.ts`
 * prints the corpus under both.
 */
export function outerFibreMm(spec: SheetSpec = DEFAULT_SHEET): number {
  return spec.substrateMm / 2 + (spec.adhesiveMm ?? 0) + spec.foilMm;
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
  const eps = outerFibreMm(spec) / bendRadiusMm(hingeMm, foldDeg);
  return foldDeg < 0 ? -eps : eps;
}

/**
 * How much of the crossing budget one crossing of this hinge spends: 0 for a fold below the threshold,
 * 1 at {@link SheetSpec.routingThresholdStrain}, clamped there. The budget is the router's, not the
 * copper's -- see that field for what the threshold is and is not.
 *
 * Tension only. Compression is left at zero here on purpose — see the header — and is charged by
 * {@link closureFraction} instead, which is a different failure with a different cause.
 */
export function thresholdFraction(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  const eps = foldStrain(hingeMm, foldDeg, spec);
  if (eps <= 0 || !(spec.routingThresholdStrain > 0)) return 0;
  return Math.min(1, eps / spec.routingThresholdStrain);
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
/**
 * How many `ratio`-fold steps above the routing threshold this crease sits, capped.
 *
 * Band 0 means the fold is under the threshold, so the crease is not worth routing around at all. That is
 * a statement about the threshold, not a prediction that the copper survives.
 *
 * This exists because {@link creaseCostFraction} answers a different question. A *cost* says how dear a
 * crossing is and gets summed along a route, and summing is the wrong arithmetic for damage: a trace fails at
 * its single worst crossing, not at the total of them. A band is what the bottleneck search in
 * `corridor.ts › searchCorridor` compares, and it is compared rather than added.
 *
 * Two deliberate coarsenings, both of which stop the bottleneck objective from being pathological:
 *
 *  - **Bands, not raw strain.** Cycles-to-failure follows a power law in strain, so what is worth a detour is
 *    a *halving*, not a one-percent trim. Compared on raw strain the search pays any detour, and any number of
 *    extra fatal crossings, to shave the worst one by an epsilon.
 *  - **A cap.** Past a few multiples of the threshold the copper is taken to be failing either
 *    way, so band 5 is not held to be meaningfully safer than band 3 and moving between them buys nothing while costing
 *    real crossings. Above the cap the search falls back on the ordinary crease cost.
 *
 * Measured on `traceformroutebench`: uncapped, this router put 58 fatiguing crossings on a pattern where the
 * ordinary cost put 39, and used 2.2x the copper. Capped at 2 it puts 30.7 and uses 2% more copper.
 */
export function strainBand(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
  ratio: number = STRAIN_BAND_RATIO,
  cap: number = STRAIN_BAND_CAP,
): number {
  const eps = foldStrain(hingeMm, foldDeg, spec);
  if (eps <= 0 || !(spec.routingThresholdStrain > 0)) return 0;
  if (eps <= spec.routingThresholdStrain) return 0;
  if (!(ratio > 1)) return Math.min(1, cap);
  const band = 1 + Math.floor(Math.log(eps / spec.routingThresholdStrain) / Math.log(ratio));
  return Math.max(0, Math.min(band, cap));
}

/**
 * The traceform crease price.  One algorithm, shared with the benchmark; every term from
 * eps = (h/2 + t) * theta / w.
 *
 *     compression (eps <= 0)        free -- a concave fold closes the outer fibre's cracks.  Charging it
 *                                   buys detours around crossings that do not break.
 *     survivable (0 < eps < eps_f)  eps/eps_f -- the copper outlasts the hinge; priced by proximity to
 *                                   the limit, which moves with the stack.  The coupling the class rule
 *                                   never had: the same fold on a thicker sheet costs more.
 *     fatiguing (eps >= eps_f)      1 + min(1, eps/epsMax) -- **floored** at the flat rule's full price,
 *                                   so a shallow-but-fatiguing mountain is never a bargain, and **graded**
 *                                   above it, so among crossings the pattern forces the gentler one wins.
 *     closure                       max with {@link closureFraction} -- a crease folded back on itself
 *                                   can short.  A fabrication hazard, not a strain one.
 *
 * Returns a fraction in [0, 2]; the caller multiplies by its fold penalty.
 *
 * Measured on the benchmark's single-sided arm -- the regime this router occupies -- this cost beats the
 * published mountain rule on both metrics under every net ordering tested (220 vs 232 tensile crossings,
 * 11,427 vs 12,603 mm copper, means over 3 orderings 221.0 vs 247.0), and an ablation attributes 97% of
 * the copper gain to the graded term specifically.  Whether that transfers to this corridor's resolution
 * is measured by `scripts/bench-band.ts` and the routing tests, not assumed.
 */
export function traceformCreaseFraction(
  hingeMm: number,
  foldDeg: number,
  epsMax: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  const closure = closureFraction(foldDeg);
  const eps = foldStrain(hingeMm, foldDeg, spec);
  if (eps <= 0) return closure;
  if (!(spec.routingThresholdStrain > 0)) return closure;
  if (eps < spec.routingThresholdStrain) {
    // Survivable: the copper outlasts the hinge.  Priced by proximity to the
    // limit, which moves with the stack -- the coupling the class rule never had.
    return Math.max(eps / spec.routingThresholdStrain, closure);
  }
  // Fatiguing: never cheaper than the flat rule's full price (a shallow-but-
  // fatiguing mountain must not be a bargain), graded above the floor so that
  // among crossings the pattern forces, the gentler one wins.
  const grade = epsMax > 0 ? Math.min(1, eps / epsMax) : 1;
  return Math.max(1 + grade, closure);
}

export function creaseCostFraction(
  hingeMm: number,
  foldDeg: number,
  spec: SheetSpec = DEFAULT_SHEET,
): number {
  return Math.max(thresholdFraction(hingeMm, foldDeg, spec), closureFraction(foldDeg));
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
