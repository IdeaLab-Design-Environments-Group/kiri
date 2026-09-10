/**
 * A jump is scored on its lands, not on the plane.
 *
 * Nothing runs between a jump's two ends — the wire leaves the sheet — so no planar crossing test can see a
 * jump, and `PlanKey` deliberately does not carry one. What remains is the copper at each end: two lands of
 * different nets within a tape width of each other are one solder blob away from being the same node.
 * `countJumpClashes` counts exactly those pairs, once each, for scripts and tests to read after the fact.
 */
import { describe, expect, it } from "vitest";
import { countJumpClashes } from "../../../src/model/route-metrics.js";
import type { Jump } from "../../../src/model/trace-types.js";

const TAPE = 2;

/** A routed jump from `a` to `b` on `net`. Pair numbers are irrelevant to this metric. */
const jump = (net: string, ax: number, ay: number, bx: number, by: number, pair = 0): Jump => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  net,
  pair,
  source: "routed",
});

describe("model/route-metrics jump clashes", () => {
  it("counts nothing when there are no jumps", () => {
    expect(countJumpClashes([], TAPE)).toBe(0);
  });

  it("never charges two jumps of the same net for sharing a land", () => {
    // One net rejoined across two seams, landing in the same place twice. That is how a net is carried on,
    // not a short: both lands sit at one potential.
    const a = jump("pwr", 0, 0, 10, 0);
    const b = jump("pwr", 0.1, 0, 10, 5, 1);
    expect(countJumpClashes([a, b], TAPE)).toBe(0);
  });

  it("charges one clash when two nets land within a tape width of each other", () => {
    const pwr = jump("pwr", 0, 0, 10, 0);
    const gnd = jump("gnd", 1, 0, 20, 20, 1);
    expect(countJumpClashes([pwr, gnd], TAPE)).toBe(1);
  });

  it("sees a clash between one jump's a and the other jump's b", () => {
    // The pairing is over ends, not over positions in the record: a's start against b's finish counts too.
    const pwr = jump("pwr", 0, 0, 10, 0);
    const gnd = jump("gnd", 40, 40, 10.5, 0, 1);
    expect(countJumpClashes([pwr, gnd], TAPE)).toBe(1);
  });

  it("treats lands exactly a tape width apart as clean", () => {
    // Strict `<`, the convention `gapNeeded`'s callers already hold: they fault on `d < need`, so touching
    // at exactly the required distance is legal and the boundary belongs to the buildable side.
    const pwr = jump("pwr", 0, 0, 10, 0);
    const gnd = jump("gnd", 0, TAPE, 30, 30, 1);
    expect(countJumpClashes([pwr, gnd], TAPE)).toBe(0);

    // A hair closer and it is a fault, so the case above is pinning the boundary and not merely a miss.
    const near = jump("gnd", 0, TAPE - 1e-9, 30, 30, 1);
    expect(countJumpClashes([pwr, near], TAPE)).toBe(1);
  });

  it("counts nothing for different nets crossing different seams far apart", () => {
    const pwr = jump("pwr", 0, 0, 10, 0);
    const gnd = jump("gnd", 100, 100, 110, 100, 1);
    expect(countJumpClashes([pwr, gnd], TAPE)).toBe(0);
  });

  it("counts each unordered pair once, so three mutually clashing nets give three", () => {
    const a = jump("pwr", 0, 0, 50, 50);
    const b = jump("gnd", 0.5, 0, 50, -50, 1);
    const c = jump("sig", 0, 0.5, -50, 50, 2);
    expect(countJumpClashes([a, b, c], TAPE)).toBe(3);
  });
});
