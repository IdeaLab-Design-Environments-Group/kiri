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
import type { Circuit, FlatFace, GapEdge, Vec2 } from "./electronics.js";
// Imported from the modules that own each concern rather than from the router's facade: net routing is
// reached BY the router, so importing the router back would close a cycle.
import { FOLD_PENALTY_FRAC, TAPE_MM } from "./tape-width.js";
import { STRAIN_BAND_CAP } from "./fold-strain.js";
import { buildCorridor, searchCorridor } from "./corridor.js";
import { patternDiag, ptKey } from "./trace-geometry.js";
import type { Corridor, Jump, PadField, Trace2D } from "./trace-types.js";
import type { FoldAdjacency } from "./fold-adjacency.js";
// The author's own jumps, and the solder lands every jump puts on the sheet. Model-side and cycle-free:
// `manual-jump.ts` reads the corridor and the adjacency, neither of which reads this file back.
import { jumpLandTraces, manualJumps } from "./manual-jump.js";
import { DEFAULT_SHEET, type SheetSpec } from "./fold-strain.js";
import { resolveNetlist, type NetPoint, type NetlistFault, type PadObstacle, type ResolvedNet } from "./netlist.js";
// The clearance gate and the leg layer, split out of this file: what a leg is judged against, and how one
// is built. Both are leaves — neither imports back — so the router keeps its place at the top of the stack.
import { type Laid, padClearanceFor, weedFloorFor } from "./net-clearance.js";
import { type LegRules, faceOfPoint, layPath } from "./net-legs.js";

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
  /**
   * How this net met the bus rail of the same id: `"none"` when there is no such rail, `"laid"` when the
   * tap leg reached it, `"failed"` when it could not be laid clear.
   *
   * Reported rather than folded into `stranded`, which is indices into `points` and has to stay that. A
   * failed tap strands nothing — every pad may well be joined to every other — and is still the difference
   * between a part that is powered and one that is not, so it needs to be sayable on its own.
   */
  railTap: "none" | "laid" | "failed";
  /**
   * The connections this net was supposed to make and did not — each as the two points a line should join.
   *
   * A ratsnest, in the PCB sense: what the netlist asked for, drawn where the copper is missing. Absent
   * when the net came out whole, so a circuit that routed carries none of this.
   *
   * **Computed here rather than in the view**, because `stranded` is indices into `ResolvedNet.points` and
   * the view holds only a {@link RoutedNet}. Handing the view the points instead would be a second copy of
   * the netlist to drift from — see `parts.ts › padRunBox` for what that costs.
   *
   * svg-pcb has the same idea written and then disabled behind `if (state.pcb && false)`; what it ships
   * instead is a nearest-neighbour ratsnest drawn from the declared netlist alone, which ignores the copper
   * and so never disappears as you route. These lines disappear, because they are derived from what was
   * actually laid.
   */
  ratsnest?: [Vec2, Vec2][];
  /** The seam rejoins this net's own routes take, if any — see {@link NetRouting.jumps}. Absent when it
   *  took none, so a net routed without an adjacency carries nothing new. */
  jumps?: Jump[];
}

export interface NetRouting {
  nets: RoutedNet[];
  /** Every net's copper, flattened — what the cut files and the canvas take. */
  traces: Trace2D[];
  /**
   * Every seam rejoin the router took, across all nets — the wires the builder solders once the sheet is
   * folded (`corridor-jumps.ts`).
   *
   * Always present and empty by default: with no adjacency the corridor has no jump to take, so this is
   * `[]` for every caller that has not asked for one. The lands themselves are ordinary copper and reach
   * the caller in `traces`, so nothing downstream needs a branch for a jump to draw or cut the sheet — it
   * needs one only to *say* there is a wire still to be soldered.
   */
  jumps: Jump[];
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
 * Join one net's points into a tree, nearest-first.
 *
 * A minimum spanning tree on straight-line distance, which is a deliberate approximation: the true cost is
 * the corridor path, but computing it for every pair before choosing any is quadratic in pads and the
 * corridor search is the expensive part. Straight-line ordering picks nearly the same tree on the patterns
 * this app produces, where pads that are close on the sheet are close through the tiling too.
 */
function spanningEdges(points: NetPoint[], joined: [number, number][] = []): [number, number][] {
  // A pair the author already joined by hand enters the tree with its mate and costs nothing, and no edge
  // is emitted for it: the copper across that seam is the jump, not a run. Empty is the tree this built
  // before jumps existed, edge for edge.
  const mates = new Map<number, number[]>();
  for (const [i, j] of joined) {
    mates.set(i, [...(mates.get(i) ?? []), j]);
    mates.set(j, [...(mates.get(j) ?? []), i]);
  }
  const inTree: number[] = [];
  const rest = new Set(points.map((_, i) => i));
  const admit = (i: number): void => {
    if (!rest.has(i)) return;
    rest.delete(i);
    inTree.push(i);
    for (const m of mates.get(i) ?? []) admit(m);
  };
  const out: [number, number][] = [];
  admit(0);
  while (rest.size) {
    let best = Infinity, bi = 0, bj = 0;
    for (const i of inTree) {
      for (const j of rest) {
        const d = Math.hypot(points[i]!.at.x - points[j]!.at.x, points[i]!.at.y - points[j]!.at.y);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    out.push([bi, bj]);
    admit(bj);
  }
  return out;
}

/**
 * Two points of one net the author has already joined across a seam — a drawn jump, as the router sees it.
 *
 * The only way an author's jump changes a route. `planRoutes` does not read `Circuit.jumps` for its
 * geometry any more than it reads `Circuit.wires` for theirs: what reaches the router is the *claim* that
 * these two places are connected, and the tree is built knowing it, so the net spends no copper going the
 * long way round for a connection that already exists.
 */
export interface PreJoin {
  net: string;
  a: Vec2;
  b: Vec2;
}

/**
 * Where a net could tap the bus, nearest first.
 *
 * A declared net named PWR and the bus's PWR rail were kept apart on purpose — the conservative reading,
 * and it can never short — but it meant a part wired to declared PWR was not thereby joined to the
 * battery, and a lone pad on PWR got no copper at all. The tap is the join, and it is one leg: the rail is
 * already one connected run, so touching it anywhere joins the whole of it.
 *
 * **Anywhere, which is why this is a list and not a point.** The nearest point on the rail is usually the
 * wrong one: the two rails run down opposite banks of one shared spine and the bus pinches them together
 * where they meet an LED — on `house`, to 0.61 of a tape width — so a tap onto the near stretch of PWR
 * cannot be laid without lying on GND. Handed only the nearest anchor the router reports the tap
 * impossible, when a stretch of the same rail a little further along is in clear air. So every projection
 * of every pad onto every rail segment is a candidate, ordered by how much copper it would cost, and the
 * caller takes the first that routes clear.
 *
 * The anchor is the closest point on the segment, not the segment's nearest end: a tap into the middle of
 * a run is an ordinary T-junction in copper tape, and refusing it would send the leg the long way round.
 */
function tapCandidates(points: NetPoint[], rails: Vec2[][]): { from: number; at: Vec2 }[] {
  const out: { from: number; at: Vec2; d: number }[] = [];
  points.forEach((p, i) => {
    for (const line of rails) {
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1]!, b = line[k]!;
        const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((p.at.x - a.x) * dx + (p.at.y - a.y) * dy) / L)) : 0;
        const at = { x: a.x + t * dx, y: a.y + t * dy };
        out.push({ from: i, at, d: Math.hypot(p.at.x - at.x, p.at.y - at.y) });
      }
    }
  });
  // Nearest first, and ties broken on position so the same rail plans the same tap every time — a bus
  // whose runs arrived in a different order must not move the tap.
  out.sort((x, y) => x.d - y.d || x.at.x - y.at.x || x.at.y - y.at.y || x.from - y.from);
  return out.slice(0, TAP_TRIES).map(({ from, at }) => ({ from, at }));
}

/**
 * How many anchors on the rail to try before reporting the tap impossible.
 *
 * Each one is a corridor search, so this is the whole cost of the feature on a circuit where the first
 * anchor works — one search — and its worst case on one where none of them does. Twelve covers the case
 * this exists for: the near stretch of the rail is pinched against the other one and the clear stretch is
 * a few segments along.
 */
const TAP_TRIES = 12;

/** Every corridor node a polyline passes through, so the next net can be kept off them. */
function claim(pts: Vec2[], into: Set<string>): void {
  for (const p of pts) into.add(ptKey(p));
}

/**
 * The lines a ratsnest should draw for one net: each stranded terminal joined to where it belongs.
 *
 * To the nearest point on the net's OWN copper where the net laid any, because that is the connection the
 * author actually asked for and the shortest honest statement of what is missing. Where the net laid
 * nothing at all, to its nearest reached terminal instead — and where nothing was reached, to the nearest
 * other terminal of the net, so a net that failed completely still shows what it was meant to be.
 */
function ratsnestFor(net: ResolvedNet, stranded: number[], laid: Trace2D[]): [Vec2, Vec2][] {
  if (!stranded.length) return [];
  const ptSeg = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
    return { x: a.x + ax * t, y: a.y + ay * t };
  };
  const out: [Vec2, Vec2][] = [];
  const isStranded = new Set(stranded);
  for (const i of stranded) {
    const from = net.points[i]?.at;
    if (!from) continue;
    let best: Vec2 | null = null;
    let bestD = Infinity;
    const offer = (q: Vec2): void => {
      const d = Math.hypot(q.x - from.x, q.y - from.y);
      if (d > 1e-12 && d < bestD) { bestD = d; best = q; }
    };
    for (const t of laid) for (let k = 1; k < t.pts.length; k++) offer(ptSeg(from, t.pts[k - 1]!, t.pts[k]!));
    if (!best) {
      // Nothing laid for this net: fall back to a terminal, preferring one that was actually reached.
      net.points.forEach((p, j) => { if (j !== i && !isStranded.has(j)) offer(p.at); });
      if (!best) net.points.forEach((p, j) => { if (j !== i) offer(p.at); });
    }
    if (best) out.push([from, best]);
  }
  return out;
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
  /** The tape's own width, in pattern units — a leg's width everywhere it is not tapering onto a pad. */
  tapeW: number,
  /** The metal near these legs, so a run stays narrow for as long as it is over a part. */
  fields: PadField[],
  /** Every pad on the sheet, so a leg is neither laid across one nor left wider than the room beside it. */
  pads: PadObstacle[],
  /** How near a run's edge may come to a pad that is not its own — see {@link PAD_CLEARANCE_MM}. */
  padGap: number,
  /** Which cuts the folded artifact rejoins, so a leg may cross one; `null` keeps every leg on the sheet. */
  adjacency: FoldAdjacency | null,
  /** Pairs of this net's own point indices the author has already joined — see {@link PreJoin}. */
  joined: [number, number][],
): {
  traces: Trace2D[];
  stranded: number[];
  used: Set<string>;
  /** The copper laid, WITH its widths — the same objects as `traces`, so the two cannot drift apart. */
  lines: Trace2D[];
  /** Nets that stood in the way of something this net could not reach, in the order blame was assigned. */
  blame: string[];
  /** Whether this net had a bus rail to tap, and whether the tap leg reached it. */
  tapped: "none" | "laid" | "failed";
  /** The seam rejoins its legs took. Empty without an adjacency. */
  jumps: Jump[];
} {
  const traces: Trace2D[] = [];
  const stranded: number[] = [];
  const jumps: Jump[] = [];
  const used = new Set<string>();
  const lines: Trace2D[] = [];
  const blame: string[] = [];
  const accuse = (who: string | null): void => {
    if (who && who !== net.id && !blame.includes(who)) blame.push(who);
  };
  const faceOf = net.points.map((p) => faceOfPoint(faces, p.at));
  const own = net.points.map((p) => p.at);

  // This net's own bus rail is not an obstacle to it: the tap leg ENDS on that copper, so measured against
  // it every tap is a violation and no net could ever reach its rail. Every other rail stays in — a PWR tap
  // that came within a tape width of the GND rail is the short this gate exists to refuse.
  const mine = theirs.filter((l) => l.rail === net.id).map((l) => l.pts);
  const others = theirs.filter((l) => l.rail !== net.id);
  const rules: LegRules = { others, clearance, tapeW, fields, pads, padGap, netId: net.id, own, faces };

  // A pad that is not on the material at all can never be reached, and says so once rather than once per
  // tree edge that happens to touch it.
  faceOf.forEach((f, i) => { if (f < 0) stranded.push(i); });

  for (const [i, j] of spanningEdges(net.points, joined)) {
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
    // Densified first, so the width profile follows the part's own pitch rather than being smeared across a
    // corridor hop — and so the clearance gate below judges exactly the copper the blade will cut.
    // `layPath`, not `layLeg`: where the chosen route crosses a seam the folded artifact rejoins, the run
    // is cut at that cut and the hop comes back as a jump rather than as copper over a hole. With no
    // adjacency there is no such hop and this lays the one leg it always did.
    const leg = layPath(c, a, b, mid, net.points[i]!.padWidth, net.points[j]!.padWidth, rules, adjacency);
    if (!leg.ok) {
      if (!stranded.includes(j)) stranded.push(j);
      accuse(leg.cuts);
      continue;
    }
    for (const trace of leg.traces) {
      claim(trace.pts, used);
      lines.push(trace);
      traces.push(trace);
    }
    jumps.push(...leg.jumps);
  }

  // The tap. One more leg, from a pad onto the net's own rail — routed through the same corridor and held
  // to the same clearance as any other leg, so it is copper on the material and clear of every other net
  // rather than a straight line drawn to the nearest rail. Anchors are tried nearest first and the first
  // that lays clear is kept; see {@link tapCandidates} for why the nearest is so often not the one.
  const candidates = tapCandidates(net.points, mine);
  let tapped: "none" | "laid" | "failed" = candidates.length ? "failed" : "none";
  for (const tap of candidates) {
    const from = faceOf[tap.from]!;
    const onto = faceOfPoint(faces, tap.at);
    if (from < 0 || onto < 0) continue;
    const a = net.points[tap.from]!.at;
    const mid =
      from === onto
        ? []
        : searchCorridor(c, from, onto, blocked, new Map(), null, false, a, null, used, null);
    if (from !== onto && !mid.length) continue;
    // Only the pad end tapers — `tap.at` lands on the rail itself, which is already the tape's own width.
    const tapLeg = layPath(c, a, tap.at, mid, net.points[tap.from]!.padWidth, undefined, rules, adjacency);
    if (!tapLeg.ok) {
      accuse(tapLeg.cuts);
      continue;
    }
    for (const trace of tapLeg.traces) {
      claim(trace.pts, used);
      lines.push(trace);
      traces.push(trace);
    }
    jumps.push(...tapLeg.jumps);
    tapped = "laid";
    break;
  }
  return { traces, stranded, used, lines, blame, tapped, jumps };
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
  /**
   * The bus's runs, tagged with the net each is a rail for.
   *
   * A net whose id matches one of these taps it — one extra leg onto the rail, which is what joins a part
   * wired to declared PWR to the battery. Passed here as well as in `obstacles` and not instead of it: a
   * rail is still copper every OTHER net has to stay clear of, and only its own net is let through.
   */
  rails: { net: string; pts: Vec2[]; widths?: number[] }[] = [],
  /**
   * The metal every part on this circuit has on the sheet — see `electronics-routing.ts › PadField`.
   *
   * A leg stays narrow for as long as it is standing over a part, and the clearance gate reads that same
   * narrowness, which is what lets two nets reach adjacent pins of a fine-pitch part. Empty means no part
   * geometry is known and every leg is planned at full tape width, exactly as before this existed.
   *
   * Appended, never inserted — see `planRoutes`. Every parameter here has a default, so an inserted one
   * silently receives the wrong argument at every existing call site.
   */
  fields: PadField[] = [],
  /**
   * Every pad on the sheet, as copper no other net may be laid across — see `netlist.ts › PadObstacle`.
   *
   * `fields` narrows a leg near the part it is reaching for; this refuses one that would run over a pad and
   * narrows it to the room beside every pad it merely passes. Two different questions, and until this
   * existed only the first was asked: a leg tapered to a hair still shorted a chip if it crossed one of its
   * pins, because the clearance gate measures against other nets' runs and a pad is not a run.
   *
   * Empty means no pad geometry is known and nothing is refused or narrowed on this ground, exactly as
   * before. Appended, never inserted — see `planRoutes`.
   */
  pads: PadObstacle[] = [],
  /** Cap on the crease severity bands the search minimises first — `fold-strain.ts › strainBand`. `0` is
   *  the pure cost ordering, and is the default: bands are measured to change no route on any shipped
   *  pattern. See `corridor.ts › buildCorridor`. */
  bandCap: number = STRAIN_BAND_CAP,
  graded: boolean = true,
  /**
   * Which cuts the folded artifact rejoins, so a net may cross one — `fold-adjacency.ts`.
   *
   * **Null by default, and null is the router that was here before**: with no adjacency the corridor gains
   * no jump link, no path can be split, and every net comes out byte for byte as it did. Appended, never
   * inserted — see the note in `planRoutes`.
   */
  adjacency: FoldAdjacency | null = null,
  /** Points the author has already joined across a seam, per net — see {@link PreJoin}. */
  prejoined: PreJoin[] = [],
): NetRouting {
  if (!nets.length) return { nets: [], traces: [], orders: 0, jumps: [] };
  const c = buildCorridor(
    faces, gaps, patternDiag(faces) * FOLD_PENALTY_FRAC, tapeW, sheet, tapeMm, bandCap, graded, adjacency);
  // A drawn jump's two ends, as indices into the net's own point list. The ends are points on the net —
  // `routeDeclaredNets` puts them there — so this is a lookup and not a snap: the nearest point to a land
  // centre is that land centre.
  const joinedIn = (n: ResolvedNet): [number, number][] => {
    const near = (p: Vec2): number => {
      let bi = -1, bd = Infinity;
      n.points.forEach((q, i) => {
        const d = Math.hypot(q.at.x - p.x, q.at.y - p.y);
        if (d < bd) { bd = d; bi = i; }
      });
      return bi;
    };
    const out: [number, number][] = [];
    for (const j of prejoined) {
      if (j.net !== n.id) continue;
      const a = near(j.a), b = near(j.b);
      if (a >= 0 && b >= 0 && a !== b) out.push([a, b]);
    }
    return out;
  };
  const clearance = weedFloorFor(tapeW, tapeMm, sheet);
  const padGap = padClearanceFor(tapeW, tapeMm);

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
    /** How many seam rejoins this plan needs. Second in the ordering — see {@link better}. */
    jumps: number;
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
    const laid: Laid[] = [
      ...obstacles.map((pts) => ({ net: null, pts })),
      // Rails carry their widths. They used to be handed over as bare polylines, so a net was held a full
      // tape width from a rail that is 1.14mm wide where it pinches at an LED — room the gate could have
      // given it for nothing.
      ...rails.map((r) => ({
        net: null,
        pts: r.pts,
        rail: r.net,
        ...(r.widths ? { widths: r.widths } : {}),
      })),
    ];
    const out: RoutedNet[] = new Array(nets.length);
    const blame = new Map<number, string[]>();
    let stranded = 0, copper = 0, jumped = 0;
    for (const idx of order) {
      const n = nets[idx]!;
      const r = routeOne(
        n, faces, c, blocked, laid, clearance, owner, tapeW, fields, pads, padGap, adjacency, joinedIn(n));
      jumped += r.jumps.length;
      for (const k of r.used) {
        blocked.add(k);
        if (!owner.has(k)) owner.set(k, n.id);
      }
      // The traces themselves, widths and all — not a second array of the same polylines without them.
      laid.push(...r.lines.map((t) => ({ net: n.id, pts: t.pts, ...(t.widths ? { widths: t.widths } : {}) })));
      // A failed tap scores as a stranded terminal, so an ordering that reaches the rail is preferred over
      // one that only joins the pads to each other. It is not pushed into `stranded` itself — see
      // {@link RoutedNet.railTap}.
      stranded += r.stranded.length + (r.tapped === "failed" ? 1 : 0);
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
      // Only where the pattern actually has a rejoined cut. Offering a jump on a pattern with none would
      // send the author looking for a seam that is not there.
      const jumpHint = adjacency?.pairs.length ? ", or let a jump rejoin it across a seam" : "";
      const tapWhy =
        r.tapped === "failed"
          ? `"${n.name}" could not be joined to the ${n.name} rail without crossing other copper. ` +
            `The pads on it are wired to each other but not to the battery: move the part, or bridge it ` +
            `to the rail by hand.`
          : "";
      const rats = ratsnestFor(n, r.stranded, r.lines);
      out[idx] = {
        id: n.id,
        name: n.name,
        traces: r.traces,
        stranded: r.stranded,
        railTap: r.tapped,
        ...(r.jumps.length ? { jumps: r.jumps } : {}),
        ...(rats.length ? { ratsnest: rats } : {}),
        ...(tapWhy && !r.stranded.length ? { why: tapWhy } : {}),
        ...(r.stranded.length
          ? {
              why:
                `${r.stranded.length} of ${n.points.length} terminals on "${n.name}" could not be reached ` +
                (inTheWay.length
                  ? `without crossing ${inTheWay.length === 1 ? inTheWay[0] : inTheWay.join(" or ")}. `
                  : `without crossing another net. `) +
                `Copper tape is single-sided, so there is no layer to cross on: move a part, or bridge ` +
                `this net by hand${jumpHint}.` + (tapWhy ? ` ${tapWhy}` : ""),
            }
          : {}),
      };
    }
    return { nets: out, stranded, jumps: jumped, copper, blame };
  };

  /**
   * Which of two plans to keep: fewest terminals stranded, then fewest jumps, then least copper.
   *
   * Jumps sit **between** the two because a jump is a real cost the author pays with a soldering iron and
   * copper is not — a plan that saves a millimetre of tape by asking for a second hand-soldered wire is
   * the wrong trade — while a terminal that cannot be reached at all is worse than any amount of either.
   * With no adjacency every plan has zero jumps and this is the two-key ordering it has always been.
   */
  const better = (
    a: { stranded: number; jumps: number; copper: number },
    b: { stranded: number; jumps: number; copper: number } | null,
  ): boolean =>
    !b ||
    a.stranded < b.stranded ||
    (a.stranded === b.stranded &&
      (a.jumps < b.jumps || (a.jumps === b.jumps && a.copper < b.copper)));

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
  let best: { nets: RoutedNet[]; stranded: number; jumps: number; copper: number } | null = null;
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
  return {
    nets: chosen,
    traces: chosen.flatMap((n) => n.traces),
    orders: seen.size,
    jumps: chosen.flatMap((n) => n.jumps ?? []),
  };
}

/**
 * Route the nets the author declared, keeping them clear of the bus and of each other.
 *
 * Separated from `planRoutes` so the netlist path can be read on its own, and so a circuit with no nets
 * pays nothing for it beyond one length check. It lives here rather than beside the bus router because
 * everything it does is netlist routing: resolve the circuit's nets, hand them to {@link planNets}, and
 * hand back what came out.
 *
 * The bus copper is handed over as a set of already-laid polylines, which {@link planNets} treats exactly
 * as it treats an earlier net's copper: nothing may come within a tape width of it. That is what keeps the
 * no-overlap guarantee true of the whole sheet rather than only of the netlist.
 *
 * It is also handed over **tagged with the net each run is a rail for**, which is a different claim and the
 * one that joins a netlist to a battery. A declared net sharing an id with a rail — `pwr`, `gnd` — taps
 * that rail rather than avoiding it, so a pad wired to PWR is wired to the battery's positive terminal and
 * not merely to the other pads that happen to be on PWR. Every other rail stays an obstacle to it. Until
 * this existed a lone pad on PWR was reported a `single-terminal-net` fault and got no copper at all.
 *
 * ## Jumps
 *
 * With an `adjacency` the nets may cross a cut the folded artifact rejoins. Two things follow, and they
 * are separate. The author's **drawn** jumps go in as {@link PreJoin}s — the claim that those two places
 * are already connected — together with their land centres as points of the net, so a leg is routed *onto*
 * the land instead of the net paying to go round a seam the author has already bridged. The router's own
 * jumps come back out, and their **lands are added to the copper here**, because a land is ordinary tape
 * and everything downstream — the canvas, the strips, the carrier — should see it as such.
 */
export function routeDeclaredNets(
  circuit: Circuit,
  faces: FlatFace[],
  gaps: GapEdge[],
  tapeW: number,
  bus: Trace2D[],
  sheet: SheetSpec = DEFAULT_SHEET,
  tapeMm: number = TAPE_MM,
  /** The battery's two terminal squares, so the netlist can route to them where the bus is not already
   *  running a rail out of them — see `netlist.ts`, the `BATTERY_PART` branch. */
  batteryPads?: { pwr: Vec2; gnd: Vec2 },
  /** Which cuts the folded artifact rejoins. `null` routes exactly as this did before jumps existed. */
  adjacency: FoldAdjacency | null = null,
): { traces: Trace2D[]; nets: RoutedNet[]; faults: NetlistFault[]; jumps: Jump[] } {
  if (!circuit.nets?.length) return { traces: [], nets: [], faults: [], jumps: [] };
  // Widths carried over, not dropped. A rail pinches to about a third of the tape where it passes an LED,
  // and handing the clearance gate a bare polyline made every net keep a full tape width from copper that
  // narrow — room given away for nothing.
  const rails = bus.map((t) => ({
    net: t.net,
    pts: t.pts,
    ...(t.widths ? { widths: t.widths } : t.width !== undefined ? { widths: t.pts.map(() => t.width!) } : {}),
  }));
  const { nets, faults, fields, pads } =
    resolveNetlist(circuit, tapeW, tapeMm, new Set(rails.map((r) => r.net)), batteryPads);
  if (!nets.length) return { traces: [], nets: [], faults, jumps: [] };
  // The author's own jumps, resolved once. Only the ones that landed on a rejoined cut count: a jump whose
  // ends sit on no pair is a fault the rules report (`jump-rules.ts`), not a connection to plan around.
  const drawn = adjacency
    ? manualJumps({ faces, gaps, circuit, tapeW, adjacency }).filter((j) => j.pair >= 0)
    : [];
  const prejoined: PreJoin[] = drawn.map((j) => ({ net: j.net, a: j.a, b: j.b }));
  // Each end of a drawn jump becomes a terminal of its net, so the tree routes copper onto the land rather
  // than to wherever the nearest pad happens to be. `part: -1` because no part owns it.
  const withLands = nets.map((n) => {
    const ends = drawn.filter((j) => j.net === n.id).flatMap((j) => [j.a, j.b]);
    return ends.length
      ? { ...n, points: [...n.points, ...ends.map((at) => ({ part: -1, pad: "jump", at }))] }
      : n;
  });
  // The bus goes over as `rails` and NOT also as `obstacles`. Passed twice it arrives twice — once tagged
  // with the net it is a rail for and once anonymously — and the anonymous copy is not excluded from a
  // net's own clearance test, so every tap is refused by the very rail it is trying to reach.
  const routed = planNets(
    withLands, faces, gaps, tapeW, [], sheet, tapeMm, rails, fields, pads,
    STRAIN_BAND_CAP, true, adjacency, prejoined);
  return {
    traces: [...routed.traces, ...jumpLandTraces(routed.jumps, tapeW, faces)],
    nets: routed.nets,
    faults,
    jumps: routed.jumps,
  };
}
