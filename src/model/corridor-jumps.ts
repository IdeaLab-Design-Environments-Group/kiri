/**
 * **Model** — the hops the corridor may take *across a cut*, because the folded artifact rejoins it.
 *
 * ## Why this is its own file
 *
 * `corridor.ts` builds the graph copper may travel on in the **flat** pattern, and every gate in it —
 * `chordInside`, `tapeOnBody`, `seamsOf` — is right to refuse a step across a cut: the sheet really is
 * severed there and a planar polyline over it is not copper, it is a gap. A **jump** is the other
 * statement: the two lips of that cut are one edge in the folded artifact (`fold-adjacency.ts`), and a
 * short wire soldered by hand after folding joins them. So a jump is not a trace and never becomes one.
 * It is a link in the search graph with two properties no bridge has — **its flat length is never
 * charged**, because the flat distance between two lips is meaningless (up to 300 units on
 * desk-lamp-shade, and 0 mm folded), and it carries **no strain band**, because there is no substrate
 * bending under it.
 *
 * Reusing `Corridor.bridges` rather than a second map is what keeps `reachableFaces` and the path
 * reconstruction untouched: they already union every hop out of a node, and a jump is one more. Only
 * the relaxation in `searchCorridor` has to tell them apart, on `CorridorBridge.kind`.
 *
 * ## Why it does not import `corridor.ts`
 *
 * It would be a runtime import cycle — `corridor.ts` calls {@link addJumpLinks} from `buildCorridor` —
 * and R11 forbids those in `model/`. So the two small pieces this needs from there, the nudge onto
 * material and the node registration, are restated below rather than imported. That is the same trade
 * `corridor.ts › bboxDiag` already makes against `trace-geometry.ts › patternDiag`.
 *
 * ## Measured
 *
 * `scripts/_jump-audit.ts`, 388 cases over the bundled corpus (`docs/fold-adjacent-routing.md` has the
 * whole table). desk-lamp-shade's rim net falls from **286.9 to 23.5** pattern units on **one** jump.
 * Five of house's nine seams are rejoined at least once over two to five nets, and the other four never
 * pay: every lip pair on that pattern lies less than five units apart in the flat sheet, so going round
 * is usually cheaper than the toll. Across the whole sweep `countNetCrossings` is **0 with the adjacency
 * and 0 without**, and `countJumpClashes` is **0** — the planar guarantee is untouched, which is the
 * measured half of the exemption argued on `route-metrics.ts › countJumpClashes`.
 */
import { type FlatFace, type Vec2, pointInFace } from "./electronics.js";
import type { Corridor, CorridorBridge } from "./trace-types.js";
import type { FoldAdjacency } from "./fold-adjacency.js";
import { add, len, ptKey, scale, sub, unit } from "./trace-geometry.js";

/**
 * What one hop across a rejoined cut costs, in pattern diagonals.
 *
 * Bracketed from both sides rather than fitted. **Above one fatiguing crease** — the dearest single
 * crossing the corridor prices is `FOLD_PENALTY_FRAC` (`tape-width.ts`), half a diagonal — so a route
 * that could stay on the material and cross one bad crease still does, and a jump is not a way of
 * dodging a mountain fold. **Far below a bridge** (`corridor.ts › BRIDGE_TOLL_DIAGS`, twenty diagonals,
 * a deliberate last resort): a bridge is tape hanging over a hole and a jump is a wire the builder
 * solders, so a jump is an ordinary option and a bridge is not.
 *
 * One diagonal is also, by construction, **the most a jump can ever save**: the longest route the
 * corridor can offer between two points of one pattern is bounded by its bounding-box diagonal, so at
 * this price a jump is taken only where going round genuinely costs more than the whole sheet's width,
 * and never merely to shave a corner.
 *
 * **Swept** by `scripts/_jump-sweep.ts`: six patterns, two to four two-terminal nets straddling the
 * most-separated lip pairs, at 0.25, 0.5, 1, 2, 5 and 20 diagonals, against `off` — no adjacency, the
 * router that was here before jumps. The whole priced range gives one answer on every case, so it
 * collapses to a single row; `countJumpClashes` is 0 throughout and no two nets come within a tape width.
 *
 * | model | nets | toll | stranded | jumps | copper |
 * | --- | --- | --- | --- | --- | --- |
 * | desk-lamp-shade | 2 | off | 0 | 0 | 617.0 |
 * | desk-lamp-shade | 2 | 0.25–20 | 0 | 2 | 26.6 |
 * | desk-lamp-shade | 3 | off | 1 | 0 | 617.0 |
 * | desk-lamp-shade | 3 | 0.25–20 | 0 | 3 | 38.9 |
 * | desk-lamp-shade | 4 | off | 2 | 0 | 617.0 |
 * | desk-lamp-shade | 4 | 0.25–20 | 0 | 4 | 50.1 |
 * | house | 2 | off | 1 | 0 | 4.9 |
 * | house | 2 | 0.25–20 | 0 | 2 | 3.7 |
 * | house | 3 | off | 1 | 0 | 8.7 |
 * | house | 3 | 0.25–20 | 1 | 2 | 3.7 |
 * | house | 4 | off | 2 | 0 | 8.7 |
 * | house | 4 | 0.25–20 | 2 | 2 | 3.6 |
 * | puffin | 2 | off | 0 | 0 | 366.5 |
 * | puffin | 2 | 0.25–20 | 0 | 2 | 22.3 |
 * | puffin | 3 | off | 0 | 0 | 519.5 |
 * | puffin | 3 | 0.25–20 | 0 | 3 | 36.8 |
 * | puffin | 4 | off | 0 | 0 | 620.0 |
 * | puffin | 4 | 0.25–20 | 0 | 4 | 50.4 |
 * | church | 2 | off | 0 | 0 | 6.1 |
 * | church | 2 | 0.25–20 | 0 | 3 | 4.4 |
 * | church | 3 | off | 1 | 0 | 3.6 |
 * | church | 3 | 0.25–20 | 0 | 5 | 7.2 |
 * | thermometer-tube | 2 | off | 0 | 0 | 181.3 |
 * | thermometer-tube | 2 | 0.25–20 | 0 | 2 | 16.9 |
 * | thermometer-tube | 3 | off | 0 | 0 | 271.9 |
 * | thermometer-tube | 3 | 0.25–20 | 0 | 3 | 25.3 |
 * | thermometer-tube | 4 | off | 0 | 0 | 362.6 |
 * | thermometer-tube | 4 | 0.25–20 | 0 | 4 | 33.8 |
 * | akde-hex | 2 | off | 0 | 0 | 143.0 |
 * | akde-hex | 2 | 0.25–20 | 0 | 0 | 143.0 |
 * | akde-hex | 3 | off | 0 | 0 | 214.6 |
 * | akde-hex | 3 | 0.25–20 | 0 | 0 | 214.6 |
 * | akde-hex | 4 | off | 0 | 0 | 286.1 |
 * | akde-hex | 4 | 0.25–20 | 0 | 0 | 286.1 |
 *
 * The plateau is the entire swept range, on every pattern and every net count: 0.25 and 20 give the same
 * plan as 1.0, which is why this constant is stated as a choice from a range and not as a fitted value.
 * Twenty diagonals — a bridge's price, meant to make a hop a last resort — never stops the hop being
 * taken, because the alternative it is weighed against is not a detour but the long way round a severed
 * sheet: 617 units and a hundred priced creases on desk-lamp-shade against 27 with the jump, and on the
 * cases where going round *is* cheap (akde-hex, whose lips are 23 units apart) no jump is taken even at
 * 0.25. What the price decides here is nothing; what decides the route is whether the hop exists at all.
 */
export const JUMP_TOLL_DIAGS = 1.0;

/**
 * Where along each lip a jump may land: the same quarter points a hinge is crossed at
 * (`corridor.ts › EDGE_CROSSINGS`), and for the same reason — two places rather than one, so two nets
 * can rejoin the same cut on separate lands, and off the middle so neither is favoured.
 *
 * The **same** `u` is used on both lips, which is the whole reason `fold-adjacency.ts` carries the
 * ordered correspondence `lipA[i] ↔ lipB[i]`: same parameter, same point on the folded edge. That is
 * also what makes a router-emitted jump pass `jump-rules.ts › JUMP_SKEW_TAPES`, which refuses ends
 * skewed along the seam by more than a tape width.
 */
const EDGE_CROSSINGS = [1 / 4, 3 / 4];

/** `p`, moved a hair toward the face's centroid — off its boundary line and unambiguously inside it.
 *  `corridor.ts › nudgeInto`, restated here rather than imported; see the file docblock. */
function nudgeInto(p: Vec2, f: FlatFace): Vec2 {
  const toC = sub(f.centroid, p);
  const d = len(toC);
  if (d < 1e-12) return p;
  return add(p, scale(unit(toC), d * 1e-6));
}

/**
 * Register `p` as a waypoint of face `fi`, exactly as the bridge block in `buildCorridor` registers a
 * lip node: new points join that face's `mids` (so the chord loop, which runs after this, gives them a
 * way to the rest of their tile), and a point that already exists — a lip node can land on the very
 * edge-crossing node the boundary edge already carries — simply gains an owner.
 *
 * No `cost` and no `band` entry: a jump node sits on material, and the price of the hop is on the link,
 * not on its ends.
 */
function addNode(c: Corridor, fi: number, p: Vec2): string {
  const key = ptKey(p);
  if (!c.point.has(key)) {
    c.point.set(key, p);
    c.mids.get(fi)?.push(p);
  }
  const owners = c.faceOf.get(key) ?? [];
  if (!owners.includes(fi)) owners.push(fi);
  c.faceOf.set(key, owners);
  return key;
}

/** One direction of a jump. Symmetric pairs are added by the caller, as bridges are. */
function link(c: Corridor, from: string, to: string, price: number, pair: number): void {
  const list = c.bridges.get(from) ?? [];
  if (!list.some((l) => l.to === to)) list.push({ to, price, band: 0, kind: "jump", pair });
  c.bridges.set(from, list);
}

/**
 * Add the seam-rejoin hops for `adjacency` to a corridor under construction.
 *
 * Two nodes per pair per lip — {@link EDGE_CROSSINGS} — linked in both directions. Called from
 * `buildCorridor` **after** the bridge block and **before** the chord loop, so the new nodes are chorded
 * to the rest of their own tile the way bridge nodes are; calling it later would leave them stranded on
 * their lip.
 *
 * A pair is skipped when either nudged node lands off the material (`pointInFace` < 0). That is the
 * point form of `corridor.ts › tapeOnBody`'s question and all a node needs: the *link* spans no
 * material by definition, so there is nothing else about it to test. It happens where a "lip" the weld
 * paired is degenerate or where the flat pattern places the two lips of one cut on top of each other,
 * and skipping is the honest answer — a land cannot be soldered onto material that is not there.
 *
 * `bandCap` is taken and not used: a jump carries band 0 whatever the cap, since there is no substrate
 * bending under a soldered wire. It is in the signature so that a future graded jump — a rejoin whose
 * lands sit on a crease, say — has somewhere to read the cap from without changing every caller.
 */
export function addJumpLinks(
  c: Corridor,
  faces: FlatFace[],
  adjacency: FoldAdjacency,
  diag: number,
  bandCap: number,
  tollDiags: number = adjacency.tollDiags ?? JUMP_TOLL_DIAGS,
): void {
  void bandCap;
  const price = tollDiags * diag;
  adjacency.pairs.forEach((pair, p) => {
    const fa = faces[pair.faceA], fb = faces[pair.faceB];
    if (!fa || !fb) return;
    for (const u of EDGE_CROSSINGS) {
      const pa = nudgeInto(add(pair.lipA[0], scale(sub(pair.lipA[1], pair.lipA[0]), u)), fa);
      const pb = nudgeInto(add(pair.lipB[0], scale(sub(pair.lipB[1], pair.lipB[0]), u)), fb);
      if (pointInFace(faces, pa) < 0 || pointInFace(faces, pb) < 0) continue;
      const ka = addNode(c, pair.faceA, pa);
      const kb = addNode(c, pair.faceB, pb);
      if (ka === kb) continue; // a degenerate pair whose two lips round to one node: no hop to make
      link(c, ka, kb, price, p);
      link(c, kb, ka, price, p);
    }
  });
}

/** The jump linking two node keys, if the corridor has one — the reading `net-routing.ts` splits a path
 *  on, and what a test uses to say where a route left the sheet. Bridges are not jumps and read null. */
export function jumpHopBetween(c: Corridor, from: string, to: string): CorridorBridge | null {
  for (const b of c.bridges.get(from) ?? []) {
    if (b.to === to && b.kind === "jump") return b;
  }
  return null;
}
