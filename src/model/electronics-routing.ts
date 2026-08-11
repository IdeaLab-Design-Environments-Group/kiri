/**
 * **Model** — the auto-router/planner for the LED electronics tool. Pure: it takes
 * a flat FKLD/FOLD pattern + a {@link Circuit} and returns the routed copper traces
 * ({@link RoutedCircuit}), all in flat millimetres.
 *
 * Two nets only — **PWR** and **GND**. Each LED bridges a gap: one leg on face `a` (the `pwr`
 * side), the other on face `b` (the `gnd` side); copper terminates on the gray tile at the LED's
 * pinched leg pad.
 *
 * **Corner-hugging bus routing (LED keep-out).** Routes run on the {@link cornerRouteGraph}: copper
 * waypoints inset onto each gray tile near its corners, linked around every tile and crossing each
 * hinge **at its corner ends**. So the bus (a) stays strictly inside the body, (b) crosses every gap at
 * its *ends*, leaving the hinge midpoint — where the LED body and legs sit — clear. **One** shortest-path
 * tree is grown from the battery and both nets ride it (PWR to one leg of each LED, GND to the other), so
 * branches share common trunks and the two rails sit at ±`off` about one common centreline.
 *
 * Crossings between the two nets are electrically free (the tape's underside is insulated), so they are a
 * legibility cost rather than a constraint — but a real one, and the router searches per-LED polarity and
 * per-net approach to reduce them. The enforced rules are the LED keep-out and staying on the gray.
 *
 * **Each trace is one continuous strip of tape, and there are as few as possible.** Copper tape bends,
 * so a strip runs *through* a junction — only the other branches there need a fresh piece laid over it,
 * and a strip ends only on a leg pad. Every strip is one {@link Trace2D}, with the leg stub as its last
 * segment rather than a separate trace. Breaking at every junction instead turns one continuous run into
 * a pile of short pieces to lay end to end (20 strips instead of 12 on the bundled house). A strip is
 * never carried into a branch that would fold it back across its own tape. Strips are **straightened**
 * inside each tile (a greedy
 * line-of-sight pull bounded by the tile's pinched ring, so copper never strays onto the cloth or over
 * a gap opening) and **offset as whole polylines** with mitered joins, so consecutive segments share
 * exact endpoints. Junctions carry a normal keyed on the incoming edge, so a branch leaves its parent
 * at precisely the point the parent ended. Offsetting per *segment* — the old behaviour — staggered
 * every bend by up to twice the rail offset and made the tape look broken.
 */
import {
  type Circuit,
  type CornerRouteGraph,
  type FlatFace,
  type GapEdge,
  type GapGraph,
  type Led,
  type RoutedCircuit,
  type TilePoly,
  type Trace2D,
  type Vec2,
  boundsDiagonal,
  cornerRouteGraph,
  dist2,
  flatFaces,
  gapForLed,
  gapGraph,
  segInsidePolygon,
  segsProperlyIntersect,
  tapeWidthForDiag,
  tilePolys,
} from "./electronics.js";
import type { FoldFile } from "./fold-file.js";

/** One placed LED resolved to its gap + the two tiles/legs its copper must reach. */
interface PlacedLed {
  index: number; // index into circuit.leds (for unreachable reporting)
  gap: GapEdge;
  /** Face carrying the `pwr` leg, and its leg pad (flat mm). */
  aFace: number;
  aLeg: Vec2;
  /** Face carrying the `gnd` leg, and its leg pad (flat mm). */
  bFace: number;
  bLeg: Vec2;
}

/** Resolve each authored LED to its gap; LEDs whose gap no longer exists are reported unreachable. */
function placeLeds(graph: GapGraph, leds: Led[], faceCount: number, unreachable: number[]): PlacedLed[] {
  const placed: PlacedLed[] = [];
  leds.forEach((led, index) => {
    const inRange = led.a >= 0 && led.a < faceCount && led.b >= 0 && led.b < faceCount;
    const gap = inRange ? gapForLed(graph.gaps, led) : null;
    if (!gap) {
      unreachable.push(index);
      return;
    }
    // Orient: leg `a` follows the LED's own `a` face so the +/− assignment stays stable.
    const aIsFaceA = gap.faceA === led.a;
    placed.push({
      index,
      gap,
      aFace: led.a,
      aLeg: aIsFaceA ? gap.legA : gap.legB,
      bFace: led.b,
      bLeg: aIsFaceA ? gap.legB : gap.legA,
    });
  });
  return placed;
}

/**
 * Plan the copper routes for `circuit` over the flat pattern in `fold`.
 *
 * Two things about each LED are the router's to choose, not the author's, and both are searched (see
 * {@link searchDecisions}):
 *
 * - **Which leg carries PWR.** A `Led` records only *which two tiles* it bridges, and `ledOf` normalises
 *   the pair to `a < b`, so the polarity falling out of it is an artefact of face numbering. Reversing an
 *   LED is free in the build — mount it the other way round.
 * - **Which waypoint each net arrives through.** Either the hinge's own dent node, or around one of its
 *   end corners.
 *
 * The second is the one that matters, because the first cannot fix the common case on its own. Both nets
 * ride one shared shortest-path tree, so they enter a tile through the same corner; where that makes both
 * pads of a hinge sit on the same side of the rail pair, one net has to cross the other, and reversing the
 * LED merely swaps which one does. Coming round the *other* corner enters the tile with the opposite
 * rotational sense, which is the only way to change the side. (Measured on house.fkld: the best result over
 * all 2⁶ polarity assignments is 3 crossings; adding the approach choice reaches 2.)
 */
export function planRoutes(fold: FoldFile, circuit: Circuit): RoutedCircuit {
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces);

  const ledPoints = circuit.leds.map((led) => {
    const gap = gapForLed(gaps.gaps, led);
    return gap ? gap.point : { x: 0, y: 0 };
  });
  const batteryFace = circuit.battery && circuit.battery.face >= 0 && circuit.battery.face < faces.length
    ? circuit.battery.face
    : null;
  const batteryPoint = batteryFace != null ? faces[batteryFace]?.centroid ?? { x: 0, y: 0 } : null;

  const unreachable: number[] = [];
  const placed = placeLeds(gaps, circuit.leds, faces.length, unreachable);
  if (batteryFace == null || placed.length === 0) {
    const seed = placed.map(() => SEED_DECISION);
    return {
      ledPoints,
      ledPads: padsForLeds(circuit.leds.length, placed, seed),
      batteryPoint,
      terminals: null,
      traces: [],
      unreachable,
    };
  }

  const ctx = buildCtx(fold, faces, gaps, batteryFace, batteryPoint!, placed, unreachable);
  const dec = searchDecisions(ctx);
  return {
    ledPoints,
    ledPads: padsForLeds(circuit.leds.length, placed, dec),
    batteryPoint,
    terminals: ctx.terminals,
    traces: emitAll(ctx, dec),
    unreachable,
  };
}

/** Everything invariant across the crossing search: geometry, the one shared tree, and the terminals. */
interface RouteCtx {
  graph: CornerRouteGraph;
  tiles: TilePoly[];
  /** The virtual battery node, already spliced into `graph`. */
  battery: number;
  terminals: { pwr: Vec2; gnd: Vec2 };
  dj: Dijkstra;
  faceOf: number[];
  off: number;
  /** One slot per gap-having LED, aligned with `placed`. */
  slots: Slot[];
  paths: PathCache;
}

/** One LED's routing options: the pads, and the ring nodes each net may arrive through. */
interface Slot {
  led: PlacedLed;
  /** False when a leg's tile is cut off from the battery — reported unreachable, never emitted. */
  routable: boolean;
  a: Approach;
  b: Approach;
}

/** The ways copper can arrive at one leg pad, and the pad itself. */
interface Approach {
  /** Ring nodes on the pad's own tile: `[dent, cornerStart, cornerEnd]`, deduped. */
  nodes: number[];
  pad: Vec2;
}

type PathCache = Map<string, number[] | null>;

/**
 * Build everything the search holds still: the flat geometry, the route graph with the battery spliced
 * in, the single shortest-path tree, and the battery terminals.
 *
 * This used to be rebuilt from scratch for every candidate the polarity search tried — `flatFaces`,
 * `gapGraph`, `cornerRouteGraph`, `tilePolys` *and* `dijkstra`, N+1 times per plan. Hoisting it is what
 * makes a real search affordable, and the router runs twice per state change (once for the preview, once
 * for the SVG export), so the saving lands twice.
 *
 * The terminals belong here because they are search-invariant: `batteryTerminals` averages
 * `(aLeg + bLeg)/2` over the placed LEDs, which is symmetric in the two legs and blind to the approach
 * nodes. So the PWR/GND sides — and with them the `±off` rail convention — are fixed before the search
 * starts and cannot be perturbed by it.
 */
function buildCtx(
  fold: FoldFile,
  faces: FlatFace[],
  gaps: GapGraph,
  batteryFace: number,
  batteryPoint: Vec2,
  placed: PlacedLed[],
  unreachable: number[],
): RouteCtx {
  const graph = cornerRouteGraph(fold, faces);
  // The real gray tiles — the containment polygons the straightener pulls chords against.
  const tiles = tilePolys(fold, faces);
  // Scale reference for the rail offset. Taken from the flat faces (not the inset route graph) so it
  // matches the diagonal the modal and the SVG export derive the tape width from.
  const diag = boundsDiagonal(faces.flatMap((f) => f.poly));

  // A virtual battery source wired to **every** waypoint on its own tile's ring — corners *and* edge
  // midpoints. Tile-to-tile hops still happen only at shared corners, but the battery sits on this tile
  // already, and a pinched ring is star-shaped about its centroid, so a straight run from the pack to
  // any of its own ring nodes stays on the gray.
  //
  // Linking only the corners (as this did) forced a detour whenever the waypoint nearest a pad was an
  // edge midpoint of the battery's own tile: the route went out to a corner and doubled back, sweeping
  // across the other net's lead. On house.fkld that turned a 0.238 straight run into a 0.727 path and
  // produced the criss-cross beside the battery.
  const battery = graph.pos.length;
  graph.pos.push(batteryPoint);
  graph.adj.push([]);
  for (const rn of graph.ringNodes[batteryFace] ?? []) {
    const w = dist2(batteryPoint, graph.pos[rn]!);
    graph.adj[battery]!.push({ to: rn, w });
    graph.adj[rn]!.push({ to: battery, w });
  }

  const dj = dijkstra(graph, battery);
  const slots: Slot[] = placed.map((led) => {
    const a = approachFor(graph, faces, tiles, led.gap, led.aFace, led.aLeg, dj);
    const b = approachFor(graph, faces, tiles, led.gap, led.bFace, led.bLeg, dj);
    const routable = a.nodes.length > 0 && b.nodes.length > 0;
    if (!routable) unreachable.push(led.index); // a leg tile is cut off from the battery within the body
    return { led, routable, a, b };
  });

  return {
    graph,
    tiles,
    battery,
    terminals: batteryTerminals(batteryPoint, placed, graph, batteryFace, diag),
    dj,
    faceOf: faceOfNode(graph),
    off: railOffsetFor(diag),
    slots,
    paths: new Map(),
  };
}

/**
 * The ring nodes through which copper may arrive at one leg pad: the hinge's own **dent** node, or around
 * either of its two **end corners**.
 *
 * This is the lever that removes crossings. A face's ring is `[corner(v0), mid(v0,v1), corner(v1), …]`
 * (see `cornerRouteGraph`), and tiles are joined *only* at those corners — so targeting a corner instead
 * of the dent makes the shared tree enter this tile having come round the other end of the hinge, i.e.
 * with the opposite rotational sense. That sense is what decides which side of the rail pair each pad
 * ends up on, and it is the one thing LED polarity cannot change: where both pads are entered in the
 * same sense, one net must cross the other whichever way the LED is turned round.
 *
 * Candidates are located by matching `gap.verts` against the face's vertex list, so they are index-derived
 * — no distances, hence nothing for a change of model scale to perturb. Falls back to the nearest
 * reachable ring node (the old behaviour) if the hinge isn't found in this face, and returns no nodes at
 * all when the tile is cut off from the battery.
 */
function approachFor(
  graph: CornerRouteGraph,
  faces: FlatFace[],
  tiles: TilePoly[],
  gap: GapEdge,
  face: number,
  pad: Vec2,
  dj: Dijkstra,
): Approach {
  const ring = graph.ringNodes[face] ?? [];
  const verts = faces[face]?.verts ?? [];
  const reachable = (n: number): boolean => dj.dist[n] !== Infinity;
  const nodes: number[] = [];
  const push = (n: number | undefined): void => {
    if (n != null && reachable(n) && !nodes.includes(n)) nodes.push(n);
  };
  // An alternative approach is only worth offering if its stub to the pad stays on the gray. A corner
  // sits further round the tile than the dent does, so its stub is longer and can cut the corner across
  // the gap opening — which would trade a crossing for copper hanging off the tile. Same 90 % test
  // `straightenTail` uses, and for the same reason: the pad itself is the ring's dent tip, so the last
  // stretch necessarily touches the boundary.
  const stubStaysOnTile = (n: number | undefined): boolean => {
    if (n == null) return false;
    const ringPoly = tileRing(tiles, face);
    if (ringPoly.length < 3) return true; // no tile to test against — leave it to the router
    const a = graph.pos[n]!;
    const near = { x: a.x + (pad.x - a.x) * 0.9, y: a.y + (pad.y - a.y) * 0.9 };
    return segInsidePolygon(a, near, ringPoly);
  };

  const n = verts.length;
  for (let k = 0; k < n; k++) {
    const va = verts[k]!, vb = verts[(k + 1) % n]!;
    const hit = (va === gap.verts[0] && vb === gap.verts[1]) || (va === gap.verts[1] && vb === gap.verts[0]);
    if (!hit) continue;
    push(ring[2 * k + 1]); // the dent — today's only option, always offered so the seed is unchanged
    for (const corner of [ring[2 * k], ring[(2 * k + 2) % ring.length]]) {
      if (stubStaysOnTile(corner)) push(corner);
    }
    break;
  }
  if (nodes.length === 0) {
    // Degenerate face, or the hinge isn't one of its edges: fall back to nearest-reachable, as before.
    let best: number | null = null, bestD = Infinity;
    for (const r of ring) {
      if (!reachable(r)) continue;
      const d = dist2(graph.pos[r]!, pad);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best != null) nodes.push(best);
  }
  return { nodes, pad };
}

/** Per-LED routing choice: which leg carries PWR, and which approach each net uses. */
interface Decision {
  /** Reverse the LED — mount it the other way round, so the `b` leg carries PWR. */
  rev: boolean;
  /** Index into the `a`-leg approach's `nodes`. */
  iA: number;
  /** Index into the `b`-leg approach's `nodes`. */
  iB: number;
}

/** Today's behaviour: authored polarity, arriving through the hinge's own dent node. */
const SEED_DECISION: Decision = { rev: false, iA: 0, iB: 0 };

/**
 * Each LED's pads as the router assigned them, index-aligned with `circuit.leds` (zeroes for an LED whose
 * gap no longer exists). Derived from the same `PlacedLed` + `Decision` the copper was emitted from, so
 * the drawn `+`/`−` cannot drift from where the tape actually lands.
 */
function padsForLeds(
  ledCount: number,
  placed: PlacedLed[],
  dec: Decision[],
): { pwr: Vec2; gnd: Vec2 }[] {
  const pads = Array.from({ length: ledCount }, () => ({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } }));
  placed.forEach((p, s) => {
    pads[p.index] = (dec[s] ?? SEED_DECISION).rev
      ? { pwr: p.bLeg, gnd: p.aLeg }
      : { pwr: p.aLeg, gnd: p.bLeg };
  });
  return pads;
}

/** Emit both nets for one decision vector. */
function emitAll(ctx: RouteCtx, dec: Decision[]): Trace2D[] {
  const traces: Trace2D[] = [];
  const pwrPaths: number[][] = [], pwrPads: Vec2[] = [];
  const gndPaths: number[][] = [], gndPads: Vec2[] = [];
  ctx.slots.forEach((slot, s) => {
    if (!slot.routable) return;
    const d = dec[s] ?? SEED_DECISION;
    // `rev` swaps which net serves which leg; the approach indices stay attached to their own leg.
    const forPwr = d.rev ? slot.b : slot.a;
    const forGnd = d.rev ? slot.a : slot.b;
    const iPwr = d.rev ? d.iB : d.iA;
    const iGnd = d.rev ? d.iA : d.iB;
    const pPath = straightPath(ctx, forPwr.nodes[iPwr % forPwr.nodes.length]!, forPwr.pad);
    const gPath = straightPath(ctx, forGnd.nodes[iGnd % forGnd.nodes.length]!, forGnd.pad);
    if (pPath) { pwrPaths.push(pPath); pwrPads.push(forPwr.pad); }
    if (gPath) { gndPaths.push(gPath); gndPads.push(forGnd.pad); }
  });
  emitFromPaths(ctx, pwrPaths, pwrPads, ctx.terminals.pwr, "pwr", +ctx.off, traces);
  emitFromPaths(ctx, gndPaths, gndPads, ctx.terminals.gnd, "gnd", -ctx.off, traces);
  return traces;
}

/**
 * How many times the PWR tape crosses the GND tape — the cost the search minimises.
 *
 * `cap` lets a candidate abort as soon as it can no longer beat the incumbent, and a bounding-box reject
 * skips the exact test for the overwhelming majority of segment pairs. Same shape as `overlapsFor`'s
 * bound in the unfolder's descent.
 */
function countNetCrossings(traces: Trace2D[], cap = Infinity): number {
  const segs = (net: "pwr" | "gnd"): { a: Vec2; b: Vec2; lo: Vec2; hi: Vec2 }[] => {
    const out: { a: Vec2; b: Vec2; lo: Vec2; hi: Vec2 }[] = [];
    for (const t of traces) {
      if (t.net !== net) continue;
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1]!, b = t.points[i]!;
        out.push({
          a, b,
          lo: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
          hi: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
        });
      }
    }
    return out;
  };
  const pwr = segs("pwr"), gnd = segs("gnd");
  let n = 0;
  for (const p of pwr) {
    for (const g of gnd) {
      if (p.hi.x < g.lo.x || g.hi.x < p.lo.x || p.hi.y < g.lo.y || g.hi.y < p.lo.y) continue;
      if (segsProperlyIntersect(p.a, p.b, g.a, g.b)) {
        n++;
        if (n >= cap) return n;
      }
    }
  }
  return n;
}

/** Total polyline length over all traces — the last tie-break, so an escape stays as cheap as it can. */
function totalLength(traces: Trace2D[]): number {
  let l = 0;
  for (const t of traces) {
    for (let i = 1; i < t.points.length; i++) {
      l += Math.hypot(t.points[i]!.x - t.points[i - 1]!.x, t.points[i]!.y - t.points[i - 1]!.y);
    }
  }
  return l;
}

/** Per-plan search budget. The router runs on every edit *and* again for the SVG export, so it is bounded
 *  rather than run to a fixed point. */
const MAX_SWEEPS = 6;
const MAX_EVALS = 128;

/**
 * Choose each LED's polarity and each net's approach so the two nets cross as little as possible.
 *
 * Best-improvement strict descent: evaluate every move in the neighbourhood, apply the single best, repeat.
 * A move is accepted **only** if it strictly reduces the crossing count; ties among accepted moves prefer
 * fewer strips, then less copper. That acceptance rule is what makes this safe to add — on a circuit that
 * already has no crossings nothing is ever accepted, so the emitted geometry is bit-identical to not
 * searching at all, and the strip-economy and straightness work cannot regress.
 *
 * After the first sweep only LEDs *incident to a surviving crossing* are reconsidered: an LED that is not
 * in one cannot remove one. That collapses the neighbourhood from every LED to a handful and is the main
 * reason the search fits inside the per-edit budget.
 */
function searchDecisions(ctx: RouteCtx): Decision[] {
  const dec: Decision[] = ctx.slots.map(() => ({ ...SEED_DECISION }));
  const routable = ctx.slots.flatMap((s, i) => (s.routable ? [i] : []));
  if (routable.length === 0) return dec;

  let bestCross = countNetCrossings(emitAll(ctx, dec));
  let evals = 1;

  // **First**-improvement, sweeping LEDs in order and keeping each win as it is found — the direct
  // generalisation of the reversal-only search this replaces, which was exactly this loop over a
  // one-move neighbourhood. Best-improvement was tried and is badly budget-inefficient here: it scans the
  // whole neighbourhood (~17 moves × every LED) before committing a single change, so under a per-edit
  // budget it lands *fewer* improvements than the old search did and can finish worse than its own seed.
  for (let sweep = 0; sweep < MAX_SWEEPS && bestCross > 0 && evals < MAX_EVALS; sweep++) {
    let improved = false;
    for (const slot of routable) {
      if (evals >= MAX_EVALS) break;
      for (const move of movesFor(ctx.slots[slot]!, dec[slot]!)) {
        if (evals >= MAX_EVALS) break;
        const saved = dec[slot]!;
        dec[slot] = move;
        const traces = emitAll(ctx, dec);
        evals++;
        const cross = countNetCrossings(traces, bestCross);
        if (cross < bestCross) { // strict descent — never accept a sideways move
          bestCross = cross;
          improved = true;
          break; // keep it: `dec[slot]` already holds `move`
        }
        dec[slot] = saved;
      }
    }
    if (!improved) break; // local optimum
  }
  return dec;
}

/**
 * Every alternative decision for one LED: the full `{rev} × {approach} × {approach}` product — but
 * **reversal first**.
 *
 * Order matters because the search runs on a budget. Reversing the LED is the cheap, long-standing lever
 * and often enough on its own; trying it before the approach changes means a tight budget still captures
 * everything the old reversal-only search captured, and spends whatever is left on the approach escapes
 * that reversal cannot express. With the approaches tried first, a small budget got *worse* results than
 * reversal alone — measured, on church and akde-hex.
 */
function movesFor(slot: Slot, cur: Decision): Decision[] {
  const out: Decision[] = [];
  const add = (rev: boolean, iA: number, iB: number): void => {
    if (rev === cur.rev && iA === cur.iA && iB === cur.iB) return;
    out.push({ rev, iA, iB });
  };
  add(!cur.rev, cur.iA, cur.iB); // the old lever, on its own
  for (const rev of [cur.rev, !cur.rev]) {
    for (let iA = 0; iA < slot.a.nodes.length; iA++) {
      for (let iB = 0; iB < slot.b.nodes.length; iB++) add(rev, iA, iB);
    }
  }
  return out;
}

/**
 * The battery's two terminal pads: offset to either side of the battery centre, perpendicular to the
 * direction the wiring heads (toward the LEDs), so PWR (+) and GND (−) leave from distinct squares.
 */
function batteryTerminals(
  batteryCentre: Vec2,
  placed: PlacedLed[],
  graph: CornerRouteGraph,
  batteryFace: number,
  diag: number,
): { pwr: Vec2; gnd: Vec2 } {
  // Mean LED leg direction → the "out" direction; the terminals straddle its perpendicular.
  let mx = 0, my = 0;
  for (const p of placed) { mx += (p.aLeg.x + p.bLeg.x) / 2; my += (p.aLeg.y + p.bLeg.y) / 2; }
  mx = mx / placed.length - batteryCentre.x;
  my = my / placed.length - batteryCentre.y;
  let ax = -my, ay = mx; // perpendicular to the out-direction
  const al = Math.hypot(ax, ay);
  if (al < 1e-6) { ax = 1; ay = 0; } else { ax /= al; ay /= al; }
  // `ax,ay` is the left normal of the out-direction, which is exactly the side the PWR rail is offset
  // to (PWR = +off along the left normal of travel). Keeping the PWR terminal on that side means the
  // two leads leave the pack already in their rail order and never have to swap over each other.
  // (Assigning terminals by which side each net's own legs lie on instead — tried and measured — put
  // PWR on the wrong side of the outgoing trunk and *added* two crossings.)
  // Pad separation is a *layout* distance, not the rail spacing: big enough to read as two distinct
  // squares at any model size, then clamped so both pads stay well inside the battery tile.
  let half = Math.max(tapeWidthForDiag(diag) * 1.5, diag * 0.02);
  let rMin = Infinity;
  for (const cn of graph.cornerNodes[batteryFace] ?? []) {
    const d = dist2(batteryCentre, graph.pos[cn]!);
    if (d < rMin) rMin = d;
  }
  if (Number.isFinite(rMin)) half = Math.min(half, rMin * 0.35);
  return {
    pwr: { x: batteryCentre.x + ax * half, y: batteryCentre.y + ay * half },
    gnd: { x: batteryCentre.x - ax * half, y: batteryCentre.y - ay * half },
  };
}

/**
 * Lateral offset separating the PWR and GND strips: **a fixed fraction of the drawn tape width**, so
 * their centrelines sit `2 × 0.55 = 1.1` tape-widths apart — adjacent, with a hairline seam, and never
 * overlapping — at every model scale.
 *
 * The old `diag * 0.006` was not tied to the tape at all, so the ratio of gap to tape width drifted
 * with the pattern; on the test fixture it worked out to 0.72 against a tape drawn ~1.9 wide, and since
 * each segment was offset independently that became a visible break at every bend.
 */
function railOffsetFor(diag: number): number {
  return tapeWidthForDiag(diag) * 0.55;
}

/** One branch of the emitted geometry: a contiguous point run, flagged if it ends on an LED leg pad. */
interface Chain {
  points: Vec2[];
  endsOnPad: boolean;
}

/**
 * The straightened **node** path from the battery to `node`, string-pulled toward `pad`.
 *
 * Net-independent — both nets walk the same shared tree — so it is computed at most once per
 * `(node, pad)` pair and reused across every candidate the search tries. Node ids, not points: the
 * virtual battery node has to resolve to each net's *own* terminal anchor at emit time.
 */
function straightPath(ctx: RouteCtx, node: number, pad: Vec2): number[] | null {
  const key = `${node}|${ptKey(pad)}`;
  const hit = ctx.paths.get(key);
  if (hit !== undefined) return hit;
  const nodes = pathFromBattery(ctx.dj, ctx.battery, node);
  const out = nodes
    ? straightenTail(
        straightenChain(nodes, ctx.graph, ctx.faceOf, ctx.tiles),
        pad, ctx.graph, ctx.faceOf, ctx.tiles,
      )
    : null;
  ctx.paths.set(key, out);
  return out;
}

/**
 * Emit a net as continuous mitered polylines.
 *
 * **Straighten whole battery→pad paths first, then merge them into chains by common prefix** — never
 * the other way round. Both nets grow from one shared Dijkstra tree, so two paths that run down the same
 * corridor share a node prefix; straightening each path from the battery makes the greedy pull take
 * identical decisions over that prefix, so the resulting centrelines are *identical* rather than merely
 * similar. PWR and GND then sit at ±`off` about one common centreline and stay parallel.
 *
 * Straightening per *chain* instead (as this first did) let the two nets chop the same corridor at
 * different junctions, so each pulled it to a slightly different chord — the rails wove across each
 * other and visibly swapped sides several times along one run.
 */
function emitFromPaths(
  ctx: RouteCtx,
  nodePaths: number[][],
  pads: Vec2[],
  anchor: Vec2,
  net: "pwr" | "gnd",
  off: number,
  traces: Trace2D[],
): void {
  if (nodePaths.length === 0) return;
  // The shared virtual battery node materialises at *this* net's own terminal pad.
  const posOf = (node: number): Vec2 => (node === ctx.battery ? anchor : ctx.graph.pos[node]!);

  const paths: Vec2[][] = nodePaths.map((nodes, i) => {
    const pts = nodes.map(posOf);
    pts.push(pads[i]!); // the leg stub is the path's last segment, not a separate trace
    return pts;
  });

  const chains = chainsFromPaths(paths);

  // Every point a strip runs *through* publishes the normal of the segment arriving there. A branch
  // that starts at such a point adopts it, so the branch leaves its parent exactly where the parent's
  // edge is rather than a rail-width off it.
  const normalAt = new Map<string, Vec2>();
  for (const c of chains) {
    for (let i = 1; i < c.points.length; i++) {
      const n = leftNormal(c.points[i - 1]!, c.points[i]!);
      if (n) normalAt.set(ptKey(c.points[i]!), n);
    }
  }

  for (const c of chains) {
    const startsAtAnchor = Math.hypot(c.points[0]!.x - anchor.x, c.points[0]!.y - anchor.y) < 1e-9;
    const startNormal = startsAtAnchor ? null : normalAt.get(ptKey(c.points[0]!)) ?? null;
    const points = offsetPolyline(c.points, off, {
      startNormal,
      taperStart: startsAtAnchor,
      taperEnd: c.endsOnPad,
    });
    if (points.length >= 2) traces.push({ net, points });
  }
}

/** The node path battery→`target` along the shortest-path tree, or null if it isn't wired up. */
function pathFromBattery(dj: Dijkstra, battery: number, target: number): number[] | null {
  const back: number[] = [];
  let cur = target;
  while (cur !== battery) {
    back.push(cur);
    const prev = dj.prev[cur]!;
    if (prev === -1) return null; // reachNode already filters these, but stay defensive
    cur = prev;
  }
  back.push(battery);
  return back.reverse();
}

/** Stable key for point identity — paths sharing a prefix produce bit-identical coordinates. */
function ptKey(p: Vec2): string {
  return `${p.x},${p.y}`;
}

/**
 * Merge the straightened paths into as few strips as possible.
 *
 * Copper tape bends, so one strip can carry straight on through a junction — only the *other* branches
 * need a new piece laid over it. At each junction the strip therefore continues into whichever child
 * best keeps its heading, and the remaining children start their own strips. Breaking every strip at
 * every junction (as this first did) chopped a single continuous run into a pile of short pieces that
 * had to be laid end to end.
 *
 * A shared trunk is still emitted once, so no tape is doubled.
 */
/** Would extending `points` to `next` make the strip cross a part of itself already laid? */
function crossesOwn(points: Vec2[], next: Vec2): boolean {
  const from = points[points.length - 1]!;
  // Skip the immediately preceding segment: it shares an endpoint, which is a touch, not a crossing.
  for (let i = 1; i < points.length - 1; i++) {
    if (segsProperlyIntersect(from, next, points[i - 1]!, points[i]!)) return true;
  }
  return false;
}

function chainsFromPaths(paths: Vec2[][]): Chain[] {
  interface Branch { pt: Vec2; kids: Map<string, Branch>; isLeaf: boolean }
  const root: Branch = { pt: paths[0]![0]!, kids: new Map(), isLeaf: false };
  for (const path of paths) {
    let node = root;
    for (let i = 1; i < path.length; i++) {
      const p = path[i]!;
      const k = ptKey(p);
      let kid = node.kids.get(k);
      if (!kid) {
        kid = { pt: p, kids: new Map(), isLeaf: false };
        node.kids.set(k, kid);
      }
      node = kid;
    }
    node.isLeaf = true; // the LED leg pad
  }

  const chains: Chain[] = [];
  const stack: Branch[] = [root];
  while (stack.length > 0) {
    let node = stack.pop()!;
    const points = [node.pt];
    for (;;) {
      const kids = [...node.kids.values()];
      if (kids.length === 0) break;
      // Keep going in the straightest direction; hand the rest off as their own strips.
      // With a single continuation there is no choice — it is the same run, so carry on.
      // At a junction, prefer the straightest branch, but never one that would fold the strip back
      // across itself: a strip that crosses its own tape is wasted copper, so start a new piece instead.
      let go = 0;
      if (kids.length > 1) {
        const inDir = points.length >= 2 ? leftNormal(points[points.length - 2]!, node.pt) : null;
        // `leftNormal` is the perpendicular, so comparing perpendiculars compares headings.
        const ranked = kids
          .map((k, i) => {
            const d = leftNormal(node.pt, k.pt);
            const dot = inDir && d ? d.x * inDir.x + d.y * inDir.y : 0;
            return { i, dot };
          })
          .sort((a, b) => b.dot - a.dot);
        const pick = ranked.find((r) => !crossesOwn(points, kids[r.i]!.pt));
        if (!pick) {
          for (const k of kids) {
            stack.push({ pt: node.pt, kids: new Map([[ptKey(k.pt), k]]), isLeaf: false });
          }
          break;
        }
        go = pick.i;
      }
      kids.forEach((k, i) => {
        if (i !== go) stack.push({ pt: node.pt, kids: new Map([[ptKey(k.pt), k]]), isLeaf: false });
      });
      node = kids[go]!;
      points.push(node.pt);
    }
    if (points.length >= 2) chains.push({ points, endsOnPad: node.isLeaf });
  }
  return chains;
}

/** Which face each route node belongs to (`-1` for the virtual battery node). */
function faceOfNode(graph: CornerRouteGraph): number[] {
  const faceOf = new Array<number>(graph.pos.length).fill(-1);
  for (let f = 0; f < graph.ringNodes.length; f++) {
    for (const n of graph.ringNodes[f] ?? []) faceOf[n] = f;
  }
  return faceOf;
}

/**
 * The gray tile a chord must stay on: the **pinched tile ring** ({@link tilePolys}), i.e. the real
 * material boundary, dented inward at every gap edge.
 *
 * Not the *inset* ring the waypoints sit on: `insetToward` pulls corners diagonally (clearance
 * `clear·cos45°`) but edge midpoints perpendicularly (clearance `clear`), so the inset ring bulges
 * inward along every straight edge. Testing against it would reject a chord running corner-to-corner
 * along an edge — which is perfectly on-material — and leave the zigzag in place. The tile ring still
 * carries the dents, so chords across a gap opening are rejected, and it still excludes the hinge
 * midpoint where the LED body sits (the dent tip *is* the leg pad).
 */
function tileRing(tiles: TilePoly[], face: number): Vec2[] {
  return tiles[face]?.ring ?? [];
}

/** Unit left normal of `a→b`, or null when the two coincide. */
function leftNormal(a: Vec2, b: Vec2): Vec2 | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return null;
  return { x: -dy / l, y: dx / l };
}

/**
 * Straighten a chain by string-pulling **within each tile**: a run of consecutive nodes on one face
 * collapses to the longest chords whose tape stays on that face's pinched ring. Tile-to-tile corner
 * hops are never shortcut, so copper still crosses each hinge exactly at a corner.
 *
 * Only vertices are removed, never moved, so a straightened route can never leave the body.
 */
function straightenChain(
  nodes: number[],
  graph: CornerRouteGraph,
  faceOf: number[],
  tiles: TilePoly[],
): number[] {
  if (nodes.length < 3) return nodes.slice();
  const out: number[] = [];
  let i = 0;
  while (i < nodes.length) {
    const f = faceOf[nodes[i]!] ?? -1;
    let j = i;
    while (j + 1 < nodes.length && (faceOf[nodes[j + 1]!] ?? -1) === f) j++;
    if (out.length === 0 || out[out.length - 1] !== nodes[i]) out.push(nodes[i]!);
    if (f < 0 || j === i) {
      for (let k = i + 1; k <= j; k++) out.push(nodes[k]!); // battery node / single-node run
    } else {
      const ring = tileRing(tiles, f);
      let k = i;
      while (k < j) {
        let t = j;
        // `t === k + 1` is an original graph edge — always legal, so this terminates.
        while (t > k + 1 && !chordOk(graph.pos[nodes[k]!]!, graph.pos[nodes[t]!]!, ring)) t--;
        out.push(nodes[t]!);
        k = t;
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * May a straight tape run join `a` to `b` across this tile? The test is the **centreline against the
 * inset ring**, which is the ring the route nodes themselves lie on.
 *
 * Deliberately *not* also testing the two offset rails: a ring node sits only
 * `clear·cos45° ≈ 0.79 mm` inside the tile boundary at a corner, which is less than `RAIL_OFFSET`, so
 * an offset rail pokes marginally outside near every corner — that is equally true of the
 * un-straightened ring-following route, which is offset the same way. Demanding strict rail
 * containment would therefore reject essentially every shortcut and leave the zigzag in place. The
 * inset itself is the margin that keeps tape on gray; what matters here is that a chord never crosses a
 * dent, and the dents are pulled inward by the full tile pinch (~2.7 mm on a 10 mm tile), far more than
 * the offset.
 */
function chordOk(a: Vec2, b: Vec2, ring: Vec2[]): boolean {
  return segInsidePolygon(a, b, ring);
}

/**
 * Pull the end of a chain straight toward its LED leg pad. The pad is a pinched *tile-ring* midpoint,
 * so it sits outside the inset ring the route nodes live on — testing all the way to it would always
 * fail. We therefore test only the first 90 % of the approach and let the last stretch cross the inset
 * boundary onto the pad, which is the one place copper is meant to touch the tile edge.
 */
function straightenTail(
  nodes: number[],
  pad: Vec2,
  graph: CornerRouteGraph,
  faceOf: number[],
  tiles: TilePoly[],
): number[] {
  if (nodes.length < 2) return nodes;
  const last = nodes[nodes.length - 1]!;
  const f = faceOf[last] ?? -1;
  if (f < 0) return nodes;
  const ring = tileRing(tiles, f);
  // Earliest node still on the pad's tile that can see the pad directly.
  let s = nodes.length - 1;
  while (s > 0 && (faceOf[nodes[s - 1]!] ?? -1) === f) s--;
  for (let t = s; t < nodes.length - 1; t++) {
    const a = graph.pos[nodes[t]!]!;
    const near = { x: a.x + (pad.x - a.x) * 0.9, y: a.y + (pad.y - a.y) * 0.9 };
    if (segInsidePolygon(a, near, ring)) return nodes.slice(0, t + 1);
  }
  return nodes;
}

interface OffsetOpts {
  /** Unit normal forced at the first point (a junction's published normal) — keeps branches joined. */
  startNormal?: Vec2 | null;
  /** Pin the offset to zero at the first point (the battery terminal pad). */
  taperStart?: boolean;
  /** Pin the offset to zero at the last point (the LED leg pad). */
  taperEnd?: boolean;
  /** Miter cap in units of `|off|`; beyond it the joint is bevelled instead of spiking. */
  miterLimit?: number;
}

/**
 * Offset a whole polyline sideways by the signed `off`, joining segments with **miters** so
 * consecutive offset segments share an exact endpoint (a bevel pair when the turn is too sharp).
 *
 * This is what makes the tape continuous. Offsetting each segment independently — the old
 * `offsetSeg` — gave every bend two different perpendiculars and split the joint by up to `2·off`.
 *
 * `off` is signed (`+` for PWR, `−` for GND) and the left normal flips with it, so the two nets land
 * on opposite sides of a shared run.
 */
function offsetPolyline(ptsIn: Vec2[], off: number, opts: OffsetOpts = {}): Vec2[] {
  const miterLimit = opts.miterLimit ?? 1.25;
  // Drop repeats first: a zero-length segment has no normal and would poison the joins.
  const pts: Vec2[] = [];
  for (const p of ptsIn) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-7) pts.push(p);
  }
  if (pts.length < 2) return pts;

  const m = pts.length - 1; // segment count
  const u: Vec2[] = [];
  const n: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    u.push({ x: (b.x - a.x) / l, y: (b.y - a.y) / l });
    n.push({ x: -(b.y - a.y) / l, y: (b.x - a.x) / l });
  }
  const at = (p: Vec2, nrm: Vec2, s: number): Vec2 => ({ x: p.x + nrm.x * s, y: p.y + nrm.y * s });
  const ramp = 2 * Math.abs(off);
  const firstLen = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
  const lastLen = Math.hypot(pts[m]!.x - pts[m - 1]!.x, pts[m]!.y - pts[m - 1]!.y);
  // With both ends tapered on a single segment there must be room for two ramps.
  const bothOnOneSeg = m === 1 && opts.taperStart === true && opts.taperEnd === true;
  const room = (len: number): boolean => len > (bothOnOneSeg ? 2 * ramp : ramp);

  const out: Vec2[] = [];
  const startNrm = opts.startNormal ?? n[0]!;
  if (opts.taperStart) {
    out.push(pts[0]!); // exactly on the pad
    if (room(firstLen)) out.push(at({ x: pts[0]!.x + u[0]!.x * ramp, y: pts[0]!.y + u[0]!.y * ramp }, startNrm, off));
  } else {
    out.push(at(pts[0]!, startNrm, off));
  }

  for (let i = 1; i < m; i++) {
    const nPrev = n[i - 1]!, nCur = n[i]!;
    const sx = nPrev.x + nCur.x, sy = nPrev.y + nCur.y;
    const sl = Math.hypot(sx, sy);
    if (sl < 1e-6) { // 180° hairpin — no meaningful miter
      out.push(at(pts[i]!, nCur, off));
      continue;
    }
    const mx = sx / sl, my = sy / sl;
    const c = mx * nCur.x + my * nCur.y; // cos(θ/2)
    const L = c > 1e-9 ? off / c : Infinity;
    // Which side of the turn is this rail on? The left normal points left, so offsetting by +off lands
    // on the inside of a left turn and the outside of a right turn.
    const turn = u[i - 1]!.x * u[i]!.y - u[i - 1]!.y * u[i]!.x;
    const inner = turn !== 0 && (turn > 0) === (off > 0);
    // On the INSIDE of a turn the two offset segments overlap, and their intersection is the correctly
    // trimmed corner — so always miter there, however sharp. Bevelling an inner corner instead emits a
    // point on each segment, which doubles back and makes the tape hook across itself. The miter limit
    // exists to stop a spike shooting off the *outside* of a sharp turn, so it only applies there.
    if (inner || Math.abs(L) <= miterLimit * Math.abs(off)) {
      // On a very tight inner corner `L` diverges (cos(θ/2) → 0); keep the joint from shooting past the
      // neighbouring vertices, which is as far as a trimmed corner can meaningfully reach.
      const segPrev = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      const segCur = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
      const cap = Math.max(Math.abs(off), Math.min(segPrev, segCur));
      const Lc = Math.sign(L) * Math.min(Math.abs(L), cap);
      out.push({ x: pts[i]!.x + mx * Lc, y: pts[i]!.y + my * Lc });
    } else {
      out.push(at(pts[i]!, nPrev, off)); // bevel: still contiguous, just chamfered
      out.push(at(pts[i]!, nCur, off));
    }
  }

  const nLast = n[m - 1]!;
  if (opts.taperEnd) {
    if (room(lastLen)) {
      out.push(at({ x: pts[m]!.x - u[m - 1]!.x * ramp, y: pts[m]!.y - u[m - 1]!.y * ramp }, nLast, off));
    }
    out.push(pts[m]!); // exactly on the pad
  } else {
    out.push(at(pts[m]!, nLast, off));
  }
  return out;
}

interface Dijkstra {
  dist: number[];
  prev: number[];
}

/** Single-source shortest paths over the route graph (binary-heap Dijkstra). */
function dijkstra(graph: CornerRouteGraph, source: number): Dijkstra {
  const n = graph.pos.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  dist[source] = 0;
  const heap = new MinHeap();
  heap.push(source, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    const du = dist[u]!;
    for (const { to, w } of graph.adj[u]!) {
      const nd = du + w;
      if (nd < dist[to]!) {
        dist[to] = nd;
        prev[to] = u;
        heap.push(to, nd);
      }
    }
  }
  return { dist, prev };
}

/** Minimal binary min-heap keyed by priority (lazy-deletion: stale entries skipped by caller dist). */
class MinHeap {
  private nodes: number[] = [];
  private prio: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, priority: number): void {
    this.nodes.push(node);
    this.prio.push(priority);
    this.bubbleUp(this.nodes.length - 1);
  }

  pop(): number {
    const top = this.nodes[0]!;
    const lastN = this.nodes.pop()!;
    const lastP = this.prio.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastN;
      this.prio[0] = lastP;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent]! <= this.prio[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.nodes.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let small = i;
      if (l < n && this.prio[l]! < this.prio[small]!) small = l;
      if (r < n && this.prio[r]! < this.prio[small]!) small = r;
      if (small === i) break;
      this.swap(i, small);
      i = small;
    }
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.prio[a], this.prio[b]] = [this.prio[b]!, this.prio[a]!];
  }
}
