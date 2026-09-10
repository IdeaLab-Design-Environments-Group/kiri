/**
 * **View** — where a tap attaches, shared by every tool that anchors a point to the circuit.
 *
 * Lifted out of `wire-tool.ts` unchanged when the jump tool arrived: a jump's two ends are
 * {@link WireVertex}es for the same reason a wire's are — they name a *thing* and so survive that thing
 * moving — and a second copy of the priority order would be a second place for it to drift. The jump tool
 * layers its own lip targets on top of these rather than replacing them.
 *
 * Everything here is a free function of its inputs, with no editor and no DOM: the tools hold the state,
 * this holds the rule.
 *
 * Units are **flat pattern units**, as in {@link WireVertex}.
 */
import type { Circuit, Vec2 } from "../model/electronics.js";
import { resolveVertex, type WireContext, type WireVertex } from "../model/manual-wire.js";
import { terminals } from "../model/footprint.js";
import { footprintById } from "../model/library.js";

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

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
export function snapVertex(at: Vec2, ctx: WireContext, r: number): WireVertex {
  for (const tier of snapTargets(ctx.circuit)) {
    const best = nearestVertex(tier, at, r, ctx);
    if (best) return best;
  }
  return { kind: "free", x: at.x, y: at.y };
}

/** Everything a wire can attach to, in snap priority order: pads, then LED legs, then battery terminals. */
export function snapTargets(c: Circuit): WireVertex[][] {
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
export function nearestVertex(
  list: WireVertex[],
  at: Vec2,
  r: number,
  ctx: WireContext,
): WireVertex | null {
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
 * Which net a run of vertices is drawn on, where the geometry says so.
 *
 * Worth the trouble because of what the alternative costs: an unnamed wire resolves its net to its own
 * id, differs from every other net by construction, and so is charged with a `crosses-net` ERROR for
 * every run it crosses (see {@link ManualWire.net}). A wire the author drew from one pad of a net to
 * another is not crossing anything, and should not be reported as unbuildable for it. A jump reads its
 * net the same way, and for the same reason — see {@link ManualJump.net}.
 *
 * Read in the order the vertices were laid, first answer wins. A battery terminal names its rail outright;
 * a pad names a net only when the netlist assigns it one. An LED's leg names nothing on purpose: which leg
 * carries which rail is the router's decision — it flips LEDs to clear crossings — so reading a net off
 * one would make the wire depend on the plan it is meant to constrain.
 */
export function netOf(pts: WireVertex[], c: Circuit): string | undefined {
  for (const v of pts) {
    if (v.kind === "battery") return v.side;
    if (v.kind !== "pad") continue;
    const t = (c.terminals ?? []).find((t) => t.part === v.part && t.pad === v.pad);
    if (t) return t.net;
  }
  return undefined;
}
