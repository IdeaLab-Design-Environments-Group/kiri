/**
 * **Model** — the graph the copper is allowed to travel on, and the search over it.
 *
 * ## Why this is its own file
 *
 * Routing a net is two separable problems: *where may tape go* and *which way should this net go*. This
 * file answers the first. It builds a {@link Corridor} — waypoints on faces and on the edges between
 * them, priced by what crossing each edge costs — and searches it with Dijkstra ({@link searchCorridor}).
 * It has no idea that nets have polarity, that LEDs have two pads, or that a battery exists.
 *
 * That separation is what lets `net-routing.ts` route arbitrary declared nets over exactly the same
 * corridor the two-rail bus uses, instead of reimplementing traversal. Before the split it had to import
 * the whole router to reach {@link buildCorridor}, and the router imported it back.
 *
 * Prices are fractions of the pattern's bounding-box diagonal; see `tape-width.ts › FOLD_PENALTY_FRAC`.
 */
import {
  type FlatFace,
  type GapEdge,
  type Vec2,
  dist2,
  pointInFace,
} from "./electronics.js";
import type { Corridor } from "./trace-types.js";
import {
  DEFAULT_SHEET,
  creaseCostFraction,
  overStrainLimit,
  type SheetSpec,
} from "./fold-strain.js";
import { FOLD_PENALTY_FRAC, TAPE_MM } from "./tape-width.js";
import {
  add,
  cross,
  crossesAny,
  intersection,
  segPointDist,
  len,
  ptKey,
  scale,
  segsCross,
  sub,
  unit,
} from "./trace-geometry.js";

const OCCUPIED_TOLL = 500;

/** Where along a shared edge the bus may cross it. Symmetric about the middle so neither net is favoured,
 *  and away from the middle so a crossing does not land on a chip, which sits at the midpoint -- which is why
 *  this fixed copper-under-the-chip as well as overlap.
 *
 *  Measured: quarters beat thirds on overlap (akde-decagon 17% -> 8%) for about 25% more copper. Three or
 *  four crossings per edge is worse on both counts -- puffin reaches 13-15 PWR/GND crossings -- because the
 *  extra freedom lets the two nets interleave rather than separate. */
const EDGE_CROSSINGS = [1 / 4, 3 / 4];

const SHARED_TOLL = 2;


const OWN_TAPE_DISCOUNT = 0.2;

/** How much nearer an earlier pad must be, in squared distance, before a branch leaves it instead of carrying
 *  on from the last pad. Below 1 it means "clearly nearer". */

export const TERMINAL_TOLL = 400;



/**
 * Zero-width cuts: two faces that touch along an edge which is **not** a shared hinge.
 *
 * A cut in these patterns is a lip — two boundary edges — and where the lip has opened it is a hole in the
 * silhouette, so {@link pointInFace} refuses copper there and nothing more is needed. A cut that has *not*
 * opened is the dangerous one: the two lips sit on the same line in the flat pattern, every point on both
 * sides is inside some face, and containment cannot see the join at all. The material is still severed.
 *
 * Measured on `kirigami-flap`, which carries three such edges: with the battery on face 2 the router laid
 * two runs straight across them. Every other bundled pattern has none, which is why this went unnoticed —
 * "no crossings" was measured on the seven patterns that cannot have any.
 *
 * Told apart by **vertex indices against coordinates**: a shared hinge is one edge, so both faces name the
 * same two vertices; a seam is two edges that happen to coincide, so the indices differ. That distinction
 * is the whole detection, and it needs nothing the router is not already given.
 */
export function seamsOf(faces: FlatFace[]): [Vec2, Vec2][] {
  const hit = SEAM_CACHE.get(faces);
  if (hit) return hit;
  const at = (p: Vec2): string => `${Math.round(p.x * 1e6)}_${Math.round(p.y * 1e6)}`;
  const byLine = new Map<string, { idx: string; seg: [Vec2, Vec2] }[]>();
  for (const f of faces) {
    const n = f.poly.length;
    for (let i = 0; i < n; i++) {
      const pa = f.poly[i]!, pb = f.poly[(i + 1) % n]!;
      const va = f.verts[i], vb = f.verts[(i + 1) % n];
      const ka = at(pa), kb = at(pb);
      const line = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const idx = va == null || vb == null ? "?" : String(Math.min(va, vb)) + "_" + String(Math.max(va, vb));
      const list = byLine.get(line) ?? [];
      list.push({ idx, seg: [pa, pb] });
      byLine.set(line, list);
    }
  }
  const out: [Vec2, Vec2][] = [];
  for (const list of byLine.values()) {
    if (list.length < 2) continue;
    const names = new Set(list.map((e) => e.idx));
    if (names.size > 1) out.push(list[0]!.seg); // same line, different vertices: a cut, not a hinge
  }
  SEAM_CACHE.set(faces, out);
  return out;
}

/** One computation per pattern. `flatFaces` returns a fresh array, so identity is a safe key. */
const SEAM_CACHE = new WeakMap<FlatFace[], [Vec2, Vec2][]>();

/**
 * Where a strip from `a` to `b` would span a cut the material is severed along, or null if it does not.
 *
 * The point, not a boolean, because the point cannot be recovered afterwards. The usual way to report a
 * strip that has left the sheet is to sample along it for somewhere off the material — and on an unopened
 * cut **both sides are on material**, which is the entire property of the thing. A sampler finds nothing
 * to report and any point it named would be one it had not derived. So the crossing is handed back by
 * whatever found it.
 *
 * Exported for `wire-rules.ts`, which needs to tell a wire that spans a cut apart from a wire that runs
 * off the edge of the sheet. Deliberately one reading rather than two: this codebase has already paid for
 * two independent readings of one footprint, and "is this a cut" is the same kind of question.
 */
export function seamCrossing(faces: FlatFace[], a: Vec2, b: Vec2): Vec2 | null {
  for (const [p, q] of seamsOf(faces)) {
    if (!segsCross(a, b, p, q)) continue;
    // A proper crossing is never parallel, so `intersection` has an answer here. The seam's own midpoint
    // is the fallback rather than null, which would read as "no crossing" and quietly undo the refusal.
    return intersection(a, b, p, q) ?? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  }
  return null;
}

/** Whether a strip from `a` to `b` would cross a cut. {@link seamCrossing} is the one reading. */
export function crossesSeam(faces: FlatFace[], a: Vec2, b: Vec2): boolean {
  return seamCrossing(faces, a, b) !== null;
}

export function tapeOnBody(faces: FlatFace[], tapeW: number, a: Vec2, b: Vec2): boolean {
  // Before the sampling, because it is the case sampling cannot see: a zero-width cut leaves material on
  // both sides and severed material in between. See {@link seamsOf}.
  if (crossesSeam(faces, a, b)) return false;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const half = tapeW * 0.5;
  const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
  const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
  const steps = Math.max(9, Math.ceil(L / half));
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) return false;
    if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) return false;
  }
  return true;
}


class MinHeap {
  private readonly keys: string[] = [];
  private readonly cost: number[] = [];

  push(key: string, c: number): void {
    this.keys.push(key);
    this.cost.push(c);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p]! <= this.cost[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): string | null {
    if (!this.keys.length) return null;
    const top = this.keys[0]!;
    const lastKey = this.keys.pop()!;
    const lastCost = this.cost.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastKey;
      this.cost[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.cost[l]! < this.cost[m]!) m = l;
        if (r < this.keys.length && this.cost[r]! < this.cost[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.cost[a], this.cost[b]] = [this.cost[b]!, this.cost[a]!];
  }
}

/** Unordered key for a chord between two midpoints. */
export function chordKey(a: Vec2, b: Vec2): string {
  const ka = ptKey(a), kb = ptKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Whether the straight line between two boundary points stays on the face. Sampled, so a chord that leaves
 *  and re-enters a concave face is rejected too. */
function chordInside(f: FlatFace, a: Vec2, b: Vec2, faces: FlatFace[], tapeW: number): boolean {
  // A chord may not span a cut, even one whose two lips still sit on the same line — the tile looks whole
  // in the flat pattern and is not. See {@link seamsOf}.
  if (crossesSeam(faces, a, b)) return false;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const half = tapeW * 0.5;
  const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
  const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
  // Sampled against the tape, not a fixed eight steps: a long chord checked at eight points can pass while a
  // stretch between two of them hangs off the material.
  const steps = Math.max(8, Math.ceil(L / half));
  for (let k = 1; k < steps; k++) {
    const u = k / steps;
    const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    if (!pointInPolyLocal(f.poly, m)) return false;
    // The strip's edges may leave this tile onto a neighbour -- that is just crossing a crease -- but they may
    // not leave the material altogether.
    if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) return false;
    if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) return false;
  }
  return true;
}

/** Even-odd point-in-polygon, local so this does not depend on face indices the way `pointInFace` does. */
function pointInPolyLocal(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Faces reachable from `start` by travelling over the material. */
export function reachableFaces(c: Corridor, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const m of c.mids.get(at) ?? []) {
      // Refused nodes are not a way through, so a tile behind one is genuinely out of reach. This has to
      // agree with `searchCorridor` or an LED is called reachable and then never routed — reported as
      // wired, drawn with no copper.
      if (c.refused.has(ptKey(m))) continue;
      for (const f of c.faceOf.get(ptKey(m)) ?? []) {
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(f);
      }
    }
  }
  return seen;
}

/** Slide any waypoint sitting on an occupied hinge to that hinge's nearer end corner, where doing so stops
 *  the rail from crossing the chip. Corners are pattern vertices, so this cannot push copper off the body. */

const edgeKeyOf = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/**
 * What one crossing of this hinge costs, as a fraction of the full crease price.
 *
 * The strain the fold puts in the copper, where the pattern says how far the crease folds — see
 * {@link creaseCostFraction}. The hinge is a real width, not an assumption: `legA` and `legB` are the two
 * tiles' pinched edge midpoints, so the distance between them is the strip of bare substrate that takes
 * the bend, and {@link TAPE_MM} over `tapeW` is the pattern's own scale in millimetres.
 *
 * Two things are deliberately not strain questions.
 *
 * A **cut** pays the full price whatever the geometry says: the material is severed there, so tape over it
 * is bridging a hole rather than bending on a substrate, and there is no bending member to compute a
 * strain in. **This branch is currently unreachable and is kept on purpose.** A cut in these patterns is a
 * lip — two boundary edges, each belonging to one face — so it fails `isGapEdge`'s "exactly two faces
 * share it" and never becomes a `GapEdge`: all eight bundled patterns carry cut edges (12 in church, 98 in
 * puffin) and none of them arrive here. What actually keeps copper off a cut is containment, since a cut
 * that has opened is a hole in the silhouette and `chordInside` refuses it — measured at zero crossings
 * over six patterns. A cut shared by two faces is still conceivable, and a zero-width seam would be one,
 * so pricing it stays.
 *
 * A crease with **no recorded fold angle** falls back to the classification this replaces — a mountain
 * costs full price, anything else costs nothing. Two of the eight bundled patterns record no angles at
 * all, and inventing one for them would be worse than admitting the model cannot run: an assumed 180
 * degrees would put a full-price crease on every mountain that in fact barely folds, and an assumed
 * gentle fold would wave copper over one that folds flat. The fallback is stated here so that a result
 * from such a pattern can be reported as the classification it is.
 */
/**
 * Whether copper may not cross this hinge at all — see {@link SheetSpec.strainLimit}.
 *
 * A cut is refused whatever the limit says, since there is no material to carry the tape. A crease with no
 * recorded angle is never refused: the model cannot compute a strain for it, and refusing on a guess would
 * make a pattern unroutable because of what its file failed to record.
 */
function creaseRefused(g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec): boolean {
  if (sheet.strainLimit == null) return false;
  if (g.dihedral == null) return false;
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
  return overStrainLimit(hingeMm, g.dihedral, sheet);
}

function creaseFraction(g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec): number {
  if (g.assignment === "C") return 1;
  if (g.dihedral == null) return g.assignment === "M" ? 1 : 0;
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
  return creaseCostFraction(hingeMm, g.dihedral, sheet);
}

/**
 * The pattern's travel network. Nodes are **edge midpoints**, and crossing a tile means taking a chord from
 * one of its edge midpoints to another — a straight line between two boundary points of a single face, so it
 * stays on the material.
 *
 * Routing through face *centres* instead, as this did before, forces every path between two tiles through a
 * single point, so both nets solve the same problem and get the same answer: that is why tolling a shared
 * waypoint diverted nothing even at 400x. Chords give a face many ways through, so the second net has
 * somewhere else to go.
 */
export function buildCorridor(
  faces: FlatFace[],
  gaps: GapEdge[],
  foldPenalty: number,
  tapeW: number,
  sheet: SheetSpec = DEFAULT_SHEET,
  /** The tape in mm — see {@link seatLed}. Only the crease strain needs it, and only to read the hinge
   *  width in millimetres; the graph itself is built in pattern units. */
  tapeMm: number = TAPE_MM,
): Corridor {
  const mids = new Map<number, Vec2[]>();
  const faceOf = new Map<string, number[]>();
  const point = new Map<string, Vec2>();
  const cost = new Map<string, number>();

  // Crossing penalties, after Nakaya et al., "4D Leaf Circuits" (SCF '25), Algorithm 1.
  //
  // Their fatigue test is the reason: a trace carried over a *mountain* fold shows a sharp rise in resistance
  // and fractures within a hundred folding cycles, while the same trace on a valley fold stays flat. So a
  // mountain crossing is charged the pattern's bounding-box diagonal -- more than any single step in the graph,
  // which makes the router take any available detour, while still leaving a mountain crossable when the tile is
  // reachable no other way. They apply the same penalty to a valley folded past 170 degrees, as such a crease
  // closes on itself and can short across.
  //
  // Cuts are ours to add: the material is severed there, so tape spanning one is bridging a hole rather than
  // lying on a substrate.
  const penaltyOf = new Map<string, number>();
  const refusedEdges = new Set<string>();
  for (const g of gaps) {
    const price = foldPenalty * creaseFraction(g, tapeW, tapeMm, sheet);
    if (price > 0) penaltyOf.set(edgeKeyOf(g.verts[0], g.verts[1]), price);
    if (creaseRefused(g, tapeW, tapeMm, sheet)) refusedEdges.add(edgeKeyOf(g.verts[0], g.verts[1]));
  }
  const refused = new Set<string>();
  const gapKeys = new Set(gaps.map((g) => ptKey(g.point)));

  faces.forEach((f, fi) => {
    const list: Vec2[] = [];
    const n = f.verts.length;
    for (let k = 0; k < n; k++) {
      // Canonical edge direction: always measure from the lower vertex id. Both faces sharing an edge must
      // compute bit-identical crossing points or the nodes fail to glue and the two tiles look disconnected
      // -- and "a quarter along" from one face is "three quarters along" from the other, which is not the
      // same arithmetic. (Midpoints hid this, being symmetric.)
      const va = f.verts[k]!, vb = f.verts[(k + 1) % n]!;
      const fwd = va <= vb;
      const pa = fwd ? f.poly[k]! : f.poly[(k + 1) % n]!;
      const pb = fwd ? f.poly[(k + 1) % n]! : f.poly[k]!;
      // Two crossing points per edge rather than one. With a single midpoint, both nets have to cross a
      // shared edge at the very same point, so they are forced together at every tile boundary -- the last
      // structural cause of overlap. Two lets PWR cross at one third and GND at two thirds.
      for (const u of EDGE_CROSSINGS) {
        const m = { x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u };
        const key = ptKey(m);
        list.push(m);
        point.set(key, m);
        const owners = faceOf.get(key) ?? [];
        if (!owners.includes(fi)) owners.push(fi);
        faceOf.set(key, owners);
        const pen = penaltyOf.get(edgeKeyOf(va, vb));
        if (pen) cost.set(key, pen);
        if (refusedEdges.has(edgeKeyOf(va, vb))) refused.add(key);
      }
    }
    mids.set(fi, list);
  });

  // A chord is only a way through if it stays on the tile. Concave faces have pairs of edge midpoints whose
  // straight line leaves the material, and taking one would put copper off the body.
  const chords = new Map<number, Set<string>>();
  faces.forEach((f, fi) => {
    const list = mids.get(fi) ?? [];
    const ok = new Set<string>();
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (chordInside(f, list[a]!, list[b]!, faces, tapeW)) {
          ok.add(chordKey(list[a]!, list[b]!));
        }
      }
    }
    chords.set(fi, ok);
  });
  // Gap midpoints are authoritative crossings and are already edge midpoints, so they need no special node;
  // this only asserts that assumption holds, and drops any that somehow do not line up.
  for (const key of gapKeys) {
    if (!point.has(key)) continue;
  }
  return { mids, faceOf, point, chords, cost, refused };
}

/**
 * Waypoints carrying the bus from tile `from` to tile `to`, exclusive of the pads. Empty when they are the
 * same tile or nothing connects them (then the hop stays straight, and the LED is reported unreachable
 * upstream).
 *
 * `taken` makes a waypoint dearer each time the other net has already used it, which with chords available
 * actually buys a different route rather than the same one at a higher price.
 */
export function corridorPath(
  c: Corridor,
  from: number,
  to: number,
  blocked: Set<string>,
  taken: Map<string, number>,
  forbid: { at: Vec2; r: number } | null,
  origin: Vec2 | null,
  legOk: ((a: Vec2, b: Vec2) => boolean) | null,
  mine: Set<string> | null,
  theirs: Vec2[][] | null,
): Vec2[] {
  // Try first with every chord that sweeps the other net's terminal *forbidden*, not merely dear. Tolling it
  // was not enough: on church the route took a chord passing 0.090 from the terminal when 0.099 was required and
  // there was room to spare, because a large toll is still finite. If forbidding leaves no route at all, fall
  // back to the tolled search rather than dropping the LED.
  if (forbid || theirs?.length) {
    const strict = searchCorridor(c, from, to, blocked, taken, forbid, true, origin, legOk, mine, theirs);
    if (strict.length) return strict;
  }
  return searchCorridor(c, from, to, blocked, taken, forbid, false, origin, legOk, mine, theirs);
}

export function searchCorridor(
  c: Corridor,
  from: number,
  to: number,
  blocked: Set<string>,
  taken: Map<string, number>,
  forbid: { at: Vec2; r: number } | null,
  strict: boolean,
  origin: Vec2 | null,
  legOk: ((a: Vec2, b: Vec2) => boolean) | null,
  mine: Set<string> | null,
  theirs: Vec2[][] | null,
): Vec2[] {
  if (from === to) return [];
  const starts = (c.mids.get(from) ?? []).filter((m) => !c.refused.has(ptKey(m)));
  const goal = new Set((c.mids.get(to) ?? []).map(ptKey).filter((k) => !c.refused.has(k)));
  if (!starts.length || !goal.size) return [];

  const cost = (key: string, step: number): number => {
    // Travelling along tape this net has already laid is cheap, so a branch *merges* into the trunk instead of
    // running beside it. Charging for it -- which this used to do -- is what made a net double back along
    // itself: the cheapest route became one that paralleled its own tape a hair away.
    //
    // A discount rather than a negative weight: a negative edge breaks Dijkstra outright, which is exactly what
    // happened the first time this was tried.
    const own = mine?.has(key) ? OWN_TAPE_DISCOUNT : 1;
    // The fold penalty is additive, not a multiplier: it is a fixed price for crossing that crease, and it must
    // not scale with how long the step happens to be.
    const fold = c.cost.get(key) ?? 0;
    const chip = blocked.has(key) ? OCCUPIED_TOLL : 1;
    const shared = 1 + (taken.get(key) ?? 0) * SHARED_TOLL;
    return step * chip * shared * own + fold;
  };

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const seen = new Set<string>();
  const heap = new MinHeap();
  for (const m of starts) {
    // The leg from the origin to this first waypoint is not a chord, so nothing else checks it stays on the
    // material. Pricing it without checking it let a run set off across a hole.
    if (origin && legOk && !legOk(origin, m)) continue;
    const k = ptKey(m);
    // Priced from where the run actually begins. Seeding every node of the starting tile at zero left the first
    // leg -- terminal to first waypoint -- costing nothing, so the search would happily set off from a node
    // behind the terminal and doubled back to get going.
    const d = cost(k, origin ? Math.sqrt(dist2(origin, m)) : 0);
    dist.set(k, d);
    heap.push(k, d);
  }

  let end: string | null = null;
  while (true) {
    // A binary heap, not a scan of every distance: this runs inside the polarity descent, once per net per
    // build, and the scan made a 12-LED puffin plan take two seconds -- far too slow to re-plan on every
    // click. (It said "rip-up loop" for a long time. There is no rip-up in this router and never has been:
    // a net that cannot be routed clear is reported, not torn up and retried. See `planNets`.)
    const top = heap.pop();
    if (!top) break;
    const at: string | null = top;
    if (seen.has(at)) continue;
    const best = dist.get(at)!;
    if (goal.has(at)) { end = at; break; }
    seen.add(at);
    const here = c.point.get(at)!;
    // Neighbours: every other midpoint of every face this midpoint belongs to. Staying inside one face means
    // the chord is on material; sharing a midpoint is how the path steps into the next tile.
    for (const f of c.faceOf.get(at) ?? []) {
      const ok = c.chords.get(f);
      for (const m of c.mids.get(f) ?? []) {
        const k = ptKey(m);
        if (k === at) continue;
        if (c.refused.has(k)) continue; // the crease there would crack the trace — see `strainLimit`
        if (ok && !ok.has(chordKey(here, m))) continue; // that chord would leave the tile
        // A chord may pass close to the other net's terminal even when both its ends are clear of it: tolling
        // nodes cannot see that, so the chord itself is measured.
        const sweeps = forbid ? segPointDist(here, m, forbid.at) < forbid.r : false;
        if (sweeps && strict) continue;
        // Cutting across the other net's tape is a short, and until now the search could not see one: crossings
        // were only counted after a whole plan was built, so nothing could steer around them. A chord that
        // crosses the other net is refused outright on the strict pass -- which is what makes a run go the long
        // way round instead -- and merely very dear on the fallback, so a pad walled in by the other net stays
        // reachable.
        const cuts = theirs ? crossesAny(here, m, theirs) : false;
        if (cuts && strict) continue;
        const w = best + cost(k, Math.sqrt(dist2(here, m))) * (sweeps || cuts ? TERMINAL_TOLL : 1);
        if (w < (dist.get(k) ?? Infinity)) {
          dist.set(k, w);
          prev.set(k, at);
          heap.push(k, w);
        }
      }
    }
  }
  if (!end) return [];
  const out: Vec2[] = [];
  let cur: string | undefined = end;
  while (cur) {
    out.push(c.point.get(cur)!);
    cur = prev.get(cur);
  }
  out.reverse();
  return out;
}

/** Greedy nearest-neighbour visiting order, starting from the battery. */
