/**
 * **Model** — whether a jump can actually be soldered.
 *
 * A jump is the one piece of copper in this program that is not a polyline: it joins the two lips of a cut
 * the unfolder made, which lie somewhere else entirely in the flat pattern and are the same edge in the
 * folded artifact. Nothing between its two ends is copper, so every planar reading `wire-rules.ts` makes —
 * containment, crossings, overlap — is meaningless on the span itself. What *is* copper is the two solder
 * **lands**: a stub of tape at each end, running from the end into its own face, that the builder joins with
 * a length of wire once the sheet is folded.
 *
 * So this module asks three questions and no others:
 *
 * - Do the two ends rest on material at all ({@link Jump} ends are author-placed points)? — `jump-unanchored`.
 * - Are they the two lips of **one** cut, at the **same place along** it? — `jump-not-adjacent`.
 * - Do the lands sit clear of every other net's copper? — `jump-land-clash`.
 *
 * The faults are {@link WireFault}s in `wire-rules.ts`'s registry, not a parallel vocabulary of their own:
 * the author sees one list of things wrong with the copper and does not care which reading found them, and
 * {@link isBuildable} is the one verdict that decides whether the sheet may be cut.
 *
 * Units are **flat pattern units** throughout, like `wire-rules.ts` and {@link Trace2D.pts} — never
 * millimetres. The millimetre constants enter through {@link weedFloorFor}, which converts them.
 */
import { pointInFace, type FlatFace, type Vec2 } from "./electronics.js";
import type { SheetSpec } from "./fold-strain.js";
import { pairContaining, type FoldAdjacency, type LipPairFlat } from "./fold-adjacency.js";
import { jumpLandTraces } from "./manual-jump.js";
import { gapNeeded, weedFloorFor } from "./net-clearance.js";
import { segNearSeg } from "./trace-geometry.js";
import type { Jump, Trace2D } from "./trace-types.js";
import type { WireFault } from "./wire-rules.js";

/**
 * How far along the seam the two ends may be offset, in tape widths, before they no longer meet.
 *
 * A jump's two ends land at parameters `uA` and `uB` along the two lips of one cut. The folded artifact
 * welds `lipA[i]` to `lipB[i]`, so the same `u` on both lips is the *same point* on the fold — and a
 * difference in `u` is a real distance the solder wire has to span *along* the closed seam, on top of
 * crossing it. One tape width is the allowance: less than that and the two lands are touching anyway once
 * the sheet is folded; much more and the author has drawn a jump between two places the folding never
 * brings together, whatever the topology says.
 *
 * **This must agree with the corridor's own lip nodes.** `corridor-jumps.ts` places its nodes at
 * `u ∈ {¼, ¾}` on *both* lips of a pair, so a router-emitted jump has `uA === uB` and zero skew by
 * construction, and passes this rule with room to spare. That agreement is the point of stating the
 * constant here rather than inlining a tape width: if the corridor is ever changed to offset its two nodes,
 * this is the number that says how far it may go.
 */
export const JUMP_SKEW_TAPES = 1;

/** Everything {@link checkJump} needs about the pattern the jump is drawn on. */
export interface JumpRuleContext {
  /** Which cuts the folding rejoins — the relation a jump is only allowed to follow. */
  adjacency: FoldAdjacency;
  /** The tape in this pattern's units, as `WireContext.tapeW`. Lands are one of these long. */
  tapeW: number;
  /** The same tape in millimetres, so the weed floor can be converted into pattern units. */
  tapeMm: number;
  /** The material, for the weed floor. */
  sheet: SheetSpec;
  faces: FlatFace[];
}

/**
 * Everything wrong with the jump `j`, given the copper in `routed` and the other jumps in `others`.
 *
 * `others` should not contain `j` itself; if it does, the same-net skip below drops it, since a jump always
 * shares its own net. `routed` is the copper as laid — the jump's own lands are **not** in it, and passing
 * them in would have every jump clash with itself.
 *
 * Unlike {@link checkWire} this is not a delta against the circuit as routed. It can afford not to be: a
 * jump's lands are two short stubs the author placed deliberately, so there is no pre-existing fault of the
 * router's to subtract, and every clash reported here is one this jump made.
 */
export function checkJump(
  j: Jump,
  ctx: JumpRuleContext,
  routed: Trace2D[],
  others: Jump[],
): WireFault[] {
  const faults: WireFault[] = [];
  const ends: Vec2[] = [j.a, j.b];
  const faceOf = ends.map((p) => pointInFace(ctx.faces, p));

  unanchored(j, ends, faceOf, faults);
  // Only when BOTH ends are on material: a lip is an edge of a face, so an end resting on no face has no
  // lip to be measured against, and reporting it as "not adjacent" would name a second problem the author
  // does not have. The unanchored warning already says what is wrong there.
  if (faceOf[0]! >= 0 && faceOf[1]! >= 0) notAdjacent(j, ctx, faults);
  landClash(j, ctx, ends, faceOf, routed, others, faults);

  return faults;
}

/**
 * The copper this jump actually lays, per end, or `null` for an end that lays none worth measuring.
 *
 * {@link jumpLandTraces} and never a local reconstruction: what the rule measures clearance around has to
 * be the same geometry the canvas draws and the exporter cuts, or a jump passes here and shorts on the
 * sheet. It returns both lands of every jump in `a`-then-`b` order, which is the order of `faceOf`.
 *
 * **An unanchored end's land is dropped here rather than measured.** `jumpLandTraces` emits one anyway —
 * deliberately, so the copper does not silently vanish from a jump the author can see — but it runs along
 * `+x` from a point that is on no material, so it is not in any meaningful position relative to the rest of
 * the sheet. Charging a clash against it would name a second problem on top of the `jump-unanchored` that
 * already says the real one.
 */
function landsOf(j: Jump, ctx: JumpRuleContext, faceOf: number[]): (Trace2D | null)[] {
  const lands = jumpLandTraces([j], ctx.tapeW, ctx.faces);
  return faceOf.map((fi, i) => (fi >= 0 ? lands[i] ?? null : null));
}

/** Ends resting on no face at all — the jump's `dangling`, and the reason the adjacency test is skipped. */
function unanchored(j: Jump, ends: Vec2[], faceOf: number[], out: WireFault[]): void {
  ends.forEach((p, i) => {
    if (faceOf[i]! >= 0) return;
    out.push({
      kind: "jump-unanchored",
      at: p,
      why: "this end of the jump rests on no material — there is nothing here to solder a land to",
      ...(j.id ? { jump: j.id } : {}),
    });
  });
}

/**
 * Whether the two ends really are the two lips of one cut, at the same place along it.
 *
 * Three ways to fail, and they are three different things to go and fix, but one kind: in every case the
 * folding does not bring these two points together, and the fix is to move an end. The message carries the
 * distinction, and the `along the seam` wording of the third is load-bearing — it is the only one where the
 * author has the right cut and the wrong position on it.
 *
 * `pair === -1` is `manual-jump.ts`'s own verdict, reached with the resolved anchors before this ever runs:
 * both ends found something to attach to and no single pair holds both. Taken at its word rather than
 * re-derived, so the two never disagree.
 */
function notAdjacent(j: Jump, ctx: JumpRuleContext, out: WireFault[]): void {
  const say = (why: string): void => {
    out.push({ kind: "jump-not-adjacent", at: j.a, why, ...(j.id ? { jump: j.id } : {}) });
  };
  if (j.pair === -1) {
    say("the two ends of this jump are not the two lips of one cut — folding never brings them together");
    return;
  }
  const ra = pairContaining(ctx.adjacency, j.a, ctx.tapeW);
  const rb = pairContaining(ctx.adjacency, j.b, ctx.tapeW);
  if (!ra || !rb) {
    say("an end of this jump is not on a cut lip — a jump may only join the two lips of one cut");
    return;
  }
  if (ra.pair !== rb.pair) {
    say("the two ends of this jump are on lips of different cuts — folding never brings them together");
    return;
  }
  if (ra.side === rb.side) {
    say("both ends of this jump are on the same lip of one cut — a jump has to cross the cut, not follow it");
    return;
  }
  const pair = ctx.adjacency.pairs[ra.pair];
  if (!pair) return;
  const skew = Math.abs(ra.u - rb.u) * seamLength(pair);
  if (skew > JUMP_SKEW_TAPES * ctx.tapeW) {
    say("the two ends of this jump are far apart along the seam — folding puts them at opposite ends of the cut");
  }
}

/**
 * The length of the seam the pair closes into, as the mean of its two lips' flat lengths.
 *
 * The two lips are one edge in the folded artifact and so have one length; in the flat pattern they can
 * differ by a rounding of the unfolder's, and the mean is the reading that does not privilege either lip.
 */
function seamLength(pair: LipPairFlat): number {
  const la = Math.hypot(pair.lipA[1].x - pair.lipA[0].x, pair.lipA[1].y - pair.lipA[0].y);
  const lb = Math.hypot(pair.lipB[1].x - pair.lipB[0].x, pair.lipB[1].y - pair.lipB[0].y);
  return (la + lb) / 2;
}

/**
 * Lands laid too near copper that is not this jump's own net.
 *
 * {@link gapNeeded} and {@link weedFloorFor}, the same rule `net-routing.ts` holds its own legs to, so a
 * land is legal exactly where a routed run of the same width would be. Both readings are made: against
 * routed copper, and against the lands of the other jumps, which are copper the router never saw and which
 * nothing else on the sheet is measuring.
 *
 * **Same net is not a fault**, on either reading. A jump joins one net to itself across a seam; its land
 * running alongside its own rail is the ordinary way a jump is drawn, and charging it would make every
 * useful jump unbuildable.
 *
 * At most one fault per end per offending net, charged to the end whose land clashes: the author's fix is
 * to move that end, and repeating the same move once per segment of a long run would bury it.
 */
function landClash(
  j: Jump,
  ctx: JumpRuleContext,
  ends: Vec2[],
  faceOf: number[],
  routed: Trace2D[],
  others: Jump[],
  out: WireFault[],
): void {
  const weed = weedFloorFor(ctx.tapeW, ctx.tapeMm, ctx.sheet);
  const lands = landsOf(j, ctx, faceOf);
  const foreign: Trace2D[] = [];
  for (const t of routed) {
    if (t.net === j.net || t.pts.length < 2) continue;
    foreign.push(t);
  }
  for (const o of others) {
    if (o.net === j.net || (j.id !== undefined && o.id === j.id)) continue;
    const oFace = [o.a, o.b].map((p) => pointInFace(ctx.faces, p));
    for (const land of landsOf(o, ctx, oFace)) {
      if (land) foreign.push(land);
    }
  }

  lands.forEach((land, i) => {
    if (!land) return;
    const seg = land.pts;
    const seen = new Set<string>();
    for (const t of foreign) {
      if (seen.has(t.net)) continue;
      const need = gapNeeded(ctx.tapeW, t.width ?? ctx.tapeW, weed);
      let hit = false;
      for (let k = 1; k < t.pts.length && !hit; k++) {
        hit = segNearSeg(seg[0]!, seg[1]!, t.pts[k - 1]!, t.pts[k]!) < need;
      }
      if (!hit) continue;
      seen.add(t.net);
      out.push({
        kind: "jump-land-clash",
        at: ends[i]!,
        why: `this jump's solder land lies on the ${t.net} copper — the wire would short the two nets together`,
        net: t.net,
        ...(j.id ? { jump: j.id } : {}),
      });
    }
  });
}
