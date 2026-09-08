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
import type { Corridor, CorridorBridge } from "./trace-types.js";
import {
  DEFAULT_SHEET,
  creaseCostFraction,
  foldStrain,
  traceformCreaseFraction,
  STRAIN_BAND_CAP,
  strainBand,
  overStrainLimit,
  type SheetSpec,
} from "./fold-strain.js";
import { FOLD_PENALTY_FRAC, TAPE_MM, bridgeSpanFor } from "./tape-width.js";
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
/** Weight of one severity band when band and cost are packed into a single heap priority. Far above any
 *  reachable path cost, so a lower band always sorts first and cost only breaks ties within a band. */
const BAND_STRIDE = 1e12;


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

/**
 * Whether a strip of tape from `a` to `b` can be laid on the material — or, given a `bridgeW`
 * ({@link bridgeSpanFor}), bridging an opening no wider than that. Never across a zero-width seam.
 *
 * Strict by default. The router asks this of the legs it does not search — the first hop out of a terminal,
 * the escape past the other net's terminal — and those must stay on the sheet: the only copper it lays over
 * air is a bridge hop between two lips, priced as such in `buildCorridor`. A hand-drawn wire is held to the
 * bridging allowance instead, by `wire-rules.ts`, which passes it.
 */
export function tapeOnBody(faces: FlatFace[], tapeW: number, a: Vec2, b: Vec2, bridgeW = 0): boolean {
  // Before the sampling, because it is the case sampling cannot see: a zero-width cut leaves material on
  // both sides and severed material in between. See {@link seamsOf}.
  if (crossesSeam(faces, a, b)) return false;
  return tapeOffBodyAt(faces, tapeW, a, b, bridgeW) === null;
}

/**
 * Where a strip from `a` to `b` first hangs off the material — for longer than `bridgeW`, when one is given —
 * or null if it never does. The seam reading is {@link crossesSeam}'s and is not repeated here.
 *
 * The strip is read along its centreline and both edges, so tape tracking a boundary with its centre on the
 * sheet and half its width off it is caught. With an allowance, each line may leave the material for up to
 * `bridgeW` of its length and land again — that is copper spanning a narrow opening — but a stretch that
 * reaches either end of the segment is not a bridge, since there is no far bank for it to land on.
 */
export function tapeOffBodyAt(faces: FlatFace[], tapeW: number, a: Vec2, b: Vec2, bridgeW = 0): Vec2 | null {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const half = tapeW * 0.5;
  const nx = L < 1e-12 ? 0 : (-(b.y - a.y) / L) * half;
  const ny = L < 1e-12 ? 0 : ((b.x - a.x) / L) * half;
  const steps = Math.max(9, Math.ceil(L / half));
  if (!(bridgeW > 0)) {
    // The strict reading, sampled exactly as it always was: the first sample with nothing under either
    // edge of the tape is the answer.
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) return m;
      if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) return m;
    }
    return null;
  }
  const coarse = L / steps;
  for (const [ox, oy] of [[0, 0], [nx, ny], [-nx, -ny]] as const) {
    const p = { x: a.x + ox, y: a.y + oy }, q = { x: b.x + ox, y: b.y + oy };
    const off = offBodyRun(faces, p, q, coarse, bridgeW, true);
    if (off) return { x: off.x - ox, y: off.y - oy }; // reported on the centreline, where the author drew it
  }
  return null;
}

/**
 * The first point on `ab` where the line leaves the material for longer than `allow`, or null.
 *
 * Sampled at `coarse` steps as {@link tapeOnBody} always has been, which is cheap enough to run for every
 * chord of every face at corridor build. Only where a sample is off the sheet is the run around it walked
 * at a fine step, both ways, until it lands again or has already exceeded the allowance — so the cost of the
 * finer reading is paid only over holes. An opening narrower than a coarse step can slip between two samples
 * unseen, as it always could, and every such opening is well inside the allowance anyway.
 *
 * `ends` says whether the segment's own endpoints are sampled. A chord between two edge nodes excludes them
 * (its ends sit on edges by construction); a hand wire includes them. A run that reaches an end of the
 * segment is refused whatever its length when `ends` is set — tape ending in mid-air is not a bridge — and
 * judged by its length like any other when it is not.
 */
export function offBodyRun(
  faces: FlatFace[], a: Vec2, b: Vec2, coarse: number, allow: number, ends: boolean,
): Vec2 | null {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const at = (t: number): Vec2 => (L < 1e-12 ? a : { x: a.x + ((b.x - a.x) * t) / L, y: a.y + ((b.y - a.y) * t) / L });
  const off = (t: number): boolean => pointInFace(faces, at(t)) < 0;
  if (L < 1e-12) return ends && off(0) ? a : null;
  const step = Math.min(coarse, L);
  const fine = Math.min(Math.max((allow > 0 ? allow : step) / 16, L * 1e-9), L / 8);
  const first = ends ? 0 : step, last = ends ? L : L - step;
  for (let t = first; t <= last + 1e-9 * L; t += step) {
    if (!off(t)) continue;
    // Walk the run out to where the material resumes, giving up as soon as it is longer than allowed.
    let lo = t, hi = t;
    while (lo - fine >= 0 && off(lo - fine)) {
      lo -= fine;
      if (hi - lo > allow) return at(t);
    }
    while (hi + fine <= L && off(hi + fine)) {
      hi += fine;
      if (hi - lo > allow) return at(t);
    }
    const reachesEnd = lo - fine < 0 || hi + fine > L;
    if (ends && reachesEnd) return at(t);
    // Back on material past the run; the next sample can start from there.
    t = hi + fine - step;
  }
  return null;
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
    // not leave the material altogether. Not even over an opening a bridge would span: a chord is travel
    // within one tile, and the only copper the router lays over air is a bridge hop between two lips.
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
      const onto = [...(c.faceOf.get(ptKey(m)) ?? [])];
      // And across any opened cut this node bridges — the tile on the far lip is reachable too.
      for (const b of c.bridges.get(ptKey(m)) ?? []) onto.push(...(c.faceOf.get(b.to) ?? []));
      for (const f of onto) {
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

function creaseBand(
  g: GapEdge,
  tapeW: number,
  tapeMm: number,
  sheet: SheetSpec,
  cap: number,
): number {
  // A cut is severed material, not a fold: it is always the worst thing a trace can cross, so it takes the top
  // band outright rather than being handed to the strain model, which has no dihedral to work from.
  if (g.assignment === "C") return cap;
  if (g.dihedral == null) return g.assignment === "M" ? cap : 0;
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
  return strainBand(hingeMm, g.dihedral, sheet, undefined, cap);
}

/** The largest tensile strain any crease in this pattern carries, for {@link traceformCreaseFraction}. */
function patternEpsMax(gaps: GapEdge[], tapeW: number, tapeMm: number, sheet: SheetSpec): number {
  let max = 0;
  for (const g of gaps) {
    if (g.dihedral == null) continue;
    const eps = foldStrain(hingeMmOf(g, tapeW, tapeMm), g.dihedral, sheet);
    if (eps > max) max = eps;
  }
  return max;
}

function hingeMmOf(g: GapEdge, tapeW: number, tapeMm: number): number {
  const mmPerUnit = tapeW > 0 ? tapeMm / tapeW : 0;
  return Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
}

/**
 * `epsMax > 0` prices the crease as a graded fraction of the pattern's worst crossing; otherwise it
 * clips at the fatigue limit, which on these stacks is a threshold in all but name (see
 * {@link gradedCreaseFraction}). Closure is taken at full price either way -- a crease folded back on
 * itself can short, and that hazard is not a matter of degree.
 */
function creaseFraction(
  g: GapEdge, tapeW: number, tapeMm: number, sheet: SheetSpec, epsMax = 0,
): number {
  if (g.assignment === "C") return 1;
  if (g.dihedral == null) return g.assignment === "M" ? 1 : 0;
  const hingeMm = hingeMmOf(g, tapeW, tapeMm);
  if (epsMax > 0) {
    return traceformCreaseFraction(hingeMm, g.dihedral, epsMax, sheet);
  }
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
  /**
   * Cap for the crease severity bands the search minimises before it minimises cost — see
   * `fold-strain.ts › strainBand`. Zero switches bands off entirely and gives the pure cost ordering.
   *
   * **Off by default, because it is measured to do nothing here.** `scripts/bench-band.ts` routes all six
   * shipped patterns both ways: on the 0.4mm sheet every tension crossing is already past the copper's
   * fatigue strain, every band caps to the same value, and all six plan identically -- 0% change in
   * crossings and in copper. On a 0.05mm film the physics does move (house's worst band falls from 3 to 1
   * and three of its eleven crossings drop below fatigue) and the routes still do not.
   *
   * The reason looks structural rather than physical: this router works on a face-adjacency corridor -- face
   * centroids and two crossing points per edge, six gaps on `house` -- and an ordering can only exploit
   * routes that exist to choose between. The same algorithm on a ~17,000-node lattice cuts fatiguing
   * crossings by up to 100% (`traceformroutebench`). Switching it on here changes routes anyway, which broke
   * seven route-pinning tests for no measured gain, so it stays available and off.
   */
  bandCap: number = STRAIN_BAND_CAP,
  /**
   * Price creases as a graded fraction of this pattern's worst crossing rather than clipping at the
   * fatigue limit — see {@link gradedCreaseFraction}. Clipping arrives at 3.7 degrees of fold on a
   * 0.4mm substrate at a 1.5mm hinge, so every real crease sits at the ceiling and a 30 degree fold
   * and a 120 degree fold are charged alike; grading is what makes the signed strain model order
   * severity rather than merely detect it.
   */
  graded: boolean = true,
): Corridor {
  const epsMax = graded ? patternEpsMax(gaps, tapeW, tapeMm, sheet) : 0;
  const mids = new Map<number, Vec2[]>();
  const faceOf = new Map<string, number[]>();
  const point = new Map<string, Vec2>();
  const cost = new Map<string, number>();
  const band = new Map<string, number>();

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
  const bandOf = new Map<string, number>();
  const refusedEdges = new Set<string>();
  for (const g of gaps) {
    const price = foldPenalty * creaseFraction(g, tapeW, tapeMm, sheet, epsMax);
    if (price > 0) penaltyOf.set(edgeKeyOf(g.verts[0], g.verts[1]), price);
    if (bandCap > 0) {
      const b = creaseBand(g, tapeW, tapeMm, sheet, bandCap);
      if (b > 0) bandOf.set(edgeKeyOf(g.verts[0], g.verts[1]), b);
    }
    if (creaseRefused(g, tapeW, tapeMm, sheet)) refusedEdges.add(edgeKeyOf(g.verts[0], g.verts[1]));
  }
  const refused = new Set<string>();
  const gapKeys = new Set(gaps.map((g) => ptKey(g.point)));
  const bridgeW = bridgeSpanFor(tapeW, tapeMm);

  // How many faces name each edge: one means a lip or the sheet's boundary, two a hinge.
  const facesOn = new Map<string, number>();
  for (const f of faces) {
    const n = f.verts.length;
    for (let k = 0; k < n; k++) {
      const key = edgeKeyOf(f.verts[k]!, f.verts[(k + 1) % n]!);
      facesOn.set(key, (facesOn.get(key) ?? 0) + 1);
    }
  }

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
        const b = bandOf.get(edgeKeyOf(va, vb));
        if (b) band.set(key, b);
        if (refusedEdges.has(edgeKeyOf(va, vb))) refused.add(key);
      }
    }
    mids.set(fi, list);
  });

  // Bridges over opened cuts.
  //
  // A cut that has opened has no shared edge for a crossing node to sit on: it is two lips, one per face,
  // with a hole between them. Where that hole is narrower than the tape can span (`bridgeW`, five
  // millimetres by default), a node is placed on each lip and the two are linked, so the search can step
  // across the way it steps across a hinge. On a kirigami net the cuts open as wedges from the vertex the
  // two patches still share, so the bridgeable stretch is the end of the lip nearest that apex — which is
  // also where the opening closes again as the net folds, so the tape over it is never pulled.
  //
  // A last resort, not an option: tape over a hole is bridging air, not bending on a substrate, so a hop
  // costs {@link BRIDGE_TOLL_DIAGS} pattern diagonals — more than any route over creases can add up to —
  // and carries the top severity band. A tile is bridged to only when nothing else reaches it, and every
  // route that had a way over the material keeps it.
  const bridges = new Map<string, CorridorBridge[]>();
  if (bridgeW > 0) {
    const toll = BRIDGE_TOLL_DIAGS * bboxDiag(faces);
    const lips: { face: number; a: Vec2; b: Vec2 }[] = [];
    faces.forEach((f, fi) => {
      const n = f.verts.length;
      for (let k = 0; k < n; k++) {
        if (facesOn.get(edgeKeyOf(f.verts[k]!, f.verts[(k + 1) % n]!)) !== 1) continue;
        lips.push({ face: fi, a: f.poly[k]!, b: f.poly[(k + 1) % n]! });
      }
    });
    const addNode = (fi: number, p: Vec2): string => {
      const key = ptKey(p);
      if (!point.has(key)) {
        point.set(key, p);
        mids.get(fi)!.push(p);
      }
      const owners = faceOf.get(key) ?? [];
      if (!owners.includes(fi)) owners.push(fi);
      faceOf.set(key, owners);
      return key;
    };
    const link = (from: string, to: string): void => {
      const list = bridges.get(from) ?? [];
      if (!list.some((l) => l.to === to)) list.push({ to, price: toll, band: bandCap > 0 ? bandCap : 0 });
      bridges.set(from, list);
    };
    for (let i = 0; i < lips.length; i++) {
      for (let j = i + 1; j < lips.length; j++) {
        const A = lips[i]!, B = lips[j]!;
        if (A.face === B.face) continue;
        for (const [u, v] of bridgeSpans(A, B, bridgeW, faces)) {
          // Nudged a hair inside their own tiles, so that a point-in-face test lands each node on the tile it
          // belongs to rather than on the boundary line, where the even-odd test is a coin toss.
          const ka = addNode(A.face, nudgeInto(u, faces[A.face]!));
          const kb = addNode(B.face, nudgeInto(v, faces[B.face]!));
          link(ka, kb);
          link(kb, ka);
        }
      }
    }
  }

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
  return { mids, faceOf, point, chords, cost, band, refused, bridges };
}

/** How finely a lip is scanned for the stretch of it that faces the other lip within reach. */
const LIP_SAMPLES = 32;

/**
 * What one hop over an opened cut costs, in pattern diagonals.
 *
 * Far above the crease price (half a diagonal at most per crossing — `tape-width.ts › FOLD_PENALTY_FRAC`)
 * and far below `BAND_STRIDE`, so that a bridge loses to any route over the material and the band ordering
 * still works above it. Twenty is not calibrated against anything: it only has to be more creases than a
 * route on these patterns ever crosses.
 */
const BRIDGE_TOLL_DIAGS = 20;

/** The pattern's bounding-box diagonal — `electronics-routing.ts › patternDiag`, which cannot be imported
 *  here without a cycle. */
function bboxDiag(faces: FlatFace[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) for (const p of f.poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0;
}

/**
 * Where tape may cross from lip `A` to lip `B`: pairs of points, one on each lip, no further apart than
 * `bridgeW`, with nothing but air between them.
 *
 * The stretch of `A` within reach of `B` is found by sampling, and crossed at its quarter points the way a
 * hinge is crossed at {@link EDGE_CROSSINGS}: two places rather than one so the two rails need not share a
 * point, and off the middle for the same reason. Each point's mate is its foot on `B`, and the foot must
 * fall strictly within `B`: two lips that merely meet at a corner — the collinear boundary edges of two
 * tiles either side of a hinge, say — have every foot clamped to that corner, and the "opening" between them
 * is the boundary line itself, which a point-in-face test reads as off the sheet. A pair is also dropped
 * when the two points touch — that is a seam, not an opening, and seams are refused by {@link seamsOf} —
 * or when there is material between them, since then it is not a hole being bridged at all.
 */
function bridgeSpans(
  A: { a: Vec2; b: Vec2 }, B: { a: Vec2; b: Vec2 }, bridgeW: number, faces: FlatFace[],
): [Vec2, Vec2][] {
  const L = len(sub(A.b, A.a));
  if (L < 1e-12) return [];
  // The first stretch of A within reach of B, as a parameter range along A.
  let lo = -1, hi = -1;
  for (let k = 0; k <= LIP_SAMPLES; k++) {
    const t = k / LIP_SAMPLES;
    const p = add(A.a, scale(sub(A.b, A.a), t));
    const near = segPointDist(B.a, B.b, p) <= bridgeW;
    if (near && lo < 0) lo = t;
    if (near) hi = t;
    else if (lo >= 0) break;
  }
  if (lo < 0) return [];
  const out: [Vec2, Vec2][] = [];
  for (const q of EDGE_CROSSINGS) {
    const p = add(A.a, scale(sub(A.b, A.a), lo + (hi - lo) * q));
    const foot = footOnSeg(p, B.a, B.b);
    if (!foot) continue; // its perpendicular misses B: a corner contact or a lip that has swung past
    const span = len(sub(foot, p));
    if (span <= 1e-9 * L || span > bridgeW) continue;
    const mid = scale(add(p, foot), 0.5);
    if (pointInFace(faces, mid) >= 0) continue; // material between the lips: not a hole
    out.push([p, foot]);
  }
  return out;
}

/** The foot of the perpendicular from `p` onto segment `ab`, or null when it falls outside the segment. */
function footOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const d = sub(b, a);
  const l2 = d.x * d.x + d.y * d.y;
  if (l2 < 1e-24) return null;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2;
  if (t <= 1e-9 || t >= 1 - 1e-9) return null;
  return add(a, scale(d, t));
}

/** `p`, moved a hair toward the face's centroid — off its boundary line and unambiguously inside it. */
function nudgeInto(p: Vec2, f: FlatFace): Vec2 {
  const toC = sub(f.centroid, p);
  const d = len(toC);
  if (d < 1e-12) return p;
  return add(p, scale(unit(toC), d * 1e-6));
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

  // Bottleneck ordering.
  //
  // Fatigue is a max statistic: a trace fails at its single worst crossing, not at the sum of them. Ordering
  // purely on cost -- which is what this did, and what Nakaya et al.\'s rule does -- can only ever reduce how
  // *many* creases a run crosses, and leaves the worst one exactly where it was. So a route is compared first
  // on the worst crease band it crosses and only then on cost, which means among routes that are equally
  // survivable the cheapest still wins, and nothing changes at all on a pattern whose creases share one band.
  //
  // The two are packed into the one number the heap orders on. BAND_STRIDE is far above any reachable path
  // cost -- a pattern diagonal is a few hundred units and the dearest node multiplies a step by
  // OCCUPIED_TOLL -- so a lower band always sorts first and cost only ever breaks ties within a band.
  const banded = c.band.size > 0;
  const bandAt = (key: string): number => (banded ? (c.band.get(key) ?? 0) : 0);
  const pack = (worst: number, run: number): number => worst * BAND_STRIDE + run;

  const dist = new Map<string, number>();
  const worstOf = new Map<string, number>();
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
    const w = bandAt(k);
    if (pack(w, d) < pack(worstOf.get(k) ?? Infinity, dist.get(k) ?? Infinity)) {
      dist.set(k, d);
      worstOf.set(k, w);
      heap.push(k, pack(w, d));
    }
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
    const worst = worstOf.get(at) ?? 0;
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
        const nextWorst = Math.max(worst, bandAt(k));
        if (pack(nextWorst, w) < pack(worstOf.get(k) ?? Infinity, dist.get(k) ?? Infinity)) {
          dist.set(k, w);
          worstOf.set(k, nextWorst);
          prev.set(k, at);
          heap.push(k, pack(nextWorst, w));
        }
      }
    }
    // And across an opened cut, where this node sits on a lip narrow enough to bridge. The hop is priced
    // as a cut on top of its length, and carries a cut's severity band — see `buildCorridor`.
    for (const b of c.bridges.get(at) ?? []) {
      const k = b.to;
      const m = c.point.get(k);
      if (!m || c.refused.has(k)) continue;
      const cuts = theirs ? crossesAny(here, m, theirs) : false;
      if (cuts && strict) continue;
      const w = best + cost(k, Math.sqrt(dist2(here, m))) * (cuts ? TERMINAL_TOLL : 1) + b.price;
      const nextWorst = Math.max(worst, banded ? b.band : 0);
      if (pack(nextWorst, w) < pack(worstOf.get(k) ?? Infinity, dist.get(k) ?? Infinity)) {
        dist.set(k, w);
        worstOf.set(k, nextWorst);
        prev.set(k, at);
        heap.push(k, pack(nextWorst, w));
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
