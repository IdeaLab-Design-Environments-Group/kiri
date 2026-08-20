import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  mirrorPoint,
  openAround,
  outlineStrip,
  sheetFrame,
  stripOutline,
} from "../../../src/model/copper-svg-export.js";
import { buildFkldSvgExport } from "../../../src/model/fkld-svg-export.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led, type Vec2 } from "../../../src/model/electronics.js";
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

/** The same fixture as `planned`, but routed for a chosen sheet size. */
function plannedAt(name: string, sheetMm: number, n = 6) {
  const { fold, faces, gaps } = load(name);
  const circuit: Circuit = { leds: ledsOn(gaps, n), battery: { face: 0 } };
  return { fold, faces, gaps, circuit, sheetMm };
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
  return { fold, faces, traces: r.traces, tapeW: tapeWidthFor(faces), keepOff, pads: r.pads };
}

/** Just the carrier's cut geometry. The file also carries a non-cut annotation layer, which is drawn with
 *  closed filled shapes -- so anything asserting what gets CUT has to look only in here. */
function cutLayer(svg: string): string {
  const from = svg.indexOf('<g id="carrier"');
  expect(from).toBeGreaterThanOrEqual(0);
  return svg.slice(from, svg.indexOf("</g>", from));
}

/** Distance from a point to a segment. */
function ptSeg(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const abx = b.x - a.x, aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
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

  it("reports the width the strips are actually cut at, not the pattern's own units", () => {
    // church carries no scale -- it is 19 units across -- so it is cut at the print sheet, where the
    // router's 0.3-unit tape is a real 3.25mm. Reporting the raw 0.3 called a perfectly cuttable file
    // uncuttable, and it was: the sheet was declared 19mm wide, with a 5mm carrier border round it.
    const small = planned("church.fkld");
    const out = buildCopperSvgExport(small.fold, small.traces, small.tapeW);
    expect(out.widthMm).toBeCloseTo(3.25, 2);
    expect(out.tooNarrow).toBe(false);

    // Copper that really is too narrow is still refused rather than handed over.
    const thin = buildCopperSvgExport(small.fold, small.traces, small.tapeW / 4);
    expect(thin.widthMm).toBeLessThan(3);
    expect(thin.tooNarrow).toBe(true);
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
      // Exactly one closed path in the cut: the frame's outer edge. Everything else is open.
      const closed = (cutLayer(out.svg).match(/ Z"/g) ?? []).length;
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

    it("tabs at the tape's own width, clear of the other net, using whichever wall is free", { timeout: 30000 }, () => {
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

    it("grips the trace body, never a pad or a battery terminal", { timeout: 30000 }, () => {
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

    it("does not run a tab over a pad or a terminal", { timeout: 30000 }, () => {
      // Keeping the *anchor* off a component was not enough: the tab still crossed parts on its way to the
      // wall, where it is stuck down on top of one and cuts into it when snipped. Zero everywhere but puffin,
      // whose window is crowded enough that some runs have no clear line out at all -- those fall back to the
      // shortest tab and are reported, not hidden.
      const budget: Record<string, number> = {
        "house.fkld": 0,
        "church.fkld": 0,
        "akde-hex.fkld": 0,
        "akde-decagon-pyramid.fkld": 0,
        "puffin.fkld": 2,
      };
      for (const [name, want] of Object.entries(budget)) {
        const { fold, traces, tapeW, keepOff } = planned(name, 12);
        const out = buildCopperCarrierExport(fold, traces, tapeW, "x", keepOff);
        expect(out.componentTabs, `${name} tabs over a component`).toBeLessThanOrEqual(want);

        // Cross-check against the geometry rather than trusting the count.
        const sheetKeep = keepOff.map((p) => sheetPoint(fold, p));
        let over = 0;
        for (const path of out.tabPaths) {
          const hit = sheetKeep.some((q) =>
            path.slice(1).some((_, i) => ptSeg(q, path[i]!, path[i + 1]!) < tapeW * 0.999),
          );
          if (hit) over++;
        }
        expect(over, `${name} tab paths over a component`).toBeLessThanOrEqual(want);
      }
    });

    it("uses more than one wall when the runs are spread out", { timeout: 30000 }, () => {
      // All tabs diving for the same edge means long runs across the window and more chance of crossing
      // something; spreading them keeps each one short.
      const { fold, traces, tapeW, keepOff } = planned("akde-decagon-pyramid.fkld", 12);
      const out = buildCopperCarrierExport(fold, traces, tapeW, "x", keepOff);
      const { window: win } = out.frame;
      const walls = new Set<string>();
      for (const path of out.tabPaths) {
        const e = path[path.length - 1]!;
        if (Math.abs(e.x - win.x0) < 1e-6) walls.add("left");
        else if (Math.abs(e.x - win.x1) < 1e-6) walls.add("right");
        else if (Math.abs(e.y - win.y0) < 1e-6) walls.add("top");
        else if (Math.abs(e.y - win.y1) < 1e-6) walls.add("bottom");
      }
      expect(walls.size).toBeGreaterThanOrEqual(3);
    });

    it("reports tabs it could not route clear rather than hiding them", { timeout: 30000 }, () => {
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
      const first = cutLayer(out.svg).match(/<path d="M ([^"]+) Z"/)![1]!.match(/-?[\d.]+/g)!.map(Number);
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
      // church is scale-less, so it is cut at the print sheet and its tape is a real 3.25mm.
      expect(out.widthMm).toBeCloseTo(3.25, 2);
      expect(out.tooNarrow).toBe(false);
      // Genuinely uncuttable copper is still reported as such.
      expect(buildCopperCarrierExport(fold, traces, tapeW / 4).tooNarrow).toBe(true);
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

  describe("mirroring", () => {
    /** Every coordinate in an SVG's path data, in the order it is written.
     *  Path data only -- the fill colours are hex digits and the header carries the sheet size, and either
     *  would put this out of step with the geometry it is meant to be reading. */
    const coords = (svg: string): number[] =>
      (svg.match(/ d="([^"]*)"/g) ?? [])
        .flatMap((d) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number));

    it("reflects the sheet about its own centre, leaving the window where it was", () => {
      // About the SHEET's centre, not the pattern's: the carrier frame, the strips and the preview each go
      // through this one transform, so they only stay registered if they all reflect about the same line.
      const { fold } = planned("house.fkld");
      const plain = sheetFrame(fold);
      const flipped = sheetFrame(fold, { x: true, y: false });

      for (const p of [{ x: 0, y: 0 }, { x: 3, y: 7 }, { x: -2, y: 1.5 }]) {
        expect(flipped.T(p).x).toBeCloseTo(plain.w - plain.T(p).x, 9);
        expect(flipped.T(p).y).toBeCloseTo(plain.T(p).y, 9);
      }
      // The margin is equal on opposite sides, so the window reflects onto itself.
      expect(flipped.window).toEqual(plain.window);
      expect(flipped.w).toBe(plain.w);
      expect(flipped.h).toBe(plain.h);
    });

    it("mirrors the cut file itself, not just the frame it sits in", () => {
      // The failure this guards against is a file that reports itself mirrored while the copper inside it is
      // unchanged -- which cuts a circuit that is the reverse of what was asked for.
      const { fold, traces, tapeW } = planned("house.fkld");
      const plain = buildCopperSvgExport(fold, traces, tapeW);
      const flipped = buildCopperSvgExport(fold, traces, tapeW, "kiri", [], { x: true, y: false });
      const { w, h } = sheetFrame(fold);

      const a = coords(plain.svg);
      const b = coords(flipped.svg);
      expect(b).toHaveLength(a.length);
      expect(b).not.toEqual(a); // it really moved

      // Same points, each reflected: the shapes are unchanged, seen from the other side.
      expect(a.length % 2).toBe(0);
      for (let i = 0; i + 1 < a.length; i += 2) {
        const m = mirrorPoint({ x: a[i]!, y: a[i + 1]! }, w, h, { x: true, y: false });
        expect(b[i]!).toBeCloseTo(m.x, 2);
        expect(b[i + 1]!).toBeCloseTo(m.y, 2);
      }
      // Mirroring cuts the same tape into the same number of strips.
      expect(flipped.counts).toEqual(plain.counts);
      expect(flipped.widthMm).toBe(plain.widthMm);
    });

    it("mirrors on either axis, and on both at once", () => {
      const { fold } = planned("house.fkld");
      const { w, h } = sheetFrame(fold);
      const p = { x: 2, y: 3 };
      const base = sheetFrame(fold).T(p);

      expect(sheetFrame(fold, { x: false, y: true }).T(p).x).toBeCloseTo(base.x, 9);
      expect(sheetFrame(fold, { x: false, y: true }).T(p).y).toBeCloseTo(h - base.y, 9);
      const both = sheetFrame(fold, { x: true, y: true }).T(p);
      expect(both.x).toBeCloseTo(w - base.x, 9);
      expect(both.y).toBeCloseTo(h - base.y, 9);
    });

    it("names a mirrored file as mirrored, and by which axis", () => {
      // A mirrored cut and a straight one are the same shape from opposite sides; on disk the name is the
      // only thing telling them apart, and cutting the wrong one wastes the tape.
      const { fold, traces, tapeW, keepOff } = planned("house.fkld");
      expect(buildCopperSvgExport(fold, traces, tapeW, "puffin").filename).toBe("puffin-copper.svg");
      expect(
        buildCopperSvgExport(fold, traces, tapeW, "puffin", [], { x: true, y: false }).filename,
      ).toBe("puffin-copper-mirrored-x.svg");
      expect(
        buildCopperSvgExport(fold, traces, tapeW, "puffin", [], { x: true, y: true }).filename,
      ).toBe("puffin-copper-mirrored-xy.svg");
      expect(
        buildCopperCarrierExport(fold, traces, tapeW, "puffin", keepOff, { x: false, y: true }).filename,
      ).toBe("puffin-copper-carrier-mirrored-y.svg");
    });

    it("keeps the mirrored carrier inside its own frame", () => {
      // The carrier only works if it lifts off the mat in one piece, so the mirrored file has to be as
      // well-formed as the plain one -- everything inside the frame, nothing pushed off the sheet.
      const { fold, traces, tapeW, keepOff } = planned("house.fkld");
      const m = { x: true, y: false };
      const out = buildCopperCarrierExport(fold, traces, tapeW, "kiri", keepOff, m);
      const { w, h, window: win } = sheetFrame(fold, m);

      expect(out.frame.window).toEqual(win);
      expect(out.counts.traces).toBeGreaterThan(0);
      expect(out.counts.tabs).toBeGreaterThan(0);
      for (const path of out.tabPaths) {
        for (const p of path) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(w);
          expect(p.y).toBeLessThanOrEqual(h);
        }
      }
    });
  });

  describe("scale-less patterns", () => {
    it("cuts a pattern with no scale of its own at the print sheet, not at its own units", () => {
      // house is authored 4 units across. Taken as 4mm, the carrier came out as a 5mm border around a 4mm
      // window -- a frame three times the size of the circuit inside it -- cut from strips a tenth of a
      // millimetre wide. It is the same pattern the STL export prints at 130mm, so that is the size it is cut.
      const { fold, traces, tapeW, keepOff } = planned("house.fkld");
      const f = sheetFrame(fold);
      const winW = f.window.x1 - f.window.x0;
      expect(winW).toBeCloseTo(130, 0);

      const out = buildCopperCarrierExport(fold, traces, tapeW, "k", keepOff);
      const outerW = out.frame.outer.x1 - out.frame.outer.x0;
      // The border is a border, not the bulk of the file.
      expect(winW / outerW).toBeGreaterThan(0.8);
      // And the copper is copper tape you can buy.
      expect(out.widthMm).toBeCloseTo(3.25, 2);
      expect(out.tooNarrow).toBe(false);
    });

    it("leaves a pattern that already has a scale alone", () => {
      // puffin is authored at 182mm. Scaling it would cut it at a size nobody asked for.
      const { fold } = planned("puffin.fkld");
      expect(sheetFrame(fold).scale).toBe(1);
      const w = sheetFrame(fold).window;
      expect(w.x1 - w.x0).toBeCloseTo(181.7, 0);
    });

    it("keeps the copper registered with the cut and score layers", () => {
      // Both files scale, or the copper lands on a pattern of a different size. This is the invariant that
      // lets the layers be imported and cut without being nudged into place by hand.
      for (const name of ["house.fkld", "puffin.fkld"]) {
        const { fold, traces, tapeW } = planned(name);
        const copper = buildCopperSvgExport(fold, traces, tapeW);
        const main = buildFkldSvgExport(fold, "base")!;
        const box = (svg: string): string => svg.match(/viewBox="([^"]+)"/)![1]!;
        expect(box(copper.svg), name).toBe(box(main.combined.svg));
      }
    });
  });

  describe("print size", () => {
    it("cuts at the size asked for, keeping the tape a real 3.25mm", () => {
      // The tape width and the sheet scale are derived from the same number and cancel: 3.25mm of copper is
      // 3.25mm of copper whatever size the paper is. They only cancel if both are told the same size, which
      // is the mistake this pins -- scaling the sheet but not the router leaves the tape wrong by the ratio.
      const { fold, faces, gaps, circuit } = plannedAt("house.fkld", 260);
      const tapeW = tapeWidthFor(faces, 260);
      const r = planRoutes(faces, gaps, circuit, 260);
      const out = buildCopperSvgExport(fold, r.traces, tapeW, "k", r.pads, undefined, 260);

      expect(out.widthMm).toBeCloseTo(3.25, 2);
      const f = sheetFrame(fold, undefined, 260);
      expect(f.window.x1 - f.window.x0).toBeCloseTo(260, 0);
      expect(out.svg).toContain(`width="${Math.round(f.w * 1000) / 1000}mm"`);
    });

    it("carries the size into the carrier and the cut layer too, so they stay registered", () => {
      const { fold, faces, gaps, circuit } = plannedAt("house.fkld", 260);
      const tapeW = tapeWidthFor(faces, 260);
      const r = planRoutes(faces, gaps, circuit, 260);
      const carrier = buildCopperCarrierExport(fold, r.traces, tapeW, "k", [], undefined, 260);
      const main = buildFkldSvgExport(fold, "k", 260)!;
      const box = (svg: string): string => svg.match(/viewBox="([^"]+)"/)![1]!;
      expect(box(carrier.svg)).toBe(box(main.combined.svg));
      expect(carrier.widthMm).toBeCloseTo(3.25, 2);
    });

    it("defaults to the print sheet when no size is given", () => {
      const { fold } = planned("house.fkld");
      expect(sheetFrame(fold).w).toBeCloseTo(sheetFrame(fold, undefined, 130).w, 6);
    });
  });

  describe("the gap under an LED", () => {
    it("narrows a run where it lands between an LED's legs", () => {
      // A run passing over a pad whose partner leg is closer than the tape is wide has to pinch in, or the
      // two nets meet under the chip and short it.
      const t = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
      const pads = [{ pwr: { x: 10, y: 0 }, gnd: { x: 11, y: 0 } }];
      const wide = outlineStrip(t.pts, 3.25);
      const pinched = stripOutline(t, 3.25, pads);
      const spread = (ring: { x: number; y: number }[]): number => {
        const ys = ring.filter((p) => Math.abs(p.x - 10) < 1e-6).map((p) => p.y);
        return Math.max(...ys) - Math.min(...ys);
      };
      expect(spread(wide)).toBeCloseTo(3.25, 6);
      expect(spread(pinched)).toBeLessThan(3.25);
      expect(spread(pinched)).toBeGreaterThan(0);
    });

    it("cuts the carrier to the same shape as the strips, so it does not short the LEDs", () => {
      // The carrier laid every run at full width because it was never given the pads: all six of puffin's
      // LEDs had the two nets meeting under the chip, while the strips file for the same circuit left a
      // clean gap. One outline definition now feeds both files.
      const { fold, traces, tapeW, keepOff, pads } = planned("puffin.fkld");
      const near = (ps: { x: number; y: number }[][], qs: { x: number; y: number }[][]): number => {
        let m = Infinity;
        for (const a of ps) for (const b of qs) for (const p of a) for (const q of b) {
          m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
        }
        return m;
      };
      const rings = (ps: { pwr: Vec2; gnd: Vec2 }[], net: "pwr" | "gnd") =>
        traces.filter((t) => t.net === net).map((t) => stripOutline(t, tapeW, ps));

      const before = near(rings([], "pwr"), rings([], "gnd"));
      const after = near(rings(pads, "pwr"), rings(pads, "gnd"));
      expect(after).toBeGreaterThan(before);

      // And the carrier really does use them — the file changes when they are supplied.
      const without = buildCopperCarrierExport(fold, traces, tapeW, "k", keepOff);
      const withPads = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      expect(withPads.svg).not.toBe(without.svg);
      expect(withPads.counts.traces).toBe(without.counts.traces);
    });
  });

  describe("annotation", () => {
    const built = () => {
      const { fold, traces, tapeW, keepOff, pads } = planned("house.fkld", 3);
      const faces = flatFaces(fold);
      const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeW);
      return buildCopperCarrierExport(fold, traces, tapeW, "k", keepOff, undefined, undefined, pads);
    };

    it("says which run is which net", () => {
      // The strips file tells you all this by colouring PWR apart from GND. The carrier is one piece of
      // copper, so it is one layer of one colour, and black outlines alone cannot say which run is positive
      // or which way round the LED goes.
      const svg = built().svg;
      const ann = svg.slice(
        svg.indexOf('<g id="annotation"'),
        svg.indexOf('<g id="carrier"'),
      );
      expect(ann).toContain("#ff0000");   // PWR
      expect(ann).toContain("#222222");   // GND
      // Filled copper, the same shapes the strips file cuts -- not a line standing in for it.
      expect(ann).toMatch(/fill="#ff0000" fill-rule="nonzero"/);
      // The copper and nothing else. Pad and terminal markers drawn over a strip merge with it into one
      // shape wider than the tape, and the cut line, which follows the strip alone, then looks misplaced.
      expect(ann).not.toContain("<circle");
      expect(ann).not.toContain("<text");
      expect(ann).not.toContain("#d8b24a");
    });

    it("keeps the annotation out of the cut, so it can be switched off", () => {
      // Every path in the carrier group is cut. An annotation cut along a trace would sever the trace it
      // names, so it lives in its own group and never in that one.
      const svg = built().svg;
      const cut = cutLayer(svg);
      expect(cut).not.toContain("#ff0000");
      expect(cut).not.toContain("#d8b24a");
      expect(cut).not.toContain("<circle");
      expect(cut).not.toContain("<text");
    });

    it("is left out entirely when there is nothing to annotate", () => {
      const { fold, tapeW } = planned("house.fkld");
      expect(buildCopperCarrierExport(fold, [], tapeW).svg).not.toContain('id="annotation"');
    });

    it("mirrors with the cut it annotates", () => {
      // It goes through the same transform, so a mirrored file cannot end up with its marks on the
      // unmirrored side — which would put the + on the wrong terminal.
      const { fold, traces, tapeW, pads } = planned("house.fkld", 3);
      const faces = flatFaces(fold);
      const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeW);
      const plain = buildCopperCarrierExport(fold, traces, tapeW, "k", [], undefined, undefined, pads);
      const flipped = buildCopperCarrierExport(
        fold, traces, tapeW, "k", [], { x: true, y: false }, undefined, pads,
      );
      // The first x in the annotation's first filled ring.
      const cx = (svg: string): number =>
        Number(
          svg
            .slice(svg.indexOf('<g id="annotation"'))
            .match(/<path d="M ([\d.-]+)/)![1],
        );
      const { w } = sheetFrame(fold);
      expect(cx(flipped.svg)).toBeCloseTo(w - cx(plain.svg), 2);
    });
  });

  it("leaves each trace joined to the carrier over one tab width, no more", () => {
    // What the file looks like: the black outline should close around each strip apart from the short span
    // its tab bridges. Opening it by a whole densified vertex left three tape widths uncut, and the export
    // read as outlines that had failed to close. Measured on the emitted geometry, since that is what is cut.
    for (const name of ["house.fkld", "puffin.fkld"]) {
      const { fold, traces, tapeW, keepOff, pads } = planned(name, 3);
      const out = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      const { T, scale } = sheetFrame(fold);
      const tape = tapeW * scale;

      const cuts = [...cutLayer(out.svg).matchAll(/<path d="([^"]+)"/g)].map((m) => {
        const n = m[1]!.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
        const pts: Vec2[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i]!, y: n[i + 1]! });
        return pts;
      });
      const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
      };

      const insideRing = (p: Vec2, ring: Vec2[]): boolean => {
        let w = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i]!, b = ring[j]!;
          if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
        }
        return w;
      };
      for (const t of traces) {
        const ring = stripOutline(t, tapeW, pads).map(T);
        if (ring.length < 3) continue;
        const others = traces
          .filter((o) => o !== t)
          .map((o) => stripOutline(o, tapeW, pads).map(T))
          .filter((r) => r.length >= 3);
        const step = tape / 20;
        let uncut = 0;
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]!, b = ring[(k + 1) % ring.length]!;
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          for (let d = step / 2; d < L; d += step) {
            const p = { x: a.x + ((b.x - a.x) * d) / L, y: a.y + ((b.y - a.y) * d) / L };
            const covered = cuts.some((path) =>
              path.some((_, i) => i > 0 && toSeg(p, path[i - 1]!, path[i]!) < tape * 0.02),
            );
            // A stretch buried inside another strip of the same net is not cut, and must not be: the two
            // are one piece of copper there. Only the outside of the shape has to be accounted for.
            const buried = others.some((ring) => insideRing(p, ring));
            if (!covered && !buried) uncut += step;
          }
        }
        expect(uncut / tape, `${name} ${t.net}: uncut span in tab widths`).toBeLessThan(1.6);
      }
    }
  }, { timeout: 30000 });

  it("never cuts through the copper, where runs of one net overlap", () => {
    // Two runs of a net meet at a junction and overlap on purpose — one net, one potential. Each was still
    // outlined all the way round, so one run's cut line crossed the other's strip and the blade would have
    // severed it: 848mm of cut running through copper across these circuits, 224mm on one.
    const insideRing = (p: Vec2, ring: Vec2[]): boolean => {
      let w = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!, b = ring[j]!;
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
      }
      return w;
    };
    const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
    };

    for (const name of ["akde-square-pyramid.fkld", "puffin.fkld"]) {
      const { fold, traces, tapeW, keepOff, pads } = planned(name, 3);
      const out = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      const { T, scale } = sheetFrame(fold);
      const tape = tapeW * scale;
      const rings = traces.map((t) => stripOutline(t, tapeW, pads).map(T)).filter((r) => r.length >= 3);
      const cuts = [...cutLayer(out.svg).matchAll(/<path d="([^"]+)"/g)].map((m) => {
        const n = m[1]!.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
        const pts: Vec2[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i]!, y: n[i + 1]! });
        return pts;
      });

      let through = 0;
      for (const path of cuts) {
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1]!, b = path[i]!;
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          const steps = Math.max(1, Math.ceil(L / (tape / 10)));
          for (let k = 0; k < steps; k++) {
            const f = (k + 0.5) / steps;
            const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
            const buried = rings.some((ring) => {
              if (!insideRing(p, ring)) return false;
              for (let q = 0; q < ring.length; q++) {
                if (toSeg(p, ring[q]!, ring[(q + 1) % ring.length]!) < tape * 0.05) return false;
              }
              return true;
            });
            if (buried) through += L / steps;
          }
        }
      }
      // Not zero: a hair of tolerance either side of a boundary is unavoidable. Two tape widths in total
      // across a whole sheet is a rounding artefact; the defect was two orders of magnitude larger.
      expect(through, `${name}: mm of cut line running through copper`).toBeLessThan(2 * tape);
    }
  }, { timeout: 30000 });

  it("joins every cut to another, so the blade never lifts mid-air", () => {
    // A tab's sides were offset from its centreline, which put them near where the outline stopped but not
    // on it. The cut came apart there: the blade lifts, drops a fraction of a millimetre away, and the
    // sliver between the two tears instead of cutting. 144 such ends across these circuits, now none here.
    for (const name of ["house.fkld", "puffin.fkld", "akde-decagon-pyramid.fkld"]) {
      const { fold, traces, tapeW, keepOff, pads } = planned(name, 1);
      const out = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      const tape = tapeW * sheetFrame(fold).scale;
      const paths = [...cutLayer(out.svg).matchAll(/<path d="([^"]+)"/g)].map((m) => {
        const closed = m[1]!.includes("Z");
        const n = m[1]!.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
        const pts: Vec2[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i]!, y: n[i + 1]! });
        return { pts, closed };
      });
      const ends: Vec2[] = [];
      for (const p of paths) if (!p.closed && p.pts.length > 1) ends.push(p.pts[0]!, p.pts[p.pts.length - 1]!);
      expect(ends.length).toBeGreaterThan(0);

      const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
      };
      const loose = ends.filter((p, i) => {
        if (ends.some((q, j) => j !== i && Math.hypot(p.x - q.x, p.y - q.y) < tape * 0.05)) return false;
        // Landing on another cut's interior is a T-junction, which the blade follows just as well.
        return !paths.some((pp) =>
          pp.pts.some((_, k) => {
            if (k === 0) return false;
            const a = pp.pts[k - 1]!, b = pp.pts[k]!;
            if (Math.hypot(p.x - a.x, p.y - a.y) < 1e-9 || Math.hypot(p.x - b.x, p.y - b.y) < 1e-9) return false;
            return toSeg(p, a, b) < tape * 0.05;
          }),
        );
      });
      expect(loose, `${name}: cut ends meeting nothing`).toEqual([]);
    }
  }, { timeout: 30000 });

  describe("openAround", () => {
    /** A 12x12 square ring, densified so its vertices are a unit apart — as the carrier's rings are. */
    const square = (): Vec2[] => {
      const r: Vec2[] = [];
      for (let x = 0; x < 12; x++) r.push({ x, y: 0 });
      for (let y = 0; y < 12; y++) r.push({ x: 12, y });
      for (let x = 12; x > 0; x--) r.push({ x, y: 12 });
      for (let y = 12; y > 0; y--) r.push({ x: 0, y });
      return r;
    };
    const length = (pts: Vec2[]): number => {
      let s = 0;
      for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      return s;
    };

    it("leaves exactly the tab's width uncut, not a whole vertex", () => {
      // Dropping the vertex the tab attaches at drops the two segments either side of it. The rings are
      // densified to about a tape width per segment, so the outline came away open over three tape widths
      // where the tab bridges one, and the copper stayed joined along a stretch that read as a failed cut.
      const ring = square();
      const perimeter = 48;
      for (const width of [1, 3.25, 5]) {
        const open = openAround(ring, 7, width);
        expect(length(open), `open by ${width}`).toBeCloseTo(perimeter - width, 6);
      }
    });

    it("opens the ring centred on the attachment point", () => {
      const ring = square();
      const open = openAround(ring, 7, 3);
      // The cut stops 1.5 before ring[7] and resumes 1.5 after it: the ends straddle it.
      expect(open[0]).toEqual({ x: 8.5, y: 0 });
      expect(open[open.length - 1]).toEqual({ x: 5.5, y: 0 });
    });

    it("keeps every other vertex of the ring", () => {
      const ring = square();
      const open = openAround(ring, 7, 3);
      // 48 vertices, minus the three the 3-wide opening spans, plus the two new cut ends.
      expect(open).toHaveLength(ring.length - 3 + 2);
    });

    it("refuses to open a ring away entirely", () => {
      // A tab wider than the trace it holds would leave nothing joined and nothing cut.
      const ring = square();
      expect(length(openAround(ring, 0, 1000))).toBeGreaterThan(0);
      expect(openAround([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 1)).toHaveLength(2);
    });
  });
});
