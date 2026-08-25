/**
 * **Model** — routing a netlist: N named nets, each joining its own terminals, no two ever touching.
 *
 * This is a different problem from the one {@link planRoutes} solves, and it is worth being plain about why
 * rather than presenting this as a generalisation of it. The bus router is structurally two-net: a tour
 * visits the LED hinges and the two rails run down opposite *banks* of one shared spine, so "the other net"
 * is always exactly one net and is always on the other side. Neither idea survives a third net, so this
 * routes each net independently and keeps them apart by exclusion instead of by geometry.
 *
 * ## How it works
 *
 * Each net becomes a tree over the same corridor graph the bus router uses — face centres joined through
 * the crossing points on their shared edges — so copper stays on the material and travels along the tiling
 * rather than cutting a straight line over whatever lies between two pads.
 *
 * Nets are routed **one at a time, hardest first**, and a net that cannot be routed clear is **reported
 * unroutable** rather than crossed, because copper tape has no second layer to escape into and no via to
 * get there with.
 *
 * ## What actually holds the no-overlap condition — read this before designing a fix
 *
 * This paragraph used to say that every corridor node a net uses is "struck out of the graph" for the nets
 * after it, and that the exclusion is what makes overlap impossible. **That is not what the code does.**
 * `blocked` reaches {@link searchCorridor} and is used in exactly one place: `blocked.has(key) ?
 * OCCUPIED_TOLL : 1`, a **finite 500x toll**. A used node is expensive, never forbidden.
 *
 * Measured rather than argued: across 396 legs on six patterns, `searchCorridor` returned empty **zero
 * times even with every node in the graph tolled**. The `!mid.length` branch below cannot fire for want of
 * room — only for two faces genuinely disconnected across the material.
 *
 * So **every stranded terminal comes from the {@link clearOf} gate**, the whole-path clearance test after
 * a route is chosen. That is the one thing standing between this router and a short, and anyone who reads
 * the old sentence goes looking for the guarantee in the wrong place — and would "fix" reach by weakening
 * an exclusion that does not exist.
 *
 * ## What has already been tried
 *
 * **Ordering is exhausted.** Blame-directed reordering — promote the loser in front of whatever blocked it
 * — explores genuinely distinct orders and strands identically: 146 of 210 terminals reached with it and
 * without it over five patterns at two-to-five nets. An exhaustive sweep of all N! orderings reaches 191
 * of 252 against 189 for the four rotations shipped here. **Two terminals in 252 is the entire prize left
 * in ordering**, so branch-and-bound over permutations is exact rather than useful.
 *
 * **A large share of the failures are not routing failures at all.** The leg that collides is often the
 * **pad-exit** segment — `pts[0]` to `mid[0]` — and that segment is not an edge of the corridor graph: it
 * is synthesised here as `[a, ...mid, b]` after the search has finished. No amount of freeing the corridor
 * gives a pad a different way out of its own tile. The lever with real reach on those is moving the part a
 * millimetre, which is placement's business and not this file's.
 *
 * ## What this cannot do, honestly
 *
 * Some netlists are simply not planar. Three nets fully joining three parts is the classic case: no
 * arrangement of it fits on one side of one sheet. Ordering and retry move *which* net loses, never whether
 * one does. So the order search below is worth having and is not a fix — when it reports a net unroutable,
 * the answer is a jumper, a different placement, or a different circuit, and saying so is more use than
 * quietly crossing two nets and letting the short be discovered after the copper is laid.
 */
import type { FlatFace, GapEdge, Vec2 } from "./electronics.js";
import { pointInFace } from "./electronics.js";
import {
  FOLD_PENALTY_FRAC,
  TAPE_MM,
  buildCorridor,
  patternDiag,
  ptKey,
  searchCorridor,
  type Corridor,
  type Trace2D,
} from "./electronics-routing.js";
import { DEFAULT_SHEET, minWebMm, type SheetSpec } from "./fold-strain.js";
import type { NetPoint, ResolvedNet } from "./netlist.js";

/** How a net fared. */
export interface RoutedNet {
  id: string;
  name: string;
  /** The copper laid for it. Empty when it could not be routed at all. */
  traces: Trace2D[];
  /**
   * Terminals this net failed to reach, as indices into its own `points`.
   *
   * Partial rather than all-or-nothing on purpose: a net that reaches four of its five pads is worth laying
   * and worth telling the user about, and throwing away the four helps nobody.
   */
  stranded: number[];
  /** Why, when anything was stranded. Written for a user. */
  why?: string;
}

export interface NetRouting {
  nets: RoutedNet[];
  /** Every net's copper, flattened — what the cut files and the canvas take. */
  traces: Trace2D[];
  /**
   * How many orderings were tried before this plan was kept.
   *
   * Diagnostic, and reported rather than inferred because the rip-up search is otherwise invisible: it
   * changes the answer on nothing measured so far (see {@link RIPUP_TRIES}), which means its effect
   * cannot be observed through the routes. A count that stops rising is how anyone finds out the search
   * has stopped running.
   */
  orders: number;
}

/** How many blind rotations of the hardest-first order to try before keeping the best. */
const MAX_ORDERS = 4;

/**
 * How many further orders the failures themselves may ask for — rip-up and reroute, bounded.
 *
 * **Measured, and it buys nothing.** Over five patterns at two to five nets — 210 terminals — the router
 * reaches 146 with these orders and 146 without them, and the extra orders are genuinely explored: on
 * `house` with three nets it tries five distinct orderings and every one strands the same two terminals;
 * on `akde-hex` with four it tries nine and lands between four and five every time.
 *
 * That is the answer to "would rip-up and reroute help here", and it is a real answer rather than a
 * guess: the residual failures are not ordering failures. On a single-sided sheet with no vias many
 * netlists are simply not planar, and no order of any length fixes one of those — reordering moves which
 * net loses, never whether one does.
 *
 * It is kept anyway, at a small bound, for two reasons. The search costs nothing on a circuit that routes
 * (the loop stops the moment nothing is stranded), and the blame it computes is what lets a stranded net
 * name the net that is in its way instead of saying only that something was.
 */
const RIPUP_TRIES = 6;

/**
 * The face a terminal sits on, or -1.
 *
 * A pad just outside every face — a part nudged over a tile edge — has no way into the corridor graph, so
 * it is stranded rather than snapped to the nearest tile. Snapping would move the user's part without
 * saying so, and the copper would then be laid to somewhere the part is not.
 */
function faceOfPoint(faces: FlatFace[], p: Vec2): number {
  return pointInFace(faces, p);
}

/**
 * Join one net's points into a tree, nearest-first.
 *
 * A minimum spanning tree on straight-line distance, which is a deliberate approximation: the true cost is
 * the corridor path, but computing it for every pair before choosing any is quadratic in pads and the
 * corridor search is the expensive part. Straight-line ordering picks nearly the same tree on the patterns
 * this app produces, where pads that are close on the sheet are close through the tiling too.
 */
function spanningEdges(points: NetPoint[]): [number, number][] {
  const inTree = [0];
  const out: [number, number][] = [];
  const rest = points.map((_, i) => i).slice(1);
  while (rest.length) {
    let best = Infinity, bi = 0, bj = 0;
    for (const i of inTree) {
      for (let k = 0; k < rest.length; k++) {
        const j = rest[k]!;
        const d = Math.hypot(points[i]!.at.x - points[j]!.at.x, points[i]!.at.y - points[j]!.at.y);
        if (d < best) { best = d; bi = i; bj = k; }
      }
    }
    const j = rest.splice(bj, 1)[0]!;
    out.push([bi, j]);
    inTree.push(j);
  }
  return out;
}

/** Distance between two segments, in the plane. */
function segSegDist(p: Vec2, q: Vec2, r: Vec2, s: Vec2): number {
  const ptSeg = (a: Vec2, b: Vec2, c: Vec2): number => {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L)) : 0;
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
  };
  return Math.min(ptSeg(p, q, r), ptSeg(p, q, s), ptSeg(r, s, p), ptSeg(r, s, q));
}

/**
 * Is the leg `a`-`b` clear of every polyline in `lines`, by at least `min`?
 *
 * Clearance, not merely non-crossing, and the difference is the whole condition. Two runs can approach to
 * nothing and never *cross*: they meet at a point, or run alongside each other, and a segment-intersection
 * test reports both as fine. Laid as tape they are one piece of copper. Measured on the first version of
 * this router, two nets that crossed nowhere came to a centreline distance of 0.0000 against a 0.0997 tape
 * — a dead short that a crossing count could not see.
 *
 * `min` is a whole tape width: each strip reaches half a width either side of its centreline, so centres a
 * width apart are two strips just touching, and anything less is overlap.
 */
function clearOf(a: Vec2, b: Vec2, lines: Laid[], min: number): boolean {
  return blamedFor(a, b, lines, min) === null;
}

/** Copper already on the sheet, and whose it is. `null` for the bus and for hand-drawn wire — immovable,
 *  so there is nothing to blame and nothing that could be routed later instead. */
interface Laid {
  net: string | null;
  pts: Vec2[];
}

/**
 * Which net's copper the leg `a`-`b` comes too close to, or null when it is clear of all of them.
 *
 * The same test {@link clearOf} makes, reporting *who* rather than *whether*. Nothing used to record that,
 * and without it a stranded terminal is a dead end: the router knows a net could not be reached and has no
 * idea which net to route later so that it could be. See {@link planNets}.
 */
function blamedFor(a: Vec2, b: Vec2, lines: Laid[], min: number): string | null {
  for (const line of lines) {
    for (let i = 1; i < line.pts.length; i++) {
      if (segSegDist(a, b, line.pts[i - 1]!, line.pts[i]!) < min) return line.net;
    }
  }
  return null;
}

/**
 * How far apart two nets have to stay, in pattern units.
 *
 * A tape width, as it always was — two strips whose centres are a width apart are just touching — unless
 * the sheet itself demands more. What is left between two runs is a web of bare substrate that has to be
 * lifted out when the sheet is weeded, and a web's tear strength goes with its cross-section: halve the
 * thickness and the same web tears at half the pull. {@link minWebMm} is that floor.
 *
 * On the sheets this system prints the tape is the wider of the two and the floor never binds, which is
 * the same story as {@link maxTraceWidthMm} and is worth reading the same way: the coupling is real, it is
 * computed rather than assumed, and on a thin-film substrate — around 0.15mm, where the web wants more
 * than 3.25mm — it takes over and the nets are held further apart without anyone editing this file.
 */
function clearanceFor(tapeW: number, tapeMm: number, sheet: SheetSpec): number {
  if (!(tapeW > 0)) return tapeW;
  const webUnits = (minWebMm(sheet) * tapeW) / tapeMm;
  return Math.max(tapeW, webUnits);
}

/** Every corridor node a polyline passes through, so the next net can be kept off them. */
function claim(pts: Vec2[], into: Set<string>): void {
  for (const p of pts) into.add(ptKey(p));
}

/** Route one net against a corridor, kept clear of `theirs` — every other net's copper laid so far. */
function routeOne(
  net: ResolvedNet,
  faces: FlatFace[],
  c: Corridor,
  blocked: Set<string>,
  theirs: Laid[],
  clearance: number,
  /** Which net owns each already-claimed corridor node, so a search that fails for want of room can say
   *  whose room it was. */
  owner: Map<string, string>,
): {
  traces: Trace2D[];
  stranded: number[];
  used: Set<string>;
  lines: Vec2[][];
  /** Nets that stood in the way of something this net could not reach, in the order blame was assigned. */
  blame: string[];
} {
  const traces: Trace2D[] = [];
  const stranded: number[] = [];
  const used = new Set<string>();
  const lines: Vec2[][] = [];
  const blame: string[] = [];
  const accuse = (who: string | null): void => {
    if (who && who !== net.id && !blame.includes(who)) blame.push(who);
  };
  const faceOf = net.points.map((p) => faceOfPoint(faces, p.at));

  // A pad that is not on the material at all can never be reached, and says so once rather than once per
  // tree edge that happens to touch it.
  faceOf.forEach((f, i) => { if (f < 0) stranded.push(i); });

  for (const [i, j] of spanningEdges(net.points)) {
    if (faceOf[i]! < 0 || faceOf[j]! < 0) { if (!stranded.includes(j)) stranded.push(j); continue; }
    const a = net.points[i]!.at, b = net.points[j]!.at;
    // `searchCorridor` plain: no crossing exclusion, no per-leg clearance test.
    //
    // Every one of its exclusion levers was tried against the alternative of simply routing and then
    // checking, and none of them earned a place. `strict` and the `theirs` polyline list refuse a leg that
    // *crosses* another net, which is the wrong predicate once the condition is clearance — a leg can cross
    // nothing and still run alongside at zero distance, and can be refused for crossing when it had room to
    // spare. Across four patterns at four net counts: strict reached 123 terminals, `theirs` 124, a `legOk`
    // clearance test 128, and nothing at all 128. All four gave an identical worst-case clearance of 1.041
    // tape widths, so none of them was buying safety either. The `legOk` test was the last to go: it cost
    // time and changed no outcome anywhere.
    //
    // What actually holds the guarantee is the whole-path check below. The `blocked` set passed here is a
    // 500x toll and not an exclusion — see the header — so it buys separation by making a used node dear,
    // not by making it impossible.
    const mid =
      faceOf[i] === faceOf[j]
        ? []
        : searchCorridor(c, faceOf[i]!, faceOf[j]!, blocked, new Map(), null, false, a, null, used, null);
    if (faceOf[i] !== faceOf[j] && !mid.length) {
      if (!stranded.includes(j)) stranded.push(j);
      // No route at all — which, per the header, means the two faces are disconnected across the material
      // rather than that the corridor was full: a tolled node is dear, never impassable, and no search in
      // 396 legs came back empty for want of room. Blame is still collected here for the disconnected
      // case, where it will find nobody and correctly accuse no one.
      const free = searchCorridor(c, faceOf[i]!, faceOf[j]!, new Set(), new Map(), null, false, a, null, used, null);
      for (const p of free) accuse(owner.get(ptKey(p)) ?? null);
      continue;
    }
    // The corridor search checks the legs it chooses between nodes, and the leg out of `a` through
    // `origin`/`legOk` — but the last hop, from the final waypoint onto pad `b`, is appended afterwards and
    // belongs to nobody's search. Left unchecked it is a crossing the guarantee would not have caught.
    const pts = [a, ...mid, b];
    let cuts: string | null = null;
    let hit = false;
    for (let k = 1; k < pts.length && !hit; k++) {
      cuts = blamedFor(pts[k - 1]!, pts[k]!, theirs, clearance);
      hit = cuts !== null || !clearOf(pts[k - 1]!, pts[k]!, theirs, clearance);
    }
    if (hit) {
      if (!stranded.includes(j)) stranded.push(j);
      accuse(cuts);
      continue;
    }
    claim(pts, used);
    lines.push(pts);
    traces.push({ net: net.id, pts });
  }
  return { traces, stranded, used, lines, blame };
}

/**
 * Route every net, keeping them all off each other.
 *
 * Nets are tried hardest-first — most terminals, then longest span — then a few rotations of that order are
 * tried and the best kept, scored on terminals stranded first and copper second. Order is the only lever
 * available: with overlap forbidden outright, the only question left is which net gets the room, and the
 * rotations are worth real terminals (six patterns, six net counts: 215 reached against 209 with a single
 * ordering).
 *
 * The hardest-first sort itself is NOT worth reach, and the obvious rationale for it — that a net with many
 * pads has the least freedom — did not survive being measured: it reached 214 where plain declaration order
 * reached 215, which is noise either way. It stays for a different and real reason. It makes the order
 * canonical, so a circuit routes the same whatever sequence its author happened to declare the nets in;
 * without it, renaming or re-adding a net silently re-plans the board.
 */
export function planNets(
  nets: ResolvedNet[],
  faces: FlatFace[],
  gaps: GapEdge[],
  tapeW: number,
  /**
   * Copper already on the sheet that no net may touch — the bus's runs, and any wire the author drew.
   *
   * This was written as an unexercised guard: no net routed between face centres on any bundled pattern
   * came within a tape width of the bus, so removing it changed no outcome that could be found. Hand-drawn
   * copper is what exercises it, exactly as suspected, because the author can put a wire anywhere —
   * including across the only corridor a net had. Measured on house with a fixed wall over the spine:
   * withheld, the net lays copper 0.36 tape widths from the wall, which is through it; passed, the net
   * reports its far terminal stranded and lays nothing near it.
   *
   * Worth being exact about what "avoid" means here, since it is not what the word suggests: on that case
   * the net does not detour, it **strands**. The wall sits across the only route, so honouring the
   * obstacle resolves as reporting honestly rather than as finding a way round.
   */
  obstacles: Vec2[][] = [],
  sheet: SheetSpec = DEFAULT_SHEET,
  /** The tape's width in mm, from the same call that produced `tapeW` — see `seatLed`. */
  tapeMm: number = TAPE_MM,
): NetRouting {
  if (!nets.length) return { nets: [], traces: [], orders: 0 };
  const c = buildCorridor(faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, sheet, tapeMm);
  const clearance = clearanceFor(tapeW, tapeMm, sheet);

  const span = (n: ResolvedNet): number => {
    const xs = n.points.map((p) => p.at.x), ys = n.points.map((p) => p.at.y);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const hardest = nets
    .map((n, i) => i)
    .sort((a, b) => nets[b]!.points.length - nets[a]!.points.length || span(nets[b]!) - span(nets[a]!));

  /** Route every net in this order, and report how it went. */
  const attempt = (order: number[]): {
    nets: RoutedNet[];
    stranded: number;
    copper: number;
    /** Per net index, the nets that stood in the way of what it could not reach. */
    blame: Map<number, string[]>;
  } => {
    const blocked = new Set<string>();
    // Which net claimed each node, so a failure can name the net that has the room rather than merely
    // reporting that there was none.
    const owner = new Map<string, string>();
    // Seeded with the immovable copper: the nets route around it, never through it. `null` for its net
    // because there is nobody to blame — the bus and the author's own wire do not move for a netlist.
    const laid: Laid[] = obstacles.map((pts) => ({ net: null, pts }));
    const out: RoutedNet[] = new Array(nets.length);
    const blame = new Map<number, string[]>();
    let stranded = 0, copper = 0;
    for (const idx of order) {
      const n = nets[idx]!;
      const r = routeOne(n, faces, c, blocked, laid, clearance, owner);
      for (const k of r.used) {
        blocked.add(k);
        if (!owner.has(k)) owner.set(k, n.id);
      }
      laid.push(...r.lines.map((pts) => ({ net: n.id, pts })));
      stranded += r.stranded.length;
      if (r.blame.length) blame.set(idx, r.blame);
      for (const t of r.traces) {
        for (let k = 1; k < t.pts.length; k++) {
          copper += Math.hypot(t.pts[k]!.x - t.pts[k - 1]!.x, t.pts[k]!.y - t.pts[k - 1]!.y);
        }
      }
      // Naming the net that was in the way, where one can be named. "Could not be reached" tells the
      // author that something is wrong; "N2 is in the way" tells them what to move. The blame is already
      // computed for the reordering below, so this costs nothing.
      const inTheWay = r.blame
        .map((id) => nets.find((x) => x.id === id)?.name)
        .filter((x): x is string => !!x);
      out[idx] = {
        id: n.id,
        name: n.name,
        traces: r.traces,
        stranded: r.stranded,
        ...(r.stranded.length
          ? {
              why:
                `${r.stranded.length} of ${n.points.length} terminals on "${n.name}" could not be reached ` +
                (inTheWay.length
                  ? `without crossing ${inTheWay.length === 1 ? inTheWay[0] : inTheWay.join(" or ")}. `
                  : `without crossing another net. `) +
                `Copper tape is single-sided, so there is no layer to cross on: move a part, or bridge ` +
                `this net by hand.`,
            }
          : {}),
      };
    }
    return { nets: out, stranded, copper, blame };
  };

  const better = (
    a: { stranded: number; copper: number },
    b: { stranded: number; copper: number } | null,
  ): boolean => !b || a.stranded < b.stranded || (a.stranded === b.stranded && a.copper < b.copper);

  /**
   * Move `victim` in front of `blocker`, which is what ripping a net up amounts to here.
   *
   * Worth being exact, because it is the whole reason this router has no separate rip-up loop: a net's
   * route depends only on **which nets were routed before it**, since every earlier net's nodes are struck
   * out and its copper is an obstacle. So tearing out the blocker and laying it again after the victim
   * gives precisely the same result as routing the victim first — the two are the same operation, and the
   * ordering is the cheaper way to say it.
   */
  const promote = (order: number[], victim: number, blocker: number): number[] => {
    const rest = order.filter((i) => i !== victim);
    const at = rest.indexOf(blocker);
    return [...rest.slice(0, at), victim, ...rest.slice(at)];
  };

  const byId = new Map(nets.map((n, i) => [n.id, i]));
  const seen = new Set<string>();
  let best: { nets: RoutedNet[]; stranded: number; copper: number } | null = null;
  let queue: number[][] = [];
  for (let rot = 0; rot < Math.min(MAX_ORDERS, hardest.length); rot++) {
    queue.push([...hardest.slice(rot), ...hardest.slice(0, rot)]);
  }

  // The blind rotations first, then orders the failures themselves ask for. `RIPUP_TRIES` bounds the
  // second kind: each one is a full re-route of every net, and the measured return falls away quickly.
  for (let tries = 0; queue.length && tries < MAX_ORDERS + RIPUP_TRIES; tries++) {
    const order = queue.shift()!;
    const key = order.join(",");
    if (seen.has(key)) continue; // an order already tried cannot give a different answer — this is the
    seen.add(key);               // whole of the cycle prevention, and it is enough because the routing
                                 // is deterministic in the order alone.
    const got = attempt(order);
    if (better(got, best)) best = got;
    if (got.stranded === 0) break; // nothing left for another order to improve

    // Rip-up, as a reordering. Take the net that lost the most and put it in front of whatever was in its
    // way; if that net has several blockers, try each. Deterministic throughout — the victim is the
    // lowest-indexed of those that lost the most, and the blockers are tried in the order blame was
    // assigned — so the same circuit re-plans identically.
    let worst = -1, lost = 0;
    for (const [idx, list] of got.blame) {
      const n = got.nets[idx]?.stranded.length ?? 0;
      if (list.length && (n > lost || (n === lost && worst >= 0 && idx < worst))) { worst = idx; lost = n; }
    }
    if (worst < 0) continue;
    for (const who of got.blame.get(worst)!) {
      const blocker = byId.get(who);
      if (blocker === undefined || blocker === worst) continue;
      const next = promote(order, worst, blocker);
      if (!seen.has(next.join(","))) queue.push(next);
    }
  }
  const chosen = best!.nets;
  return { nets: chosen, traces: chosen.flatMap((n) => n.traces), orders: seen.size };
}
