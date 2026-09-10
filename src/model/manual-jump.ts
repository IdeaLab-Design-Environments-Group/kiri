/**
 * **Model** — hand-drawn jumps, and the two solder lands each one leaves on the sheet.
 *
 * A jump is the one connection that is not copper on the flat pattern. Two lips of one cut lie far apart
 * in the sheet and touch in the folded artifact (see `fold-adjacency.ts`), so a net that has to cross that
 * cut either pays the whole long way round the pattern or is joined, once the sheet is folded, by a short
 * piece of wire soldered between the two lips. This module is the *author's* half of that: a jump they
 * drew, resolved against the pattern, plus the copper it needs at each end for the wire to be soldered to.
 *
 * It mirrors `manual-wire.ts` deliberately and reuses its vocabulary: an end is a {@link WireVertex}, so a
 * jump is attached to a *thing* and survives that thing moving, and {@link resolveVertex} is the single
 * place a stored end becomes a point. Two rules differ from a wire's, both because a jump has exactly two
 * ends and no middle:
 *
 * - **A jump with a dangling end is dropped entirely.** A wire drops the dangling vertex and draws the
 *   stretch that survives; a one-ended jump is not a connection at all and there is nothing to draw. The
 *   {@link ManualJump} itself stays in the circuit — resolution never edits it — except when the part it
 *   names is deleted, which `circuit-commands.ts` handles and documents.
 * - **Failing to be adjacent is reported, not refused.** When both ends resolve but do not sit on the two
 *   lips of one pair, the jump still resolves, with `pair === -1`. The author has drawn something; a rule
 *   (`jump-rules.ts`) then says why it will not work. Returning null here would delete the evidence.
 *
 * Units are **flat pattern units** throughout, the same as {@link WireContext.tapeW} and {@link Trace2D.pts}.
 */
import { pointInFace, type FlatFace, type Vec2 } from "./electronics.js";
import { tapeOnBody } from "./corridor.js";
import type { Trace2D } from "./electronics-routing.js";
import type { Jump } from "./trace-types.js";
import type { FoldAdjacency, LipPairFlat } from "./fold-adjacency.js";
import { pairContaining } from "./fold-adjacency.js";
import { resolveVertex, type WireContext, type WireVertex } from "./manual-wire.js";

/**
 * One jump the author drew: two ends and what it is to carry.
 *
 * No `pts` and no `width` — unlike a {@link ManualWire} a jump is never a polyline. Its two ends are
 * joined by wire the author solders after folding, and the only copper it puts on the sheet is the land at
 * each end, which is always a tape width wide because that is what a soldered wire needs to sit on.
 */
export interface ManualJump {
  /** Stable for the life of the jump — the canvas selects by it, and it is this jump's net when it has no other. */
  id: string;
  a: WireVertex;
  b: WireVertex;
  /**
   * Which net this jump carries, where the author has said.
   *
   * Left unset the jump's own {@link id} is used, exactly as {@link ManualWire.net} falls back to a wire's
   * id and for the same reason: two unnamed jumps must not read as one net downstream. The same warning
   * applies — the fallback is a floor, not a default to lean on, and the jump tool should set `net` to the
   * net the author is drawing on.
   */
  net?: string;
}

/** A {@link WireContext} plus the relation a jump is only meaningful against. */
export interface JumpContext extends WireContext {
  /** Which lips the folded artifact brings together — `foldAdjacency(fold, faces)` on this pattern. */
  adjacency: FoldAdjacency;
}

/** How far a land reaches onto the sheet, and the shortest it is allowed to be, both in tape widths. */
const LAND_TAPES = 1;
const LAND_MIN_TAPES = 0.5;

const EPS = 1e-9;

/** Unit vector along a lip, `lip[0] → lip[1]`; the zero vector for a degenerate lip. */
function lipDir(lip: [Vec2, Vec2]): Vec2 {
  const dx = lip[1].x - lip[0].x, dy = lip[1].y - lip[0].y;
  const L = Math.hypot(dx, dy);
  return L < EPS ? { x: 0, y: 0 } : { x: dx / L, y: dy / L };
}

/** The lip of `pair` on the given side. */
function lipOf(pair: LipPairFlat, side: "A" | "B"): [Vec2, Vec2] {
  return side === "A" ? pair.lipA : pair.lipB;
}

/**
 * One jump as the router and the canvas see it, or null when an end no longer attaches to anything.
 *
 * `pair` is an index into `ctx.adjacency.pairs`, or **-1** when both ends resolved but do not sit on the
 * two lips of one pair — ends on the same lip, on lips of two different cuts, or simply nowhere near a
 * cut. Reach is one tape width, the distance within which a land actually touches the lip it is meant to
 * be soldered at. `dirA`/`dirB` are the directions of the lips the two ends sit on, which is what lets the
 * folded overlay draw the jump as a ribbon without knowing the adjacency; they are left unset with the
 * pair, since there is no lip to take a direction from.
 */
export function resolveJump(j: ManualJump, ctx: JumpContext): Jump | null {
  const a = resolveVertex(j.a, ctx);
  const b = resolveVertex(j.b, ctx);
  if (!a || !b) return null;

  const out: Jump = { a, b, net: j.net ?? j.id, pair: -1, source: "drawn", id: j.id };
  const onA = pairContaining(ctx.adjacency, a, ctx.tapeW);
  const onB = pairContaining(ctx.adjacency, b, ctx.tapeW);
  if (!onA || !onB || onA.pair !== onB.pair || onA.side === onB.side) return out;

  const pair = ctx.adjacency.pairs[onA.pair];
  if (!pair) return out;
  out.pair = onA.pair;
  out.dirA = lipDir(lipOf(pair, onA.side));
  out.dirB = lipDir(lipOf(pair, onB.side));
  return out;
}

/**
 * Every hand-drawn jump on this circuit.
 *
 * Bit-identical across calls on identical input, which the canvas and the export both rely on — the same
 * guarantee {@link manualTraces} makes, for the same reason. A circuit with no `jumps` yields none.
 */
export function manualJumps(ctx: JumpContext): Jump[] {
  const out: Jump[] = [];
  for (const j of ctx.circuit.jumps ?? []) {
    const resolved = resolveJump(j, ctx);
    if (resolved) out.push(resolved);
  }
  return out;
}

/**
 * What a jump is CALLED, per jump, index-aligned with `jumps`.
 *
 * `J<n>`, where `n` counts the distinct seams in play in ascending {@link Jump.pair} order — not the jumps.
 * Two jumps across the SAME cut therefore share one label, which is the point: the label names the seam
 * that has to be soldered, and someone holding the folded sheet is looking for the two lands marked `J1`,
 * of which there may be four. Nets keep them apart, and `pair` order is deterministic because
 * `FoldAdjacency.pairs` is.
 */
export function jumpLabels(jumps: Jump[]): string[] {
  const pairs = [...new Set(jumps.map((j) => j.pair))].sort((a, b) => a - b);
  const nth = new Map(pairs.map((p, i) => [p, i + 1]));
  return jumps.map((j) => `J${nth.get(j.pair)}`);
}

/**
 * The solder lands: one two-point {@link Trace2D} per end of every jump, in `a`-then-`b` order.
 *
 * Lands are plain copper on purpose (D8): the strips file, the carrier, the canvas and the folded overlay
 * all take a `Trace2D` and none of them needs a branch for a jump. Each land runs from the jump's end
 * *inward*, toward the centroid of the face the end is on, so it lies along the material rather than
 * across the lip it sits beside. Full length is one tape width; where that hangs off the sheet the land is
 * halved until {@link tapeOnBody} accepts it, down to half a tape.
 *
 * **A land that will not fit is still emitted**, as the degenerate half-tape run. The alternative is
 * copper silently vanishing from a jump the author can see on the canvas; emitting it lets `jump-rules.ts`
 * report it as unanchored, which is the fault it actually is.
 *
 * The owning face is read with {@link pointInFace} rather than from the adjacency — which is why this
 * takes no `FoldAdjacency` — and the two agree for any end near enough a lip to be jumped from, since such
 * an end lies just inside the face whose lip it is. An end that is on no face at all has no centroid to
 * aim at and the land runs along +x; it is off the material either way, and is the unanchored case above.
 */
export function jumpLandTraces(jumps: Jump[], tapeW: number, faces: FlatFace[]): Trace2D[] {
  const out: Trace2D[] = [];
  for (const j of jumps) {
    out.push(land(j.a, j.net, tapeW, faces));
    out.push(land(j.b, j.net, tapeW, faces));
  }
  return out;
}

/** One land: from `p` toward its face's centroid, as long as the material allows. */
function land(p: Vec2, net: string, tapeW: number, faces: FlatFace[]): Trace2D {
  const dir = inward(p, faces);
  const min = tapeW * LAND_MIN_TAPES;
  const at = (len: number): Vec2 => ({ x: p.x + dir.x * len, y: p.y + dir.y * len });
  let len = tapeW * LAND_TAPES;
  while (!tapeOnBody(faces, tapeW, p, at(len))) {
    if (len <= min + EPS) { len = min; break; }
    len = Math.max(len / 2, min);
  }
  return { pts: [{ x: p.x, y: p.y }, at(len)], net, width: tapeW };
}

/** Unit vector from `p` toward the centroid of the face it is on; +x when it is on none. */
function inward(p: Vec2, faces: FlatFace[]): Vec2 {
  const fi = pointInFace(faces, p);
  const face = fi >= 0 ? faces[fi] : undefined;
  if (!face) return { x: 1, y: 0 };
  const dx = face.centroid.x - p.x, dy = face.centroid.y - p.y;
  const L = Math.hypot(dx, dy);
  return L < EPS ? { x: 1, y: 0 } : { x: dx / L, y: dy / L };
}
