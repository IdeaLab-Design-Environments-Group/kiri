/**
 * **Model** — where the copper carrier's tabs go.
 *
 * Each trace in the carrier frame is held to the frame's window by a tab of tape width. These are the
 * helpers that choose a tab's anchor and its path out to a wall, open the trace's outline where the tab
 * lands, and break the window edge across the tabs once they are placed; {@link buildCopperCarrierExport}
 * turns the result into cuts.
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
  /**
   * Points a tab would rather not grip: a placed part's cut ends, which are its pads. Weaker than `avoid` —
   * a clear tab here is still taken over one across the other net. Kept off as hard as a pad, on house and
   * church, it sent two to four times as many tabs across a trace to spare a part's lead.
   */
  noGrip: Vec2[] = [],
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
  const onPart = (p: Vec2): boolean => noGrip.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < tapeW * PAD_CLEAR);
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
  /** Clear, but gripping a part's cut end. Better than lying across the other net. */
  let gripping: { index: number; side: Side; path: Vec2[] } | null = null;
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
    // Nor back across its own run. A bent tab whose first leg heads inward lies on the copper it grips: its
    // outline is never clipped against that run, so its sides cut straight through it.
    if (path.some((_, k) => k > 0 && crossesRing(path[k - 1]!, path[k]!, ring, c.index))) continue;
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
      if (onPart(a)) {
        if (!gripping) gripping = { index: c.index, side: c.side, path };
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
  if (gripping) {
    return { index: gripping.index, side: gripping.side, path: gripping.path, clear: true, onComponent: true, overComponent: false };
  }
  fallback ??= overFallback;
  return fallback
    ? {
        index: fallback.index, side: fallback.side, path: fallback.path,
        clear: false, onComponent: forcedOntoComponent, overComponent: fallback.over,
      }
    : null;
}

/** Whether two runs' strips overlap: some stretch of one centreline within a tape width of the other. */
export function stripsMeet(a: Vec2[], b: Vec2[], tapeW: number): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) if (segSegDist(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!) < tapeW) return true;
  }
  return false;
}

/** Whether a-q crosses an edge of `ring`, leaving out the two that meet at vertex `from`, where it starts. */
function crossesRing(a: Vec2, q: Vec2, ring: Vec2[], from: number): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    if (i === from || (i + 1) % n === from) continue;
    if (segsIntersect(a, q, ring[i]!, ring[(i + 1) % n]!)) return true;
  }
  return false;
}

/** Whether the tab segment a-q comes within a tape width of any edge of `ring`. */
function segNearRing(a: Vec2, q: Vec2, ring: Vec2[], tapeW: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i]!, d = ring[(i + 1) % ring.length]!;
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
  // Two segments that cross are at zero, though neither one's ends need come near the other.
  if (segsIntersect(a, b, c, d)) return 0;
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
