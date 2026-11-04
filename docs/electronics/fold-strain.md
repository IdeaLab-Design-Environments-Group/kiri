# Fold strain

`src/model/fold-strain.ts` turns each hinge's fold angle, hinge width and sheet stack into the strain at the copper's outer fibre, and from that into the price the router pays to cross the hinge. This page covers the formulas, the material numbers behind them, how the corridor uses them, and the unit traps around fold angles.

## Why strain and not the crease letter

The router used to price a crease from its assignment alone: `M` and `C` cost a fixed amount, and `V` was free unless the file said it folded past 170°. The module header explains why that was replaced:

> That is a classification, not a physical quantity, and it could not answer the two questions that actually decide whether a trace survives — *how far* does this crease fold, and *how thick is the sheet under the copper*. A mountain folded 30 degrees on a thin sheet and one folded 160 degrees on a thick one were charged the same.

The strain model was built up over several commits: `16e6181` "Score traces by worst crease crossed", `ff53581` "Price creases in three regimes", `78286e8` "Enable graded price and band ordering", and `b25c490` "Derive routing threshold from ductility".

## The bend and the strain

A crease here is not a knife line. It is a strip of bare backing of width `w` between two rigid tiles, and bending that strip takes up the fold. Bent through `θ`, the strip is an arc of radius `R = w / θ`. The copper's outer surface sits a distance `c` from the neutral plane, so its strain is `ε = c / R = c·θ / w`.

```ts title="src/model/fold-strain.ts › bendRadiusMm, outerFibreMm"
export function bendRadiusMm(hingeMm: number, foldDeg: number): number {
  const theta = (Math.max(Math.abs(foldDeg), FLAT_DEG) * Math.PI) / 180;
  return Math.max(hingeMm, 0) / theta;
}
// …
export function outerFibreMm(spec: SheetSpec = DEFAULT_SHEET): number {
  return spec.substrateMm / 2 + (spec.adhesiveMm ?? 0) + spec.foilMm;
}
```

```ts title="src/model/fold-strain.ts › foldStrain"
export function foldStrain(hingeMm: number, foldDeg: number, spec: SheetSpec = DEFAULT_SHEET): number {
  if (!(hingeMm > 0)) return 0; // no bending member: not a bend, and not this function's business
  // Exactly zero for a flat facet, rather than the vanishing strain the radius floor would otherwise
  // return. …
  if (Math.abs(foldDeg) < FLAT_DEG) return 0;
  const eps = outerFibreMm(spec) / bendRadiusMm(hingeMm, foldDeg);
  return foldDeg < 0 ? -eps : eps;
}
```

`c = h/2 + a + t` adds half the hinge member, the adhesive that holds the foil off it, and the foil itself. The result is signed: **positive is tension** (a mountain, with copper on the convex side) and negative is compression (a valley).

!!! info "Dimension and limit checks"
    - `R = w/θ`: mm / rad = mm. `ε = c/R`: mm / mm, dimensionless.
    - `θ → 0` gives `ε → 0`. A wider hinge or a thinner stack gives less strain. Both limits go the right way, as the header notes.
    - Default stack: `c = 0.4/2 + 0.035 + 0.05 = 0.285 mm`. On a 2.55 mm hinge (the median the source quotes) folded 90°, `R = 2.55 / (π/2) ≈ 1.62 mm` and `ε ≈ 0.285 / 1.62 ≈ 0.18`. That is far past the 0.03 routing threshold, so ordinary folds on this sheet sit in the "fatiguing" regime below.
    - `FLAT_DEG = 0.01` keeps `R` finite, and `foldStrain` returns exactly 0 below it. A flat edge would otherwise pay a small toll just for travelling straight across a flat tile.

`outerFibreMm` puts the neutral plane at mid-member, and its comment calls this the **conservative** end of the range. A fully composite section, with the adhesive transferring shear perfectly, would put the copper's outer fibre 0.075 mm from the neutral plane instead of 0.285 mm. That is 3.8× less strain. The conservative reading was kept because a 35 µm acrylic PSA is not established to transfer shear like a bond line, and because the composite reading would put 25% strain in the backing at a 90° fold, so the backing would fail first, "which it observably does not". `scripts/_strain-audit.ts` prints the corpus under both readings.

### The sheet

```ts title="src/model/fold-strain.ts › DEFAULT_SHEET"
export const DEFAULT_SHEET: SheetSpec = {
  substrateMm: 0.4,
  foilMm: 0.05,
  adhesiveMm: 0.035,
  substrateGPa: 3.5,
  foilGPa: 117,
  routingThresholdStrain: thresholdStrainFor(),
  // Off. A limit that refuses most of the corpus is a decision for whoever is folding the thing, not a
  // default — …
  strainLimit: null,
  tapeChoice: "roll",
};
```

Only `foilMm` and `adhesiveMm` come from a datasheet: the copper tape's, with 0.050 mm foil and 0.035 mm adhesive. `foilMm` read 0.035 until that datasheet was checked. That figure was the adhesive's. `substrateMm = 0.4` is a stated assumption for the backing that spans a printed hinge, and it has not been measured on a built sheet. The moduli are handbook figures, and `substrateGPa` feeds only `maxTraceWidthMm`, never the strain.

## Why the sign decides the price

Nakaya et al., "4D Leaf Circuits" (SCF '25), folded samples 0–180° for 100 cycles. A trace over a mountain rose sharply in resistance and fractured. The same trace on a valley rose and then held a plateau. `|ε|` is the same either way, so a model that used `|θ|` would charge the two alike. In tension the copper cracks and the crack runs across the trace. In compression it wrinkles and can delaminate, but it does not part. So **tension is priced and compression is not**.

!!! warning "Zero cost for compression is a choice about which failure to price"
    The header is explicit. The same paper reports resistance rising "for both mountain and valley conditions", and "lower and more stable is not zero". This module prices severing the conductor and ignores degraded conductivity. A design that has to hold a **resistance budget**, rather than just stay connected, is outside what this cost models.

Compression is not free at every angle, though. A valley folded back on itself brings two banks of copper face to face, and they can short. `closureFraction` charges for that with a linear ramp, unsigned, from 0 at `CLOSING_DEG = 150` to 1 at `CLOSED_DEG = 180`. It replaces the old `> 170°` step, which said "a 169-degree fold is perfectly safe and a 171-degree one is ruinous, which is not true of any sheet."

## The routing threshold

`SheetSpec.routingThresholdStrain` is the tensile strain above which the router treats a crossing as damage. Since `b25c490` (2026-09-09) it has been **derived, not chosen**:

```ts title="src/model/fold-strain.ts › thresholdStrainFor"
export function thresholdStrainFor(
  cycles: number = DESIGN_FOLD_CYCLES,
  exponent: number = COFFIN_MANSON_C,
  ductility: number = FOIL_ELONGATION,
): number {
  const n = Math.max(cycles, 1);
  const fatigue = FOIL_ENDURANCE.strain * (n / FOIL_ENDURANCE.cycles) ** exponent;
  return Math.min(ductility, fatigue);
}
```

That is `ε(N) = min(elongation at break, ε_ref · (N / N_ref)^c)`, the plastic branch of a Coffin–Manson strain-life law capped by single-pull ductility.

| Constant | Value | Source given in code |
|---|---|---|
| `FOIL_ENDURANCE` | 0.478% at 8.0×10⁴ cycles | Wu et al., *Nanomaterials* 16(1):11: 24 µm rolled foil over a 2.5 mm radius, `t/(2R + t)` |
| `COFFIN_MANSON_C` | −0.6 | Anand & Parks (MIT 2.002 notes): range −0.5 to −0.7, "c = −.6 as typical" |
| `FOIL_ELONGATION` | 3% | Rogers Corp., 1 oz electrodeposited foil. Chosen because the tape's temper is unknown |
| `DESIGN_FOLD_CYCLES` | 100 | A design decision: folded once on assembly, then tens of times in handling. It matches Nakaya's cycle count |

At 100 cycles the fatigue branch extrapolates to about 26% at `c = −0.6` (13–52% across the exponent range). That is above the strain that breaks the foil in one pull, so the ductility branch governs and the function returns exactly **0.03**. The fatigue branch takes over only above about 2×10³ folds, giving about 1.7% at 10⁴ and about 0.5% at 10⁵.

!!! info "Dimension check"
    `N / N_ref` is dimensionless, so `ε_ref · (N/N_ref)^c` is a strain, and so is the ductility cap. At the shipped values: `0.00478 · (100 / 8e4)^(−0.6) ≈ 0.00478 · 55.2 ≈ 0.26`, and `min(0.03, 0.26) = 0.03`.

??? info "History: the old 1% threshold"
    Until 2026-09-09 the threshold was a chosen 1%, which the file described as "the low-cycle regime". On the strain-life curve, 1% corresponds to 1.8–2.8×10⁴ folds. That is an endurance-grade figure, about 200× stricter than the service life these objects are built for. The field docs say the change does not rescale the router uniformly. At 1%, most tensile creases in the bundled corpus were over the line, so the threshold acted as the normaliser of the graded price rather than as a discriminator. At 3%, the saturation angle at the median hinge (about 15.4°) falls inside the corpus's own fold angles. Saturation angle `θ = ε_f·w/c = 0.03 · 2.55 / 0.285 ≈ 0.268 rad ≈ 15.4°`.

!!! warning "A routing threshold, not a validated fatigue limit"
    The code repeats this in several places. Nothing measures the strain at which copper tape on these hinges cracks. Treat any number from this module as true "given a sheet of these properties".

## The crease price

The corridor charges a crossing `foldPenalty × fraction`, where `foldPenalty = patternDiag × FOLD_PENALTY_FRAC` (0.5) and the fraction comes from the strain:

```ts title="src/model/fold-strain.ts › traceformCreaseFraction"
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
```

| Regime | Condition | Fraction |
|---|---|---|
| Compression | `ε ≤ 0` | `closure` only |
| Survivable | `0 < ε < ε_f` | `max(ε/ε_f, closure)`, in [0, 1) |
| Fatiguing | `ε ≥ ε_f` | `max(1 + min(1, ε/ε_max), closure)`, in [1, 2] |

`ε_max` is **the worst tensile strain in this pattern** (`corridor.ts › patternEpsMax`), not a material constant. The docblock spells out what follows: the worst crease of every pattern scores exactly 2.0, costs are not comparable across patterns, and editing one fold angle re-scales every other crease's price. The [1, 2] band is deliberate. It breaks ties among crossings the layout forces, and a fatiguing crossing can never compete with a survivable one.

`creaseCostFraction` is the ungraded variant, `max(min(1, ε/ε_f), closure)`. The corridor uses it when `graded` is false. `planRoutes` defaults `graded` to true.

```ts title="src/model/corridor.ts › creaseFraction"
function creaseFraction(
  g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec, epsMax = 0,
): number {
  if (g.assignment === "C") return 1;
  const hingeMm = g.dihedral == null ? null : measuredHingeMm(g, tapeW, tapeMm);
  if (hingeMm == null) return g.assignment === "M" ? 1 : 0;
  if (epsMax > 0) {
    return traceformCreaseFraction(hingeMm, g.dihedral!, epsMax, sheet);
  }
  return creaseCostFraction(hingeMm, g.dihedral!, sheet);
}
```

Two fallbacks return to the old classification (mountain = full price, anything else free):

- **No recorded fold angle** (`dihedral == null`). Some bundled patterns record none. The `corridor.ts` comment argues that inventing an angle would be worse than admitting the model cannot run. Results from such patterns are classification results and should be reported that way.
- **No measurable hinge width.** `measuredHingeMm` is the `legA`–`legB` distance converted to mm by `tapeMm / tapeW`. On a vinyl sheet a crease is scored, not cut open, so the two legs coincide and the width is zero. "The strain model has no width to run on", and a width "is not something to invent here."

!!! info "Price scale"
    A crossing costs up to `0.5 × 2 = 1` pattern diagonal. Before tolls, a step along the corridor costs its own length, which is always shorter than the pattern's diagonal. So a fatiguing crease is crossed only when a detour of comparable length is not available. The [Routing](routing.md#corridor-search) page shows the full cost function.

## Strain bands: worst crossing first

A sum of costs is the wrong arithmetic for fatigue. A trace fails at its single worst crossing, not at the total. So the corridor search also tracks a **band** per node and compares routes on their worst band before their cost:

```ts title="src/model/fold-strain.ts › strainBand"
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
```

Band 0 means under the threshold. Band `k ≥ 1` means `ε/ε_f` lies in `[2^(k−1), 2^k)`, capped at `STRAIN_BAND_CAP = 2`. The docblock gives two reasons for coarsening:

- **Bands, not raw strain.** Cycles-to-failure follows a power law, so a *halving* of strain is worth a detour and a one-percent trim is not. Compared on raw strain, the search pays any detour to shave the worst crossing by an epsilon.
- **A cap.** Past a few multiples of the threshold the copper is taken to be failing either way. The `traceformroutebench` measurement quoted in the source: uncapped bands put 58 fatiguing crossings on a pattern where plain cost put 39 and used 2.2× the copper. Capped at 2 it put 30.7 and used 2% more copper.

`corridor.ts › creaseBand` gives a cut the top band outright and falls back to `cap`-or-0 by assignment when strain cannot be computed. [Routing](routing.md#corridor-search) shows how band and cost are packed into one heap key.

## Strain limit: price versus refusal

`SheetSpec.strainLimit` turns a price into a prohibition. When set, `overStrainLimit` marks every corridor node on a hinge whose tensile strain exceeds it as `refused`. `reachableFaces` and `searchCorridor` both skip refused nodes, so an LED behind such a hinge is reported unreachable rather than wired with copper that will crack. The default is `null`, because refusing every crease over the routing threshold "refuses almost every mountain these patterns have" (see `strain-limit.test.ts`). A crease with no recorded angle or no measurable width is never refused.

## Are cuts invisible to the router?

Partly, and less than before. `C` is in `GAP_ASSIGNMENTS`, so a cut edge that two faces share would become a `GapEdge`. `creaseFraction` would charge it 1, and `creaseBand` would give it the top band. The comments in `corridor.ts` record that this branch is **unreachable on the shipped patterns**. A cut there is a *lip*: two boundary edges, one per face, so it fails `isGapEdge`'s "exactly two faces" test. The branch is kept in case such a cut ever appears.

Cuts are still seen, through three other mechanisms:

| Kind of cut | How the router sees it |
|---|---|
| Opened cut (a hole in the silhouette) | Containment. `chordInside` and `tapeOnBody` sample the strip's centreline and both edges with `pointInFace`, and refuse any chord that leaves the material |
| Opened cut narrower than `BRIDGE_MM` (5 mm) | Since `9a1ccb8` "Let copper bridge narrow openings", `buildCorridor` links nodes on facing lips. A hop costs `BRIDGE_TOLL_DIAGS = 20` pattern diagonals plus its length and carries the top band, so it is a last resort |
| Unopened zero-width seam | `seamsOf` finds collinear face edges with *different* vertex ids. `chordInside`, `tapeOnBody` and `wire-rules` refuse to span one, because containment cannot see a seam: there is material on both sides |

`BRIDGE_MM` is "a stated allowance rather than a measurement" (`tape-width.ts`). A kirigami cut opens as a wedge from the vertex the two patches still share. Near that apex the opening is narrow and it closes as the net folds, so tape over it is never pulled.

## Other ways sheet thickness reaches the copper

```ts title="src/model/fold-strain.ts › maxTraceWidthMm, minWebMm"
export function maxTraceWidthMm(hingeLenMm: number, spec: SheetSpec = DEFAULT_SHEET): number {
  const foil = spec.foilGPa * spec.foilMm ** 3;
  if (!(foil > 0)) return Infinity;
  const sheet = spec.substrateGPa * spec.substrateMm ** 3;
  return (STIFFENING_SHARE * Math.max(hingeLenMm, 0) * sheet) / foil;
}
// …
export function minWebMm(spec: SheetSpec = DEFAULT_SHEET): number {
  if (!(spec.substrateMm > 0)) return WEB_REF_MM;
  return (WEB_REF_MM * WEB_REF_THICKNESS_MM) / spec.substrateMm;
}
```

- **`maxTraceWidthMm`**: a copper strip splints the hinge it crosses. Plate bending stiffness goes as `E·h³`, so `w ≤ share·L·(E_s h³)/(E_cu t³)`. Units are GPa·mm³·mm over GPa·mm³, which gives mm. With the default sheet and `STIFFENING_SHARE = 0.5` this is about 7.7 mm of trace per mm of hinge length, so it does not bind against 1.5 mm tape. Because it goes as the cube of the substrate, thin film brings it under the roll. `tape-width.ts › widthMmFor` applies it against the pattern's shortest edge.
- **`minWebMm`**: the strip of bare substrate between two runs must survive weeding, and its strength goes with its thickness, so the floor scales inversely with `h`. It is anchored at 1.1375 mm for 0.4 mm, the figure the code cut to before (`TAPE_MM × LED_GAP_FRAC` at 3.25 mm tape). This is `MIN_WEED_MM`.

## Angle-unit pitfalls

!!! danger "Fold angles are degrees in `GapEdge.dihedral`, but files disagree"
    - **Two sources, two units.** FOLD's `edges_foldAngle` is in degrees by specification. FKLD's `fkld:edges_dihedralTarget` is written by this project's pipeline from an `atan2`, so it is in **radians**. `electronics.ts › dihedralMap` normalises per source (`toDeg = degrees ? 1 : 180 / Math.PI`). Before that fix, every FKLD pattern read as nearly flat: 160° of fold reported as 2.8°, so the old `> 170` test never fired on a real pattern.
    - **Sign comes from the assignment.** `dihedralMap` keeps only the magnitude. `signedFold` makes `V` negative and everything else positive. The two file conventions do not agree on sign, and "guessing a sign convention from a file that does not declare one is how a mountain gets routed as a valley."
    - **`bendRadiusMm` takes degrees** and converts to radians itself. Pass it `GapEdge.dihedral` directly, never a radian value.
    - **`null` is not 0.** No recorded angle stays `null`, and the corridor falls back to classification. `0` is a real flat crease and costs nothing.
    - **`V` does not mean "folds".** The `foldStrain` docblock notes that most `V` edges in the bundled corpus carry a target of exactly 0. Anything that reads the letter as "this folds" is wrong on most valleys that ship.

## Hand-drawn wires use the same rule

`wire-rules.ts › badHinge`, which raises the `fold-fatigue` warning on an author's hand-drawn wire, reads the router's strain model. A cut always warns. Otherwise the crease warns when `foldStrain` at its measured hinge width reaches `routingThresholdStrain`, or when `closureFraction` reaches 1. With no recorded angle or no measurable hinge width it falls back to the letter, as the corridor does: a mountain warns. `WireContext.sheet` carries the sheet the router planned for, so both read the same `SheetSpec`.

Its docblock records why this changed: it used to warn on every `M` (plus `C`, and `V` past 170°), and disagreed with the router on 343 of 1,464 hinges across the corpus, "warning of cracks over a 1.4-degree mountain." See [Editor](editor.md).

## Design choices

| Choice | Alternative considered | Reason (from source) |
|---|---|---|
| Strain from measured hinge width and fold angle | Price by `M`/`V`/`C` letter | The letter "could not answer … *how far* does this crease fold, and *how thick is the sheet*" (header) |
| Price tension, ignore compression (except closure) | Charge by `|ε|` | Nakaya et al.: mountains fracture, valleys plateau. `|θ|` "would flatten that result away" |
| Closure as a 150°→180° ramp | Step at 170° | A step says 169° is safe and 171° ruinous, "which is not true of any sheet" |
| Neutral plane at mid-member | Composite transformed section | The PSA's shear transfer is not established, and the composite reading would fail the backing first, "which it observably does not" (`outerFibreMm`) |
| Threshold derived from ductility at 100 folds | Chosen 1% | 1% corresponds to about 2×10⁴ folds, about 200× stricter than the service life (`thresholdStrainFor`) |
| Fatiguing price floored at 1, graded to 2 by pattern `ε_max` | Clip at 1 | Clipping put every real crease at the ceiling, so a 30° fold and a 120° fold cost the same. Grading "makes the signed strain model order severity rather than merely detect it" (`buildCorridor` `graded` param) |
| Worst-band ordering, bands ×2, capped at 2 | Raw-strain bottleneck; uncapped bands | Raw strain buys detours for epsilon gains. Uncapped bands added fatiguing crossings and doubled copper on the benchmark (`strainBand`) |
| `strainLimit` off by default | Refuse creases over threshold | It would turn "your LED is dear to reach" into "unreachable" across every bundled pattern (`DEFAULT_SHEET`) |
| Fall back to classification when angle or width is missing | Assume an angle or width | An assumed 180° over-prices barely folded mountains, and an assumed gentle fold waves copper over flat-folded ones (`corridor.ts`) |

??? info "Source comments that are out of date"
    These read as current but no longer match the code. Trust the code.

    - `buildCorridor`'s `graded` docs say clipping "arrives at 3.7 degrees of fold on a 0.4mm substrate at a 1.5mm hinge". That was with the old 1% threshold and no adhesive term. At the current values it is `0.03 × 1.5 / 0.285 ≈ 9°`.
    - The `traceformCreaseFraction` docblock writes `eps = (h/2 + t) * theta / w`. The code also adds the adhesive (`outerFibreMm`).
    - `maxTraceWidthMm`'s docblock compares against "0.035mm of copper foil". `foilMm` is now 0.05.

Related: [Routing](routing.md), [Overview](overview.md), [Design decisions](../architecture/design-decisions.md), [FKLD format](../kirigami/fkld.md).
