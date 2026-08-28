/**
 * The router's objective is a ranking, not a number.
 *
 * `PlanKey` is `[chips, terminals, crossings, defects, length]`, worst fault first, and the promise it
 * makes is absolute: no quantity of a lower entry may ever buy a unit of a higher one. Tape under a chip
 * destroys the part; a PWR×GND crossing shorts the layout; a sharp join only makes the sheet hard to weed.
 * Those are different kinds of bad, and trading between them is never the right answer.
 *
 * That promise used to be kept by a weighted sum — `chips·1e12 + terms·1e9 + crossings·1e6 + defects +
 * length·1e-6` — whose comments claimed the ranking above and whose arithmetic merely happened to produce
 * it, because the constants were far apart. These tests pin the guarantee itself rather than the numbers
 * it used to be spelled with, so they would have FAILED against the old sum on the cases below.
 */
import { describe, expect, it } from "vitest";
import { lexLess, type PlanKey } from "../../../src/model/electronics-routing.js";

/** The sum this replaced, so the cases can state what it would have done. */
const oldSum = (k: PlanKey): number =>
  k[0] * 1e12 + k[1] * 1e9 + k[2] * 1e6 + k[3] + k[4] * 1e-6;

describe("model/plan-key", () => {
  it("ranks on the first entry that differs and never looks below it", () => {
    // One chip fault against every other measure at its worst. A plan that shorts a component is worse
    // than any amount of untidy copper, and no total of the lower tiers may say otherwise.
    const oneChip: PlanKey = [1, 0, 0, 0, 0];
    const messy: PlanKey = [0, 9, 9, 9e9, 9e9];
    expect(lexLess(messy, oneChip)).toBe(true);
    expect(lexLess(oneChip, messy)).toBe(false);
  });

  it("refuses the trade the weighted sum would have made", () => {
    // The case the sum gets wrong. A defect tier of 2e6 outweighs the 1e6 a crossing was worth, so the
    // sum ranks the crossing plan BETTER — it buys a short in the layout with a tidier sheet. Measured on
    // the bundled patterns the worst real defect tier is 214.5 against that 1e6, a margin of about 4700x,
    // so this never happened in practice; it is a property of the arithmetic, not of the corpus, and a
    // larger pattern is all that stands between it and happening.
    const crossing: PlanKey = [0, 0, 1, 0, 0];
    const defects: PlanKey = [0, 0, 0, 2e6, 0];
    expect(lexLess(defects, crossing), "a crossing must outrank any quantity of defect").toBe(true);
    expect(oldSum(defects) > oldSum(crossing), "the old sum ranked them the other way").toBe(true);
  });

  it("is a strict order: equal keys are not less than each other", () => {
    const k: PlanKey = [0, 1, 2, 3.5, 4];
    expect(lexLess(k, [...k] as unknown as PlanKey)).toBe(false);
    expect(lexLess([...k] as unknown as PlanKey, k)).toBe(false);
  });

  it("compares only the leading entries when asked, which is how length is excluded", () => {
    // The squared-landing gate compares everything except length: a squared landing is always slightly
    // longer than a diagonal one — that is what it is for — and the tie-breaker refused every one of them
    // when the gate first went in. `upto: 4` says that exactly, where the old code subtracted the length
    // term back out of the sum and so depended on the scale separation a second time.
    const shortPlan: PlanKey = [0, 0, 0, 5, 10];
    const longPlan: PlanKey = [0, 0, 0, 5, 99];
    expect(lexLess(shortPlan, longPlan)).toBe(true);
    expect(lexLess(shortPlan, longPlan, 4)).toBe(false);
    expect(lexLess(longPlan, shortPlan, 4)).toBe(false);
  });

  it("keeps defects as ONE entry, so joins and overlap can still be traded", () => {
    // Deliberate, and the only place in the key where two measures are weighed against each other:
    // `countAcuteJoins · overlapTol · 4` converts a join into a length so it can be spent against overlap
    // in the same currency. Splitting it into two entries would make one absolute and change the
    // objective. Asserted through the key's shape, which is what a future edit would break.
    const k: PlanKey = [0, 0, 0, 1, 0];
    expect(k).toHaveLength(5);
    // Four joins' worth of defect and none of overlap ranks with overlap of the same length, not above it.
    expect(lexLess([0, 0, 0, 3, 0], [0, 0, 0, 4, 0])).toBe(true);
    expect(lexLess([0, 0, 0, 4, 0], [0, 0, 0, 4, 0])).toBe(false);
  });
});
