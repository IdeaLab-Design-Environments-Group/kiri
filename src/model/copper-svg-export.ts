/**
 * **Model** — copper-tape cutting file.
 *
 * Turns the planned traces into an SVG a cutter can follow. A cutter tracks the *path*, so a stroked
 * centreline would cut a line down the middle of each strip instead of cutting the strip out. Every run is
 * therefore emitted as its own **closed outline** at the tape width, with a fill and no stroke.
 *
 * Runs are grouped per net with distinct fills, which is how Cricut Design Space separates layers, so PWR and
 * GND can be cut from separate pieces of tape. Runs of the same net may overlap — they are separate strips laid
 * on top of one another, which is how the tape goes down by hand and is electrically free.
 *
 * The frame (margin, bounds, Y-flip) matches {@link buildFkldSvgExport} exactly, so this file imports
 * registered against the cut and score layers rather than needing to be aligned by hand.
 */
import type { FoldFile } from "./fold-file.js";
import type { Vec2 } from "./electronics.js";
import type { Trace2D } from "./electronics-routing.js";

const MARGIN = 8; // mm — must match the FKLD SVG export or the layers import misaligned

/** Width of the carrier frame's border, outside the pattern window. */
const FRAME_BUFFER = 5;



/** Below this the strips are not worth cutting: a blade will not track it and copper tape is not sold that
 *  narrow. Reported rather than silently widened, since widening would break registration with the preview
 *  and could make separate strips touch. */
const MIN_CUTTABLE_MM = 6.5;

/** Cut colours. Distinct so a cutter treats each net as its own layer. */
const PWR_FILL = "#ff0000";
const GND_FILL = "#222222";

export interface CopperSvgExport {
  filename: string;
  svg: string;
  /** How many strips each net is cut into — what the user has to peel and lay. */
  counts: { pwr: number; gnd: number };
  /** Strip width in the file's own units, which the SVG declares as mm. */
  widthMm: number;
  /**
   * Set when the strips come out too narrow to cut.
   *
   * The width is a fraction of the pattern, and a flat pattern carries no guaranteed physical scale — a
   * kirigamized one can be 19mm across, which puts the strips at 0.3mm. A cutter will not follow that, and no
   * copper tape is made that narrow. Better to say so than to hand over a file that cannot be cut.
   */
  tooNarrow: boolean;
}

/**
 * Build the cutting file for `traces` on `fold`'s flat pattern.
 *
 * `tapeW` is the strip width in the pattern's own units. The preview draws the same width, so what is cut is
 * what was shown.
 */
/** The export sheet: its size, the pattern's window within it, and the flat-to-sheet transform. */
export interface SheetFrame {
  w: number;
  h: number;
  /** The pattern's bounding box in sheet coordinates — the carrier frame's window. */
  window: { x0: number; y0: number; x1: number; y1: number };
  T: (p: Vec2) => Vec2;
}

/** Work out the sheet exactly as {@link buildFkldSvgExport} does, so every layer registers. */
export function sheetFrame(fold: FoldFile): SheetFrame {
  const coords = (fold.vertices_coords ?? []) as unknown[][];
  const pts: Vec2[] = coords.map((c) => ({ x: Number(c[0]) || 0, y: Number(c[1]) || 0 }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  const w = maxX - minX + 2 * MARGIN;
  const h = maxY - minY + 2 * MARGIN;
  // Shift to a positive origin with a margin and flip Y (FOLD is y-up, SVG is y-down). A vertical flip only —
  // it never mirrors the cut left/right.
  return {
    w,
    h,
    window: { x0: MARGIN, y0: MARGIN, x1: w - MARGIN, y1: h - MARGIN },
    T: (p: Vec2): Vec2 => ({ x: p.x - minX + MARGIN, y: maxY - p.y + MARGIN }),
  };
}

export function buildCopperSvgExport(
  fold: FoldFile,
  traces: Trace2D[],
  tapeW: number,
  baseName = "kiri",
): CopperSvgExport {
  const { w, h, T } = sheetFrame(fold);

  const layer = (net: "pwr" | "gnd"): { body: string; count: number } => {
    const runs = traces.filter((t) => t.net === net && t.pts.length >= 2);
    const paths: string[] = [];
    for (const t of runs) {
      const ring = outlineStrip(t.pts, tapeW);
      if (ring.length < 3) continue;
      paths.push(`<path d="${ringPath(ring.map(T))}" />`);
    }
    return { body: paths.join("\n    "), count: paths.length };
  };

  const pwr = layer("pwr");
  const gnd = layer("gnd");
  const body =
    `  <g id="pwr" fill="${PWR_FILL}" stroke="none" fill-rule="nonzero">\n    ${pwr.body}\n  </g>\n` +
    `  <g id="gnd" fill="${GND_FILL}" stroke="none" fill-rule="nonzero">\n    ${gnd.body}\n  </g>`;

  return {
    widthMm: tapeW,
    tooNarrow: tapeW < MIN_CUTTABLE_MM,
    filename: `${baseName}-copper.svg`,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
      `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body}\n</svg>\n`,
    counts: { pwr: pwr.count, gnd: gnd.count },
  };
}

/**
 * The closed outline of a strip of tape laid along `pts`.
 *
 * Walks one side of the centreline out and the other back, so the result is a single ring: the shape to cut.
 * Corners are mitred, capped so a sharp turn produces a blunt corner rather than a long spike.
 */
export function outlineStrip(pts: Vec2[], width: number): Vec2[] {
  const clean = dedupe(pts);
  if (clean.length < 2 || width <= 0) return [];
  const half = width / 2;
  const left = offsetSide(clean, half);
  const right = offsetSide(clean, -half);
  return [...left, ...right.reverse()];
}

/** Offset a polyline to one side by `off` (signed), mitring at the joins. */
function offsetSide(pts: Vec2[], off: number): Vec2[] {
  const out: Vec2[] = [];
  const miterLimit = 2;
  for (let i = 0; i < pts.length; i++) {
    const prev = i > 0 ? pts[i - 1]! : null;
    const next = i < pts.length - 1 ? pts[i + 1]! : null;
    const dIn = prev ? unit(sub(pts[i]!, prev)) : unit(sub(next!, pts[i]!));
    const dOut = next ? unit(sub(next, pts[i]!)) : dIn;
    const nIn = left(dIn);
    const nOut = left(dOut);
    let n = { x: nIn.x + nOut.x, y: nIn.y + nOut.y };
    const l = len(n);
    if (l < 1e-9) {
      // The run doubles back on itself: keep the incoming side rather than shooting off to infinity.
      out.push(add(pts[i]!, scale(nIn, off)));
      continue;
    }
    n = scale(n, 1 / l);
    // The join sits further out than the flat offset by 1/cos(half-angle), which runs away as the turn
    // sharpens -- so it is capped, giving a blunt corner instead of a spike.
    const cos = Math.max(n.x * nIn.x + n.y * nIn.y, 1e-6);
    let mag = off / cos;
    const cap = Math.abs(off) * miterLimit;
    if (Math.abs(mag) > cap) mag = Math.sign(mag) * cap;
    out.push(add(pts[i]!, scale(n, mag)));
  }
  return out;
}

function ringPath(ring: Vec2[]): string {
  return "M " + ring.map((p, i) => (i === 0 ? "" : "L ") + `${fmt(p.x)} ${fmt(p.y)}`).join(" ") + " Z";
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-12) continue;
    out.push(p);
  }
  return out;
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const left = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);

function unit(a: Vec2): Vec2 {
  const l = len(a);
  return l < 1e-12 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");

// ---- carrier frame ----------------------------------------------------------

export interface CopperCarrierExport {
  filename: string;
  svg: string;
  /** How many traces are held in the frame, and how many tabs to snip once it is stuck down. */
  counts: { traces: number; tabs: number };
  /**
   * Tabs that could not reach a wall without lying across another trace.
   *
   * Such a tab is stuck down on top of the trace it crosses, shorting the two, and snipping it cuts into the
   * trace underneath. Reported rather than hidden: on a crowded window there may be no clear line out, and that
   * is worth knowing before cutting.
   */
  crossingTabs: number;
  /** Tab centrelines in sheet coordinates, so a preview can draw exactly what will be cut. */
  tabPaths: Vec2[][];
  /** The frame's window and outer edge in sheet coordinates, likewise. */
  frame: { window: Win; outer: Win };
  widthMm: number;
  tooNarrow: boolean;
}

/**
 * Build the **carrier** cutting file: one piece of copper holding every trace in place.
 *
 * The copper is cut as a frame with a {@link FRAME_BUFFER}mm border whose window is exactly the unfolded
 * pattern, with the traces sitting inside it at their planned positions, each held to the frame by a thin
 * tab. You align the frame to the pattern once, press the traces down, then snip the tabs and lift the frame
 * away — every trace is already where it belongs, so nothing has to be placed by hand.
 *
 * That imposes one hard requirement on the file: **the copper must come off the mat as a single piece.** A cut
 * line all the way around a trace would free it whatever tabs are drawn, so the outlines here are *open* —
 * each ring stops short of its tab, the tab's two sides run out to the window edge, and the window edge itself
 * breaks where a tab lands. The remaining uncut spans are the tabs. This is why the traces are stroked cut
 * lines rather than the filled shapes {@link buildCopperSvgExport} emits: there, each strip is meant to come
 * away on its own.
 */
export function buildCopperCarrierExport(
  fold: FoldFile,
  traces: Trace2D[],
  tapeW: number,
  baseName = "kiri",
): CopperCarrierExport {
  const { w, h, window: win, T } = sheetFrame(fold);
  const runs = traces.filter((t) => t.pts.length >= 2);

  const cuts: string[] = [];
  // The frame's outer edge: a plain closed rectangle, cut all the way round.
  const ox0 = win.x0 - FRAME_BUFFER, oy0 = win.y0 - FRAME_BUFFER;
  const ox1 = win.x1 + FRAME_BUFFER, oy1 = win.y1 + FRAME_BUFFER;
  cuts.push(rectPath(ox0, oy0, ox1, oy1));

  // Each trace: its outline, opened where its tab attaches, plus the tab's two sides.
  //
  // A tab is the width of the tape itself, and it must not lie across another trace: it would be stuck down on
  // top of it, shorting the two, and snipping it would cut into the trace underneath. So every candidate anchor
  // is tried -- each vertex of the run against each of the four walls, nearest first -- and the first tab that
  // reaches its wall without touching another run is the one used. Tabs therefore end up spread over all four
  // walls rather than all diving for the closest edge.
  // Densified, so a tab can leave from anywhere along an outline rather than only at its corners. With thick
  // tape and a crowded window, corners alone leave most runs with no clear line out to a wall.
  const rings = runs.map((t) => ({
    net: t.net,
    ring: densify(outlineStrip(t.pts, tapeW).map(T), tapeW),
  }));
  const gaps: { side: Side; from: number; to: number }[] = [];
  let tabs = 0;
  let crossingTabs = 0;
  const tabPaths: Vec2[][] = [];
  rings.forEach(({ net, ring }, ri) => {
    if (ring.length < 3) return;
    // Only the *other* net's runs are obstacles. Runs of the same net meet at junctions by design and may
    // overlap freely -- one net, one potential -- so treating them as obstacles left every candidate blocked,
    // which is why neither more anchors nor bent tabs changed anything.
    const others = rings.filter((r, i) => i !== ri && r.net !== net).map((r) => r.ring);
    const choice = pickTab(ring, others, win, tapeW);
    if (!choice) return;
    const { index, side } = choice;
    if (!choice.clear) crossingTabs++;
    tabPaths.push(choice.path);
    // Open the ring: drop the vertex the tab attaches at, so the trace stays joined to its tab.
    const open = ring.slice(index + 1).concat(ring.slice(0, index));
    if (open.length >= 2) cuts.push(openPath(open));
    // The tab's two sides: its centreline offset either way, so a bent tab keeps its width around the corner.
    const s1 = offsetSide(choice.path, tapeW / 2);
    const s2 = offsetSide(choice.path, -tapeW / 2);
    const q1 = onWindow(s1[s1.length - 1]!, side, win);
    const q2 = onWindow(s2[s2.length - 1]!, side, win);
    s1[s1.length - 1] = q1;
    s2[s2.length - 1] = q2;
    cuts.push(openPath(s1), openPath(s2));
    // The window edge must break across the tab's footprint, or the tab is severed from the frame.
    const [from, to] = alongSide(side, q1, q2);
    gaps.push({ side, from, to });
    tabs++;
  });

  // The window edge, cut in the spans between tabs.
  for (const side of SIDES) {
    for (const seg of sideSpans(side, win, gaps.filter((g) => g.side === side))) {
      cuts.push(openPath(seg));
    }
  }

  const body =
    `  <g id="carrier" fill="none" stroke="#000000" stroke-width="0.25">\n    ` +
    cuts.map((d) => `<path d="${d}" />`).join("\n    ") +
    `\n  </g>`;

  return {
    filename: `${baseName}-copper-carrier.svg`,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
      `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body}\n</svg>\n`,
    counts: { traces: runs.length, tabs },
    crossingTabs,
    tabPaths,
    frame: { window: win, outer: { x0: ox0, y0: oy0, x1: ox1, y1: oy1 } },
    widthMm: tapeW,
    tooNarrow: tapeW < MIN_CUTTABLE_MM,
  };
}

type Side = "left" | "right" | "top" | "bottom";
const SIDES: Side[] = ["left", "right", "top", "bottom"];
export type Win = { x0: number; y0: number; x1: number; y1: number };

/** Insert points along each edge so anchors are available between the corners, at roughly `step` spacing. */
function densify(ring: Vec2[], step: number): Vec2[] {
  if (ring.length < 2 || step <= 0) return ring;
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    out.push(a);
    const n = Math.floor(len(sub(b, a)) / step);
    for (let k = 1; k < n; k++) {
      const u = k / n;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
  }
  return out;
}

/**
 * How to tab a trace: where it leaves its outline, and the path out to a wall.
 *
 * A tab must not lie across another trace — it would be stuck down on top of it, shorting the two, and snipping
 * it would cut into the trace underneath. Straight tabs alone cannot manage it on a crowded window (puffin: 8
 * of 13 blocked), so each candidate may also turn one corner: sideways along the wall first, then out. Every
 * combination of anchor, wall and sideways step is tried shortest-first, and the first clear one is used.
 *
 * When nothing is clear the shortest is used anyway — a trace is never left loose — and the caller is told via
 * {@link CopperCarrierExport.crossingTabs}.
 */
function pickTab(
  ring: Vec2[],
  others: Vec2[][],
  win: Win,
  tapeW: number,
): { index: number; side: Side; path: Vec2[]; clear: boolean } | null {
  // Nine offsets is as good as twenty-four: measured identical, so the extra reach buys nothing.
  const SIDE_STEPS = [0, 1.5, -1.5, 3, -3, 5, -5, 8, -8];
  const candidates: { index: number; side: Side; step: number; reach: number }[] = [];
  ring.forEach((p, i) => {
    const dist: [Side, number][] = [
      ["left", p.x - win.x0], ["right", win.x1 - p.x],
      ["top", p.y - win.y0], ["bottom", win.y1 - p.y],
    ];
    for (const [side, d] of dist) {
      if (d < 0) continue; // already outside that wall
      for (const step of SIDE_STEPS) {
        candidates.push({ index: i, side, step, reach: d + Math.abs(step) * tapeW });
      }
    }
  });
  candidates.sort((a, b) => a.reach - b.reach || a.index - b.index);

  let fallback: { index: number; side: Side; path: Vec2[] } | null = null;
  for (const c of candidates) {
    const a = ring[c.index]!;
    const across = perpTo(c.side);
    const bend = c.step === 0
      ? null
      : { x: a.x + across.x * c.step * tapeW, y: a.y + across.y * c.step * tapeW };
    const end = onWindow(bend ?? a, c.side, win);
    const path = bend ? [a, bend, end] : [a, end];
    if (!fallback) fallback = { index: c.index, side: c.side, path };
    const blocked = others.some((o) => {
      for (let k = 1; k < path.length; k++) {
        if (segNearRing(path[k - 1]!, path[k]!, o, tapeW)) return true;
      }
      return false;
    });
    if (!blocked) return { index: c.index, side: c.side, path, clear: true };
  }
  return fallback ? { ...fallback, clear: false } : null;
}

/** Whether the tab segment a-q comes within a tape width of any edge of `ring`. */
function segNearRing(a: Vec2, q: Vec2, ring: Vec2[], tapeW: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i]!, d = ring[(i + 1) % ring.length]!;
    if (segsIntersect(a, q, c, d)) return true;
    if (segSegDist(a, q, c, d) < tapeW) return true;
  }
  return false;
}

function segsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cr = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}

function ptSegDist(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const L2 = ab.x * ab.x + ab.y * ab.y;
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

/** Unit vector across a tab running to `side` — the direction its width is measured in. */
function perpTo(side: Side): Vec2 {
  return side === "left" || side === "right" ? { x: 0, y: 1 } : { x: 1, y: 0 };
}

/** `p` projected onto the given window edge. */
function onWindow(p: Vec2, side: Side, win: Win): Vec2 {
  switch (side) {
    case "left": return { x: win.x0, y: p.y };
    case "right": return { x: win.x1, y: p.y };
    case "top": return { x: p.x, y: win.y0 };
    default: return { x: p.x, y: win.y1 };
  }
}

/** The two tab feet as coordinates along the edge, low first. */
function alongSide(side: Side, a: Vec2, b: Vec2): [number, number] {
  const va = side === "left" || side === "right" ? a.y : a.x;
  const vb = side === "left" || side === "right" ? b.y : b.x;
  return va <= vb ? [va, vb] : [vb, va];
}

/** One window edge, split into the spans that still get cut — everything except the tab footprints. */
function sideSpans(side: Side, win: Win, gaps: { from: number; to: number }[]): Vec2[][] {
  const vertical = side === "left" || side === "right";
  const lo = vertical ? win.y0 : win.x0;
  const hi = vertical ? win.y1 : win.x1;
  const fixed = side === "left" ? win.x0 : side === "right" ? win.x1 : side === "top" ? win.y0 : win.y1;
  const at = (v: number): Vec2 => (vertical ? { x: fixed, y: v } : { x: v, y: fixed });

  const sorted = [...gaps].sort((a, b) => a.from - b.from);
  const out: Vec2[][] = [];
  let cursor = lo;
  for (const g of sorted) {
    const from = Math.max(lo, Math.min(hi, g.from));
    const to = Math.max(lo, Math.min(hi, g.to));
    if (from > cursor + 1e-9) out.push([at(cursor), at(from)]);
    cursor = Math.max(cursor, to);
  }
  if (hi > cursor + 1e-9) out.push([at(cursor), at(hi)]);
  return out;
}

function rectPath(x0: number, y0: number, x1: number, y1: number): string {
  return `M ${fmt(x0)} ${fmt(y0)} L ${fmt(x1)} ${fmt(y0)} L ${fmt(x1)} ${fmt(y1)} L ${fmt(x0)} ${fmt(y1)} Z`;
}

function openPath(pts: Vec2[]): string {
  return "M " + pts.map((p, i) => (i === 0 ? "" : "L ") + `${fmt(p.x)} ${fmt(p.y)}`).join(" ");
}
