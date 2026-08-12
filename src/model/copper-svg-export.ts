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

/** Width of the tabs holding each trace to the frame. Thin enough to snip, wide enough to survive handling. */
const TAB_W = 1;

/** Below this the strips are not worth cutting: a blade will not track it and copper tape is not sold that
 *  narrow. Reported rather than silently widened, since widening would break registration with the preview
 *  and could make separate strips touch. */
const MIN_CUTTABLE_MM = 1.5;

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
  const gaps: { side: Side; from: number; to: number }[] = [];
  let tabs = 0;
  for (const t of runs) {
    const ring = outlineStrip(t.pts, tapeW).map(T);
    if (ring.length < 3) continue;
    const anchor = nearestOnWindow(ring, win);
    if (!anchor) continue;
    const { index, side } = anchor;
    // Open the ring: drop the vertex the tab attaches at, and remember where the tab meets the window.
    const open = ring.slice(index + 1).concat(ring.slice(0, index));
    if (open.length >= 2) cuts.push(openPath(open));
    const a = ring[index]!;
    const across = perpTo(side);
    const p1 = { x: a.x + across.x * (TAB_W / 2), y: a.y + across.y * (TAB_W / 2) };
    const p2 = { x: a.x - across.x * (TAB_W / 2), y: a.y - across.y * (TAB_W / 2) };
    const q1 = onWindow(p1, side, win);
    const q2 = onWindow(p2, side, win);
    cuts.push(openPath([p1, q1]), openPath([p2, q2]));
    // The window edge must break across the tab's footprint, or the tab is severed from the frame.
    const [from, to] = alongSide(side, q1, q2);
    gaps.push({ side, from, to });
    tabs++;
  }

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
    widthMm: tapeW,
    tooNarrow: tapeW < MIN_CUTTABLE_MM,
  };
}

type Side = "left" | "right" | "top" | "bottom";
const SIDES: Side[] = ["left", "right", "top", "bottom"];
type Win = { x0: number; y0: number; x1: number; y1: number };

/** The ring vertex closest to the window edge, and which edge that is — where the tab goes. */
function nearestOnWindow(ring: Vec2[], win: Win): { index: number; side: Side } | null {
  let best = Infinity, index = -1, side: Side = "left";
  ring.forEach((p, i) => {
    const d: [Side, number][] = [
      ["left", p.x - win.x0],
      ["right", win.x1 - p.x],
      ["top", p.y - win.y0],
      ["bottom", win.y1 - p.y],
    ];
    for (const [sd, dist] of d) {
      if (dist < best) { best = dist; index = i; side = sd; }
    }
  });
  return index < 0 ? null : { index, side };
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
