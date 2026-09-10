/**
 * **Model** — laying one leg: the copper between two points, narrowed to fit and bent aside if it will not.
 *
 * ## Why this is its own file
 *
 * The corridor search (`corridor.ts`) chooses *which way* a leg goes and the clearance gate
 * (`net-clearance.ts`) says *whether the copper fits*. Neither of them lays anything. Between the two sits
 * a third job — turn a chosen way into a real run: densify it where it passes a part, give every point a
 * width, test the whole thing, and try a bend when it is refused — and that job was buried in the middle of
 * `net-routing.ts` among the netlist bookkeeping it has nothing to do with.
 *
 * It is separate because it is the piece that grows. A leg is where every new way of getting copper from
 * one place to another has to land, and the router around it should not have to be re-read to add one.
 *
 * ## Entry points
 *
 * {@link layLeg} is the whole of it: `a`, `b`, the waypoints between them, and {@link LegRules} — everything
 * a leg is judged against, gathered so the call takes one argument rather than nine. {@link pathOk} is the
 * gate on its own, for a caller that has already built a path. {@link legWidths} and
 * {@link densifyNearFields} are the width profile, exposed because the same profile has to be reproduced
 * anywhere a run is built outside this file.
 *
 * {@link layPath} is the whole of a leg that may leave the sheet and come back: a corridor path that
 * crosses a seam rejoin is cut into pieces at each jump ({@link splitAtJumps}), each piece laid by
 * {@link layLeg}, and the hops between them returned as {@link Jump}s rather than as copper. A path with
 * no jump in it lays exactly one leg, so a router that never passes an adjacency is the router that was
 * here before.
 */
import { type FlatFace, type Vec2, pointInFace } from "./electronics.js";
import type { Corridor, CorridorBridge, Jump, PadField, Trace2D } from "./trace-types.js";
import type { FoldAdjacency } from "./fold-adjacency.js";
import type { PadObstacle } from "./netlist.js";
import { jumpHopBetween } from "./corridor-jumps.js";
import { ptKey, sub, unit } from "./trace-geometry.js";
import { narrowedTo } from "./pad-landing.js";
import {
  type Laid,
  blamedFor,
  clearOf,
  padCapAt,
  padHitBy,
  ptSegDist,
} from "./net-clearance.js";

/**
 * The face a terminal sits on, or -1.
 *
 * A pad just outside every face — a part nudged over a tile edge — has no way into the corridor graph, so
 * it is stranded rather than snapped to the nearest tile. Snapping would move the user's part without
 * saying so, and the copper would then be laid to somewhere the part is not.
 */
export function faceOfPoint(faces: FlatFace[], p: Vec2): number {
  return pointInFace(faces, p);
}

/**
 * A leg's width at each of its points, narrowed at either end that lands on a real pad rather than on a
 * tap point out on the rail.
 *
 * One point narrows, not several: `outlineStrip` draws a straight taper across whatever segment separates
 * two differently-sized points on its own, the same way the bus already narrows onto an LED's legs, so
 * there is nothing to interpolate here — only which end, if either, gets its pad's own width instead of
 * the tape's.
 *
 * Returns `undefined` when neither end narrows, so a leg with two bare `NetPoint`s (`padWidth` unset — the
 * shape every hand-built test fixture is) comes out with no `widths` at all and renders exactly as before.
 */
/**
 * Split any stretch of a leg that passes near a part, so its width can follow the metal instead of being
 * interpolated across a whole corridor hop.
 *
 * {@link legWidths} gives a width per POINT and `outlineStrip` tapers linearly between them, so the width
 * profile is only as good as the point spacing. A leg out of a chip's pin runs pad → corridor node, and a
 * corridor node is a face centre — millimetres away. Measured on the reported circuit: three points over
 * 24.96mm carrying 1.20mm, 3.03mm and 1.00mm, which `outlineStrip` drew as a wedge some 3mm wide across four
 * neighbouring pins. That is what "the wire goes to the closest pin" looked like on screen.
 *
 * No new constant decides where the taper ends: {@link narrowedTo} already returns the full tape width once a
 * point is past a field's `reach`, so densifying and asking it per point makes the profile follow the part's
 * own pitch. Only stretches actually near a field are split, so an ordinary leg between two bare pads is
 * untouched and still comes back with no `widths` at all.
 */
export function densifyNearFields(pts: Vec2[], tapeW: number, fields: PadField[]): Vec2[] {
  if (!fields.length || pts.length < 2) return pts;
  const step = tapeW / 2;
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1]!, b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Only where it can matter: a segment whose closest approach to some field is beyond that field's reach
    // has one width along its whole length and nothing to interpolate.
    const near = fields.some((f) => ptSegDist(f.at, a, b) <= f.reach + tapeW);
    if (near && len > step) {
      // Capped, so a long leg across a crowded board cannot turn into thousands of points.
      const n = Math.min(Math.ceil(len / step), 64);
      for (let k = 1; k < n; k++) {
        out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      }
    }
    out.push(b);
  }
  return out;
}

export function legWidths(
  pts: Vec2[], tapeW: number, startPad?: number, endPad?: number,
  /** The metal near this leg — see `electronics-routing.ts › PadField`. */
  fields: PadField[] = [],
  /** Every foreign pad this leg has to squeeze past — see {@link padCapAt}. */
  cap?: (p: Vec2) => number,
): number[] | undefined {
  const start = startPad !== undefined && startPad < tapeW ? startPad : null;
  const end = endPad !== undefined && endPad < tapeW ? endPad : null;
  // Every point, not only the two ends. A pad's own field is centred on the pad, so an endpoint narrows
  // because it stands at distance zero from its own field, and an interior point still over the part
  // narrows for the same reason by the same rule — which collapses the old endpoint special case and the
  // "stay narrow while crossing the part" requirement into one thing rather than adding a second.
  //
  // It had to stop being an endpoint rule. `pts[1]` is a corridor node — a face centre, typically
  // millimetres away — so copper reached full tape width within a millimetre of a 1.6mm pin and blanketed
  // its neighbours. That is what "the wire goes to the closest pin" looks like on screen.
  // Two narrowings, and they answer different questions. `fields` is the part's OWN pitch — how wide copper
  // may be while standing over the part it is reaching for. `cap` is the room left by every pad this leg is
  // not landing on, which is what lets it thread between two pins instead of being refused for touching one.
  const ws = pts.map((p) => Math.min(narrowedTo(tapeW, p, fields), cap ? cap(p) : tapeW));
  if (start !== null) ws[0] = Math.min(ws[0] ?? tapeW, start);
  if (end !== null) ws[ws.length - 1] = Math.min(ws[ws.length - 1] ?? tapeW, end);
  // Nothing narrowed anywhere: no `widths` at all, so a leg between two ordinary pads renders exactly as it
  // always has and every reader of `Trace2D` that has never heard of `widths` keeps working.
  return ws.some((w) => w < tapeW) ? ws : undefined;
}

/** Everything a leg is judged against, gathered so `layLeg` takes one argument rather than nine. */
export interface LegRules {
  others: Laid[];
  clearance: number;
  tapeW: number;
  fields: PadField[];
  pads: PadObstacle[];
  padGap: number;
  netId: string;
  /** This net's own pad centres — see {@link padIsMine}. */
  own: Vec2[];
  faces: FlatFace[];
}

/**
 * How far to the side a refused leg will step, and in how many tries.
 *
 * The corridor's only nodes are the midpoints of a face's own edges — one per edge — so inside a tile a leg
 * is a straight chord and the search has no way to go round anything. A pad on that chord is therefore not
 * something the search can avoid, and without this the leg is simply refused and its terminal reported
 * stranded. One bend, at increasing offsets either side of the straight approach, is enough for the case
 * this exists for: a leg arriving across the pins either side of the one it lands on, which needs to come
 * in from a clear direction rather than to find a winding path.
 */
const DETOUR_STEPS = 6;
const DETOUR_STEP_TAPES = 0.6;

/** Whether a whole path clears every other net AND every pad that is not this net's. */
export function pathOk(
  pts: Vec2[], widths: number[] | undefined, r: LegRules,
): { ok: true } | { ok: false; cuts: string | null } {
  const wAt = (k: number): number => widths?.[k] ?? r.tapeW;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!;
    const cuts = blamedFor(a, b, r.others, r.clearance, wAt(k - 1), wAt(k), r.tapeW);
    if (cuts !== null || !clearOf(a, b, r.others, r.clearance, wAt(k - 1), wAt(k), r.tapeW)) {
      return { ok: false, cuts };
    }
    // And the pads, which the check above cannot see: it measures against other nets' RUNS.
    const over = padHitBy(a, b, r.pads, r.netId, r.padGap, wAt(k - 1), wAt(k), r.own);
    // Blame the net that owns the pad where there is one. An unwired pin belongs to nobody, and saying so
    // is more honest than naming whatever else its part is wired to.
    if (over) return { ok: false, cuts: over.net };
  }
  return { ok: true };
}

/**
 * Lay one leg from `a` to `b` through `mid`, narrowed to fit past the pads and bent aside if it still will
 * not go.
 *
 * The straight approach is tried first, so a leg with room takes the path it always did. Only a refused one
 * pays for the detours.
 */
export function layLeg(
  a: Vec2, b: Vec2, mid: Vec2[],
  padWidthA: number | undefined, padWidthB: number | undefined,
  r: LegRules,
): { ok: true; pts: Vec2[]; widths?: number[] } | { ok: false; cuts: string | null } {
  const cap = (p: Vec2): number => padCapAt(p, r.pads, r.netId, r.padGap, r.tapeW, r.own);
  const build = (way: Vec2[]): { pts: Vec2[]; widths?: number[] } => {
    // Densified first, so the width profile follows the part's own pitch rather than being smeared across a
    // corridor hop — and so the gate judges exactly the copper the blade will cut.
    const pts = densifyNearFields([a, ...way, b], r.tapeW, r.fields);
    const widths = legWidths(pts, r.tapeW, padWidthA, padWidthB, r.fields, cap);
    return { pts, ...(widths ? { widths } : {}) };
  };

  const straight = build(mid);
  const first = pathOk(straight.pts, straight.widths, r);
  if (first.ok) return { ok: true, ...straight };

  // The last hop is the one that lands on the pad, so that is the one to bend: a waypoint offset square to
  // it brings the leg in from the side instead of straight down the row.
  const from = mid.length ? mid[mid.length - 1]! : a;
  const dx = b.x - from.x, dy = b.y - from.y;
  const L = Math.hypot(dx, dy);
  if (L > 1e-9) {
    const px = -dy / L, py = dx / L;
    for (let step = 1; step <= DETOUR_STEPS; step++) {
      const off = step * DETOUR_STEP_TAPES * r.tapeW;
      for (const sign of [1, -1]) {
        const w = { x: from.x + dx / 2 + px * sign * off, y: from.y + dy / 2 + py * sign * off };
        // A waypoint off the material is no waypoint: copper cannot be laid where there is no sheet.
        if (faceOfPoint(r.faces, w) < 0) continue;
        const bent = build([...mid, w]);
        if (pathOk(bent.pts, bent.widths, r).ok) return { ok: true, ...bent };
      }
    }
  }
  return { ok: false, cuts: first.cuts };
}

/**
 * Cut a corridor path into the stretches that lie on the sheet, and the seam rejoins between them.
 *
 * A path out of `searchCorridor` is a list of nodes, and two consecutive nodes are ordinarily joined by
 * material — a chord across a tile, or a step through a hinge. A **jump** is the exception: the two nodes
 * sit on the two lips of one cut and there is nothing between them in the plane at all, so laying a
 * polyline through the pair would draw copper across a hole. Hence the split: every piece is a run that
 * can be laid, and every hop between two pieces is a wire the builder solders once the sheet is folded.
 *
 * Bridges are NOT split on. A bridge is tape spanning a narrow opening — real copper, in the plane, whose
 * length is charged — so it stays inside its piece, which is why this asks `jumpHopBetween` rather than
 * merely looking for a `bridges` entry.
 *
 * `pieces` always has one more entry than `hops`, and never an entry before the first node or after the
 * last: a path with no jump in it comes back as itself.
 */
export function splitAtJumps(
  c: Corridor,
  path: string[],
): { pieces: string[][]; hops: { from: string; to: string; hop: CorridorBridge }[] } {
  const pieces: string[][] = [];
  const hops: { from: string; to: string; hop: CorridorBridge }[] = [];
  let piece: string[] = [];
  for (let k = 0; k < path.length; k++) {
    const key = path[k]!;
    if (k > 0) {
      const hop = jumpHopBetween(c, path[k - 1]!, key);
      if (hop) {
        hops.push({ from: path[k - 1]!, to: key, hop });
        pieces.push(piece);
        piece = [];
      }
    }
    piece.push(key);
  }
  pieces.push(piece);
  return { pieces, hops };
}

/** The lip directions to hang a routed jump's folded ribbon on, in the order its own two ends are given.
 *
 *  Which lip an end sits on is read off the geometry rather than off the corridor's bookkeeping: a jump
 *  node is a point on a lip nudged a millionth of its own distance toward the face centroid, so the lip it
 *  came from is the nearer of the pair's two by a wide margin. `dirA` belongs to `pa` and `dirB` to `pb`,
 *  whichever way round the search happened to traverse the hop. */
function lipDirsFor(adj: FoldAdjacency, pair: number, pa: Vec2, pb: Vec2): { dirA?: Vec2; dirB?: Vec2 } {
  const lp = adj.pairs[pair];
  if (!lp) return {};
  const dA = unit(sub(lp.lipA[1], lp.lipA[0]));
  const dB = unit(sub(lp.lipB[1], lp.lipB[0]));
  const onA = ptSegDist(pa, lp.lipA[0], lp.lipA[1]) <= ptSegDist(pa, lp.lipB[0], lp.lipB[1]);
  void pb;
  return onA ? { dirA: dA, dirB: dB } : { dirA: dB, dirB: dA };
}

/**
 * Lay a whole corridor path as copper, cutting it at every seam rejoin it takes.
 *
 * The ordinary case is one leg and is bit-identical to calling {@link layLeg} directly: with no adjacency,
 * or with a path that takes no jump, this builds the same single {@link Trace2D} the router built before
 * jumps existed and returns no jumps at all.
 *
 * Where the path does cross a seam, each piece is laid on its own and **every piece has to pass**: one
 * refused piece fails the whole leg, exactly as one refused leg fails a tree edge today, and for the same
 * reason — half a connection is not a connection, and copper laid for it would be a stub going nowhere.
 * The failure is reported in {@link layLeg}'s own shape so the caller needs no second branch.
 *
 * A piece ends *at* the lip node, which is the centre of the land `manual-jump.ts › jumpLandTraces` puts
 * there. The land itself is not laid here: it belongs to the jump, not to the leg, and the caller adds one
 * per end so that a jump drawn by the author and a jump found by the router put down the same copper.
 */
export function layPath(
  c: Corridor,
  a: Vec2, b: Vec2, mid: Vec2[],
  padWidthA: number | undefined, padWidthB: number | undefined,
  r: LegRules,
  /** Which cuts the folded artifact rejoins, or `null` for a router that does not jump. */
  adjacency: FoldAdjacency | null = null,
): { ok: true; traces: Trace2D[]; jumps: Jump[] } | { ok: false; cuts: string | null } {
  const laid = (leg: { pts: Vec2[]; widths?: number[] }): Trace2D =>
    ({ net: r.netId, pts: leg.pts, ...(leg.widths ? { widths: leg.widths } : {}) });

  const split = adjacency?.pairs.length ? splitAtJumps(c, mid.map(ptKey)) : null;
  if (!adjacency || !split || !split.hops.length) {
    const leg = layLeg(a, b, mid, padWidthA, padWidthB, r);
    return leg.ok ? { ok: true, traces: [laid(leg)], jumps: [] } : leg;
  }

  // The pieces are consecutive stretches of `mid`, so they are recovered by walking it rather than by
  // looking every key back up in `c.point` — one fewer place for a key and a point to disagree.
  let at = 0;
  const runs: Vec2[][] = split.pieces.map((p) => {
    const seg = mid.slice(at, at + p.length);
    at += p.length;
    return seg;
  });

  const traces: Trace2D[] = [];
  for (let i = 0; i < runs.length; i++) {
    const nodes = runs[i]!;
    const first = i === 0, last = i === runs.length - 1;
    const from = first ? a : nodes[0]!;
    const to = last ? b : nodes[nodes.length - 1]!;
    const inner = nodes.slice(first ? 0 : 1, last ? nodes.length : nodes.length - 1);
    // Two jumps meeting at one land: the piece between them is a single node, so there is no copper to
    // lay and nothing to check. It is a real path — the folded artifact rejoins two cuts at one point —
    // and skipping it is the honest reading rather than laying a zero-length run.
    if (!inner.length && Math.hypot(to.x - from.x, to.y - from.y) < 1e-12) continue;
    const leg = layLeg(from, to, inner, first ? padWidthA : undefined, last ? padWidthB : undefined, r);
    if (!leg.ok) return leg;
    traces.push(laid(leg));
  }

  const jumps: Jump[] = split.hops.map((h, k) => {
    const pa = runs[k]![runs[k]!.length - 1]!, pb = runs[k + 1]![0]!;
    const pair = h.hop.pair ?? -1;
    return { a: pa, b: pb, net: r.netId, pair, source: "routed", ...lipDirsFor(adjacency, pair, pa, pb) };
  });
  return { ok: true, traces, jumps };
}
