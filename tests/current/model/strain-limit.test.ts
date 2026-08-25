/**
 * Strain as a LIMIT rather than a price.
 *
 * `fatigueStrain` makes a crease dear to cross. `strainLimit` makes it impossible: copper may not use that
 * hinge, and an LED reachable only across one is reported unreachable rather than wired with tape that
 * will crack. The two are deliberately separate settings — the first is what the router optimises against,
 * the second is a refusal — and the limit is OFF by default for the reason measured below.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Led } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  FOLD_PENALTY_FRAC,
  buildCorridor,
  patternDiag,
  planRoutes,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";
import { DEFAULT_SHEET, type SheetSpec } from "../../../src/model/fold-strain.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const load = (n: string): FoldFile => JSON.parse(readFileSync(`${EXAMPLES}${n}`, "utf8")) as FoldFile;

function on(name: string): { faces: ReturnType<typeof flatFaces>; gaps: any[]; tapeW: number } {
  const fold = load(name);
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces) };
}

function ledsOn(gaps: { faceA: number; faceB: number }[], max: number): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(l);
    if (leds.length >= max) break;
  }
  return leds;
}

const limited = (strainLimit: number | null): SheetSpec => ({ ...DEFAULT_SHEET, strainLimit });

describe("model/strain-limit", () => {
  it("refuses nothing when no limit is set, which is the default", () => {
    const { faces, gaps, tapeW } = on("house.fkld");
    const c = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW);
    expect(DEFAULT_SHEET.strainLimit).toBeNull();
    expect(c.refused.size).toBe(0);
  });

  it("refuses the creases that would crack the trace, once a limit is set", () => {
    const { faces, gaps, tapeW } = on("house.fkld");
    const c = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, limited(0.01));
    expect(c.refused.size).toBeGreaterThan(0);
  });

  it("scales with the sheet: a thinner substrate passes creases a thicker one is refused", () => {
    // The coupling made load-bearing. Same pattern, same limit, different sheet — and the thin sheet
    // strains its copper less, so fewer creases are out of bounds.
    const { faces, gaps, tapeW } = on("house.fkld");
    const refusedOn = (substrateMm: number): number =>
      buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, {
        ...limited(0.01),
        substrateMm,
      }).refused.size;
    expect(refusedOn(0.05)).toBeLessThan(refusedOn(0.8));
  });

  it("reports an LED behind a refused crease as unreachable, rather than wiring it anyway", () => {
    // The whole point of a limit. Reachability and the search must agree: an LED called reachable and
    // then not routed would be reported as wired and drawn with no copper.
    const { faces, gaps } = on("house.fkld");
    const leds = ledsOn(gaps, 6);
    const loose = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
    const strict = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined, limited(0.001));
    expect(strict.unreachable.length).toBeGreaterThan(loose.unreachable.length);
    for (const i of strict.unreachable) expect(strict.pads[i]).toBeTruthy(); // still reported, not dropped
  });

  it("lays no copper over a crease it refused", () => {
    // The load-bearing assertion: a refusal that the router then routed over would be worse than no
    // refusal at all, because it would report a fold-safe circuit that is not one.
    const { faces, gaps, tapeW } = on("house.fkld");
    const sheet = limited(0.001);
    const c = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, sheet);
    const refusedPts = [...c.refused].map((k) => c.point.get(k)!).filter(Boolean);
    expect(refusedPts.length).toBeGreaterThan(0);

    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 6), battery: { face: 0 } }, undefined, sheet);
    for (const t of r.traces) {
      for (const p of t.pts) {
        for (const q of refusedPts) {
          expect(Math.hypot(p.x - q.x, p.y - q.y), "a run used a refused crossing").toBeGreaterThan(1e-9);
        }
      }
    }
  });

  it("records what a limit at the fatigue strain costs across the corpus", () => {
    // Why the default is null, in numbers. Strain saturates at about 12 degrees of fold on the default
    // sheet, so a limit set at the fatigue strain refuses most of the mountains these patterns are made
    // of, and the reach collapses. Recorded rather than argued.
    const rows: string[] = [];
    for (const name of ["house.fkld", "church.fkld", "akde-hex.fkld"]) {
      const { faces, gaps } = on(name);
      const leds = ledsOn(gaps, 6);
      const loose = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
      const strict = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined, limited(0.01));
      rows.push(`${name}: unreachable ${loose.unreachable.length} -> ${strict.unreachable.length} of ${leds.length}`);
      expect(strict.unreachable.length).toBeGreaterThanOrEqual(loose.unreachable.length);
    }
    // eslint-disable-next-line no-console
    console.log("strain limit at fatigue strain:", rows.join(" | "));
  });

  it("tells an LED that cannot be reached apart from one that will not fit", () => {
    // Found by measurement, not by reading: `akde-square-pyramid` reports 8 of 12 LEDs unreachable and
    // every one of them is a seating failure — the package's pads, stepped off the hinge by the tape's
    // width, do not land on their own tiles. Reported as "unreachable" it reads as a routing failure and
    // sends the author to move parts that were never in the wrong place.
    const fold = load("akde-square-pyramid.fkld");
    const faces = flatFaces(fold);
    const { gaps } = gapGraph(fold, faces);
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
    expect(r.unreachable.length).toBeGreaterThan(0);
    expect(r.unseated.length, "no LED was reported as unseated").toBeGreaterThan(0);
    // Unseated is a subset of unreachable — it is a reason, not a second list of victims.
    for (const i of r.unseated) expect(r.unreachable).toContain(i);

    // And a pattern whose LEDs seat cleanly reports none of them.
    const houseFold = load("house.fkld");
    const hf = flatFaces(houseFold);
    const hg = gapGraph(houseFold, hf).gaps;
    const house = planRoutes(hf, hg, { leds: ledsOn(hg, 4), battery: { face: 0 } });
    expect(house.unseated).toEqual([]);
  });
});
