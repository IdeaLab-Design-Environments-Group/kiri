/**
 * Every across-part's pad, in the run's axes, on both sides of the pipeline.
 *
 * **This is the test that was missing, and its absence is the whole story.** `acrossPart` normalises
 * `rowSep` and `pitch` into the run's frame and returned `pad` raw, so every consumer that read `.w` as
 * "across the rail" was right about the 44 library parts whose terminals run along x and wrong about the
 * 43 whose terminals run along y. Three sessions reasoned about which axis meant what and reached three
 * different wrong answers; the suite stayed green throughout, because the drawing and the copper read the
 * SAME wrong field and therefore agreed with each other.
 *
 * That is why the sweep asserts a triangle rather than a pair:
 *
 *  1. the DRAWING's pad matches the footprint, in the run's axes
 *  2. the CUT land matches the footprint, in the run's axes
 *  3. and the two match each other
 *
 * Any one of the three alone stays green through the bug. (3) held before this fix and (1) and (2) did
 * not. A test on internal consistency would have proved the two halves were wrong together.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LIBRARY, componentById } from "../../../src/model/library.js";
import { acrossPart, padAxis, padRunBox, placement } from "../../../src/model/parts.js";
import { padSize, terminals } from "../../../src/model/footprint.js";
import { partShape } from "../../../src/model/copper-svg-export.js";
import {
  planRoutes,
  tapeMmFor,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** Every library component the rail steps across, with its id. */
function acrossParts(): { id: string; fp: ReturnType<typeof componentById> extends null ? never : any }[] {
  return LIBRARY.filter((c) => acrossPart(c.footprint) !== null).map((c) => ({ id: c.id, fp: c.footprint }));
}

/**
 * The footprint's own truth about ONE NAMED terminal, in the RUN's axes — derived from `padSize` and
 * `alongIsY` directly rather than from `padRunBox`, so the test does not check the implementation against
 * itself. A turned part's footprint along-axis is the run's across-axis.
 *
 * By name, not by position: a part's terminals are not all the same size — `Amplifier_Analog_MAX98357AETE`
 * has a 0.25mm pad first and a 0.50mm one where `acrossPart` picks its `live` — so sampling the first
 * terminal and comparing it against the live one measures the part's own variation and calls it a bug.
 * The first draft of this test did exactly that.
 */
function truthOf(fp: any, name: string): { across: number; along: number } {
  const ax = padAxis(fp);
  const t = terminals(fp).find(([n]) => n === name)?.[1];
  if (!t) throw new Error(`no terminal "${name}"`);
  const s = padSize(t);
  return ax.alongIsY ? { across: s.h, along: s.w } : { across: s.w, along: s.h };
}

/** A drawn lead's extents resolved against the run direction `u`. */
function leadExtents(
  lead: { a: Vec2; b: Vec2; width: number },
  u: Vec2,
): { across: number; along: number } {
  const dx = lead.b.x - lead.a.x, dy = lead.b.y - lead.a.y;
  const len = Math.hypot(dx, dy);
  const alongRun = Math.abs((dx * u.x + dy * u.y) / len) > 0.7;
  return alongRun
    ? { across: lead.width, along: len }
    : { across: len, along: lead.width };
}

describe("model/pad-axis — the run's axes, end to end", () => {
  it("has across-parts of both axis families, or the sweep proves nothing", () => {
    // A guard on the CORPUS, not on the code. Every assertion below is vacuous if the library happens to
    // hold only x-axis parts, which is exactly the condition under which the original bug was invisible.
    const parts = acrossParts();
    const byY = parts.filter((p) => padAxis(p.fp).alongIsY).length;
    expect(parts.length).toBeGreaterThan(50);
    expect(byY).toBeGreaterThan(10);
    expect(parts.length - byY).toBeGreaterThan(10);
  });

  it("normalises every across-part's pad into the run's axes", () => {
    for (const { id, fp } of acrossParts()) {
      const ap = acrossPart(fp)!;
      const want = truthOf(fp, ap.names.live); // the pad `acrossPart` itself reports
      const got = ap.pad;
      expect(got.w, `${id} across-run extent`).toBeCloseTo(want.across, 9);
      expect(got.h, `${id} along-run extent`).toBeCloseTo(want.along, 9);
    }
  });

  it("draws every across-part's pad at the footprint's own size, in the run's axes", () => {
    // (1) of the triangle. `partShape` is what the canvas and the export's parts layer both draw from,
    // and the notch it carries is cut, so a transposed drawing removes the wrong copper.
    const a = { x: 0, y: 0 }, b = { x: 40, y: 0 };
    const u = { x: 1, y: 0 };
    let checked = 0;
    for (const { id, fp } of acrossParts()) {
      const sh = partShape(fp, a, b, false);
      if (!sh || !sh.leads.length) continue;
      // EVERY named lead against its OWN terminal, not one sample against one guess: a part whose pads
      // differ in size is precisely where a single-sample check stops meaning anything.
      for (const lead of sh.leads) {
        if (lead.name === undefined) continue;
        const want = truthOf(fp, lead.name);
        const got = leadExtents(lead, u);
        expect(got.across, `${id} pad ${lead.name} drawn across-run`).toBeCloseTo(want.across, 6);
        expect(got.along, `${id} pad ${lead.name} drawn along-run`).toBeCloseTo(want.along, 6);
      }
      checked++;
    }
    expect(checked, "no across-part was actually drawn").toBeGreaterThan(50);
  });

  it("cuts land copper at the pad's own across-run width, and agrees with the drawing", { timeout: 30_000 }, () => {
    // (2) and (3). Only the parts a rail can actually pass through reach `switchLand` — `placement()`
    // refuses anything past three terminals — so this is 8 of the 87, and the 3 transposed ones among them
    // are the entire wrong-copper-on-a-sheet radius of the bug this file pins.
    const fold = JSON.parse(readFileSync(`${EXAMPLES}akde-hex.fkld`, "utf8")) as FoldFile;
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    const seen = new Set<string>();
    const leds: Led[] = [];
    for (const g of gaps) {
      const l = ledOf(g.faceA, g.faceB);
      const k = `${l.a}_${l.b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      leds.push(l);
      if (leds.length >= 3) break;
    }
    const base: Circuit = { leds, battery: { face: 0 } };
    const plain = planRoutes(faces, gaps, base);
    const run = plain.traces.find((t) => t.net === "pwr" && t.pts.length > 2)!;
    const mid = run.pts[Math.floor(run.pts.length / 2)]!;
    const k = tapeMmFor(faces, undefined, undefined, base) / tapeWidthFor(faces, undefined, undefined, base);

    const seatable = acrossParts().filter(({ fp }) => placement(fp).placeable);
    expect(seatable.length, "nothing seatable — the cut half of the sweep would be vacuous")
      .toBeGreaterThan(2);

    let seated = 0;
    for (const { id, fp } of seatable) {
      const r = planRoutes(faces, gaps, { ...base, parts: [{ component: id, x: mid.x, y: mid.y }] });
      const lands = r.traces.filter((t) => t.width !== undefined);
      const seat = r.parts?.[0];
      if (!seat || !lands.length) continue; // this part found no seat on this pattern; not this test's claim
      const du = { x: seat.b.x - seat.a.x, y: seat.b.y - seat.a.y };
      const L = Math.hypot(du.x, du.y);
      const u = { x: du.x / L, y: du.y / L };
      const want = truthOf(fp, acrossPart(fp)!.names.live);

      // (2) the cut land against the footprint.
      const l0 = lands[0]!;
      const [p, q] = [l0.pts[0]!, l0.pts[l0.pts.length - 1]!];
      const dl = Math.hypot(q.x - p.x, q.y - p.y);
      const alongRun = Math.abs(((q.x - p.x) * u.x + (q.y - p.y) * u.y) / dl) > 0.7;
      const landAcross = (alongRun ? l0.width! : dl) * k;
      expect(landAcross, `${id} land across-run`).toBeCloseTo(want.across, 6);

      // (3) and against the drawing, which is the property that held all through the bug.
      const sh = partShape(fp, seat.a, seat.b, seat.flip)!;
      const drawn = leadExtents(sh.leads[0]!, u);
      expect(drawn.across * k, `${id} drawn vs cut`).toBeCloseTo(landAcross, 6);
      seated++;
    }
    expect(seated, "no part seated — the cut assertions never ran").toBeGreaterThan(0);
  });
});
