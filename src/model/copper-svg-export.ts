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
export function buildCopperSvgExport(
  fold: FoldFile,
  traces: Trace2D[],
  tapeW: number,
  baseName = "kiri",
): CopperSvgExport {
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
  // Same transform as the FKLD export: shift to a positive origin with a margin, flip Y (FOLD is y-up, SVG
  // is y-down). A vertical flip only — it never mirrors the cut left/right.
  const T = (p: Vec2): Vec2 => ({ x: p.x - minX + MARGIN, y: maxY - p.y + MARGIN });

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
