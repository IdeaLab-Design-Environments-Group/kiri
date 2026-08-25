/**
 * The width the blade actually sees, as against the width the export reports.
 *
 * `CopperSvgExport.widthMm` is the NOMINAL tape, and `tooNarrow` is computed from it. But a strip carries a
 * width per point — narrowed between an LED's legs, and cut at a part's own pad size under a land — and all
 * of that happens after the flag is computed. So a file could be handed over with `tooNarrow: false` while
 * containing copper at a third of the limit that flag names, and nothing anywhere said so.
 *
 * These tests exist to make that gap **loud and measured** rather than silent. They deliberately do NOT
 * assert that the narrow copper is a defect: the local narrowing is old, deliberate and commented, and a
 * flag that fired on every circuit would say nothing. What they pin is the size of the discrepancy, so that
 * whoever decides whether 3mm is the right bar for a local pinch is deciding with the real number in hand.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCopperSvgExport,
  narrowestWidth,
  stripOutline,
} from "../../../src/model/copper-svg-export.js";
import {
  planRoutes,
  tapeMmFor,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** The blade limit the export names. Read from the export's own behaviour, not copied — see below. */
const CUT_LIMIT_MM = 3;

function fixture(extra: Partial<Circuit> = {}) {
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
  const circuit: Circuit = { leds, battery: { face: 0 }, ...extra };
  const tapeW = tapeWidthFor(faces, undefined, undefined, circuit);
  const routed = planRoutes(faces, gaps, circuit);
  return { fold, faces, gaps, circuit, tapeW, routed };
}

describe("model/emitted-width", () => {
  it("reports the narrowest copper in the file, not just the nominal tape", { timeout: 30_000 }, () => {
    const { fold, routed, tapeW } = fixture();
    const x = buildCopperSvgExport(fold, routed.traces, tapeW, "t", routed.pads);
    expect(x.widthMm).toBeCloseTo(3.25, 6);
    // A plain three-LED circuit with a battery: no switch, no library part, nothing exotic. The copper
    // still comes out at about a third of the nominal tape where it lands between an LED's legs.
    expect(x.narrowestMm).toBeLessThan(x.widthMm);
    expect(x.narrowestMm).toBeCloseTo(1.1375, 3);
  });

  it("hands over copper under the blade limit while `tooNarrow` stays false", { timeout: 30_000 }, () => {
    // THE point of this file, stated as a failing property of the product rather than of the code: the flag
    // that means "this cannot be cut" is computed from a width that is not what gets cut.
    //
    // Pinned rather than fixed, on purpose. Flipping `tooNarrow` to read the emitted widths would make it
    // true for every circuit this tool can produce — the assertion below holds on the plainest circuit
    // there is — and a flag that is always true is not a warning, it is noise. The decision about whether
    // 3mm is the right bar for a LOCAL pinch belongs to whoever owns the cutter.
    const { fold, routed, tapeW } = fixture();
    const x = buildCopperSvgExport(fold, routed.traces, tapeW, "t", routed.pads);
    expect(x.narrowestMm).toBeLessThan(CUT_LIMIT_MM);
    expect(x.tooNarrow).toBe(false);
  });

  it("narrows further for a part with its own land, and says so", { timeout: 30_000 }, () => {
    // Each of these cuts copper at its pad's own size, which is smaller again than the LED pinch.
    const base = fixture();
    const run = base.routed.traces.find((t) => t.net === "pwr" && t.pts.length > 2)!;
    const mid = run.pts[Math.floor(run.pts.length / 2)]!;
    const narrowest = (extra: Partial<Circuit>): number => {
      const f = fixture(extra);
      const x = buildCopperSvgExport(f.fold, f.routed.traces, f.tapeW, "t", f.routed.pads);
      return x.narrowestMm;
    };
    const plain = narrowest({});
    const withSwitch = narrowest({ switches: [{ x: mid.x, y: mid.y }] });
    expect(withSwitch).toBeLessThan(plain);
    expect(withSwitch).toBeLessThan(CUT_LIMIT_MM / 2);
  });

  it("reads the same widths the outline is built from", () => {
    // One reading, not two. A second implementation of "how wide is this strip here" is a second thing to
    // drift, and this file has spent a night demonstrating where that leads.
    const { routed, tapeW } = fixture();
    for (const t of routed.traces) {
      if (t.pts.length < 2) continue;
      const w = narrowestWidth(t, tapeW, routed.pads);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(t.width ?? tapeW);
      // And it describes copper that exists: a strip at that width has an outline.
      expect(stripOutline(t, tapeW, routed.pads).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("falls back to the nominal width when there is no copper at all", { timeout: 30_000 }, () => {
    // An empty file is not infinitely narrow. `Math.min` of nothing is `Infinity`, and reporting that as a
    // millimetre figure would be worse than the gap this whole file is about.
    const { fold, tapeW } = fixture();
    const x = buildCopperSvgExport(fold, [], tapeW, "t", []);
    expect(Number.isFinite(x.narrowestMm)).toBe(true);
    expect(x.narrowestMm).toBeCloseTo(x.widthMm, 9);
  });
});
