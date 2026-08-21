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
import { type Trace2D, landingWidth } from "./electronics-routing.js";
import { printScale } from "./print-scale.js";
import { R_1206, slide_switch } from "./footprints.generated.js";

const MARGIN = 8; // mm — must match the FKLD SVG export or the layers import misaligned

/** How far from a pad or terminal a tab must anchor, in tape widths.
 *
 *  A tape width clears the pad itself, which is about a third of that. Anything larger and short runs -- the
 *  ones running only from one pad to the next -- have no point left to grip: at 1.6 widths, 7 of puffin's 15
 *  runs were fully excluded and had to fall back onto a pad. At 1.0 it is 1. */
const PAD_CLEAR = 1.0;

/**
 * How much of a run's outline earns it another tab, in millimetres of perimeter.
 *
 * One grip per run leaves a long trace free to swing about it, and a corner can lift off the mat before it is
 * pressed down. A second costs a tape width of extra cut and a second snip by hand, which is why this is
 * generous rather than tight: on the bundled circuits it is the long runs that gain one, not every run.
 */
const TAB_EVERY_MM = 60;

/** However long a run is, this many grips at most: each is a place the copper stays joined to the waste. */
const MAX_TABS_PER_RUN = 2;

/** What a wall already carrying a tab adds to the cost of reaching it, in tape widths. */
const CROWD_TOLL = 6;

/** Width of the carrier frame's border, outside the pattern window. */
const FRAME_BUFFER = 5;




/**
 * Which way, if either, the cut is flipped.
 *
 * Copper tape is cut face up and laid face down as often as not: cutting it through the backing, or laying a
 * strip adhesive-side up so the copper faces the paper, reverses the pattern, and a circuit cut the wrong way
 * round is scrap — the LEDs land on the mirror image of where they belong. Both axes are offered because which
 * one is needed depends on how the sheet goes onto the mat, which the file cannot know.
 */
export interface Mirror {
  /** Flip left-right, across the sheet's vertical centreline. */
  x: boolean;
  /** Flip top-bottom. Note the base transform already flips Y once, to get from FOLD's y-up to SVG's y-down;
   *  this is a second flip on top of that, not that one. */
  y: boolean;
}

/** Cut as designed. */
export const NO_MIRROR: Mirror = { x: false, y: false };

/**
 * Reflect a point already in sheet coordinates.
 *
 * The mirror is taken about the *sheet's* centre rather than the pattern's, so every layer of a job — strips,
 * carrier, and the editor's own preview — reflects about the same line and stays registered with the others.
 */
export function mirrorPoint(p: Vec2, w: number, h: number, m: Mirror): Vec2 {
  return { x: m.x ? w - p.x : p.x, y: m.y ? h - p.y : p.y };
}

/** Below this the strips are not worth cutting: a blade will not track it and copper tape is not sold that
 *  narrow. Reported rather than silently widened, since widening would break registration with the preview
 *  and could make separate strips touch. */
const MIN_CUTTABLE_MM = 3;

/** Cut colours. Distinct so a cutter treats each net as its own layer. */
/** The carrier is one piece of copper, so it gets one colour — copper, with the nets drawn on top of it. */
const CARRIER_FILL = "#b87333";
const PWR_FILL = "#ff0000";
const GND_FILL = "#222222";

/**
 * The parts' own copper, from fab-modules `pcb.py` by way of `ocaml/footprints.ml`.
 *
 * A named part is the size it is. Every pad, pitch and hole below is that library's, so nothing here is a
 * guess at a footprint or a shape scaled to whatever the tape happens to be.
 */
const SWITCH = {
  fp: slide_switch,
  /** Centre to centre between adjacent pads: the copper is broken by exactly this. */
  pitch: slide_switch.pads[1]!.cx - slide_switch.pads[0]!.cx,
  /** How far the housing stands clear of the pad row — the pads' own offset from the part's origin. */
  offset: slide_switch.pads[0]!.cy,
  /** Between the two rows: the common's edge to the throws'. The break is this plus a neck. */
  rowSep: slide_switch.pads[0]!.cy - slide_switch.pads[1]!.cy,
};

/** A resistor: a black body, with grey leads reaching either way onto the copper it bridges. */
const RES_BODY = "#111111";
const RES_LEAD = "#c3cad6";   // bright enough to read against the black housing it sits on

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
  /**
   * Millimetres of sheet per unit of pattern — see {@link printScale}.
   *
   * Anything measured in flat units has to be multiplied by this before it is used against sheet
   * coordinates. Tape widths and clearances are the ones that matter: they come from the router in the
   * pattern's units, and comparing them raw against millimetres is how a 0.1-unit strip ends up being
   * treated as a tenth of a millimetre of copper.
   */
  scale: number;
}

/** Work out the sheet exactly as {@link buildFkldSvgExport} does, so every layer registers.
 *
 *  `mirror` reflects the finished sheet. It is applied here, at the single transform every layer goes through,
 *  rather than at each shape: mirroring the geometry piecemeal would let one layer flip without another, and
 *  the whole point of the shared frame is that they cannot drift apart. */
export function sheetFrame(
  fold: FoldFile,
  mirror: Mirror = NO_MIRROR,
  /** The sheet a scale-less pattern is cut at. Must be the size the router planned for, or the tape is no
   *  longer 3.25mm: the two derivations cancel only when they agree on it. */
  sheetMm?: number,
): SheetFrame {
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
  // Pattern units to millimetres first, then the margin — which is a real 8mm border on the cut sheet, not
  // eight of whatever the pattern happens to be measured in.
  const k = printScale(fold, sheetMm);
  const w = (maxX - minX) * k + 2 * MARGIN;
  const h = (maxY - minY) * k + 2 * MARGIN;
  // Shift to a positive origin with a margin and flip Y (FOLD is y-up, SVG is y-down), then apply the
  // requested mirror. The window is unchanged either way: the margin is equal on opposite sides, so it
  // reflects onto itself.
  return {
    w,
    h,
    window: { x0: MARGIN, y0: MARGIN, x1: w - MARGIN, y1: h - MARGIN },
    scale: k,
    T: (p: Vec2): Vec2 =>
      mirrorPoint({ x: (p.x - minX) * k + MARGIN, y: (maxY - p.y) * k + MARGIN }, w, h, mirror),
  };
}

export function buildCopperSvgExport(
  fold: FoldFile,
  traces: Trace2D[],
  tapeW: number,
  baseName = "kiri",
  /** LED pads, so a run can be narrowed where it lands between an LED's legs. */
  pads: { pwr: Vec2; gnd: Vec2 }[] = [],
  mirror: Mirror = NO_MIRROR,
  sheetMm?: number,
  /** Where each resistor bridges a break in the PWR run. Drawn on the parts layer, never cut. */
  resistors: { a: Vec2; b: Vec2 }[] = [],
  /** How wide across to draw a part, so a resistor matches an LED. Defaults to the tape's width. */
  partMm?: number,
  /** Where each switch bridges a break — drawn, never cut. */
  switches: { a: Vec2; b: Vec2 }[] = [],
): CopperSvgExport {
  const { w, h, T, scale } = sheetFrame(fold, mirror, sheetMm);
  // What will actually be cut, in millimetres. The outlines are built in flat units and mapped through T,
  // which scales them, so the strips come out this wide without anything else being done to them.
  const tapeMm = tapeW * scale;

  // Windows to take out of the copper: an SPDT's idle throw needs bare pattern under it. Each is carried on
  // the same path as the strip it holes, since a separate one would just lie on top; `evenodd` then reads
  // the inner ring as a hole rather than as more copper.
  const windows = switches
    .map((w) => switchShape(T(w.a), T(w.b), tapeMm, partMm)?.notch)
    .filter((n): n is Vec2[] => !!n && n.length >= 3);

  const layer = (net: "pwr" | "gnd"): { body: string; count: number } => {
    const runs = traces.filter((t) => t.net === net && t.pts.length >= 2);
    const paths: string[] = [];
    for (const t of runs) {
      const ring = stripOutline(t, tapeW, pads).map(T);
      if (ring.length < 3) continue;
      const mine = windows.filter((n) => pointInRing(centreOf(n), ring));
      paths.push(`<path d="${[ringPath(ring), ...mine.map(ringPath)].join(" ")}" />`);
    }
    return { body: paths.join("\n    "), count: paths.length };
  };

  const pwr = layer("pwr");
  const gnd = layer("gnd");
  const parts = [
    ...resistors.flatMap((r) => resistorMarks(r, tapeMm, T, partMm)),
    ...switches.flatMap((r) => switchMarks(r, tapeMm, T, partMm)),
  ];
  const body =
    `  <g id="pwr" fill="${PWR_FILL}" stroke="none" fill-rule="evenodd">\n    ${pwr.body}\n  </g>\n` +
    `  <g id="gnd" fill="${GND_FILL}" stroke="none" fill-rule="evenodd">\n    ${gnd.body}\n  </g>` +
    // The parts sit on their own layer: they show where the resistor goes, and are not copper to cut.
    (parts.length ? `\n  <g id="parts">\n    ${parts.join("\n    ")}\n  </g>` : "");

  return {
    widthMm: tapeMm,
    tooNarrow: tapeMm < MIN_CUTTABLE_MM,
    filename: `${baseName}-copper${mirrorSuffix(mirror)}.svg`,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
      `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body}\n</svg>\n`,
    counts: { pwr: pwr.count, gnd: gnd.count },
  };
}

/**
 * The outline of one run of tape: the shape that will be cut.
 *
 * The single definition of what a run looks like. The strips file, the carrier and the editor's canvas all
 * draw this, so the gap that keeps the two nets apart under a chip cannot exist in one and not another --
 * which it did: the carrier laid every run at full width, shorting all six of puffin's LEDs while the strips
 * file for the same circuit had a clean 1.14mm between them.
 */
export function stripOutline(
  t: Trace2D,
  tapeW: number,
  pads: { pwr: Vec2; gnd: Vec2 }[] = [],
): Vec2[] {
  // Land copper under a part's terminals carries its own width; ordinary tape has none and takes the tape's.
  return outlineStrip(t.pts, widthsFor(t, t.width ?? tapeW, pads));
}

/**
 * The tape's width at each point of a run.
 *
 * Full width along the way, narrowed only where it lands on an LED pad whose partner leg is close enough that a
 * full-width strip would reach across the chip. The two nets would otherwise meet under the part and short it,
 * and a vinyl cutter could not weed the gap between them.
 */
function widthsFor(t: Trace2D, tapeW: number, pads: { pwr: Vec2; gnd: Vec2 }[]): number[] {
  return t.pts.map((p) => {
    let w = tapeW;
    for (const pad of pads) {
      const own = t.net === "pwr" ? pad.pwr : pad.gnd;
      const mate = t.net === "pwr" ? pad.gnd : pad.pwr;
      if (Math.hypot(p.x - own.x, p.y - own.y) > tapeW) continue; // not landing here
      w = Math.min(w, landingWidth(own, mate, tapeW));
    }
    return w;
  });
}

/**
 * The closed outline of a strip of tape laid along `pts`.
 *
 * Walks one side of the centreline out and the other back, so the result is a single ring: the shape to cut.
 * Corners are mitred, capped so a sharp turn produces a blunt corner rather than a long spike.
 */
export function outlineStrip(pts: Vec2[], width: number | number[]): Vec2[] {
  const clean = dedupe(pts);
  if (clean.length < 2) return [];
  // A width per point, so a run can narrow where it lands between an LED's legs and stay full width elsewhere.
  const widths = Array.isArray(width)
    ? matchLength(width, pts, clean)
    : clean.map(() => width);
  if (widths.every((w) => w <= 0)) return [];
  const left = offsetSide(clean, widths.map((w) => w / 2));
  const right = offsetSide(clean, widths.map((w) => -w / 2));
  return [...left, ...right.reverse()];
}

/** Carry per-point widths through `dedupe`, which may have dropped repeated points. */
function matchLength(widths: number[], original: Vec2[], clean: Vec2[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const p of clean) {
    while (j < original.length && (original[j]!.x !== p.x || original[j]!.y !== p.y)) j++;
    out.push(widths[Math.min(j, widths.length - 1)] ?? widths[widths.length - 1] ?? 0);
    j++;
  }
  return out;
}

/** Offset a polyline to one side by `off` (signed), mitring at the joins. */
function offsetSide(pts: Vec2[], offs: number[]): Vec2[] {
  const out: Vec2[] = [];
  const miterLimit = 2;
  for (let i = 0; i < pts.length; i++) {
    const off = offs[i] ?? offs[offs.length - 1] ?? 0;
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

/**
 * A closed ring, opened by exactly `width` centred on `ring[index]` — the span the tab bridges.
 *
 * Measured along the ring rather than by dropping vertices. Dropping one drops the two segments either side
 * of it, and the ring has been densified to about a tape width per segment, so the outline came away open
 * over some three tape widths where the tab covers one: the copper was left joined along a stretch that
 * looked, correctly, like an outline that had failed to close.
 */
/**
 * The parts of a cut that are not buried in copper, as separate paths.
 *
 * Two runs of one net meet at a junction and overlap on purpose — one net, one potential, and the tape is
 * laid over itself by hand. But each run was still outlined all the way round, so where they overlapped one
 * run's cut line crossed the other's strip, and the blade would have severed it. Across the bundled circuits
 * that came to 848mm of cut running through copper, 224mm on a single one.
 *
 * Cutting only what is outside every strip leaves the outside of the merged shape: a boundary that carries
 * on across the join rather than stopping at it. Nothing is unioned or re-derived — each edge is split where
 * it enters copper and the buried part is dropped.
 *
 * `self` is the ring this cut is the boundary of, if any — skipped, because a strip's own outline runs along
 * itself and would otherwise delete itself. It is matched by identity rather than by a distance tolerance:
 * a tolerance keeps a little of each ring past the crossing, by a different amount on each side, and the two
 * boundaries then stop short of one another by up to a tape width. Stroked that is invisible, but the
 * fragments are chained back into closed loops ({@link stitchLoops}), and a loop cannot close across a gap.
 * Sub-spans are classified by their midpoints, which are strictly inside or strictly outside, so no tolerance
 * is needed for the rest.
 */
function clipOutside(
  cut: { pts: Vec2[]; closed: boolean; self?: Vec2[][] },
  solids: Vec2[][],
): { pts: Vec2[]; closed: boolean }[] {
  const pts = cut.closed ? [...cut.pts, cut.pts[0]!] : cut.pts;
  if (pts.length < 2) return [];

  const buried = (p: Vec2): boolean =>
    solids.some((ring) => !cut.self?.includes(ring) && pointInRing(p, ring));

  const out: { pts: Vec2[]; closed: boolean }[] = [];
  let run: Vec2[] = [];
  let clipped = false;
  const flush = (): void => {
    if (run.length >= 2) out.push({ pts: run, closed: false });
    run = [];
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    // Split where the edge crosses into or out of copper, so the cut stops at the copper's edge rather
    // than at whichever sample happened to land there.
    const ts = [0, ...crossingsAlong(a, b, solids), 1].sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1]!, t1 = ts[k]!;
      if (t1 - t0 < 1e-9) continue;
      const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      const p0 = at(t0), p1 = at(t1);
      if (buried(at((t0 + t1) / 2))) {
        clipped = true;
        flush();
      }
      else {
        if (!run.length) run.push(p0);
        run.push(p1);
      }
    }
  }
  // A closed cut that lost nothing stays closed. The frame's outer edge is the one that matters: it is cut
  // all the way round, and reopening it would leave the sheet joined to the waste around it.
  if (cut.closed && !clipped) return [{ pts: cut.pts, closed: true }];
  flush();
  return out;
}

/**
 * Chain open cut fragments back into the closed loops they are pieces of.
 *
 * The carrier's cuts are *built* as fragments — a window edge broken across each tab, each tab's two sides,
 * each trace outline opened where its tab attaches — but they are pieces of one continuous boundary: the edge
 * of the copper. Follow it from a window edge, up one side of a tab, round the trace, back down the other
 * side, on along the window edge, and it closes. Stroked, the fragments look right and cut right; **filled**,
 * they are nothing, because an open path has no inside. So they are joined end to end here.
 *
 * Endpoints coincide by construction (a tab's sides are landed exactly on the ends of the ring it opens, and
 * on the window; a crossing point is cut at from both sides), so a tight tolerance chains them. Anything that
 * still will not close is handed back as `open` rather than dropped — a cut that vanished silently is worse
 * than one drawn as a line.
 */
function stitchLoops(frags: Vec2[][], tol: number): { loops: Vec2[][]; open: Vec2[][] } {
  const items = frags.map(dedupe).filter((f) => f.length >= 2);
  const used = items.map(() => false);
  const loops: Vec2[][] = [];
  const open: Vec2[][] = [];
  const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = items[i]!.slice();
    for (let grew = true; grew; ) {
      grew = false;
      if (chain.length > 2 && near(chain[0]!, chain[chain.length - 1]!)) break;
      const head = chain[0]!, tail = chain[chain.length - 1]!;
      for (let j = 0; j < items.length; j++) {
        if (used[j]) continue;
        const f = items[j]!;
        const a = f[0]!, b = f[f.length - 1]!;
        // Four ways a fragment can extend the chain: onto either end, either way round.
        if (near(tail, a)) chain = chain.concat(f.slice(1));
        else if (near(tail, b)) chain = chain.concat(f.slice(0, -1).reverse());
        else if (near(head, b)) chain = f.slice(0, -1).concat(chain);
        else if (near(head, a)) chain = f.slice(1).reverse().concat(chain);
        else continue;
        used[j] = true;
        grew = true;
        break;
      }
    }
    if (chain.length > 3 && near(chain[0]!, chain[chain.length - 1]!)) loops.push(dedupe(chain.slice(0, -1)));
    else open.push(chain);
  }
  return { loops, open };
}

/** Where segment ab crosses any solid's edge, as fractions along ab. */
function crossingsAlong(a: Vec2, b: Vec2, solids: Vec2[][]): number[] {
  const ts: number[] = [];
  for (const ring of solids) {
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i]!, d = ring[(i + 1) % ring.length]!;
      const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
      const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  return ts;
}

/**
 * Containment by **winding number**, not even-odd.
 *
 * A run that doubles back on itself — a hairpin round a tile, which the router plans freely — outlines as a
 * ring that crosses itself, and the lobe where it overlaps is wound twice. Even-odd calls that lobe *outside*
 * the strip, so the cut kept the buried line there and dropped the line that was really on the outside; the
 * boundary then stood open by a millimetre or two at each crossing and would not close. Winding counts the
 * overlap as the solid copper it is: three of akde-hex's twelve runs self-intersect, nine crossings in all.
 */
/** The average of a ring's corners — good enough to say which strip a small window sits in. */
function centreOf(ring: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let wind = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!, b = ring[i]!;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) {
      if (b.y > p.y && side > 0) wind++;
    } else if (b.y <= p.y && side < 0) wind--;
  }
  return wind !== 0;
}

/**
 * A closed ring, opened by `width` at each of several attachment points — one arc per gap between them.
 *
 * The single-tab case is {@link openAround}. With more than one tab the ring is no longer one arc but
 * several, and each has to be emitted once for the whole ring rather than once per tab: opening it separately
 * for each would emit a near-complete ring per tab, and the boundary would be cut two and three times over.
 *
 * Openings that overlap are merged, so two tabs landing within a tape width of each other leave one gap
 * rather than a sliver of cut between them.
 */
export function openAtMany(
  ring: Vec2[],
  indices: number[],
  width: number,
): { arcs: Vec2[][]; openings: { from: Vec2; to: Vec2 }[] } {
  const n = ring.length;
  if (n < 3 || !indices.length) return { arcs: [ring.slice()], openings: [] };
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(l);
    total += l;
  }
  if (!(total > 0)) return { arcs: [ring.slice()], openings: [] };
  const at = (i: number): number => {
    let acc = 0;
    for (let k = 0; k < i; k++) acc += seg[k]!;
    return acc;
  };
  const wrap = (v: number): number => ((v % total) + total) % total;
  const pointAt = (v: number): Vec2 => {
    let t = wrap(v);
    for (let i = 0; i < n; i++) {
      if (t <= seg[i]! || i === n - 1) {
        const a = ring[i]!, b = ring[(i + 1) % n]!;
        const f = seg[i]! > 0 ? Math.min(t / seg[i]!, 1) : 0;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      t -= seg[i]!;
    }
    return ring[0]!;
  };
  // Never open away more than half the ring in total, however many tabs land on it.
  // Independent of how many tabs there are: a tab that turns out to be redundant is dropped later, and if
  // the width depended on the count the survivors' openings would move when it did — leaving their sides
  // landed on points the arcs were no longer cut at, and the boundary unable to close.
  const half = Math.min(width / 2, total / 8);
  // Reported back in the caller's own order, so each tab can land its sides on the very points its opening
  // was cut at. Landing them on separately-computed points is what left the boundary unable to close: the
  // two halves differed, and the ends missed each other by the difference.
  const openings = indices.map((i) => ({
    from: pointAt(at(i) - half),
    to: pointAt(at(i) + half),
  }));
  const cuts = indices
    .map((i) => ({ from: wrap(at(i) - half), to: wrap(at(i) + half) }))
    .sort((a, b) => a.from - b.from);

  const arcs: Vec2[][] = [];
  for (let k = 0; k < cuts.length; k++) {
    const start = cuts[k]!.to;
    const end = cuts[(k + 1) % cuts.length]!.from;
    const span = wrap(end - start);
    if (span < 1e-9) continue; // the two openings meet: no copper edge between them to cut
    // In order ALONG the arc, not in ring-index order: an arc starts wherever its opening ended, so walking
    // the vertices from index 0 hands them over out of sequence and the outline doubles back on itself.
    const between = [];
    for (let i = 0; i < n; i++) {
      const d = wrap(at(i) - start);
      if (d > 1e-9 && d < span) between.push({ d, p: ring[i]! });
    }
    between.sort((x, y) => x.d - y.d);
    const arc: Vec2[] = [pointAt(start), ...between.map((b) => b.p), pointAt(end)];
    if (arc.length >= 2) arcs.push(arc);
  }
  return { arcs, openings };
}

export function openAround(ring: Vec2[], index: number, width: number): Vec2[] {
  const n = ring.length;
  if (n < 3) return ring.slice();
  // Arc length to each vertex, once round.
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[(i + 1) % n]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(l);
    total += l;
  }
  if (!(total > 0)) return ring.slice();
  // Half the tab either side of the attachment point; a tab wider than the whole ring would leave nothing
  // to cut, so it is capped well short of that.
  const half = Math.min(width / 2, total / 4);
  const at = (i: number): number => {
    let s = 0;
    for (let k = 0; k < i; k++) s += seg[k]!;
    return s;
  };
  const wrap = (s: number): number => ((s % total) + total) % total;
  const pointAt = (s: number): Vec2 => {
    let t = wrap(s);
    for (let i = 0; i < n; i++) {
      if (t <= seg[i]! || i === n - 1) {
        const a = ring[i]!, b = ring[(i + 1) % n]!;
        const f = seg[i]! > 0 ? Math.min(t / seg[i]!, 1) : 0;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      t -= seg[i]!;
    }
    return ring[0]!;
  };

  const s0 = wrap(at(index) + half);  // the far side of the tab: where the cut resumes
  const s1 = wrap(at(index) - half);  // the near side: where it stops
  const out: Vec2[] = [pointAt(s0)];
  // Every vertex strictly between s0 and s1, walking forward and wrapping once.
  for (let k = 1; k <= n; k++) {
    const i = (index + k) % n;
    const si = wrap(at(i) - s0);
    if (si > 0 && si < wrap(s1 - s0)) out.push(ring[i]!);
  }
  out.push(pointAt(s1));
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

/**
 * The annotation layer: everything the editor's canvas shows that a cut line cannot say.
 *
 * The strips file separates PWR from GND by colour, so opening it tells you which strip is which and where
 * the parts go. The carrier could not: it is one piece of copper, which means one layer of one colour, and
 * black outlines alone do not say which run is positive, where the LED sits, or which way round it goes.
 *
 * So the strips file is drawn on top of it: each run filled in its net's colour, at the width it is cut, and
 * nothing else. The carrier is solid copper underneath, so the file reads as the strips export with the frame
 * and its tabs added — the same shapes, in the same colours, in the same places, on the piece they arrive on.
 *
 * Only the copper. Pad and terminal markers were tried here and taken out again: drawn over the strip they
 * merge with it into one red blob wider than the tape, and the cut line, which follows the strip alone, then
 * reads as an outline that does not fit its own shape.
 *
 * **This layer is not meant to be cut.** It is kept out of `carrier` precisely so it can be switched off or
 * deleted in the cutting software; a cutter set to follow every path in the file would cut these too, which
 * would sever the traces they are drawn on top of.
 */
function annotationLayer(
  traces: Trace2D[],
  pads: { pwr: Vec2; gnd: Vec2 }[],
  resistors: { a: Vec2; b: Vec2 }[],
  switches: { a: Vec2; b: Vec2 }[],
  tapeW: number,
  scale: number,
  T: (p: Vec2) => Vec2,
  partMm?: number,
): string {
  const parts: string[] = [];

  // No copper here. The carrier IS the copper -- frame, tabs and traces are one piece, drawn as one filled
  // shape -- so redrawing each run on top of it in its net's colour said nothing the shape did not already
  // say and made the file read as though the nets were separate pieces laid over the frame. Only the parts
  // are left: where they go, and which way round.
  // The resistors, over the breaks they bridge. Drawn after the copper so a part reads as sitting on top of
  // the tape, which is how it goes down.
  for (const r of resistors) parts.push(...resistorMarks(r, tapeW * scale, T, partMm));
  for (const r of switches) parts.push(...switchMarks(r, tapeW * scale, T, partMm));

  if (!parts.length) return "";
  return `  <g id="annotation" stroke-linejoin="round">\n    ${parts.join("\n    ")}\n  </g>\n`;
}

/**
 * A resistor drawn across the break in the copper it bridges.
 *
 * Grey leads run the whole span, from one cut end of the tape to the other — that is what is taped down onto
 * the copper either side and carries the current. The black body sits in the middle, over the bare pattern
 * where there is deliberately no copper at all.
 */
export interface ResistorShape {
  /** The two contacts, drawn across the tape at each cut end — one per lead. */
  leads: { a: Vec2; b: Vec2; width: number }[];
  /** The body, square across the run. */
  body: { x: number; y: number; w: number; h: number; angle: number; cx: number; cy: number };
  /** Mounting holes, where the part has them. Drawn, never cut: a hole through the pattern is the user's
   *  decision, not the exporter's. */
  holes?: { c: Vec2; r: number }[];
  /**
   * Copper to take out from under a pin, as a closed ring in sheet coordinates.
   *
   * The idle throw of an SPDT needs bare pattern beneath it, or the switch is wired to nothing in one
   * position and to the rail in both. Unlike the break, this does not sever the run: it is a window inside
   * the strip, and the copper carries on either side of it.
   */
  notch?: Vec2[];
}

/**
 * Where a resistor's leads and body go, given the break its leads bridge — both already in sheet coordinates.
 *
 * One definition, used by the strips file, the carrier and the editor's canvas. The leads reach `LEAD_OVER`
 * past each cut end, because that is the part that matters: it lies on the copper, and it is what holds the
 * part down and carries the current. Drawn only to the edge of the gap they would show a part touching
 * nothing.
 */
export function resistorShape(
  a: Vec2,
  b: Vec2,
  tape: number,
  /** The part's width across the run. Defaults to the tape's, but the canvas passes the size it draws an
   *  LED at, so the two parts come out the same size beside each other. */
  cross = tape,
): ResistorShape | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const ux = dx / L, uy = dy / L;
  const px = -uy, py = ux;               // across the run
  const over = tape * 0.5;               // how far each contact reaches back onto the tape
  const half = cross * 0.5;              // and how far across it
  const bodyW = cross * 0.85;            // the body, a little inside its contacts
  // The body spans the whole break and laps a little onto each contact. At four fifths of the gap it fell
  // short of both, leaving the part drawn as three pieces with bare pattern showing between them.
  const bodyL = L + over * 0.5;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // A contact at each cut end, lying across the tape rather than along it: that is the shape of the join,
  // a band of lead pressed down over the full width of the copper, not a line running down the middle.
  const contact = (p: Vec2, dir: number): { a: Vec2; b: Vec2; width: number } => {
    const c = { x: p.x + ux * dir * (over / 2), y: p.y + uy * dir * (over / 2) };
    return {
      a: { x: c.x - px * half, y: c.y - py * half },
      b: { x: c.x + px * half, y: c.y + py * half },
      width: over,
    };
  };
  return {
    leads: [contact(a, -1), contact(b, +1)],
    body: {
      x: mid.x - bodyL / 2, y: mid.y - bodyW / 2, w: bodyL, h: bodyW,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI, cx: mid.x, cy: mid.y,
    },
  };
}

/**
 * Where the switch's pads, body and mounting holes go, given the break its middle pads bridge.
 *
 * Three pads at the part's own pitch. The break is one pitch, so pad 2 sits on the copper at one end of it
 * and pad 3 on the copper at the other, with pad 1 a further pitch back beside pad 2 — two on one side, one
 * on the other.
 *
 * The body is offset the part's `.1in` clear of the pad row rather than drawn over it. That is where it
 * really sits: the legs reach out to the copper and the housing stands beside them. Drawn centred on the
 * rail it covered the very tape it is soldered to.
 */
export function switchShape(a: Vec2, b: Vec2, tape: number, cross = tape): ResistorShape | null {
  void tape; void cross;                 // a named part is its own size, not the tape's
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return null;
  const ux = dx / L, uy = dy / L;
  const px = -uy, py = ux;               // across the run, towards the body
  // The rail runs straight through the part: the common is on the near edge of the break, the two throws on
  // the far edge, a pitch either side of the centreline. The outgoing tape runs down the middle and reaches
  // neither throw by itself — one gets a land, the other is left bare, and that is what opens the circuit.
  const p0 = SWITCH.fp.pads[0]!;
  const common = a;
  // The throws sit a row's separation along from the common — not at the far cut end, which is pulled back
  // a neck further so the idle throw lands in clear pattern rather than beside the tape.
  const row = { x: a.x + ux * SWITCH.rowSep, y: a.y + uy * SWITCH.rowSep };
  const live = { x: row.x + px * SWITCH.pitch, y: row.y + py * SWITCH.pitch };
  const idle = { x: row.x - px * SWITCH.pitch, y: row.y - py * SWITCH.pitch };
  // The housing spans both rows, centred between them.
  const cx = (a.x + row.x) / 2, cy = (a.y + row.y) / 2;
  // Across the rail: out to the throws' centres. Each terminal then straddles a corner of the housing --
  // half its width on, half off -- so it reads as attached while still standing proud. Drawn out to the
  // pads' far edges instead the housing swallowed them; drawn short of their centres they met it at a
  // single point and looked detached, which is what they were.
  const bodyL = 2 * SWITCH.pitch;
  // Along the rail: exactly edge to edge between the two pad rows, so each terminal straddles the housing's
  // outline and half of it stands proud, as the legs do on the part. A pad's length deeper and every
  // terminal fell inside the outline, leaving the legs as slivers at the corners.
  const bodyW = SWITCH.rowSep;
  // A pad at its own size: `w` across the part's long axis, `h` along the rail.
  const pad = (c: Vec2): { a: Vec2; b: Vec2; width: number } => {
    const half = p0.h / 2;
    return {
      a: { x: c.x - ux * half, y: c.y - uy * half },
      b: { x: c.x + ux * half, y: c.y + uy * half },
      width: p0.w,
    };
  };
  return {
    leads: [pad(idle), pad(common), pad(live)],
    body: {
      x: cx - bodyL / 2, y: cy - bodyW / 2, w: bodyL, h: bodyW,
      angle: (Math.atan2(py, px) * 180) / Math.PI, cx, cy,
    },
    // The two mounting holes, on the body's own centre line.
    holes: SWITCH.fp.holes.map((h) => ({
      c: { x: cx + ux * h.cx + px * h.cy, y: cy + uy * h.cx + py * h.cy },
      r: h.r,
    })),
  };
}

function partMarks(sh: ResistorShape, bodyFill: string): string[] {
  const { leads, body } = sh;
  // Housing first, pads over it. A part's legs run under its body, but a footprint drawing that hides them
  // there answers none of the questions you look at it to answer: where the copper is and how big it is.
  return [
    `<rect x="${fmt(body.x)}" y="${fmt(body.y)}" width="${fmt(body.w)}" ` +
      `height="${fmt(body.h)}" rx="${fmt(body.h * 0.18)}" fill="${bodyFill}" ` +
      `transform="rotate(${fmt(body.angle)} ${fmt(body.cx)} ${fmt(body.cy)})" />`,
    ...leads.map(
      (l) =>
        `<line x1="${fmt(l.a.x)}" y1="${fmt(l.a.y)}" x2="${fmt(l.b.x)}" y2="${fmt(l.b.y)}" ` +
        `stroke="${RES_LEAD}" stroke-width="${fmt(l.width)}" stroke-linecap="butt" />`,
    ),
    ...(sh.holes ?? []).map(
      (h) =>
        `<circle cx="${fmt(h.c.x)}" cy="${fmt(h.c.y)}" r="${fmt(h.r)}" fill="none" ` +
        `stroke="${RES_LEAD}" stroke-width="${fmt(h.r * 0.5)}" />`,
    ),
  ];
}

function switchMarks(
  r: { a: Vec2; b: Vec2 },
  tape: number,
  T: (p: Vec2) => Vec2,
  cross?: number,
): string[] {
  const sh = switchShape(T(r.a), T(r.b), tape, cross);
  return sh ? partMarks(sh, RES_BODY) : [];
}

function resistorMarks(
  r: { a: Vec2; b: Vec2 },
  tape: number,
  T: (p: Vec2) => Vec2,
  cross?: number,
): string[] {
  const sh = resistorShape(T(r.a), T(r.b), tape, cross);
  if (!sh) return [];
  const { leads, body } = sh;
  const bodyL = body.w, bodyW = body.h, ang = body.angle;
  const mid = { x: body.cx, y: body.cy };
  return [
    ...leads.map(
      (l) =>
        `<line x1="${fmt(l.a.x)}" y1="${fmt(l.a.y)}" x2="${fmt(l.b.x)}" y2="${fmt(l.b.y)}" ` +
        `stroke="${RES_LEAD}" stroke-width="${fmt(l.width)}" stroke-linecap="butt" />`,
    ),
    // The body, square across the run.
    `<rect x="${fmt(mid.x - bodyL / 2)}" y="${fmt(mid.y - bodyW / 2)}" width="${fmt(bodyL)}" ` +
      `height="${fmt(bodyW)}" rx="${fmt(bodyW * 0.18)}" fill="${RES_BODY}" ` +
      `transform="rotate(${fmt(ang)} ${fmt(mid.x)} ${fmt(mid.y)})" />`,
  ];
}

/** Names a mirrored file as mirrored, and by which axis.
 *
 *  A mirrored cut and a straight one are the same shape seen from opposite sides, so on disk they are told
 *  apart only by their names — and cutting the wrong one wastes the tape and the LEDs' positions with it. */
function mirrorSuffix(m: Mirror): string {
  if (!m.x && !m.y) return "";
  return `-mirrored-${m.x ? "x" : ""}${m.y ? "y" : ""}`;
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
  /**
   * Tabs that had to grip a pad because the run had nowhere else to be gripped.
   *
   * Happens on a run shorter than a tape width or two between its two pads: every point on it is under a
   * component. Such a tab is still better than leaving the trace loose in the window, but it sits where the LED
   * goes and is snipped at the pad, so it is counted rather than passed off as clean.
   */
  padTabs: number;
  /**
   * Tabs whose route out passes over a pad or a terminal.
   *
   * Only the fallback can produce one: when no candidate anchor, wall or sideways step gets clear of the
   * components and the other net, the shortest is used anyway rather than leaving the trace loose. Such a tab
   * is stuck down on top of a part and cuts into it when snipped, so it is counted and shown.
   */
  componentTabs: number;
  /** Tab centrelines in sheet coordinates, so a preview can draw exactly what will be cut. */
  tabPaths: Vec2[][];
  /**
   * Cut fragments that could not be chained into a closed loop.
   *
   * Expected to be zero: the carrier's boundary is continuous, so every fragment has a neighbour at each end.
   * A non-zero count means some stretch is drawn as a bare line instead of bounding filled copper — it still
   * cuts, but that part of the shape has no inside, so it is reported rather than passed off as solid.
   */
  unclosedCuts: number;
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
 * line all the way around a trace would free it whatever tabs are drawn, so no trace gets an outline of its
 * own — each ring stops short of its tab, the tab's two sides run out to the window edge, and the window edge
 * itself breaks where a tab lands. The remaining uncut spans are the tabs.
 *
 * Those pieces are then chained back into the closed loops they belong to ({@link stitchLoops}) and emitted
 * **filled**, like {@link buildCopperSvgExport}'s strips: the outer rectangle, and one inner loop that runs
 * along the window and detours around every trace by way of its tab. Filled `evenodd`, that is the copper —
 * frame, tabs and traces solid, the waste inside the window empty. The cut is the same line either way; a
 * shape additionally says which side of it the copper is on, which is what a cutter reads, and it is why no
 * trace can come away on its own here: its outline is not a loop, it is a detour in a bigger one.
 */
export function buildCopperCarrierExport(
  fold: FoldFile,
  traces: Trace2D[],
  tapeW: number,
  baseName = "kiri",
  /** Pads and battery terminals, in flat coordinates. Tabs are kept off them. */
  keepOff: Vec2[] = [],
  mirror: Mirror = NO_MIRROR,
  sheetMm?: number,
  /** LED pads, so a run narrows where it lands between an LED's legs — exactly as the strips file does.
   *  Without them the carrier meets itself under the chip and shorts the two nets together. */
  pads: { pwr: Vec2; gnd: Vec2 }[] = [],
  /** Where each resistor bridges a break in the PWR run — drawn, never cut. */
  resistors: { a: Vec2; b: Vec2 }[] = [],
  /** How wide across to draw a part, so a resistor matches an LED. Defaults to the tape's width. */
  partMm?: number,
  /** Where each switch bridges a break — drawn, never cut. */
  switches: { a: Vec2; b: Vec2 }[] = [],
): CopperCarrierExport {
  const { w, h, window: win, T, scale } = sheetFrame(fold, mirror, sheetMm);
  // Everything below works in sheet millimetres, so the tape width has to be converted out of the pattern's
  // units first -- tabs, clearances and spacing are all measured against it.
  const tape = tapeW * scale;
  const runs = traces.filter((t) => t.pts.length >= 2);

  // Geometry, not markup: the cuts are clipped against the copper before they are written out.
  const cuts: { pts: Vec2[]; closed: boolean; self?: Vec2[][] }[] = [];
  // The frame's outer edge: a plain closed rectangle, cut all the way round.
  const ox0 = win.x0 - FRAME_BUFFER, oy0 = win.y0 - FRAME_BUFFER;
  const ox1 = win.x1 + FRAME_BUFFER, oy1 = win.y1 + FRAME_BUFFER;
  cuts.push({
    pts: [
      { x: ox0, y: oy0 }, { x: ox1, y: oy0 }, { x: ox1, y: oy1 }, { x: ox0, y: oy1 },
    ],
    closed: true,
  });

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
    ring: densify(stripOutline(t, tapeW, pads).map(T), tape),
  }));
  // A tab must grip the trace, not the component. Anchoring on a pad puts the tab exactly where the LED sits
  // and means snipping it cuts at the pad; the same goes for a battery terminal. Those spots are excluded, so a
  // tab lands on the run's body.
  const avoid = keepOff.map(T);
  const gaps: { side: Side; from: number; to: number }[] = [];
  let tabs = 0;
  let crossingTabs = 0;
  let padTabs = 0;
  let componentTabs = 0;
  const tabPaths: Vec2[][] = [];
  /** Every tab placed so far, so the next one can keep off them and off their walls. */
  const chosen: { side: Side; path: Vec2[] }[] = [];
  const quads: Vec2[][] = [];
  /** Each tab as built, held back until every quad exists — whether a tab is redundant depends on the rest. */
  /** Held per RING, not per tab: a ring with two tabs is two arcs, and they are the ring's, not either
   *  tab's. Emitting an opened ring per tab would cut most of the boundary twice over. */
  const held: {
    ring: Vec2[];
    tabs: { index: number; quad: Vec2[]; s1: Vec2[]; s2: Vec2[]; side: Side; q1: Vec2; q2: Vec2 }[];
  }[] = [];
  rings.forEach(({ net, ring }, ri) => {
    if (ring.length < 3) return;
    // Only the *other* net's runs are obstacles. Runs of the same net meet at junctions by design and may
    // overlap freely -- one net, one potential -- so treating them as obstacles left every candidate blocked,
    // which is why neither more anchors nor bent tabs changed anything.
    const others = rings.filter((r, i) => i !== ri && r.net !== net).map((r) => r.ring);
    // How many supports this run earns. A long run held at one point still swings about it and can lift a
    // corner off the mat; a second grip costs a tab's width of extra cut and stops that. Kept modest --
    // every tab is a place the copper stays joined to the waste and has to be snipped by hand.
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      perimeter += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const want = Math.max(1, Math.min(MAX_TABS_PER_RUN, 1 + Math.floor(perimeter / TAB_EVERY_MM)));

    // Each further tab is asked for with the ones already placed added to what it must keep clear of, so it
    // lands somewhere else along the run rather than beside its neighbour.
    const picks: { index: number; side: Side; path: Vec2[] }[] = [];
    const taken = [...avoid];
    for (let t = 0; t < want; t++) {
      const choice = pickTab(ring, others, win, tape, taken, chosen);
      if (!choice) break;
      // The first grip is taken as it comes — a run has to be held even where the only spot is a poor one.
      // An extra is a convenience, so it is only worth having if it is clean: taking a compromised one would
      // trade a support nobody asked for against a tab that cuts into a part.
      if (t > 0 && (!choice.clear || choice.onComponent || choice.overComponent)) break;
      if (!choice.clear) crossingTabs++;
      if (choice.onComponent) padTabs++;
      if (choice.overComponent) componentTabs++;
      tabPaths.push(choice.path);
      taken.push(ring[choice.index]!);
      picks.push({ index: choice.index, side: choice.side, path: choice.path });
      // Every tab on the sheet so far, not just this run's: they all share the four walls.
      chosen.push({ side: choice.side, path: choice.path });
    }
    if (!picks.length) return;

    // Cut the openings once, for the whole set, and land every tab on the very points its own was cut at.
    const { openings } = openAtMany(ring, picks.map((p) => p.index), tape);
    const mine: { index: number; quad: Vec2[]; s1: Vec2[]; s2: Vec2[]; side: Side; q1: Vec2; q2: Vec2 }[] = [];
    picks.forEach((p, k) => buildTab(p, openings[k] ?? null, mine));
    held.push({ ring, tabs: mine });
    tabs += mine.length;
  });

  /** The sides of one tab, landed on its opening and run out to the wall. */
  function buildTab(
    choice: { index: number; side: Side; path: Vec2[] },
    opening: { from: Vec2; to: Vec2 } | null,
    into: { index: number; quad: Vec2[]; s1: Vec2[]; s2: Vec2[]; side: Side; q1: Vec2; q2: Vec2 }[],
  ): void {
    const { index, side } = choice;
    // The tab's two sides: its centreline offset either way, so a bent tab keeps its width around the corner.
    const s1 = offsetSide(choice.path, choice.path.map(() => tape / 2));
    const s2 = offsetSide(choice.path, choice.path.map(() => -tape / 2));
    // Land the tab's sides exactly where the outline stopped. Offsetting the tab's centreline puts them
    // near those points but not on them, which left the cut in pieces: a blade lifting off and dropping
    // back on a fraction of a millimetre away, and a sliver between the two that tears rather than cuts.
    if (opening) {
      const a = opening.to, b = opening.from;
      const gap = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y);
      const straight = gap(s1[0]!, a) + gap(s2[0]!, b) <= gap(s1[0]!, b) + gap(s2[0]!, a);
      s1[0] = straight ? a : b;
      s2[0] = straight ? b : a;
    }
    const q1 = onWindow(s1[s1.length - 1]!, side, win);
    const q2 = onWindow(s2[s2.length - 1]!, side, win);
    s1[s1.length - 1] = q1;
    s2[s2.length - 1] = q2;
    const quad = [...s1, ...s2.slice().reverse()];
    quads.push(quad);
    into.push({ index, quad, s1, s2, side, q1, q2 });
  }
    // Clipped against every other run, but not against the one they grip: a tab side starts *on* its own
    // ring, and leaving at a shallow angle its first step reads as inside — dropped, the tab would come away
    // from the trace it holds and the boundary would stand open across the whole tab footprint.
    // The tab as a shape, not just its two sides: two tabs landing close on one wall overlap, and the buried
    // halves of their sides have to go the same way a run buried in another run's strip does. Without it those
    // sides ran on to a window edge that had already been broken across both, and ended on nothing.

  // Every piece of copper inside the window: the runs and the tabs holding them.
  const solid = [...rings.map((r) => r.ring), ...quads];

  // A tab can come out buried: `pickTab` treats only the *other* net as an obstacle, so a tab may lie inside
  // a run of its own net, which is copper it is already fused to. Both its sides then clip away to nothing,
  // and the opening they were meant to bridge is left standing in the ring with nothing crossing it — a gap
  // in the boundary a tape width wide, exactly where a closing straight line would seal the run into a loop
  // of its own and free it. The tab is redundant there, so the ring is simply not opened: it is cut whole,
  // and where it runs through the copper that swallowed the tab, the clip below drops that stretch and the
  // two boundaries carry on as one.
  for (const h of held) {
    // Which of this ring's tabs actually survive. A buried one clips away to nothing and must not open the
    // ring, or the opening it was meant to bridge stands in the boundary with nothing crossing it.
    const live = h.tabs.filter((t) => {
      const sides = [t.s1, t.s2].map((pts) =>
        clipOutside({ pts, closed: false, self: [h.ring, t.quad] }, solid),
      );
      return !sides.every((f) => f.length === 0);
    });
    if (!live.length) {
      cuts.push({ pts: h.ring, closed: true, self: [h.ring, ...h.tabs.map((t) => t.quad)] });
      continue;
    }
    for (const t of live) {
      // Clipped against every other shape, but not against the two it is the boundary of: a tab side starts
      // *on* its ring and runs along its own quad, and either would otherwise delete it.
      cuts.push(
        { pts: t.s1, closed: false, self: [h.ring, t.quad] },
        { pts: t.s2, closed: false, self: [h.ring, t.quad] },
      );
      // The window edge must break across the tab's footprint, or the tab is severed from the frame.
      const [from, to] = alongSide(t.side, t.q1, t.q2);
      gaps.push({ side: t.side, from, to });
    }
    // The ring, opened once for the whole set: with two tabs it is two arcs, and they belong to the ring.
    const selves = [h.ring, ...live.map((t) => t.quad)];
    for (const arc of openAtMany(h.ring, live.map((t) => t.index), tape).arcs) {
      if (arc.length >= 2) cuts.push({ pts: arc, closed: false, self: selves });
    }
  }

  // The window edge, cut in the spans between tabs.
  for (const side of SIDES) {
    for (const seg of sideSpans(side, win, gaps.filter((g) => g.side === side))) {
      cuts.push({ pts: seg, closed: false });
    }
  }

  // Drop every stretch of cut that lies buried in copper. Two runs of one net meet at a junction and
  // overlap by design -- one net, one potential -- but each was still outlined in full, so one run's cut
  // ran clean through the other's strip and the blade would sever it. What is left is the outside of the
  // copper: a boundary that carries on across the join instead of stopping at it.
  const drawn = cuts.flatMap((c) => clipOutside(c, solid));

  // Close the boundary back up, and emit the carrier as the solid shape it is rather than as loose lines.
  //
  // The fragments above are pieces of one continuous edge, so chaining them gives the outer rectangle plus the
  // inner loop that runs along the window and detours around every trace by way of its tab. Filled `evenodd`,
  // that pair *is* the copper: frame, tabs and traces solid, the waste inside the window empty. The same
  // geometry either way -- what changes is that the file now says which side of each line the copper is on,
  // which is what the strips file has always said and what a cutter reads a shape from.
  const preClosed = drawn.filter((d) => d.closed).map((d) => d.pts);
  // One tight pass: every endpoint either was built to coincide with its neighbour's, or is a crossing point
  // that both sides were cut at, so they agree to within rounding. A looser pass would only paper over a gap
  // that is real, and a gap that is real is a cut that does not bound anything.
  // Tight first: every endpoint either was built to coincide with its neighbour's, or is a crossing point
  // both sides were cut at, so they agree to within rounding. Then one bounded pass at a tenth of a tape
  // width, which closes a near-tangential graze -- a tab side that just clips another run leaves entry and
  // exit a fraction of a millimetre apart, and one of the two can fall below the sliver threshold. Joining
  // ends that close moves the cut by less than the line it used to be drawn as. Anything further apart is a
  // real gap and is left open and counted, not quietly bridged.
  const tight = stitchLoops(drawn.filter((d) => !d.closed).map((d) => d.pts), 1e-6);
  const closing = stitchLoops(tight.open, tape * 0.1);
  const stitched = { loops: [...tight.loops, ...closing.loops], open: closing.open };
  // The windows under an SPDT's idle throw. Added as loops rather than as cuts to be stitched: they are
  // already closed, they bound nothing else, and `evenodd` reads a ring inside the copper as a hole. Passing
  // them through the clip would only delete them, since they lie squarely inside a strip by design.
  const windows = switches
    .map((w) => switchShape(T(w.a), T(w.b), tape, partMm)?.notch)
    .filter((n): n is Vec2[] => !!n && n.length >= 3);
  const loops = [...preClosed, ...stitched.loops, ...windows];
  const cutLayer =
    `  <g id="carrier" fill="${CARRIER_FILL}" stroke="none" fill-rule="evenodd">\n    ` +
    `<path d="${loops.map(ringPath).join(" ")}" />` +
    `\n  </g>` +
    // Anything that would not close is still cut -- drawn as a line, and counted, rather than dropped.
    (stitched.open.length
      ? `\n  <g id="carrier-unclosed" fill="none" stroke="#000000" stroke-width="0.25">\n    ` +
        stitched.open.map((o) => `<path d="${openPath(o)}" />`).join("\n    ") +
        `\n  </g>`
      : "");
  // On top of the carrier now that the carrier is filled: underneath it, the solid copper would bury it.
  const body = cutLayer + "\n" + annotationLayer(traces, pads, resistors, switches, tapeW, scale, T, partMm);

  return {
    filename: `${baseName}-copper-carrier${mirrorSuffix(mirror)}.svg`,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" ` +
      `viewBox="0 0 ${fmt(w)} ${fmt(h)}">\n${body}\n</svg>\n`,
    counts: { traces: runs.length, tabs },
    crossingTabs,
    padTabs,
    componentTabs,
    tabPaths,
    unclosedCuts: stitched.open.length,
    frame: { window: win, outer: { x0: ox0, y0: oy0, x1: ox1, y1: oy1 } },
    widthMm: tape,
    tooNarrow: tape < MIN_CUTTABLE_MM,
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
  avoid: Vec2[],
  /**
   * Tabs already placed, so this one can go somewhere else.
   *
   * Sorted on distance alone, every tab dives for whichever wall happens to be nearest and they pile up:
   * across the bundled circuits, 45 of 99 tabs ran within a tape width of another, and puffin sent all six
   * to the top wall. A crowded wall is charged for, and a tab that would lie on one already placed is passed
   * over while any clear spot remains.
   */
  placed: { side: Side; path: Vec2[] }[] = [],
): {
  index: number;
  side: Side;
  path: Vec2[];
  clear: boolean;
  onComponent: boolean;
  overComponent: boolean;
} | null {
  /** Whether a ring point is too close to a pad or terminal to tab onto. */
  const onComponent = (p: Vec2): boolean =>
    avoid.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < tapeW * PAD_CLEAR);
  // Nine offsets is as good as twenty-four: measured identical, so the extra reach buys nothing.
  const SIDE_STEPS = [0, 1.5, -1.5, 3, -3, 5, -5, 8, -8];
  const candidates: { index: number; side: Side; step: number; reach: number }[] = [];
  ring.forEach((p, i) => {
    if (onComponent(p)) return; // a pad or a terminal: grip the trace elsewhere
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
  let forcedOntoComponent = false;
  if (!candidates.length) {
    // Every point sits on a component (a very short run between two pads). Better held by a tab on a pad than
    // left loose in the window, so try again without the exclusion — and say so.
    forcedOntoComponent = true;
    ring.forEach((p, i) => {
      const dist: [Side, number][] = [
        ["left", p.x - win.x0], ["right", win.x1 - p.x],
        ["top", p.y - win.y0], ["bottom", win.y1 - p.y],
      ];
      for (const [side, d] of dist) {
        if (d < 0) continue;
        for (const step of SIDE_STEPS) {
          candidates.push({ index: i, side, step, reach: d + Math.abs(step) * tapeW });
        }
      }
    });
  }
  // A wall already carrying tabs costs more to reach, so later tabs spread onto the others rather than
  // stacking. Priced in tape widths: dear enough to move a tab to another wall, not so dear that it drives
  // one across the whole sheet.
  const crowd = (side: Side): number => placed.filter((q) => q.side === side).length;
  candidates.sort(
    (a, b) =>
      a.reach + crowd(a.side) * tapeW * CROWD_TOLL - (b.reach + crowd(b.side) * tapeW * CROWD_TOLL) ||
      a.index - b.index,
  );

  let fallback: { index: number; side: Side; path: Vec2[]; over?: boolean } | null = null;
  /** Clear of the copper and the parts, but lying on a tab already placed. Better than going over a part. */
  let crowded: { index: number; side: Side; path: Vec2[] } | null = null;
  for (const c of candidates) {
    const a = ring[c.index]!;
    const across = perpTo(c.side);
    const bend = c.step === 0
      ? null
      : { x: a.x + across.x * c.step * tapeW, y: a.y + across.y * c.step * tapeW };
    const end = onWindow(bend ?? a, c.side, win);
    const path = bend ? [a, bend, end] : [a, end];
    if (!fallback) fallback = { index: c.index, side: c.side, path, over: false };
    // A tab may not run *over* a pad or a terminal on its way out, not merely start off one. Keeping the anchor
    // clear was not enough: the run itself passed across components on the way to the wall, where it would be
    // stuck down on top of the part and cut into it when snipped.
    const overComponent = avoid.some((q) => {
      for (let k = 1; k < path.length; k++) {
        if (ptSegDist(q, path[k - 1]!, path[k]!) < tapeW * PAD_CLEAR) return true;
      }
      return false;
    });
    if (overComponent) {
      // Remember the shortest one anyway: if nothing at all is clear, a tab over a part still beats a trace
      // left loose in the window.
      if (!fallback) fallback = { index: c.index, side: c.side, path, over: true };
      continue;
    }
    const blocked = others.some((o) => {
      for (let k = 1; k < path.length; k++) {
        if (segNearRing(path[k - 1]!, path[k]!, o, tapeW)) return true;
      }
      return false;
    });
    if (!blocked) {
      // Not on top of a tab already placed: two tabs on one another are stuck down together and snipping
      // one cuts the other.
      const onAnother = placed.some((q) => {
        for (let k = 1; k < path.length; k++) {
          for (let j = 1; j < q.path.length; j++) {
            if (segSegDist(path[k - 1]!, path[k]!, q.path[j - 1]!, q.path[j]!) < tapeW) return true;
          }
        }
        return false;
      });
      if (onAnother) {
        if (!crowded) crowded = { index: c.index, side: c.side, path };
        continue;
      }
      return {
        index: c.index, side: c.side, path,
        clear: true, onComponent: forcedOntoComponent, overComponent: false,
      };
    }
  }
  if (crowded) {
    return {
      index: crowded.index, side: crowded.side, path: crowded.path,
      clear: true, onComponent: forcedOntoComponent, overComponent: false,
    };
  }
  return fallback
    ? {
        index: fallback.index, side: fallback.side, path: fallback.path,
        clear: false, onComponent: forcedOntoComponent, overComponent: !!fallback.over,
      }
    : null;
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
