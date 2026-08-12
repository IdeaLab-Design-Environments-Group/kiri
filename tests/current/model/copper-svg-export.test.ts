import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCopperSvgExport, outlineStrip } from "../../../src/model/copper-svg-export.js";
import { buildFkldSvgExport } from "../../../src/model/fkld-svg-export.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import { patternDiag, planRoutes } from "../../../src/model/electronics-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  return { fold, faces, gaps };
}

function ledsOn(gaps: ReturnType<typeof load>["gaps"], max: number): Led[] {
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

function planned(name: string, n = 6) {
  const { fold, faces, gaps } = load(name);
  const circuit: Circuit = { leds: ledsOn(gaps, n), battery: { face: 0 } };
  const r = planRoutes(faces, gaps, circuit);
  return { fold, faces, traces: r.traces, tapeW: patternDiag(faces) * 0.011 };
}

describe("model/copper-svg-export", () => {
  it("emits closed filled outlines, not stroked centrelines", () => {
    // A cutter follows the path, so a stroked centreline would cut a slit down the middle of each strip
    // instead of cutting the strip out.
    const { fold, traces, tapeW } = planned("house.fkld");
    const out = buildCopperSvgExport(fold, traces, tapeW);
    expect(out.svg).toContain('stroke="none"');
    expect(out.svg).not.toMatch(/stroke-width/);
    expect(out.svg).toMatch(/fill="#ff0000"/);
    // Every path is a closed ring.
    const paths = out.svg.match(/<path d="[^"]+"/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.trimEnd().endsWith('Z"')).toBe(true);
  });

  it("groups the two nets separately so a cutter sees two layers", () => {
    const { fold, traces, tapeW } = planned("church.fkld");
    const out = buildCopperSvgExport(fold, traces, tapeW);
    expect(out.svg).toContain('<g id="pwr"');
    expect(out.svg).toContain('<g id="gnd"');
    expect(out.counts.pwr).toBeGreaterThan(0);
    expect(out.counts.gnd).toBeGreaterThan(0);
    // One outline per planned run, so the reported strip count is what has to be cut and laid.
    const total = out.counts.pwr + out.counts.gnd;
    expect(total).toBe(traces.filter((t) => t.pts.length >= 2).length);
  });

  it("shares the cut file's frame exactly, so the layers import registered", () => {
    // The whole point of matching MARGIN, bounds and the Y-flip: copper must land on the pattern it was
    // planned for, without being nudged into place by hand.
    const { fold, traces, tapeW } = planned("akde-hex.fkld");
    const copper = buildCopperSvgExport(fold, traces, tapeW);
    const main = buildFkldSvgExport(fold, "base")!;
    const box = (svg: string): string => svg.match(/viewBox="([^"]+)"/)![1]!;
    const size = (svg: string): string => svg.match(/width="([^"]+)" height="([^"]+)"/)!.slice(1, 3).join("x");
    expect(box(copper.svg)).toBe(box(main.combined.svg));
    expect(size(copper.svg)).toBe(size(main.combined.svg));
  });

  it("names the file so it sits beside the cut and score files", () => {
    const { fold, traces, tapeW } = planned("house.fkld");
    expect(buildCopperSvgExport(fold, traces, tapeW, "puffin").filename).toBe("puffin-copper.svg");
  });

  it("flags strips too narrow to cut instead of handing over an uncuttable file", () => {
    // church is 19mm across, so a strip at the preview width is 0.3mm -- no blade tracks that, and no copper
    // tape is that narrow. The file is still produced, dimensionally faithful, but the caller is told.
    const small = planned("church.fkld");
    const outSmall = buildCopperSvgExport(small.fold, small.traces, small.tapeW);
    expect(outSmall.widthMm).toBeLessThan(1.5);
    expect(outSmall.tooNarrow).toBe(true);

    // The same pattern at a real scale is fine.
    const outReal = buildCopperSvgExport(small.fold, small.traces, 5);
    expect(outReal.tooNarrow).toBe(false);
    expect(outReal.widthMm).toBe(5);
  });

  it("produces nothing to cut when nothing is planned", () => {
    const { fold, tapeW } = planned("house.fkld");
    const out = buildCopperSvgExport(fold, [], tapeW);
    expect(out.counts).toEqual({ pwr: 0, gnd: 0 });
    expect(out.svg).toContain("<svg");
  });

  describe("outlineStrip", () => {
    it("outlines a straight run as a rectangle of the tape's width", () => {
      const ring = outlineStrip([{ x: 0, y: 0 }, { x: 10, y: 0 }], 2);
      expect(ring).toHaveLength(4);
      // Two points either side at half the width.
      expect(ring.map((p) => p.y).sort((a, b) => a - b)).toEqual([-1, -1, 1, 1]);
      expect(new Set(ring.map((p) => p.x))).toEqual(new Set([0, 10]));
    });

    it("encloses the full length of a bent run", () => {
      // The strip ends flush at its endpoints -- tape has no end caps -- so the run spans x 0..11 (the outer
      // corner is half a width past the bend) and y -1..11.
      const ring = outlineStrip([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 2);
      const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
      expect(Math.min(...xs)).toBe(0);
      expect(Math.max(...xs)).toBeCloseTo(11, 6);
      expect(Math.min(...ys)).toBeCloseTo(-1, 6);
      expect(Math.max(...ys)).toBe(10);
    });

    it("caps the mitre on a sharp turn instead of throwing out a spike", () => {
      // A hairpin: an uncapped mitre runs away to infinity as the angle closes.
      const ring = outlineStrip([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0.2 }], 2);
      for (const p of ring) {
        expect(Math.abs(p.x)).toBeLessThan(40);
        expect(Math.abs(p.y)).toBeLessThan(40);
      }
    });

    it("returns nothing for a degenerate run or a zero width", () => {
      expect(outlineStrip([{ x: 1, y: 1 }], 2)).toEqual([]);
      expect(outlineStrip([{ x: 1, y: 1 }, { x: 1, y: 1 }], 2)).toEqual([]);
      expect(outlineStrip([{ x: 0, y: 0 }, { x: 5, y: 0 }], 0)).toEqual([]);
    });
  });
});
