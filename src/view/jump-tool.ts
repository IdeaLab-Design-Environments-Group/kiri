/**
 * **View** — drawing a jump by hand: two taps, and nothing else.
 *
 * `wire-tool.ts` is the model this follows, down to the guarantees at the head of that file: it never
 * touches the canvas (everything arrives through {@link JumpHost}), it never routes (a full re-plan is
 * most of a second, so a gesture only ever writes `host.live().innerHTML`), and it hit-tests
 * geometrically so a mock DOM can drive every gesture with no browser at all.
 *
 * What differs is the gesture, because a jump is not a polyline. It has exactly two ends and no middle:
 * a stub of copper on each lip of one cut, joined by a length of wire once the sheet is folded (see
 * `model/manual-jump.ts`). So there is no `Enter`, no `Backspace` and no `X`+tap — the first tap places
 * one end, the second places the other and commits, and `Escape` in between throws the draft away. Between
 * the two taps the **peer lip** is highlighted: the author has just tapped one lip of a cut and the only
 * useful place for the second end is the lip it welds to, which in the flat pattern may be three hundred
 * units away and looks like unrelated boundary.
 *
 * **Snapping sets the end back into the face.** A point exactly on a lip is on the material's edge, and a
 * tape-width land laid from there has its ribbon corners hanging off the sheet — the folded overlay drops
 * such a quad and the export cuts copper that is not there. So a tap that snaps to a lip commits the point
 * nudged toward the owning face's centroid by {@link LIP_SETBACK_TAPES} of a tape width: far enough in
 * that the land and its corners are on material, near enough that `pairContaining` still reads the end as
 * being on that lip (it reaches one whole tape width).
 *
 * Units are **flat pattern units** everywhere a point is stored or compared, exactly as in `wire-tool.ts`.
 */
import type { Vec2 } from "../model/electronics.js";
import { pairContaining, type FoldAdjacency, type LipPairFlat } from "../model/fold-adjacency.js";
import {
  manualJumps,
  resolveJump,
  type JumpContext,
  type ManualJump,
} from "../model/manual-jump.js";
import { checkJump, type JumpRuleContext } from "../model/jump-rules.js";
import { appendJump, removeJump } from "../model/circuit-commands.js";
import type { SheetSpec } from "../model/fold-strain.js";
import { TAPE_MM } from "../model/tape-width.js";
import { resolveVertex, type WireVertex } from "../model/manual-wire.js";
import type { WireFault } from "../model/wire-rules.js";
import { dist, netOf, snapVertex } from "./wire-snap.js";
import { ptStr, sceneSvg, type SceneItem } from "./pcb-scene.js";
import type { WireHost } from "./wire-tool.js";

/**
 * Everything the tool needs of the editor, which is {@link WireHost} plus the two things a jump has that
 * a wire does not: the relation it is only meaningful against, and the sheet its lands are clear on.
 *
 * `drawnJumps` rather than reading `circuit().jumps` here, for the same reason `WireHost` has `circuit()`:
 * the editor owns what a jump list is, and a tool that reached into the circuit for one would be a second
 * place to keep that agreement.
 */
export interface JumpHost extends WireHost {
  /** Which lips the folded artifact brings together — `foldAdjacency(fold, faces)` on this pattern. */
  adjacency(): FoldAdjacency;
  /** The material, for the weed floor the land-clash rule measures against. */
  sheet(): SheetSpec;
  drawnJumps(): ManualJump[];
}

/**
 * How far into the face a snapped end is set back from the lip it landed on, in tape widths.
 *
 * A land is a tape-width stub run from the end toward the face centroid, and the folded overlay draws it
 * as a ribbon a tape wide — so an end sitting exactly ON the lip puts half that ribbon over the cut, and
 * `pushQuad` drops the corners that fall off the material. The visible symptom is a jump whose land is
 * drawn on the flat canvas and missing from the folded model.
 *
 * 0.6 is chosen between two hard limits and not tuned: below half a tape the ribbon's far corner is still
 * over the edge, and at one whole tape `pairContaining` — which reaches exactly one tape width — stops
 * reading the end as being on that lip at all, so the jump would resolve with `pair === -1` and the rule
 * would report the author's own snap as not adjacent.
 */
const LIP_SETBACK_TAPES = 0.6;

/** How far a press may wander and still be a tap, in pixels. The modal's figure, and `wire-tool.ts`'s. */
const TAP_SLOP = 5;

export class JumpTool {
  private active = false;
  /** The first end, once tapped. Null when no jump is part-drawn. */
  private draft: WireVertex | null = null;
  /** Where the pointer is, in flat units — the loose end of the rubber band. */
  private cursor: Vec2 | null = null;
  private sel: string | null = null;
  /** An in-flight press: where it started and how far it has wandered, to tell a tap from a drag. */
  private press: { x: number; y: number; moved: number } | null = null;
  private faultList: WireFault[] = [];

  constructor(private readonly host: JumpHost) {}

  /**
   * Arm or disarm the tool.
   *
   * Disarming abandons the half-drawn jump rather than committing it, exactly as the wire tool does: a
   * jump with one end is not a connection, and committing one on the way out would leave the author a
   * fault to clear for a gesture they walked away from.
   */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.draft = null;
    this.cursor = null;
    this.press = null;
    if (!on) {
      this.sel = null;
      this.faultList = [];
    }
    this.paint();
  }

  /** The committed jump currently selected, by {@link ManualJump.id}. */
  selected(): string | null {
    return this.sel;
  }

  /** Whether one end is down and the other is not — the host may want to say so, and a test wants to ask. */
  drawing(): boolean {
    return this.draft !== null;
  }

  /** Everything wrong with the jump last committed or selected. Empty when there is none. */
  faults(): WireFault[] {
    return this.faultList;
  }

  // ---- pointer -------------------------------------------------------------

  onPointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0) return false;
    if (!this.host.clientToFlat(e)) return false;
    this.press = { x: e.clientX, y: e.clientY, moved: 0 };
    return true;
  }

  onPointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    if (this.press) {
      this.press.moved += Math.abs(e.clientX - this.press.x) + Math.abs(e.clientY - this.press.y);
      this.press.x = e.clientX;
      this.press.y = e.clientY;
    }
    if (this.draft) {
      // The whole of a move: drag the rubber band, read no plan and commit nothing.
      this.cursor = this.host.clientToFlat(e);
      this.paint();
      return true;
    }
    return this.press !== null;
  }

  onPointerUp(e: PointerEvent): boolean {
    if (!this.active) return false;
    const flat = this.host.clientToFlat(e);
    const press = this.press;
    this.press = null;
    if (!press) return false;
    // A press that wandered was a drag on empty canvas and places nothing. It is still consumed: the host
    // was told at `pointerdown` that this gesture was ours, and it did not pan.
    if (press.moved >= TAP_SLOP || !flat) {
      this.paint();
      return true;
    }
    return this.tap(flat);
  }

  /**
   * Keys. Only two, and both are about abandoning something.
   *
   * There is no `Enter`: a jump is finished by its second tap and there is no state in which it is
   * complete but uncommitted. `Backspace` would have exactly one thing to take back — the first end — and
   * that is what `Escape` already does.
   */
  onKey(e: KeyboardEvent): boolean {
    if (!this.active || e.type === "keyup") return false;
    if (e.key === "Escape") {
      if (this.draft) {
        this.draft = null;
        this.cursor = null;
        this.paint();
        return true;
      }
      if (!this.sel) return false;
      this.sel = null;
      this.faultList = [];
      this.paint();
      return true;
    }
    if (e.key === "Delete") {
      // Never mid-draw: `Delete` with a hand on the gesture is a slip, and taking a committed jump off the
      // sheet because of one is not an edit the author can see coming. `Escape` is how a draft goes.
      if (this.draft || !this.sel) return false;
      const id = this.sel;
      if (!this.jumps().some((j) => j.id === id)) return false;
      this.sel = null;
      this.faultList = [];
      this.host.commit(removeJump(id).apply(this.host.circuit()));
      this.paint();
      return true;
    }
    return false;
  }

  // ---- gestures ------------------------------------------------------------

  /** A tap that stayed put: place the first end, or place the second and commit. */
  private tap(flat: Vec2): boolean {
    if (this.draft) return this.finish(flat);
    const hit = this.jumpAt(flat);
    if (hit) {
      this.sel = hit;
      this.recheck();
      this.paint();
      return true;
    }
    this.sel = null;
    this.faultList = [];
    this.draft = this.snap(flat);
    this.cursor = flat;
    this.paint();
    return true;
  }

  /**
   * The second tap: commit one jump, through `circuit-commands.ts` like every other circuit edit (R10).
   *
   * The net is read off the two ends the same way a wire's is ({@link netOf}) — a jump drawn from a pad of
   * PWR to the far lip is on PWR, and saying so is what keeps its lands from being charged with clashing
   * against the rail they are meant to join. Left unnamed, `ManualJump.net` falls back to the jump's id.
   */
  private finish(flat: Vec2): boolean {
    const a = this.draft;
    this.draft = null;
    this.cursor = null;
    if (!a) return false;
    const b = this.snap(flat);
    const jump: ManualJump = { id: this.newId(), a, b };
    const net = netOf([a, b], this.host.circuit());
    if (net) jump.net = net;
    this.sel = jump.id;
    this.host.commit(appendJump(jump).apply(this.host.circuit()));
    this.recheck();
    this.paint();
    return true;
  }

  // ---- hit-testing and snapping -------------------------------------------

  /**
   * Where a tap attaches: the wire tool's targets first, then the nearest cut lip.
   *
   * The order is the wire tool's priority carried over — a pad within the radius is the deliberate act and
   * wins over geometry that happens to be nearer — with the lip appended as the one target a jump has and
   * a wire does not. A tap on neither is a `free` vertex where it landed, which is a jump the rule will
   * report as not adjacent rather than one this refuses to place.
   */
  private snap(at: Vec2): WireVertex {
    const ctx = this.host.context();
    const r = this.host.snapRadiusFlat();
    const v = snapVertex(at, ctx, r);
    if (v.kind !== "free") return v;
    return this.lipVertex(at, r) ?? v;
  }

  /** The nearest lip within `r`, as a point set back into its own face — see {@link LIP_SETBACK_TAPES}. */
  private lipVertex(at: Vec2, r: number): WireVertex | null {
    const adj = this.host.adjacency();
    const hit = pairContaining(adj, at, r);
    if (!hit) return null;
    const pair = adj.pairs[hit.pair];
    if (!pair) return null;
    const lip = lipOf(pair, hit.side);
    const on = {
      x: lip[0].x + (lip[1].x - lip[0].x) * hit.u,
      y: lip[0].y + (lip[1].y - lip[0].y) * hit.u,
    };
    const ctx = this.host.context();
    const face = ctx.faces[hit.side === "A" ? pair.faceA : pair.faceB];
    if (!face) return { kind: "free", x: on.x, y: on.y };
    const dx = face.centroid.x - on.x, dy = face.centroid.y - on.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return { kind: "free", x: on.x, y: on.y };
    const back = LIP_SETBACK_TAPES * ctx.tapeW;
    return { kind: "free", x: on.x + (dx / L) * back, y: on.y + (dy / L) * back };
  }

  /** The committed jump whose end a tap lands on, nearest first, or null. */
  private jumpAt(at: Vec2): string | null {
    const ctx = this.jumpContext();
    let best: string | null = null;
    let bestD = this.host.snapRadiusFlat();
    for (const j of this.jumps()) {
      const r = resolveJump(j, ctx);
      if (!r) continue;
      for (const p of [r.a, r.b]) {
        const d = dist(p, at);
        if (d > bestD) continue;
        bestD = d;
        best = j.id;
      }
    }
    return best;
  }

  // ---- the circuit ---------------------------------------------------------

  private jumps(): ManualJump[] {
    return this.host.drawnJumps();
  }

  /** Jump ids in the modal's own style — `j1`, `j2` — and deterministic, so a test can name one. */
  private newId(): string {
    const used = new Set(this.jumps().map((j) => j.id));
    let n = 1;
    while (used.has(`j${n}`)) n++;
    return `j${n}`;
  }

  private jumpContext(): JumpContext {
    return { ...this.host.context(), adjacency: this.host.adjacency() };
  }

  private ruleContext(): JumpRuleContext {
    const ctx = this.host.context();
    return {
      adjacency: this.host.adjacency(),
      tapeW: ctx.tapeW,
      tapeMm: ctx.tapeMm ?? TAPE_MM,
      sheet: this.host.sheet(),
      faces: ctx.faces,
    };
  }

  /**
   * Re-read the selected jump's faults. Called when one is committed or selected — never on a move.
   *
   * `routed()` is read here and nowhere else, which is the whole reason this is not called from the
   * pointer handlers: the plan is the expensive thing to ask for, and a rubber band that asked for it
   * would be a rubber band that stutters.
   *
   * The jump's own lands are not among the copper it is measured against — {@link checkJump} takes the
   * routed traces and the OTHER jumps, and passing its own would have every jump clash with itself.
   */
  private recheck(): void {
    this.faultList = [];
    const id = this.sel;
    if (!id) return;
    const mine = this.jumps().find((j) => j.id === id);
    if (!mine) return;
    const ctx = this.jumpContext();
    const j = resolveJump(mine, ctx);
    if (!j) return;
    const others = manualJumps(ctx).filter((o) => o.id !== id);
    this.faultList = checkJump(j, this.ruleContext(), this.host.routed().traces, others);
  }

  // ---- painting ------------------------------------------------------------

  /**
   * Repaint the live layer, and nothing else.
   *
   * The committed jumps are drawn by the canvas itself (`jumpParts`), as the committed wires are. What is
   * here is only what is under the author's hand: the peer lip, the end placed so far, the rubber band to
   * the cursor, the selected jump's two ends, and the faults. Colours are the stylesheet's — `el-jump-peer`
   * is this file's own, the rest are the wire tool's, because they mean the same things.
   */
  paint(): void {
    if (!this.active) {
      this.host.live().innerHTML = "";
      return;
    }
    const items: SceneItem[] = [];
    const k = this.worldScale();
    const ctx = this.host.context();
    const width = ctx.tapeW * k;
    const peer = this.draft ? this.peerLip() : null;
    if (peer) {
      items.push({
        kind: "wire",
        d: `M ${ptStr(this.host.tp(peer[0]))} L ${ptStr(this.host.tp(peer[1]))}`,
        cls: "el-jump-peer",
        width,
      });
    }
    const r = Math.max(width * 0.6, 1);
    const at = this.draft ? this.place(this.draft) : null;
    if (at) {
      const q = this.host.tp(at);
      items.push({ kind: "dot", x: q.x, y: q.y, r, cls: "el-wire-handle" });
      if (this.cursor) {
        items.push({
          kind: "wire",
          d: `M ${ptStr(q)} L ${ptStr(this.host.tp(this.cursor))}`,
          cls: "el-wire-band",
          width,
        });
      }
    }
    const sel = this.sel ? this.jumps().find((j) => j.id === this.sel) : undefined;
    const resolved = sel ? resolveJump(sel, this.jumpContext()) : null;
    if (resolved) {
      for (const p of [resolved.a, resolved.b]) {
        const q = this.host.tp(p);
        items.push({ kind: "dot", x: q.x, y: q.y, r, cls: "el-wire-handle" });
      }
    }
    for (const f of this.faultList) {
      const q = this.host.tp(f.at);
      items.push({ kind: "dot", x: q.x, y: q.y, r: r * 1.6, cls: "el-wire-fault" });
    }
    this.host.live().innerHTML = sceneSvg(items);
  }

  /**
   * The lip the first end will weld to, in flat units, or null when it sits on no lip.
   *
   * Reach is one tape width — {@link resolveJump}'s own figure, so what is highlighted is exactly the lip
   * the committed jump will be read as pairing with, and an end the tool set back by
   * {@link LIP_SETBACK_TAPES} of a tape is still comfortably inside it.
   */
  private peerLip(): [Vec2, Vec2] | null {
    const at = this.draft ? this.place(this.draft) : null;
    if (!at) return null;
    const adj = this.host.adjacency();
    const hit = pairContaining(adj, at, this.host.context().tapeW);
    if (!hit) return null;
    const pair = adj.pairs[hit.pair];
    return pair ? lipOf(pair, hit.side === "A" ? "B" : "A") : null;
  }

  /** Where a stored end is right now, or null when it names something the circuit no longer has. */
  private place(v: WireVertex): Vec2 | null {
    return resolveVertex(v, this.host.context());
  }

  /**
   * World units per flat unit, measured through {@link WireHost.tp} rather than asked for.
   *
   * `tp` is affine — a scale, a flip and possibly a mirror — so the length of the image of a unit step is
   * the factor, whichever way the mirror is set. `wire-tool.ts` measures it the same way, for the same
   * reason: it keeps the host interface one method smaller and cannot drift from the real transform.
   */
  private worldScale(): number {
    return dist(this.host.tp({ x: 0, y: 0 }), this.host.tp({ x: 1, y: 0 })) || 1;
  }
}

/** The lip of `pair` on the given side. */
function lipOf(pair: LipPairFlat, side: "A" | "B"): [Vec2, Vec2] {
  return side === "A" ? pair.lipA : pair.lipB;
}
