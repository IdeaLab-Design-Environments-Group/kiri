import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  outlineStrip,
  sheetFrame,
} from "../../../src/model/copper-svg-export.js";
import { buildFkldSvgExport } from "../../../src/model/fkld-svg-export.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import {
  batteryTerminals,
  patternDiag,
  planRoutes,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";

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
  // Width now comes from tapeWidthFor (the real 6.5mm, scaled to the pattern), not a fraction constant.
  const diag = patternDiag(faces);
  const term = batteryTerminals(faces[0]!.centroid, diag, faces[0]!.poly);
  const keepOff = [
    ...r.pads.flatMap((p) => [p.pwr, p.gnd]).filter((p) => !(p.x === 0 && p.y === 0)),
    term.pwr,
    term.gnd,
  ];
  return { fold, faces, traces: r.traces, tapeW: tapeWidthFor(faces), keepOff };
}

/** Flat point to sheet coordinates, the same shift-and-flip the exports use. */
function sheetPoint(fold: any, p: { x: number; y: number }): { x: number; y: number } {
  const coords = fold.vertices_coords as number[][];
  let minX = Infinity, maxY = -Infinity;
  for (const c of coords) {
    minX = Math.min(minX, Number(c[0]) || 0);
    maxY = Math.max(maxY, Number(c[1]) || 0);
  }
  return { x: p.x - minX + 8, y: maxY - p.y + 8 };
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
    const outReal = buildCopperSvgExport(small.fold, small.traces, 8);
    expect(outReal.tooNarrow).toBe(false);
    expect(outReal.widthMm).toBe(8);
  });

  it("produces nothing to cut when nothing is planned", () => {
    const { fold, tapeW } = planned("house.fkld");
    const out = buildCopperSvgExport(fold, [], tapeW);
    expect(out.counts).toEqual({ pwr: 0, gnd: 0 });
    expect(out.svg).toContain("<svg");
  });

  describe("carrier frame", () => {
    it("holds every trace on a tab instead of cutting it free", () => {
      // The point of the carrier: the copper leaves the mat as one piece, so the traces arrive already in
      // position. A closed cut round a trace would free it whatever tabs are drawn -- so no trace outline may
      // be a closed path.
      const { fold, traces, tapeW } = planned("church.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW);
      expect(out.counts.traces).toBeGreaterThan(0);
      expect(out.counts.tabs).toBe(out.counts.traces); // one tab each, nothing left loose
      // Exactly one closed path: the frame's outer edge. Everything else is open.
      const closed = (out.svg.match(/ Z"/g) ?? []).length;
      expect(closed).toBe(1);
    });

    it("breaks the window edge across each tab, so the tab reaches the frame", () => {
      // If the window edge were cut straight through, every tab would be severed from the frame and the traces
      // would drop out -- the exact failure the carrier exists to avoid.
      const { fold, traces, tapeW } = planned("house.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW);
      const { window: win } = sheetFrame(fold);
      // Collect the cut spans lying on the left edge and check they do not cover it end to end.
      const onLeft = [...out.svg.matchAll(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)(?! L)/g)]
        .map((m) => m.slice(1).map(Number) as [number, number, number, number])
        .filter(([x1, , x2]) => Math.abs(x1 - win.x0) < 1e-6 && Math.abs(x2 - win.x0) < 1e-6);
      const covered = onLeft.reduce((n, [, y1, , y2]) => n + Math.abs(y2 - y1), 0);
      if (onLeft.length) expect(covered).toBeLessThan(win.y1 - win.y0 - 1e-6);
    });

    it("tabs at the tape's own width, clear of the other net, using whichever wall is free", () => {
      // A tab across another trace would be stuck down on top of it, shorting the two, and snipping it would cut
      // the trace underneath. Same-net runs are not obstacles: they meet at junctions by design.
      // Zero on akde-hex. house and church each keep a couple: routing around mountain folds sends runs down
      // narrower corridors, which leaves fewer clear lines out to a wall. Pinned so they cannot spread.
      const budget: Record<string, number> = { "akde-hex.fkld": 0, "house.fkld": 2, "church.fkld": 1 };
      for (const [name, want] of Object.entries(budget)) {
        const { fold, traces, tapeW } = planned(name, 12);
        const out = buildCopperCarrierExport(fold, traces, tapeW);
        expect(out.crossingTabs, `${name} has tabs across a trace`).toBeLessThanOrEqual(want);
        expect(out.tabPaths).toHaveLength(out.counts.tabs);
        // Every tab starts inside the window and ends on one of its four walls.
        const { window: win } = out.frame;
        for (const path of out.tabPaths) {
          const end = path[path.length - 1]!;
          const onWall =
            Math.abs(end.x - win.x0) < 1e-6 || Math.abs(end.x - win.x1) < 1e-6 ||
            Math.abs(end.y - win.y0) < 1e-6 || Math.abs(end.y - win.y1) < 1e-6;
          expect(onWall, `${name} tab does not reach a wall`).toBe(true);
        }
      }
    });

    it("grips the trace body, never a pad or a battery terminal", () => {
      // A tab on a pad sits exactly where the LED goes, and snipping it would cut at the pad. The pads are the
      // outermost points of every run, so they are the first thing a nearest-wall search reaches -- which is
      // what it used to pick.
      // Zero on every pattern but puffin, which has one run so short that every point on it is under a
      // component, leaving the tab nowhere else to grip. Counted, not hidden.
      const budget: Record<string, number> = {
        "house.fkld": 0,
        "church.fkld": 0,
        "akde-hex.fkld": 0,
        "akde-square-pyramid.fkld": 0,
        "puffin.fkld": 2,
      };
      for (const [name, want] of Object.entries(budget)) {
        const { fold, traces, tapeW, keepOff } = planned(name, 12);
        const out = buildCopperCarrierExport(fold, traces, tapeW, "x", keepOff);
        expect(out.padTabs, `${name} tabs gripping a component`).toBeLessThanOrEqual(want);
        // Cross-check against the geometry, at the clearance the code actually promises (one tape width).
        const sheetKeep = keepOff.map((p) => sheetPoint(fold, p));
        const gripping = out.tabPaths.filter((path) =>
          sheetKeep.some((q) => Math.hypot(path[0]!.x - q.x, path[0]!.y - q.y) < tapeW * 0.999),
        ).length;
        expect(gripping, `${name} anchors on a component`).toBeLessThanOrEqual(want);
        expect(out.tabPaths.length).toBeGreaterThan(0);
      }
    });

    it("reports tabs it could not route clear rather than hiding them", () => {
      // puffin's window is crowded enough that some runs are enclosed by the other net with no clear line out.
      const { fold, traces, tapeW } = planned("puffin.fkld", 12);
      const out = buildCopperCarrierExport(fold, traces, tapeW);
      expect(out.crossingTabs).toBeGreaterThan(0);
      expect(out.crossingTabs).toBeLessThanOrEqual(out.counts.tabs);
    });

    it("frames the pattern with a 5mm border, inside the sheet the other layers use", () => {
      const { fold, traces, tapeW } = planned("akde-hex.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW);
      const { w, h, window: win } = sheetFrame(fold);
      // The outer rectangle is the first path, and sits 5mm outside the window on every side.
      const first = out.svg.match(/<path d="M ([^"]+) Z"/)![1]!.match(/-?[\d.]+/g)!.map(Number);
      // The file rounds to 3 decimals, so compare at that precision.
      expect(first[0]).toBeCloseTo(win.x0 - 5, 3);
      expect(first[1]).toBeCloseTo(win.y0 - 5, 3);
      expect(first[2]).toBeCloseTo(win.x1 + 5, 3);
      expect(first[5]).toBeCloseTo(win.y1 + 5, 3);
      // Still the same sheet, so it registers with cut and score.
      expect(out.svg).toContain(`width="${Math.round(w * 1000) / 1000}mm"`);
      expect(out.svg).toContain(`height="${Math.round(h * 1000) / 1000}mm"`);
    });

    it("is named apart from the plain trace file, and reports the same width warning", () => {
      const { fold, traces, tapeW } = planned("church.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW, "puffin");
      expect(out.filename).toBe("puffin-copper-carrier.svg");
      expect(out.tooNarrow).toBe(true); // church is 19mm across
      expect(buildCopperCarrierExport(fold, traces, 8).tooNarrow).toBe(false);
    });
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
