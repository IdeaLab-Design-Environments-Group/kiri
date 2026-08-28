/**
 * The crease price against a **length-only** baseline.
 *
 * `fold-strain.test.ts` asks what the strain model charges; this asks what charging it is worth. The
 * comparison is `planRoutes` at its shipped `FOLD_PENALTY_FRAC` against the same `planRoutes` with the
 * price set to zero — a router that minimises copper and nothing else — on the same patterns, the same
 * circuits and the same code. A baseline routed by a fork of the router would measure the fork.
 *
 * Crossings are counted by **face transition**, not by segment intersection: a route through the corridor
 * graph passes exactly *through* a hinge midpoint, and a proper-crossing test does not see that. Counted
 * the wrong way, `house` at three LEDs reads as zero mountain crossings for the length-only route and one
 * for the priced route — the exact opposite of what the two plans do.
 *
 * Recorded, not aspirational: these are what the router gives today.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Led, flatFaces, gapGraph, ledOf, pointInFace } from "../../../src/model/electronics.js";
import { FOLD_PENALTY_FRAC, patternDiag, planRoutes, totalLength } from "../../../src/model/electronics-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps };
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

/** Tension (mountain) and compression (valley) crossings, by the face the copper is on. */
function crossings(name: string, ledCount: number, creaseFrac?: number) {
  const { faces, gaps } = load(name);
  const leds = ledsOn(gaps, ledCount);
  const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined, undefined, creaseFrac);
  const gapFor = new Map<string, (typeof gaps)[number]>();
  for (const g of gaps) gapFor.set(`${Math.min(g.faceA, g.faceB)}_${Math.max(g.faceA, g.faceB)}`, g);
  const step = patternDiag(faces) / 3000;
  let tension = 0;
  let compression = 0;
  for (const t of r.traces) {
    let last = -1;
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!;
      const b = t.pts[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 0; k <= n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        const f = pointInFace(faces, p);
        if (f < 0) continue;
        if (last >= 0 && f !== last) {
          const g = gapFor.get(`${Math.min(f, last)}_${Math.max(f, last)}`);
          // No gap edge means a flat facet diagonal (`F`) interior to one printed tile — measured: every
          // unpriced transition on `house` and `akde-hex` is one of those. Nothing folds there.
          if (g) {
            if (g.dihedral != null ? g.dihedral > 0 : g.assignment === "M") tension++;
            else if (g.assignment !== "C") compression++;
          }
        }
        last = f;
      }
    }
  }
  return { tension, compression, len: +totalLength(r.traces).toFixed(2) };
}

describe("model/crease-price", () => {
  it("buys tension crossings, and pays for them in copper", { timeout: 60000 }, () => {
    // `church` at seven LEDs, the cheapest pattern where the price changes the plan at all: six mountain
    // crossings fewer for 14.1% more copper. Both halves of the trade are pinned, because a change that
    // keeps the crossings and drops the copper is an improvement and a change that keeps the copper and
    // drops the crossings is a regression — and one number cannot tell them apart.
    //
    // Re-recorded on 2026-08-28 when `TAPE_MM` fell to 1.5 (from 16/14 crossings and 14.23/15.07 units).
    // Narrower tape gives the search more room, so it both crosses more creases when nothing stops it and
    // avoids more of them when the price does: the trade got wider at both ends, which is the direction it
    // should move, and the assertions below pin the SHAPE of it rather than only the four numbers.
    const priced = crossings("church.fkld", 12);
    const lengthOnly = crossings("church.fkld", 12, 0);
    expect(lengthOnly.tension).toBe(17);
    expect(priced.tension).toBe(11);
    expect(lengthOnly.len).toBeCloseTo(13.9, 2);
    expect(priced.len).toBeCloseTo(15.86, 2);
    // The trade itself, independent of the four figures above: fewer creases crossed, more copper spent.
    expect(priced.tension).toBeLessThan(lengthOnly.tension);
    expect(priced.len).toBeGreaterThan(lengthOnly.len);
  });

  it("is saturated: the shipped price and the full diagonal plan identically", { timeout: 60000 }, () => {
    // The crease price stops changing routes at or below where it is set: every route is identical from
    // `FOLD_PENALTY_FRAC` up to the full diagonal Nakaya et al. use, so its exact value is not a number this
    // system has to defend — anything from the knee up gives the same plan.
    //
    // **The margin is gone, and that is the finding.** This used to saturate at 0.15, "well below where it
    // is set", and on 2026-08-28 `TAPE_MM` fell to 1.5 and the knee moved to 0.5 — exactly the shipped
    // value. Swept on church: 0 -> 17 crossings, 0.05 -> 15, 0.1 through 0.3 -> 14, and 0.5 through 1.0 ->
    // 11. Narrower tape opens routes that a wider price is still needed to reject, so the knee follows the
    // tape down. It has not crossed yet; a further narrowing could push it past 0.5, and then the exact
    // value starts mattering again. Pinned here so that happens loudly.
    const knee = crossings("church.fkld", 12, FOLD_PENALTY_FRAC);
    expect(knee).toEqual(crossings("church.fkld", 12, 1));
    expect(knee).toEqual(crossings("church.fkld", 12, 0.7));
    // And the knee really is at the shipped value rather than below it: just under, the plan still differs.
    expect(crossings("church.fkld", 12, 0.3)).not.toEqual(knee);
  });
});
