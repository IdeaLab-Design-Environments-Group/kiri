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
import { COMPONENTS } from "../../../src/model/footprints.generated.js";
import { padAt, padNamed, padSize } from "../../../src/model/footprint.js";
import { PCB_COLOURS } from "../../../src/model/part-render.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led, type Vec2 } from "../../../src/model/electronics.js";
import {
  batteryTerminals,
  patternDiag,
  planRoutes,
  tapeWidthFor,
  MIN_WEED_MM,
  TAPE_MM,
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

/** Just the filled carrier shape — the `carrier` group and nothing else. */
function filledLayer(svg: string): string {
  const from = svg.indexOf('<g id="carrier"');
  expect(from).toBeGreaterThanOrEqual(0);
  return svg.slice(from, svg.indexOf("</g>", from));
}

/**
 * Everything that gets CUT: the filled carrier, plus any fragments that would not close into a loop and are
 * drawn as bare lines in `carrier-unclosed`. Both are cut; only the annotation layer is not, and it is left
 * out here so that anything asserting what the blade does looks at exactly the blade's paths.
 */
function cutLayer(svg: string): string {
  let out = filledLayer(svg);
  const from = svg.indexOf('<g id="carrier-unclosed"');
  if (from >= 0) out += svg.slice(from, svg.indexOf("</g>", from));
  return out;
}

/**
 * The carrier's cut, as separate subpaths.
 *
 * It is emitted as filled shapes, so one `<path>` carries every loop as its own `M ... Z` subpath. Splitting
 * on the moves matters: read as one run of coordinates, the jump from the end of one loop to the start of the
 * next reads as a cut across the sheet, and the closing edge of each loop is missed entirely.
 */
function cutPaths(svg: string): { pts: Vec2[]; closed: boolean }[] {
  const out: { pts: Vec2[]; closed: boolean }[] = [];
  for (const m of cutLayer(svg).matchAll(/<path d="([^"]+)"/g)) {
    for (const sub of m[1]!.split(/(?=M )/)) {
      if (!sub.trim()) continue;
      const n = sub.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
      const pts: Vec2[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i]!, y: n[i + 1]! });
      const closed = sub.includes("Z");
      if (closed && pts.length > 1) pts.push(pts[0]!); // the closing edge is cut too
      out.push({ pts, closed });
    }
  }
  return out;
}

/** Even-odd containment against every closed loop at once — the carrier's own fill rule. */
function inCarrier(svg: string, p: Vec2): boolean {
  let n = 0;
  for (const { pts, closed } of cutPaths(svg)) {
    if (!closed) continue;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!, b = pts[j]!;
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) n++;
    }
  }
  return n % 2 === 1;
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
    expect(out.widthMm).toBeCloseTo(TAPE_MM, 2);
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
      // position. A closed cut round a trace would free it whatever tabs are drawn. The cut is emitted as
      // filled shapes, so every subpath IS closed now -- the invariant is that none of those loops is a
      // trace: a run's outline is a detour in a longer boundary, never a loop of its own.
      const { fold, traces, tapeW, pads } = planned("church.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW, "k", [], undefined, undefined, pads);
      expect(out.counts.traces).toBeGreaterThan(0);
      // At least one grip each, so nothing is left loose in the window. Long runs earn a second: held at a
      // single point a long trace still swings about it and a corner can lift before it is pressed down.
      expect(out.counts.tabs).toBeGreaterThanOrEqual(out.counts.traces);
      expect(out.counts.tabs).toBeLessThanOrEqual(out.counts.traces * 2);
      // And a long run really does get the second one — a range alone would pass with one grip each.
      expect(out.counts.tabs).toBeGreaterThan(out.counts.traces);
      const { T } = sheetFrame(fold);
      const area = (r: Vec2[]): number => {
        let a = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]!.x + r[i]!.x) * (r[j]!.y - r[i]!.y);
        return Math.abs(a / 2);
      };
      const loops = cutPaths(out.svg).filter((c) => c.closed).map((c) => c.pts);
      expect(loops.length).toBeGreaterThan(0);
      for (const t of traces) {
        const strip = stripOutline(t, tapeW, pads).map(T);
        if (strip.length < 3) continue;
        const own = area(strip);
        // No loop the size of a strip: one that matched would be that strip, cut out on its own.
        expect(loops.some((l) => Math.abs(area(l) - own) < own * 0.02)).toBe(false);
      }
    });

    it("emits the carrier as filled shapes, not as line art", () => {
      // A cutter reads a shape, and the strips file has always given it one: a closed outline with a fill and
      // no stroke. The carrier gave it hairlines instead, which import as outlines rather than as copper.
      const { fold, traces, tapeW, pads } = planned("house.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW, "k", [], undefined, undefined, pads);
      const cut = filledLayer(out.svg);
      expect(cut).toContain('fill-rule="evenodd"');
      expect(cut).toContain('stroke="none"');
      expect(cut).not.toContain('fill="none"');
      // Every subpath closes, and nothing was left over as a bare line.
      expect(out.unclosedCuts).toBe(0);
      expect(out.svg).not.toContain('id="carrier-unclosed"');
      expect(cutPaths(out.svg).every((c) => c.closed)).toBe(true);
    });

    it("fills the copper and leaves the waste empty", () => {
      // The shape has to be the copper itself: solid down every run, solid across the frame, and nothing in
      // between. Filled the wrong way round it would cut the waste out and drop the circuit.
      const { fold, traces, tapeW, pads } = planned("house.fkld");
      const out = buildCopperCarrierExport(fold, traces, tapeW, "k", [], undefined, undefined, pads);
      const { T } = sheetFrame(fold);
      const { window: win, outer } = out.frame;
      for (const t of traces) {
        expect(inCarrier(out.svg, T(t.pts[Math.floor(t.pts.length / 2)]!))).toBe(true);
      }
      // The frame border is copper; off the sheet is not.
      expect(inCarrier(out.svg, { x: (win.x0 + outer.x0) / 2, y: (win.y0 + win.y1) / 2 })).toBe(true);
      expect(inCarrier(out.svg, { x: outer.x0 - 2, y: outer.y0 - 2 })).toBe(false);
      // Somewhere inside the window well clear of every run and every tab: waste, and empty.
      const strips = traces.map((t) => stripOutline(t, tapeW, pads).map(T)).filter((r) => r.length >= 3);
      const clear: Vec2[] = [];
      for (let x = win.x0 + 2; x < win.x1 - 2 && clear.length < 3; x += 1.5) {
        for (let y = win.y0 + 2; y < win.y1 - 2 && clear.length < 3; y += 1.5) {
          const p = { x, y };
          const far = (r: Vec2[]): boolean =>
            r.every((_, i) => i === 0 || ptSeg(p, r[i - 1]!, r[i]!) > out.widthMm * 2);
          if (strips.every(far) && out.tabPaths.every(far)) clear.push(p);
        }
      }
      expect(clear.length).toBeGreaterThan(0);
      for (const p of clear) expect(inCarrier(out.svg, p)).toBe(false);
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
      expect(out.widthMm).toBeCloseTo(TAPE_MM, 2);
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
      expect(out.widthMm).toBeCloseTo(TAPE_MM, 2);
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
    it("cuts at the size asked for, keeping the tape its real width in millimetres", () => {
      // The tape width and the sheet scale are derived from the same number and cancel: 3.25mm of copper is
      // 3.25mm of copper whatever size the paper is. They only cancel if both are told the same size, which
      // is the mistake this pins -- scaling the sheet but not the router leaves the tape wrong by the ratio.
      const { fold, faces, gaps, circuit } = plannedAt("house.fkld", 260);
      const tapeW = tapeWidthFor(faces, 260);
      const r = planRoutes(faces, gaps, circuit, 260);
      const out = buildCopperSvgExport(fold, r.traces, tapeW, "k", r.pads, undefined, 260);

      expect(out.widthMm).toBeCloseTo(TAPE_MM, 2);
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
      expect(carrier.widthMm).toBeCloseTo(TAPE_MM, 2);
    });

    it("defaults to the print sheet when no size is given", () => {
      const { fold } = planned("house.fkld");
      expect(sheetFrame(fold).w).toBeCloseTo(sheetFrame(fold, undefined, 130).w, 6);
    });
  });

  describe("the gap under an LED", () => {
    it("narrows a run that passes an LED's pad, but not one that ends on it", () => {
      // Two cases, and they used to be treated as one. Narrowing exists so the two nets cannot meet under
      // the chip, and a run passing SIDEWAYS across a pad really can: its full width spills over the bare
      // strip towards the other leg, so it has to pinch in.
      //
      // A run that ENDS on its pad cannot. It is capped square across its own direction, so the copper
      // stops at the pad and the two nets are held apart by the part's own pitch — 2.00mm of bare pattern
      // on an LED_1206 — not by their widths. Pinching there did real harm: it cut a 3.25mm strip to the
      // 1.14mm floor directly beneath a 1.70mm pad, which is where the reported 68-93% pad coverage came
      // from, and it drew as a spike tapering into the body gap. Exempting the end-on case took coverage
      // to 96-100%.
      // The ring's height where a vertical line crosses it. Measured by intersecting the edges rather
      // than by looking for vertices at that x: a strip only has vertices where its width changes, so a
      // full-width run has none in the middle and a vertex search reports nothing at all.
      const spreadAt = (ring: { x: number; y: number }[], x: number): number => {
        const ys: number[] = [];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
          if (a.x === b.x) continue;
          const t = (x - a.x) / (b.x - a.x);
          if (t < 0 || t > 1) continue;
          ys.push(a.y + t * (b.y - a.y));
        }
        return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
      };

      // Passing: the pad sits mid-run, its partner across the tape. Still narrowed.
      const across = {
        net: "pwr" as const,
        pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      };
      const passing = stripOutline(across, 3.25, [{ pwr: { x: 10, y: 0 }, gnd: { x: 10, y: 1 } }]);
      expect(spreadAt(outlineStrip(across.pts, 3.25), 10)).toBeCloseTo(3.25, 6);
      expect(spreadAt(passing, 10)).toBeLessThan(3.25);
      expect(spreadAt(passing, 10)).toBeGreaterThan(0);

      // End-on: the run stops at its pad, running along the line between the two legs. Full width.
      const endOn = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
      const landed = stripOutline(endOn, 3.25, [{ pwr: { x: 10, y: 0 }, gnd: { x: 11, y: 0 } }]);
      expect(spreadAt(landed, 10)).toBeCloseTo(3.25, 6);
      // And it does not overrun the pad it landed on.
      expect(Math.max(...landed.map((p) => p.x))).toBeCloseTo(10, 6);
    });

    it("cuts the carrier to the same shape as the strips, so it does not short the LEDs", () => {
      // The carrier laid every run at full width because it was never given the pads: all six of puffin's
      // LEDs had the two nets meeting under the chip, while the strips file for the same circuit left a
      // clean gap. One outline definition now feeds both files.
      const { fold, traces, tapeW, keepOff, pads } = planned("puffin.fkld");
      // How far the two nets' copper stays apart: the true distance between the two outlines, edges
      // included. This used to compare their vertices, which is not the same thing and was only ever a
      // proxy — two strips can cross with no vertex of one anywhere near a vertex of the other, and once
      // the LED legs came in over the tile gap that is exactly what happened: the proxy reported the gap
      // closing while the real one was opening. Measured properly, the point the test was written for is
      // much starker than it could show — at full width the two nets do not merely come close, they
      // TOUCH, which is the short.
      const near = (ps: Vec2[][], qs: Vec2[][]): number => {
        let m = Infinity;
        for (const a of ps) for (const b of qs) {
          for (const p of a) for (let i = 0; i < b.length; i++) m = Math.min(m, ptSeg(p, b[i]!, b[(i + 1) % b.length]!));
          for (const q of b) for (let i = 0; i < a.length; i++) m = Math.min(m, ptSeg(q, a[i]!, a[(i + 1) % a.length]!));
        }
        return m;
      };
      const rings = (ps: { pwr: Vec2; gnd: Vec2 }[], net: "pwr" | "gnd") =>
        traces.filter((t) => t.net === net).map((t) => stripOutline(t, tapeW, ps));

      const before = near(rings([], "pwr"), rings([], "gnd"));
      const after = near(rings(pads, "pwr"), rings(pads, "gnd"));
      // **The fault changed character on 2026-08-28, when `TAPE_MM` fell to 1.5.** At 3.25mm the two nets
      // TOUCHED at full width — `before` was 0.000000, an outright short. At 1.5mm they no longer touch:
      // `before` is 0.114mm. That is not a fix, it is a smaller version of the same problem, because
      // 0.114mm of substrate is a tenth of the 1.1375mm web the tweezers can lift — so a carrier cut this
      // way still cannot be weeded between the two nets, and the narrowing still has to happen.
      //
      // Asserted as a band rather than as zero: what matters is that full width is unweedable and that
      // supplying the pads opens it, which is the claim the file is about. `after` measures 0.326mm.
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThan(MIN_WEED_MM); // unweedable, whether or not it is a dead short
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
    const built = (withParts = true) => {
      const { fold, traces, tapeW, keepOff, pads } = planned("house.fkld", 3);
      const pwr = traces.find((t) => t.net === "pwr")!;
      const at = pwr.pts[Math.floor(pwr.pts.length / 2)]!;
      const res = withParts ? [{ a: at, b: pwr.pts[Math.min(1, pwr.pts.length - 1)]! }] : [];
      return buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads, res,
      );
    };

    it("marks the parts and leaves the copper to the carrier", () => {
      // The carrier IS the copper: frame, tabs and traces are one piece, cut as one filled shape. Redrawing
      // each run on top of it in its net's colour said nothing the shape had not already said, and made the
      // file read as though the nets were separate pieces laid over the frame.
      const svg = built().svg;
      // The annotation group follows the cut, so it draws over the copper rather than under it.
      const ann = svg.slice(svg.indexOf('<g id="annotation"'));
      expect(ann).not.toContain("#ff0000");   // no PWR run redrawn
      expect(ann).not.toContain("#222222");   // nor GND
      // What is left is the part, drawn as its footprint: copper pads under their mask openings.
      expect(ann).toContain(PCB_COLOURS.copper);
      expect(ann).toContain(PCB_COLOURS.mask);
      expect(ann).toContain(PCB_COLOURS.componentLabel);   // and which one it is
    });

    it("keeps the annotation out of the cut, so it can be switched off", () => {
      // Every path in the carrier group is cut. An annotation cut along a trace would sever the trace it
      // marks, so it lives in its own group and never in that one.
      const svg = built().svg;
      const cut = cutLayer(svg);
      expect(cut).not.toContain(PCB_COLOURS.copper);
      expect(cut).not.toContain(PCB_COLOURS.mask);
      expect(cut).not.toContain(PCB_COLOURS.padLabel);
      expect(cut).not.toContain(PCB_COLOURS.componentLabel);
      expect(cut).not.toContain("<circle");
      expect(cut).not.toContain("<text");
    });

    it("is left out entirely when there is nothing to annotate", () => {
      const { fold, tapeW } = planned("house.fkld");
      expect(buildCopperCarrierExport(fold, [], tapeW).svg).not.toContain('id="annotation"');
    });

    /**
     * Every x coordinate the annotation layer draws at, from whichever elements it uses.
     *
     * The parts are drawn by `part-render`, which is free to emit a pad as a polygon, a path or a rect —
     * so this asks the markup for its geometry rather than for a particular tag. Text is included: a
     * label that did not travel with the part it names would be marking the wrong component.
     */
    /**
     * The x extent of what the annotation DRAWS — its pads, holes and origins.
     *
     * The designators are left out, and deliberately. A label is always upright, in both files, because a
     * part on a diagonal break would otherwise carry its name sideways on one and upside down on the
     * other; and which side of the part it stands on is chosen from the part's own narrowest way out,
     * which is a fact about the footprint rather than about the sheet. So a label is not a mirrored
     * quantity and never was — it just could not be seen until LEDs, which are symmetric end to end,
     * started being drawn: on a symmetric part the two ways out tie, and the tie breaks the same way
     * whichever way round the sheet is, putting the name a designator's offset out on the other side.
     * The copper is what has to reflect, and that is what this measures.
     */
    const annotationXs = (svg: string): number[] => {
      const ann = svg.slice(svg.indexOf('<g id="annotation"')).replace(/<text[^>]*>[^<]*<\/text>/g, "");
      const xs: number[] = [];
      for (const m of ann.matchAll(/\b(?:x|cx|x1|x2)="(-?[\d.]+)"/g)) xs.push(Number(m[1]));
      for (const m of ann.matchAll(/\bpoints="([^"]+)"/g)) {
        const n = m[1]!.trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i < n.length; i += 2) xs.push(n[i]!);
      }
      for (const m of ann.matchAll(/\bd="([^"]+)"/g)) {
        const n = m[1]!.replace(/[A-Za-z]/g, " ").trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i < n.length; i += 2) xs.push(n[i]!);
      }
      return xs.filter(Number.isFinite);
    };

    it("mirrors with the cut it annotates", () => {
      // It goes through the same transform, so a mirrored file cannot end up with its parts on the
      // unmirrored side, marking a component where there is no copper.
      const { fold, traces, tapeW, pads } = planned("house.fkld", 3);
      const pwr = traces.find((t) => t.net === "pwr")!;
      const res = [{ a: pwr.pts[Math.floor(pwr.pts.length / 2)]!, b: pwr.pts[1]! }];
      const plain = buildCopperCarrierExport(
        fold, traces, tapeW, "k", [], undefined, undefined, pads, res,
      );
      const flipped = buildCopperCarrierExport(
        fold, traces, tapeW, "k", [], { x: true, y: false }, undefined, pads, res,
      );
      // The annotation's x extent, whatever elements it happens to be drawn from. A single coordinate is
      // no use: mirroring reverses the order of a pad's own corners, so the mirrored file's first x
      // answers to a different corner than the plain file's. The extent is order-free, and reflecting a
      // shape swaps its two ends of it.
      const { w } = sheetFrame(fold);
      const span = (svg: string): { lo: number; hi: number } => {
        const xs = annotationXs(svg);
        expect(xs.length).toBeGreaterThan(0);
        return { lo: Math.min(...xs), hi: Math.max(...xs) };
      };
      const a = span(plain.svg), b = span(flipped.svg);
      expect(b.lo).toBeCloseTo(w - a.hi, 2);
      expect(b.hi).toBeCloseTo(w - a.lo, 2);
    });

    /** Every designator the file prints, in the order it prints them. */
    const labels = (svg: string): string[] =>
      [...svg.matchAll(/>([A-Z]+\d+)</g)].map((m) => m[1]!);

    /** Each designator against the point it is printed at — which part it is actually naming. */
    const labelled = (svg: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([A-Z]+\d+)<\/text>/g)) {
        out[m[3]!] = `${m[1]},${m[2]}`;
      }
      return out;
    };

    it("gives a part the same designator on the strips file and on the carrier", () => {
      // The two files are laid one over the other: the strips are stuck down onto the carrier's window.
      // A part called R1 on one and R2 on the other would be worse than printing no designator at all,
      // because the reader would trust it.
      const { fold, traces, tapeW, keepOff, pads } = planned("house.fkld", 3);
      const pwr = traces.find((t) => t.net === "pwr")!;
      const res = [
        { a: pwr.pts[Math.floor(pwr.pts.length / 2)]!, b: pwr.pts[1]! },
        { a: pwr.pts[0]!, b: pwr.pts[Math.min(2, pwr.pts.length - 1)]! },
      ];
      const sw = [{ a: pwr.pts[1]!, b: pwr.pts[Math.min(3, pwr.pts.length - 1)]! }];

      const strips = buildCopperSvgExport(
        fold, traces, tapeW, "k", pads, undefined, undefined, res, sw,
      );
      const carrier = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads, res, sw,
      );
      // Both files are framed by the same `sheetFrame`, so a designator naming the same part lands on the
      // same point in both. Comparing the names alone would pass even if the two files had handed them
      // out to different parts, which is exactly the failure worth guarding.
      const onStrips = labelled(strips.svg);
      expect(Object.keys(onStrips).length).toBeGreaterThan(1);
      expect(labelled(carrier.svg)).toEqual(onStrips);
    });

    it("numbers each family from one, in the order the parts were placed", () => {
      const { fold, traces, tapeW, pads } = planned("house.fkld", 3);
      const pwr = traces.find((t) => t.net === "pwr")!;
      const res = [
        { a: pwr.pts[Math.floor(pwr.pts.length / 2)]!, b: pwr.pts[1]! },
        { a: pwr.pts[0]!, b: pwr.pts[Math.min(2, pwr.pts.length - 1)]! },
      ];
      const sw = [{ a: pwr.pts[1]!, b: pwr.pts[Math.min(3, pwr.pts.length - 1)]! }];
      const svg = buildCopperSvgExport(
        fold, traces, tapeW, "k", pads, undefined, undefined, res, sw,
      ).svg;
      // Two resistors, a switch and the fixture's three LEDs: the resistors count 1, 2 between themselves
      // and each other family starts at 1 rather than carrying on from theirs. The LEDs are here because
      // an LED is now drawn as its own footprint from the same `pads` the runs are narrowed against —
      // before that it was the one component the cut files left off the drawing entirely.
      expect(new Set(labels(svg))).toEqual(new Set(["R1", "R2", "SW1", "LED1", "LED2", "LED3"]));
    });

    it("drops a part it cannot draw without spending its number", () => {
      // An unknown component is not in the library and is not drawn. If it still took a designator, the
      // real parts after it would be numbered one too high and the file would disagree with itself.
      const { fold, traces, tapeW, pads } = planned("house.fkld", 3);
      const pwr = traces.find((t) => t.net === "pwr")!;
      const at = pwr.pts[Math.floor(pwr.pts.length / 2)]!;
      const parts = [
        { component: "NOT_A_PART", a: at, b: pwr.pts[1]! },
        { component: "R_2010", a: at, b: { x: at.x + 6, y: at.y } },
      ];
      const svg = buildCopperSvgExport(
        fold, traces, tapeW, "k", pads, undefined, undefined, [], [], parts,
      ).svg;
      // The R_2010 is R1, so `NOT_A_PART` before it spent nothing. The three LEDs come after every part
      // in the list and are the fixture's, drawn from `pads` as their own footprints.
      expect(labels(svg)).toEqual(["R1", "LED1", "LED2", "LED3"]);
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

      const cuts = cutPaths(out.svg).map((c) => c.pts);
      const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
      };

      // By winding, as the exporter clips: a run that doubles back outlines as a ring that crosses itself,
      // and even-odd calls the doubled lobe hollow -- so a stretch buried there reads as uncut when it is
      // simply copper.
      const insideRing = (p: Vec2, ring: Vec2[]): boolean => {
        let w = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[j]!, b = ring[i]!;
          const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
          if (a.y <= p.y) { if (b.y > p.y && side > 0) w++; } else if (b.y <= p.y && side < 0) w--;
        }
        return w !== 0;
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
            // A stretch buried inside another strip of the same net is not cut, and must not be: the two are
            // one piece of copper there. Nor is a stretch running under a tab — cutting there would sever the
            // tab from the run it holds. Only the outside of the shape has to be accounted for.
            const buried =
              others.some((o) => insideRing(p, o)) ||
              out.tabPaths.some((path) =>
                path.some((_, i) => i > 0 && toSeg(p, path[i - 1]!, path[i]!) <= tape / 2));
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
      const cuts = cutPaths(out.svg).map((c) => c.pts);

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
      // Was 848mm across these circuits before runs were clipped against each other, 224mm on one. What is
      // left is the tab lead-ins: a tab side starts on the ring it grips and is not clipped against it, so
      // its first fraction of a millimetre lies inside that strip by construction -- about 0.2mm a tab.
      expect(through, `${name}: mm of cut line running through copper`).toBeLessThan(3.5 * tape);
    }
  }, { timeout: 30000 });

  it("joins every cut to another, so the blade never lifts mid-air", () => {
    // A tab's sides were offset from its centreline, which put them near where the outline stopped but not
    // on it. The cut came apart there: the blade lifts, drops a fraction of a millimetre away, and the sliver
    // between the two tears instead of cutting. 144 such ends across these circuits. Every fragment is now
    // chained into a closed loop before it is written out, so a loose end cannot be emitted at all -- and if
    // one will not join, it is counted rather than passed off as part of the shape.
    for (const name of ["house.fkld", "puffin.fkld", "akde-decagon-pyramid.fkld"]) {
      const { fold, traces, tapeW, keepOff, pads } = planned(name, 1);
      const out = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      const paths = cutPaths(out.svg);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((p) => !p.closed), `${name}: cut ends meeting nothing`).toEqual([]);
      expect(out.unclosedCuts, `${name}: fragments that would not close`).toBe(0);
    }
  }, { timeout: 30000 });

  it("spreads its tabs over the walls instead of stacking them on one", () => {
    // Sorted on distance alone every tab dives for whichever wall is nearest, and they pile up: 45 of 99
    // tabs across the bundled circuits ran within a tape width of another, and puffin sent all six to the
    // top. Two tabs on one another are stuck down together, and snipping one cuts the other.
    const toSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
    };

    for (const name of ["akde-hex.fkld", "akde-square-pyramid.fkld"]) {
      const { fold, traces, tapeW, keepOff, pads } = planned(name, 6);
      const out = buildCopperCarrierExport(
        fold, traces, tapeW, "k", keepOff, undefined, undefined, pads,
      );
      const { window: win, scale } = sheetFrame(fold);
      const tape = tapeW * scale;
      expect(out.tabPaths.length).toBeGreaterThan(4);

      // No tab lies on another.
      let touching = 0;
      for (let i = 0; i < out.tabPaths.length; i++) {
        for (let j = i + 1; j < out.tabPaths.length; j++) {
          let nearest = Infinity;
          for (const p of out.tabPaths[i]!) {
            for (let q = 1; q < out.tabPaths[j]!.length; q++) {
              nearest = Math.min(nearest, toSeg(p, out.tabPaths[j]![q - 1]!, out.tabPaths[j]![q]!));
            }
          }
          if (nearest < tape) touching++;
        }
      }
      expect(touching, `${name}: tabs lying on one another`).toBe(0);

      // And they use more than one wall — on a circuit this size, at least three of the four.
      const wall = (p: Vec2): string => {
        const d: [string, number][] = [
          ["L", Math.abs(p.x - win.x0)], ["R", Math.abs(p.x - win.x1)],
          ["T", Math.abs(p.y - win.y0)], ["B", Math.abs(p.y - win.y1)],
        ];
        return d.sort((a, b) => a[1] - b[1])[0]![0];
      };
      const used = new Set(out.tabPaths.map((t) => wall(t[t.length - 1]!)));
      expect(used.size, `${name}: walls used`).toBeGreaterThanOrEqual(3);
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

/**
 * The LED, drawn as the library part it is.
 *
 * An LED used to be the one component the cut files did not draw at all — it was a pair of points the
 * runs were narrowed against and nothing else, and what the editor showed instead was a bespoke pair of
 * coloured circles invented for this app. It now goes through `partShape`/`partSvg` on the same code
 * path as a resistor, from the same two points, so an LED on screen is the footprint that gets cut.
 *
 * The two points a cut file is handed are the CUT ENDS of the two nets' copper, not the pad centres:
 * the in-line form puts each pad centre half a pad-length outboard of the end it is given. That is what
 * makes an LED's legs land on copper — the router brings the two ends to within the part's own bare gap
 * and the pads then fall at the part's own pitch, half on the tape either side.
 */
describe("model/copper-svg-export LEDs", () => {
  /** The part's own numbers, read from the library rather than written down here. */
  const dims = (id: string) => {
    const fp = BY_ID(id);
    const [p1, p2] = [padNamed(fp, "1"), padNamed(fp, "2")];
    const pad = padSize(p1);
    const pitch = Math.abs(padAt(p2).x - padAt(p1).x);
    return { pitch, pad, gap: pitch - pad.w };
  };

  const BY_ID = (id: string) => COMPONENTS.find((c) => c.id === id)!.footprint;

  /** Just the parts layer — everything the file draws and nothing it cuts. */
  const partsOf = (svg: string): string => {
    const from = svg.indexOf('<g id="parts"');
    return from < 0 ? "" : svg.slice(from);
  };

  /** The full-size pad outlines in a drawing: the copper rings, as their bounding boxes and centres. */
  const padsDrawn = (svg: string): { c: Vec2; w: number; h: number }[] => {
    const out: { c: Vec2; w: number; h: number }[] = [];
    const re = new RegExp(`<path d="([^"]+)" fill="${PCB_COLOURS.copper}"`, "g");
    for (const m of svg.matchAll(re)) {
      const n = m[1]!.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) { xs.push(n[i]!); ys.push(n[i + 1]!); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({ c: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, w: x1 - x0, h: y1 - y0 });
    }
    return out;
  };

  /**
   * One LED on `house.fkld`, with its two copper ends the part's own bare gap apart across the hinge.
   *
   * Built by hand rather than taken from the router so that this file tests its own half of the job: the
   * router owns where the copper ends up, this owns what is drawn once it is there.
   */
  function oneLed(component?: string) {
    const { fold, traces, tapeW } = planned("house.fkld", 1);
    const { scale } = sheetFrame(fold);
    const d = dims(component ?? "LED_1206");
    const pwrRun = traces.find((t) => t.net === "pwr")!;
    const c = pwrRun.pts[Math.floor(pwrRun.pts.length / 2)]!;
    // Flat units: the gap is a millimetre length, and the cut files scale flat to sheet by `scale`.
    const halfFlat = d.gap / 2 / scale;
    const pads = [{
      pwr: { x: c.x, y: c.y + halfFlat },
      gnd: { x: c.x, y: c.y - halfFlat },
      ...(component ? { component } : {}),
    }];
    return { fold, traces, tapeW, pads, d, scale };
  }

  it("lands an LED's legs on the copper: pads at the part's own pitch, over the cut ends", () => {
    // The whole point of the change. The two ends of copper are a bare gap apart; the pads must come out
    // a PITCH apart, which means each one overlaps half its length of tape. Pads placed on the cut ends
    // themselves would sit in the bare pattern between the two nets and touch neither.
    const { fold, traces, tapeW, pads, d } = oneLed();
    // Read back out of the file, so the tolerance is the file's: coordinates are written to four
    // decimal places, and a centre averaged over rounded corners can be that much out.
    const drawn = padsDrawn(partsOf(buildCopperSvgExport(fold, traces, tapeW, "k", pads).svg));
    expect(drawn).toHaveLength(2);
    const sep = Math.hypot(drawn[0]!.c.x - drawn[1]!.c.x, drawn[0]!.c.y - drawn[1]!.c.y);
    expect(sep).toBeCloseTo(d.pitch, 3);
    // And at the part's own size: `w` runs along the break, `h` across it. The break is vertical here.
    for (const p of drawn) {
      expect(p.h).toBeCloseTo(d.pad.w, 3);
      expect(p.w).toBeCloseTo(d.pad.h, 3);
    }
  });

  it("draws an 0603 at 0603's size, not at 1206's", () => {
    // Nothing may hard-code the 1206's dimensions: a smaller LED has to come out smaller.
    const big = oneLed("LED_1206");
    const small = oneLed("LED_0603");
    const a = padsDrawn(partsOf(buildCopperSvgExport(big.fold, big.traces, big.tapeW, "k", big.pads).svg));
    const b = padsDrawn(partsOf(buildCopperSvgExport(small.fold, small.traces, small.tapeW, "k", small.pads).svg));
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    const sep = (p: typeof a) => Math.hypot(p[0]!.c.x - p[1]!.c.x, p[0]!.c.y - p[1]!.c.y);
    expect(sep(a)).toBeCloseTo(big.d.pitch, 3);
    expect(sep(b)).toBeCloseTo(small.d.pitch, 3);
    expect(sep(b)).toBeLessThan(sep(a) * 0.6);
    expect(b[0]!.w).toBeLessThan(a[0]!.w);
    expect(b[0]!.h).toBeLessThan(a[0]!.h);
  });

  it("means LED_1206 when the circuit does not say, so an old file draws what it always drew", () => {
    const { fold, traces, tapeW, pads } = oneLed();
    const bare = buildCopperSvgExport(fold, traces, tapeW, "k", pads).svg;
    const named = buildCopperSvgExport(
      fold, traces, tapeW, "k", pads.map((p) => ({ ...p, component: "LED_1206" })),
    ).svg;
    expect(partsOf(bare)).toBe(partsOf(named));
  });

  it("draws the LED on both cut files, and cuts it on neither", () => {
    // A cut along a pad would slice the very tape the leg is soldered to.
    const { fold, traces, tapeW, pads } = oneLed();
    const strips = buildCopperSvgExport(fold, traces, tapeW, "k", pads);
    const carrier = buildCopperCarrierExport(fold, traces, tapeW, "k", [], undefined, undefined, pads);
    for (const svg of [strips.svg, carrier.svg]) {
      expect(padsDrawn(partsOf(svg) || svg.slice(svg.indexOf('<g id="annotation"')))).toHaveLength(2);
    }
    // Nothing the part is painted in may appear in what the blade follows — on either file.
    const paint = [PCB_COLOURS.copper, PCB_COLOURS.mask, PCB_COLOURS.padLabel, PCB_COLOURS.origin];
    const stripCut = strips.svg.slice(0, strips.svg.indexOf('<g id="parts"'));
    for (const colour of paint) {
      expect(stripCut).not.toContain(colour);
      expect(cutLayer(carrier.svg)).not.toContain(colour);
    }
    // And drawn on the carrier, not merely absent from its cuts.
    expect(carrier.svg).toContain('<g id="annotation"');
    expect(carrier.svg.slice(carrier.svg.indexOf('<g id="annotation"'))).toContain(PCB_COLOURS.copper);
  });

  it("names LEDs after every other part, so the canvas and the files agree", () => {
    // The editor's canvas builds the same list in the same order — resistors, switches, parts, LEDs —
    // and hands out designators over it. A chip called LED1 on screen and LED2 on the file would be
    // worse than no designator at all.
    const { fold, traces, tapeW, pads } = oneLed();
    const pwr = traces.find((t) => t.net === "pwr")!;
    const res = [{ a: pwr.pts[0]!, b: pwr.pts[1]! }];
    const svg = buildCopperSvgExport(fold, traces, tapeW, "k", pads, undefined, undefined, res).svg;
    expect([...svg.matchAll(/>([A-Z]+\d+)</g)].map((m) => m[1]!)).toEqual(["R1", "LED1"]);
  });

  it("skips an LED the router could not place, and spends no number on it", () => {
    // An unreachable LED keeps its zeroed pads, and `pads` stays index-aligned with the circuit's LEDs
    // so that it can. Drawn from those, the chip would land at the sheet's own origin; numbered from
    // them, every LED after it would be one too high and the file would disagree with the canvas.
    //
    // Both shapes of the fault are here. Two zeroed pads are the router's actual convention, and a
    // degenerate placement is already refused for having no length. One zeroed pad is not something the
    // router emits today, and is exactly why the check is on the pads rather than on the length: half a
    // placement has plenty of length, and would be drawn as a chip stretched from the sheet's corner
    // out to the hinge.
    const { fold, traces, tapeW, pads } = oneLed();
    const dead = [
      { pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } },
      { pwr: { x: 0, y: 0 }, gnd: pads[0]!.gnd },
      { pwr: pads[0]!.pwr, gnd: { x: 0, y: 0 } },
    ];
    const svg = buildCopperSvgExport(fold, traces, tapeW, "k", [...dead, ...pads]).svg;
    expect(padsDrawn(partsOf(svg))).toHaveLength(2);
    expect([...svg.matchAll(/>([A-Z]+\d+)</g)].map((m) => m[1]!)).toEqual(["LED1"]);
  });

  it("draws nothing for a component that is not in the library", () => {
    const { fold, traces, tapeW, pads } = oneLed();
    const svg = buildCopperSvgExport(
      fold, traces, tapeW, "k", pads.map((p) => ({ ...p, component: "NOT_A_PART" })),
    ).svg;
    expect(svg).not.toContain('<g id="parts"');
  });
});
