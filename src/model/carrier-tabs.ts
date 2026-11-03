/**
 * **Model** — where the copper carrier's tabs go.
 *
 * Each trace in the carrier frame is held to the frame's window by a tab of tape width. These are the
 * helpers that choose a tab's anchor and its path out to a wall, and that break the window edge across the
 * tabs once they are placed; {@link buildCopperCarrierExport} turns the result into cuts.
 */
import type { Vec2 } from "./electronics.js";

/** How far from a pad or terminal a tab must anchor, in tape widths.
 *
 *  A tape width clears the pad itself, which is about a third of that. Anything larger and short runs -- the
 *  ones running only from one pad to the next -- have no point left to grip: at 1.6 widths, 7 of puffin's 15
 *  runs were fully excluded and had to fall back onto a pad. At 1.0 it is 1. */
const PAD_CLEAR = 1.0;

/** What a wall already carrying a tab adds to the cost of reaching it, in tape widths. */
const CROWD_TOLL = 6;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);

export type Side = "left" | "right" | "top" | "bottom";
export const SIDES: Side[] = ["left", "right", "top", "bottom"];
export type Win = { x0: number; y0: number; x1: number; y1: number };

/** Insert points along each edge so anchors are available between the corners, at roughly `step` spacing. */
export function densify(ring: Vec2[], step: number): Vec2[] {
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
export function pickTab(
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

  let fallback: { index: number; side: Side; path: Vec2[]; over: boolean } | null = null;
  /** The shortest that goes over a part, used only when every candidate does. */
  let overFallback: { index: number; side: Side; path: Vec2[]; over: boolean } | null = null;
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
      if (!overFallback) overFallback = { index: c.index, side: c.side, path, over: true };
      continue;
    }
    if (!fallback) fallback = { index: c.index, side: c.side, path, over: false };
    const blocked = others.some((o) => {
      for (let k = 1; k < path.length; k++) {
        if (segNearRing(path[k - 1]!, path[k]!, o, tapeW)) return true;
      }
      return false;
    });
    if (!blocked) {
      // Not on top of a tab already placed: two tabs on one another are stuck down together and snipping
      // one cuts the other. Exactly a tape apart counts too: their sides coincide and cut one line twice.
      const onAnother = placed.some((q) => {
        for (let k = 1; k < path.length; k++) {
          for (let j = 1; j < q.path.length; j++) {
            if (segSegDist(path[k - 1]!, path[k]!, q.path[j - 1]!, q.path[j]!) < tapeW * (1 + 1e-6)) return true;
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
  fallback ??= overFallback;
  return fallback
    ? {
        index: fallback.index, side: fallback.side, path: fallback.path,
        clear: false, onComponent: forcedOntoComponent, overComponent: fallback.over,
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
export function onWindow(p: Vec2, side: Side, win: Win): Vec2 {
  switch (side) {
    case "left": return { x: win.x0, y: p.y };
    case "right": return { x: win.x1, y: p.y };
    case "top": return { x: p.x, y: win.y0 };
    default: return { x: p.x, y: win.y1 };
  }
}

/** The two tab feet as coordinates along the edge, low first. */
export function alongSide(side: Side, a: Vec2, b: Vec2): [number, number] {
  const va = side === "left" || side === "right" ? a.y : a.x;
  const vb = side === "left" || side === "right" ? b.y : b.x;
  return va <= vb ? [va, vb] : [vb, va];
}

/** One window edge, split into the spans that still get cut — everything except the tab footprints. */
export function sideSpans(side: Side, win: Win, gaps: { from: number; to: number }[]): Vec2[][] {
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
