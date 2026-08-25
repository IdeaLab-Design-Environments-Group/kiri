/**
 * **View** — drawing copper by hand: the gesture grammar, and nothing else.
 *
 * The router plans copper for the author; {@link ../model/manual-wire.js} resolves copper the author planned
 * themselves. This is the middle piece — the state machine that turns pointer and key events into
 * {@link ManualWire}s — ported from svg-pcb's `addPathManipulation`: tap to lay a vertex, drag a handle to
 * move one, `Enter`/`Escape` to finish, `Backspace` to take one back, `X`+tap to drop one, `Delete` to
 * remove the whole wire.
 *
 * Two decisions shape everything here.
 *
 * **It never touches the canvas.** Everything it needs of the editor arrives through {@link WireHost}: the
 * pointer-to-pattern mapping, the circuit, the way to commit one, and a single `<g>` to repaint. So the
 * modal can hand this a host without this file knowing what the modal is, and — the reason that matters —
 * every gesture can be driven in a test against a fake host, with no DOM at all.
 *
 * **It never routes.** A full re-plan is most of a second, so a drag that re-planned would be a drag that
 * stutters. During a gesture the only thing written is `host.live().innerHTML`; the circuit is committed on
 * pointer *up*, once, and the host re-plans in its own time.
 *
 * Hit-testing is geometric — `clientToFlat` and nearest-within-radius — never `event.target`. The live
 * layer is rebuilt on every pointer move, so the node under the cursor at `pointerdown` need not exist at
 * `pointerup`; and a geometric test is one a mock DOM can answer. `partAt` and `nearestOnRail` in
 * `electronics-modal.ts` pick the same way, for the same reason.
 *
 * Units are **flat pattern units** everywhere a point is stored or compared, as in {@link WireVertex}.
 * Painting is the one exception, and it goes through {@link WireHost.tp} at the last moment.
 */
import type { Circuit, Vec2 } from "../model/electronics.js";
import type { RoutedCircuit } from "../model/electronics-routing.js";
import {
  resolveVertex,
  resolveWire,
  type ManualWire,
  type WireContext,
  type WireVertex,
} from "../model/manual-wire.js";
import { checkWire, type WireFault } from "../model/wire-rules.js";
import { terminals } from "../model/footprint.js";
import { footprintById } from "../model/library.js";
import { ptStr, sceneSvg, type SceneItem } from "./pcb-scene.js";

/**
 * Everything the tool needs of the editor around it.
 *
 * Deliberately narrow, and deliberately in the editor's own terms — `clientToFlat`, `tp` and `emit` are
 * methods `ElectronicsModal` already has. The DOM surface is one object with an `innerHTML`, which is what
 * keeps this file out of the canvas and testable without one.
 */
export interface WireHost {
  /** Pointer client coordinates to flat pattern units, or null when the canvas cannot be measured. */
  clientToFlat(e: { clientX: number; clientY: number }): Vec2 | null;
  /** Flat pattern units to the canvas's world space — the modal's own transform, mirror and all. */
  tp(p: Vec2): Vec2;
  /** How near a tap has to land to snap, or to count as landing on a thing. Flat pattern units. */
  snapRadiusFlat(): number;
  circuit(): Circuit;
  /** Hand back an edited circuit — the modal's `emit()`, which re-plans and repaints. */
  commit(next: Circuit): void;
  context(): WireContext;
  /** The overlay `<g>` this tool owns outright. Nothing else may write to it. */
  live(): { innerHTML: string };
  /** The plan as it stands, for reading faults against. Never re-planned by this tool. */
  routed(): RoutedCircuit;
}

/**
 * How far a press may wander and still be a tap, in pixels.
 *
 * The modal's own figure, and the same reading (summed absolute deltas, not straight-line distance) so a
 * gesture means the same thing whether the wire tool or the modal ends up handling it.
 */
const TAP_SLOP = 5;

/** A vertex the author can grab: which wire (null for the wire being drawn) and which of its points. */
interface Handle {
  wire: string | null;
  index: number;
}

/**
 * One vertex as it is shown: where it sits, and whether that position was inferred rather than resolved.
 *
 * `dangling` means the vertex names something the circuit no longer has — see {@link WireTool.place}.
 */
interface Placed {
  at: Vec2;
  dangling: boolean;
}

/** The wire being drawn resolves under this net while it is still a draft — see {@link recheck}. */
const DRAFT_ID = "wire-draft";

export class WireTool {
  private active = false;
  /** The wire being drawn, in the order the author laid it down. Empty when not drawing. */
  private draft: WireVertex[] = [];
  /** Where the pointer is, in flat units — the loose end of the rubber band, and of a vertex being dragged. */
  private cursor: Vec2 | null = null;
  private sel: string | null = null;
  private drag: Handle | null = null;
  /** An in-flight press: where it started and how far it has wandered, to tell a tap from a drag. */
  private press: { x: number; y: number; moved: number } | null = null;
  private xHeld = false;
  private draftFaults: WireFault[] = [];

  constructor(private readonly host: WireHost) {}

  /**
   * Arm or disarm the tool.
   *
   * Disarming abandons the wire being drawn rather than committing it: an unfinished wire is a gesture the
   * author walked away from, and committing one on the way out would leave copper nobody asked for.
   */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.draft = [];
    this.cursor = null;
    this.drag = null;
    this.press = null;
    this.xHeld = false;
    this.draftFaults = [];
    if (!on) this.sel = null;
    this.paint();
  }

  /** The committed wire currently selected, by {@link ManualWire.id}. */
  selected(): string | null {
    return this.sel;
  }

  /** Whether a wire is part-drawn — the host may want to say so, and a test wants to ask. */
  drawing(): boolean {
    return this.draft.length > 0;
  }

  /** Everything wrong with the wire being drawn, as of the last vertex laid. Empty when not drawing. */
  faults(): WireFault[] {
    return this.draftFaults;
  }

  // ---- pointer -------------------------------------------------------------

  onPointerDown(e: PointerEvent): boolean {
    if (!this.active || e.button !== 0) return false;
    const flat = this.host.clientToFlat(e);
    if (!flat) return false;
    const handle = this.handleAt(flat);
    if (this.xHeld) {
      // `X` is a modifier on the handle, not a mode: with no handle under it the press is not ours, and
      // letting it fall through means holding `X` never swallows an ordinary tap.
      if (!handle) return false;
      this.dropVertex(handle);
      return true;
    }
    // Every press is measured, handle or not: a press on a handle that never moves is a *tap* on that
    // handle, and the two gestures mean different things — see {@link onPointerUp}.
    this.press = { x: e.clientX, y: e.clientY, moved: 0 };
    if (handle) {
      this.drag = handle;
      this.cursor = flat;
      this.paint();
    }
    return true;
  }

  onPointerMove(e: PointerEvent): boolean {
    if (!this.active) return false;
    const flat = this.host.clientToFlat(e);
    if (this.press) {
      this.press.moved += Math.abs(e.clientX - this.press.x) + Math.abs(e.clientY - this.press.y);
      this.press.x = e.clientX;
      this.press.y = e.clientY;
    }
    if (this.drag) {
      // The whole of a drag: move the preview, commit nothing. See the note at the top of the file.
      if (flat) this.cursor = flat;
      this.paint();
      return true;
    }
    if (this.draft.length) {
      this.cursor = flat;
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
    const wandered = (press?.moved ?? 0) >= TAP_SLOP;
    if (this.drag) {
      const handle = this.drag;
      this.drag = null;
      this.cursor = null;
      // A press that stayed put was a tap, even though it landed on a handle. On the last vertex of the
      // wire being drawn that is the finish gesture — the author taps the point they just laid to say
      // "done" — and anywhere else it is nothing at all. Committing a vertex that did not move would put
      // an edit in the undo history for a gesture that changed no geometry.
      if (!wandered) {
        if (handle.wire === null && handle.index === this.draft.length - 1) return this.finish();
        this.paint();
        return true;
      }
      if (flat) this.moveVertex(handle, flat);
      else this.paint(); // the canvas went unmeasurable mid-drag: put the vertex back where it was
      return true;
    }
    if (!press) return false;
    // A press that wandered was a drag on empty canvas, and lays nothing down. It is still consumed: the
    // host was told at `pointerdown` that this gesture was ours, and it did not pan.
    if (wandered || !flat) {
      this.paint();
      return true;
    }
    return this.tap(flat);
  }

  /**
   * Keys, both down and up — `X` is a held modifier, so its release matters as much as its press.
   *
   * `X` itself is never consumed: this only watches for it, and swallowing it would take the key away from
   * whatever else the editor gives it.
   */
  onKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === "x" || e.key === "X") {
      this.xHeld = e.type !== "keyup";
      return false;
    }
    if (e.type === "keyup") return false;
    if (e.key === "Enter") return this.finish();
    if (e.key === "Escape") {
      if (this.draft.length) return this.finish();
      if (!this.sel) return false;
      this.sel = null;
      this.paint();
      return true;
    }
    if (e.key === "Backspace") {
      if (!this.draft.length) return false;
      this.draft = this.draft.slice(0, -1);
      this.recheck();
      this.paint();
      return true;
    }
    if (e.key === "Delete") {
      // Only ever the selected wire, and only when nothing is part-drawn: `Delete` mid-draw is a slip, and
      // taking a finished wire off the board because of one is not an edit the author can see coming.
      if (this.draft.length || !this.sel) return false;
      const wires = this.wires();
      const kept = wires.filter((w) => w.id !== this.sel);
      if (kept.length === wires.length) return false;
      this.sel = null;
      this.commitWires(kept);
      this.paint();
      return true;
    }
    return false;
  }

  // ---- gestures ------------------------------------------------------------

  /** A tap that stayed put: finish, select, or lay a vertex down. */
  private tap(flat: Vec2): boolean {
    if (this.draft.length) {
      const last = resolveVertex(this.draft[this.draft.length - 1]!, this.host.context());
      if (last && dist(last, flat) <= this.host.snapRadiusFlat()) return this.finish();
      this.draft = [...this.draft, this.snap(flat)];
      this.cursor = flat;
      this.recheck();
      this.paint();
      return true;
    }
    const hit = this.wireAt(flat);
    if (hit) {
      this.sel = hit;
      this.paint();
      return true;
    }
    this.sel = null;
    this.draft = [this.snap(flat)];
    this.cursor = flat;
    this.recheck();
    this.paint();
    return true;
  }

  /**
   * Commit the wire being drawn, if there is enough of it to be one.
   *
   * Under two vertices there is no polyline, so the draft is dropped without a commit — the author tapped
   * once and changed their mind, and a one-point wire would resolve to nothing anyway
   * ({@link resolveWire} refuses it) while still counting as an edit to undo.
   */
  private finish(): boolean {
    if (!this.draft.length) return false;
    const pts = this.draft;
    this.draft = [];
    this.cursor = null;
    this.draftFaults = [];
    if (pts.length < 2) {
      this.paint();
      return true;
    }
    const wire: ManualWire = { id: this.newId(), pts };
    const net = this.netOf(pts);
    if (net) wire.net = net;
    this.sel = wire.id;
    this.commitWires([...this.wires(), wire]);
    this.paint();
    return true;
  }

  /** Put the dragged vertex down where it landed — snapped, so a drag onto a pad attaches to the pad. */
  private moveVertex(handle: Handle, flat: Vec2): void {
    const v = this.snap(flat);
    if (handle.wire === null) {
      this.draft = this.draft.map((p, i) => (i === handle.index ? v : p));
      this.recheck();
      this.paint();
      return;
    }
    this.commitWires(this.wires().map((w) => {
      if (w.id !== handle.wire) return w;
      const pts = w.pts.map((p, i) => (i === handle.index ? v : p));
      return this.renet({ ...w, pts });
    }));
    this.paint();
  }

  /** `X`+tap: take one vertex out, and the wire with it once too little is left to be a wire. */
  private dropVertex(handle: Handle): void {
    if (handle.wire === null) {
      this.draft = this.draft.filter((_, i) => i !== handle.index);
      this.recheck();
      this.paint();
      return;
    }
    const next: ManualWire[] = [];
    for (const w of this.wires()) {
      if (w.id !== handle.wire) {
        next.push(w);
        continue;
      }
      const pts = w.pts.filter((_, i) => i !== handle.index);
      if (pts.length < 2) {
        if (this.sel === w.id) this.sel = null;
        continue; // the last two points cannot lose one and still be copper
      }
      next.push(this.renet({ ...w, pts }));
    }
    this.commitWires(next);
    this.paint();
  }

  // ---- hit-testing and snapping -------------------------------------------

  /**
   * Where a tap actually attaches: a part terminal, then an LED leg, then a battery terminal, then nowhere.
   *
   * The order is a **priority, not a tie-break** — a pad anywhere within the radius wins over an LED leg
   * that happens to be nearer. Wiring to a part's pad is the deliberate act; landing on a leg of the chip
   * beside it is the accident, and letting proximity decide would make the accident the common case on a
   * dense pattern.
   *
   * What comes back is the SYMBOLIC vertex and never a baked coordinate. That is the whole reason a wire
   * follows a part that moves: a `{kind:"pad"}` re-resolves through {@link resolveVertex} every time it is
   * drawn, and a `{x, y}` copied off it at snap time would stay behind the moment the author nudged the part.
   *
   * There is no grid. kiri's patterns are arbitrary polygons and the hinge lattice is the real structure, so
   * a grid would snap to a spacing that means nothing on the sheet.
   */
  private snap(at: Vec2): WireVertex {
    const r = this.host.snapRadiusFlat();
    for (const tier of this.snapTargets()) {
      const best = this.nearestVertex(tier, at, r);
      if (best) return best;
    }
    return { kind: "free", x: at.x, y: at.y };
  }

  /** Everything a wire can attach to, in snap priority order: pads, then LED legs, then battery terminals. */
  private snapTargets(): WireVertex[][] {
    const c = this.host.context().circuit;
    const pads: WireVertex[] = [];
    (c.parts ?? []).forEach((part, i) => {
      const fp = footprintById(part.component);
      if (!fp) return;
      // `terminals`, not every pad: a mounting peg is a pad in the footprint file and carries no signal, so
      // a wire to one would be copper run to a hole. `padPosition` refuses it downstream anyway.
      for (const [name] of terminals(fp)) pads.push({ kind: "pad", part: i, pad: name });
    });
    const legs: WireVertex[] = [];
    (c.leds ?? []).forEach((_, i) => {
      legs.push({ kind: "led", led: i, leg: 0 });
      legs.push({ kind: "led", led: i, leg: 1 });
    });
    const batt: WireVertex[] = c.battery
      ? [{ kind: "battery", side: "pwr" }, { kind: "battery", side: "gnd" }]
      : [];
    return [pads, legs, batt];
  }

  /** The nearest of these vertices to `at` within `r`, by where each one currently resolves. */
  private nearestVertex(list: WireVertex[], at: Vec2, r: number): WireVertex | null {
    const ctx = this.host.context();
    let best: WireVertex | null = null;
    let bestD = r;
    for (const v of list) {
      const p = resolveVertex(v, ctx);
      if (!p) continue; // dangling: the part is gone, or the hinge under the chip is
      const d = dist(p, at);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /**
   * The handle under a tap: a vertex of the wire being drawn, or of the selected wire.
   *
   * Not every wire's vertices, which is svg-pcb's rule too. Handles are shown for the selected path only,
   * and offering a grab target that is not drawn makes a wire move when the author meant to start one.
   *
   * Dangling vertices are grabbable here, at the position {@link place} infers for them. That is what makes
   * {@link ManualWire}'s promise — a wire whose end lost its part is kept "so the author can re-attach it" —
   * something the author can actually act on: grab the marker, drop it on a pad, and it is attached again.
   */
  private handleAt(at: Vec2): Handle | null {
    const r = this.host.snapRadiusFlat();
    let best: Handle | null = null;
    let bestD = r;
    const consider = (wire: string | null, pts: WireVertex[]): void => {
      this.place(wire, pts).forEach((p, index) => {
        if (!p) return;
        const d = dist(p.at, at);
        if (d > bestD) return;
        bestD = d;
        best = { wire, index };
      });
    };
    consider(null, this.draft);
    const sel = this.sel ? this.wires().find((w) => w.id === this.sel) : undefined;
    if (sel) consider(sel.id, sel.pts);
    return best;
  }

  /** The committed wire whose body a tap lands on, nearest first, or null. */
  private wireAt(at: Vec2): string | null {
    const ctx = this.host.context();
    let best: string | null = null;
    let bestD = this.host.snapRadiusFlat();
    for (const w of this.wires()) {
      const t = resolveWire(w, ctx);
      if (!t) continue;
      for (let i = 1; i < t.pts.length; i++) {
        const d = distToSeg(at, t.pts[i - 1]!, t.pts[i]!);
        if (d > bestD) continue;
        bestD = d;
        best = w.id;
      }
    }
    return best;
  }

  // ---- the circuit ---------------------------------------------------------

  private wires(): ManualWire[] {
    return this.host.circuit().wires ?? [];
  }

  private commitWires(wires: ManualWire[]): void {
    this.host.commit({ ...this.host.circuit(), wires });
  }

  /** Wire ids in the modal's own style — `w1`, `w2` — and deterministic, so a test can name one. */
  private newId(): string {
    const used = new Set(this.wires().map((w) => w.id));
    let n = 1;
    while (used.has(`w${n}`)) n++;
    return `w${n}`;
  }

  /**
   * Which net a run of vertices is drawn on, where the geometry says so.
   *
   * Worth the trouble because of what the alternative costs: an unnamed wire resolves its net to its own
   * id, differs from every other net by construction, and so is charged with a `crosses-net` ERROR for
   * every run it crosses (see {@link ManualWire.net}). A wire the author drew from one pad of a net to
   * another is not crossing anything, and should not be reported as unbuildable for it.
   *
   * Read in the order the vertices were laid, first answer wins. A battery terminal names its rail outright;
   * a pad names a net only when the netlist assigns it one. An LED's leg names nothing on purpose: which leg
   * carries which rail is the router's decision — it flips LEDs to clear crossings — so reading a net off
   * one would make the wire depend on the plan it is meant to constrain.
   */
  private netOf(pts: WireVertex[]): string | undefined {
    const c = this.host.circuit();
    for (const v of pts) {
      if (v.kind === "battery") return v.side;
      if (v.kind !== "pad") continue;
      const t = (c.terminals ?? []).find((t) => t.part === v.part && t.pad === v.pad);
      if (t) return t.net;
    }
    return undefined;
  }

  /**
   * Fill in an edited wire's net, without ever overwriting one it already carries.
   *
   * An inferred net is a guess made from where the ends landed; a set one may be the author's, and an edit
   * to one vertex is not a statement about the whole wire's net.
   */
  private renet(w: ManualWire): ManualWire {
    if (w.net !== undefined) return w;
    const net = this.netOf(w.pts);
    return net ? { ...w, net } : w;
  }

  /**
   * Re-read the draft's faults. Called when a vertex is laid, taken back or moved — never on a pointer move.
   *
   * The draft is checked under its inferred net where it has one, and under {@link DRAFT_ID} where it does
   * not, which is the same rule the wire will live by once committed: an unnamed wire is a net of its own,
   * so the crossings it is charged with mid-draw are the crossings it will be charged with after.
   */
  private recheck(): void {
    this.draftFaults = [];
    if (this.draft.length < 2) return;
    const ctx = this.host.context();
    const net = this.netOf(this.draft);
    const t = resolveWire({ id: DRAFT_ID, pts: this.draft, ...(net ? { net } : {}) }, ctx);
    if (t) this.draftFaults = checkWire(t, ctx, this.host.routed());
  }

  // ---- painting ------------------------------------------------------------

  /**
   * Repaint the live layer, and nothing else.
   *
   * This is the only thing that runs during a drag, and the only DOM this file writes. Colours are the
   * stylesheet's: every item names a class — `el-wire-draft`, `el-wire-band`, `el-wire-sel`,
   * `el-wire-handle`, `el-wire-fault` — exactly as {@link SceneItem} intends.
   */
  paint(): void {
    if (!this.active) {
      this.host.live().innerHTML = "";
      return;
    }
    const items: SceneItem[] = [];
    const k = this.worldScale();
    const width = this.host.context().tapeW * k;
    const sel = this.sel ? this.wires().find((w) => w.id === this.sel) : undefined;
    const selPlaced = sel ? this.place(sel.id, sel.pts) : [];
    if (sel) {
      const pts = onWire(selPlaced);
      if (pts.length > 1) items.push({ kind: "wire", d: this.path(pts), cls: "el-wire-sel", width });
    }
    const draftPlaced = this.place(null, this.draft);
    const draft = onWire(draftPlaced);
    if (draft.length > 1) items.push({ kind: "wire", d: this.path(draft), cls: "el-wire-draft", width });
    // The rubber band, and only while drawing — a dragged handle moves the wire itself, not a loose end.
    if (draft.length && this.cursor && !this.drag) {
      const from = draft[draft.length - 1]!;
      items.push({ kind: "wire", d: this.path([from, this.cursor]), cls: "el-wire-band", width });
    }
    const r = Math.max(width * 0.6, 1);
    // A dangling vertex gets a marker of its own rather than an ordinary handle: it is a grab target at a
    // position nobody chose, sitting off a wire it is not part of until it resolves again, and drawing it
    // as a handle would say the copper runs through it when it does not.
    for (const p of [...draftPlaced, ...selPlaced]) {
      if (!p) continue;
      const q = this.host.tp(p.at);
      items.push({ kind: "dot", x: q.x, y: q.y, r, cls: p.dangling ? "el-wire-dangling" : "el-wire-handle" });
    }
    for (const f of this.draftFaults) {
      const q = this.host.tp(f.at);
      items.push({ kind: "dot", x: q.x, y: q.y, r: r * 1.6, cls: "el-wire-fault" });
    }
    this.host.live().innerHTML = sceneSvg(items);
  }

  /**
   * Where a wire's points are on screen right now, one entry per stored vertex and in the same order.
   *
   * Index-aligned on purpose: every edit downstream — {@link moveVertex}, {@link dropVertex} — names a
   * vertex by its index in `pts`, so a list that dropped entries could not be turned back into a handle.
   *
   * Three cases. The vertex being dragged follows the cursor. A vertex that resolves sits where it
   * resolves. A vertex that no longer resolves is *placed anyway*, at a position inferred from its
   * neighbours and flagged `dangling` — {@link ManualWire} keeps such a wire "so the author can re-attach
   * it", and a vertex with nowhere to be drawn is a vertex nobody can grab. Only the last case is an
   * invention of this file: `dangling` entries are kept off the copper by {@link onWire}, so what is drawn
   * as wire stays exactly what {@link resolveWire} would resolve, and the marker is a grab target beside it.
   */
  private place(id: string | null, pts: WireVertex[]): (Placed | null)[] {
    const ctx = this.host.context();
    const out: (Placed | null)[] = pts.map((v, i) => {
      if (this.drag && this.drag.wire === id && this.drag.index === i && this.cursor) {
        return { at: this.cursor, dangling: false };
      }
      const p = resolveVertex(v, ctx);
      return p ? { at: p, dangling: false } : null;
    });
    const known = out.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    if (!known.length || known.length === out.length) return out; // nothing to infer from, or nothing to infer
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) out[i] = { at: this.inferAt(i, out, known), dangling: true };
    }
    return out;
  }

  /**
   * Where to show the dangling vertex at index `i`, from the vertices around it that do resolve.
   *
   * Between two resolvable neighbours it goes where the author would expect the wire to pass — interpolated
   * along the straight run the wire draws as while the vertex is dangling — so grabbing it and dropping it
   * on a pad bends the wire the way the shape already suggested. Off either end there is nothing to
   * interpolate between, so the last step of the wire is continued outward; with a single resolvable vertex
   * to go on, or a run of coincident ones, it is stood off by a snap radius, which is exactly far enough to
   * be a separate grab target from the vertex it came from.
   */
  private inferAt(i: number, at: (Placed | null)[], known: number[]): Vec2 {
    const first = known[0]!;
    const last = known[known.length - 1]!;
    const p = (j: number): Vec2 => at[j]!.at;
    if (i > first && i < last) {
      const l = known.filter((j) => j < i).pop()!;
      const r = known.find((j) => j > i)!;
      const t = (i - l) / (r - l);
      return { x: p(l).x + (p(r).x - p(l).x) * t, y: p(l).y + (p(r).y - p(l).y) * t };
    }
    const anchor = i < first ? first : last;
    const inner = i < first ? known[1] : known[known.length - 2];
    let step: Vec2 = { x: this.host.snapRadiusFlat() * 2, y: 0 };
    if (inner !== undefined) {
      const n = Math.abs(anchor - inner);
      const d = { x: (p(anchor).x - p(inner).x) / n, y: (p(anchor).y - p(inner).y) / n };
      if (Math.hypot(d.x, d.y) > 1e-9) step = d;
    }
    const n = Math.abs(i - anchor);
    return { x: p(anchor).x + step.x * n, y: p(anchor).y + step.y * n };
  }

  private path(pts: Vec2[]): string {
    return pts.map((p, i) => `${i ? "L" : "M"} ${ptStr(this.host.tp(p))}`).join(" ");
  }

  /**
   * World units per flat unit, measured through {@link WireHost.tp} rather than asked for.
   *
   * `tp` is affine — a scale, a flip and possibly a mirror — so the length of the image of a unit step is
   * the factor, whichever way the mirror is set. Measuring it keeps the host interface one method smaller
   * and cannot drift from the transform the canvas actually uses.
   */
  private worldScale(): number {
    const a = this.host.tp({ x: 0, y: 0 });
    const b = this.host.tp({ x: 1, y: 0 });
    return dist(a, b) || 1;
  }
}

/**
 * The placed vertices the copper actually runs through, in order.
 *
 * Dangling ones are left out, exactly as {@link resolveWire} leaves them out, so a wire with one end on a
 * deleted part draws as the stretch that is left — and draws it the same way the canvas and the export do.
 */
function onWire(placed: (Placed | null)[]): Vec2[] {
  return placed.filter((p): p is Placed => !!p && !p.dangling).map((p) => p.at);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from `p` to the segment `ab` — how near a tap has to be to land on a wire's body. */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 < 1e-18) return dist(p, a);
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
  return dist(p, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
}
