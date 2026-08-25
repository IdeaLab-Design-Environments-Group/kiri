import { describe, expect, it } from "vitest";
import { WireTool, type WireHost } from "../../../src/view/wire-tool.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import type { RoutedCircuit } from "../../../src/model/electronics-routing.js";
import { resolveVertex, type WireContext } from "../../../src/model/manual-wire.js";
import { isBuildable } from "../../../src/model/wire-rules.js";
import { terminals } from "../../../src/model/footprint.js";
import { LIBRARY } from "../../../src/model/library.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** A 2x2 grid of unit quads: four faces, hinges between neighbours. The modal's own test fixture. */
function grid2x2(): FoldFile {
  return {
    vertices_coords: [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
      [0, 2], [1, 2], [2, 2],
    ],
    faces_vertices: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [3, 4, 7, 6],
      [4, 5, 8, 7],
    ],
    edges_vertices: [[1, 4], [3, 4], [4, 5], [4, 7]],
    edges_assignment: ["M", "M", "M", "M"],
  } as unknown as FoldFile;
}

/** Pixels per flat unit in the fake host, so a test can convert a pattern point into a pointer event. */
const PX = 10;
const SNAP = 0.1;

const EMPTY_ROUTE: RoutedCircuit = {
  traces: [], pads: [], unreachable: [], unseated: [], resistors: [], switches: [], parts: [], nets: [], netFaults: [],
};

/**
 * The editor, faked down to the seven methods the tool actually uses.
 *
 * This is what {@link WireHost} is for: no DOM, no modal, no router — `live` is an object with an
 * `innerHTML`, and `commit` is a recorder, so every gesture can be driven and every commit counted.
 */
function makeHost(circuit: Circuit): {
  host: WireHost;
  commits: Circuit[];
  ctx: WireContext;
  now: () => Circuit;
  live: { innerHTML: string };
  /** How many times the tool asked for the plan. `routed()` is read only by `recheck`, so this counts
   *  fault passes — the expensive work a gesture must not repeat. See the pointer-move tests. */
  counts: { routed: number };
} {
  const fold = grid2x2();
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  let current = circuit;
  const commits: Circuit[] = [];
  const live = { innerHTML: "" };
  const counts = { routed: 0 };
  const ctx: WireContext = { faces, gaps, circuit: current, tapeW: 0.05 };
  const host: WireHost = {
    clientToFlat: (e) => ({ x: e.clientX / PX, y: e.clientY / PX }),
    tp: (p) => ({ x: p.x * PX, y: p.y * PX }),
    snapRadiusFlat: () => SNAP,
    circuit: () => current,
    commit: (next) => {
      current = next;
      ctx.circuit = next;
      commits.push(next);
    },
    context: () => ctx,
    live: () => live,
    routed: () => { counts.routed++; return EMPTY_ROUTE; },
  };
  return { host, commits, ctx, now: () => current, live, counts };
}

/** A press-and-release that stays put: the tool's tap. */
function tap(tool: WireTool, at: Vec2): void {
  const e = { button: 0, clientX: at.x * PX, clientY: at.y * PX, pointerId: 1 } as unknown as PointerEvent;
  tool.onPointerDown(e);
  tool.onPointerUp(e);
}

/** Press at `from`, move through `via`, release at `to` — a drag, not a tap. */
function drag(tool: WireTool, from: Vec2, to: Vec2): void {
  const ev = (p: Vec2): PointerEvent =>
    ({ button: 0, clientX: p.x * PX, clientY: p.y * PX, pointerId: 1 }) as unknown as PointerEvent;
  tool.onPointerDown(ev(from));
  tool.onPointerMove(ev({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }));
  tool.onPointerMove(ev(to));
  tool.onPointerUp(ev(to));
}

/** One pointer event at a pattern point — for the gestures that have to be driven step by step. */
function ev(p: Vec2): PointerEvent {
  return { button: 0, clientX: p.x * PX, clientY: p.y * PX, pointerId: 1 } as unknown as PointerEvent;
}

function key(name: string, type: "keydown" | "keyup" = "keydown"): KeyboardEvent {
  return { key: name, type } as unknown as KeyboardEvent;
}

function bare(): Circuit {
  return { leds: [], battery: null };
}

/** A tool armed on a fresh host, which is the first two lines of nearly every test here. */
function armed(circuit: Circuit = bare()): ReturnType<typeof makeHost> & { tool: WireTool } {
  const h = makeHost(circuit);
  const tool = new WireTool(h.host);
  tool.setActive(true);
  return { ...h, tool };
}

describe("WireTool drawing", () => {
  it("makes a three-vertex wire from three taps and commits exactly once", () => {
    const { tool, commits, now } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    expect(commits).toHaveLength(0); // nothing is committed while the wire is being drawn
    expect(tool.onKey(key("Enter"))).toBe(true);
    expect(commits).toHaveLength(1);
    const wires = now().wires ?? [];
    expect(wires).toHaveLength(1);
    expect(wires[0]!.pts).toHaveLength(3);
    expect(wires[0]!.pts.map((p) => p.kind)).toEqual(["free", "free", "free"]);
  });

  it("hands the host nothing on a pointer move — only a finished wire is ever committed", () => {
    const { tool, commits } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    const move = { clientX: 5, clientY: 5, button: 0, pointerId: 1 } as unknown as PointerEvent;
    for (let i = 0; i < 20; i++) tool.onPointerMove(move);
    expect(commits).toHaveLength(0);
    tap(tool, { x: 0.8, y: 0.8 });
    expect(commits).toHaveLength(0);
    tool.onKey(key("Escape"));
    expect(commits).toHaveLength(1);
  });

  /**
   * The cost of a gesture, counted rather than inferred.
   *
   * The existing guard above counts COMMITS, and the work this file exists to avoid does not commit: a
   * re-check walks every routed trace against every segment of the draft. `routed()` is read only by
   * `recheck`, so it is the one call that says whether a move did that work — and a content assertion on
   * the live layer cannot see it, because a redundant pass paints the same bytes.
   */
  it("does not re-check the draft on a pointer move", () => {
    const { tool, counts } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.2 });
    const before = counts.routed;
    for (let i = 0; i < 20; i++) tool.onPointerMove(ev({ x: 0.8 + i * 0.01, y: 0.5 }));
    expect(counts.routed - before).toBe(0);
    // ...and laying the next vertex down DOES re-check, or the counter would prove nothing.
    tap(tool, { x: 1.4, y: 0.5 });
    expect(counts.routed - before).toBeGreaterThan(0);
  });

  it("does not re-check the draft while one of its handles is dragged", () => {
    const { tool, counts } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.2 });
    tap(tool, { x: 1.4, y: 0.2 });
    const before = counts.routed;
    // The FIRST vertex, so this is a handle drag and not the finish gesture. The draft is still live, so
    // a re-check here would run a full fault pass on every move of the drag.
    tool.onPointerDown(ev({ x: 0.2, y: 0.2 }));
    for (let i = 0; i < 20; i++) tool.onPointerMove(ev({ x: 0.2, y: 0.2 + i * 0.05 }));
    expect(counts.routed - before).toBe(0);
    // Dropping it re-checks exactly once.
    tool.onPointerUp(ev({ x: 0.2, y: 1.2 }));
    expect(counts.routed - before).toBe(1);
  });

  it("finishes on a tap back on the last vertex", () => {
    const { tool, commits, now } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    tap(tool, { x: 0.8 + SNAP / 2, y: 0.8 }); // within the snap radius of the last one
    expect(commits).toHaveLength(1);
    expect(now().wires![0]!.pts).toHaveLength(2);
  });

  it("drops the last vertex on Backspace, and commits nothing for a one-point wire", () => {
    const { tool, commits, now } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    expect(tool.onKey(key("Backspace"))).toBe(true);
    expect(tool.drawing()).toBe(true);
    tool.onKey(key("Enter"));
    expect(commits).toHaveLength(0);
    expect(now().wires ?? []).toHaveLength(0);
  });

  it("consumes nothing at all while inactive", () => {
    const h = makeHost(bare());
    const tool = new WireTool(h.host);
    const e = { button: 0, clientX: 2, clientY: 2, pointerId: 1 } as unknown as PointerEvent;
    expect(tool.onPointerDown(e)).toBe(false);
    expect(tool.onPointerMove(e)).toBe(false);
    expect(tool.onPointerUp(e)).toBe(false);
    expect(tool.onKey(key("Enter"))).toBe(false);
    expect(tool.onKey(key("Delete"))).toBe(false);
    expect(h.commits).toHaveLength(0);
    expect(h.live.innerHTML).toBe("");
  });

  it("abandons the wire being drawn when the tool is put away", () => {
    const { tool, commits } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    tool.setActive(false);
    expect(commits).toHaveLength(0);
    expect(tool.drawing()).toBe(false);
  });
});

describe("WireTool snapping", () => {
  /** A circuit with one library part, plus where its first terminal lands on the pattern. */
  function withPart(at: Vec2): { circuit: Circuit; pad: string; comp: string } {
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const pad = terminals(comp.footprint)[0]![0];
    return {
      circuit: { leds: [], battery: null, parts: [{ component: comp.id, x: at.x, y: at.y }] },
      pad,
      comp: comp.id,
    };
  }

  it("snaps a tap near a part terminal to that pad, symbolically", () => {
    const { circuit, pad } = withPart({ x: 0.5, y: 0.5 });
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    expect(padAt).not.toBeNull();
    tap(tool, { x: padAt.x + SNAP / 3, y: padAt.y });
    tap(tool, { x: padAt.x + 0.6, y: padAt.y + 0.6 });
    tool.onKey(key("Enter"));
    const first = now().wires![0]!.pts[0]!;
    expect(first).toEqual({ kind: "pad", part: 0, pad });
  });

  it("leaves a tap in open space free rather than dragging it onto the nearest thing", () => {
    const { circuit, pad } = withPart({ x: 0.5, y: 0.5 });
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    // Well clear of every pad of the part, not just of this one — the footprint chosen here is a coin
    // cell holder, and its other terminals sit a tenth of the pattern away along the same axis.
    tap(tool, { x: padAt.x, y: padAt.y + 0.8 });
    tap(tool, { x: padAt.x + 0.6, y: padAt.y + 1.2 });
    tool.onKey(key("Enter"));
    expect(now().wires![0]!.pts[0]!.kind).toBe("free");
  });

  it("prefers a part terminal to a battery terminal that is nearer", () => {
    // The claim is a PRIORITY, not a tie-break: a pad anywhere inside the radius beats a terminal that is
    // strictly nearer. So the winning pad has to sit FARTHER from the tap than the terminal it beats.
    //
    // This previously placed the part AT the battery terminal, and this footprint's pad "2" sits on the
    // part's own origin — so the winning pad and the terminal were the same point, and the test read only
    // tier order at equal distance. It also asserted `.kind`, which cannot tell the pad it aimed at from
    // another pad of the same part.
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const at = { x: 0.62, y: 0.5 };
    const R = 0.15;
    // Pad "2" is on the part's origin and this footprint's other terminals lie far off along x, so
    // offsetting the part in y leaves exactly one pad in range, at a distance we choose.
    const circuit: Circuit = {
      leds: [],
      battery: { face: 0 },
      parts: [{ component: comp.id, x: at.x, y: at.y + 0.12 }],
    };
    const h = makeHost(circuit);
    const host: WireHost = { ...h.host, snapRadiusFlat: () => R };
    const tool = new WireTool(host);
    tool.setActive(true);

    const term = resolveVertex({ kind: "battery", side: "pwr" }, h.ctx)!;
    const padAt = resolveVertex({ kind: "pad", part: 0, pad: "2" }, h.ctx)!;
    const toTerm = Math.hypot(term.x - at.x, term.y - at.y);
    const toPad = Math.hypot(padAt.x - at.x, padAt.y - at.y);
    expect(toTerm).toBeLessThan(toPad);          // the terminal really is the nearer of the two...
    expect(toPad).toBeLessThan(R);               // ...the pad really is inside the radius...
    expect(toPad - toTerm).toBeGreaterThan(0.05); // ...and they are not the same point.

    tap(tool, at);
    tap(tool, { x: 0.3, y: 1.6 });
    tool.onKey(key("Enter"));
    expect(h.commits).toHaveLength(1);
    // The pad it aimed at, named — not merely "some pad".
    expect(h.now().wires![0]!.pts[0]).toEqual({ kind: "pad", part: 0, pad: "2" });
  });

  it("prefers a part terminal to an LED leg that is nearer", () => {
    // The other half of the priority rule, and the half the suite never had a fixture for: nearly every
    // circuit here has `leds: []`, so pads-over-legs went untested while pads-over-terminals did not.
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const at = { x: 0.96, y: 0.5 };
    const R = 0.15;
    const circuit: Circuit = {
      leds: [ledOf(0, 1)],
      battery: { face: 0 },
      parts: [{ component: comp.id, x: at.x, y: at.y + 0.12 }],
    };
    const h = makeHost(circuit);
    const host: WireHost = { ...h.host, snapRadiusFlat: () => R };
    const tool = new WireTool(host);
    tool.setActive(true);

    const leg = resolveVertex({ kind: "led", led: 0, leg: 0 }, h.ctx)!;
    const padAt = resolveVertex({ kind: "pad", part: 0, pad: "2" }, h.ctx)!;
    const toLeg = Math.hypot(leg.x - at.x, leg.y - at.y);
    const toPad = Math.hypot(padAt.x - at.x, padAt.y - at.y);
    expect(toLeg).toBeLessThan(toPad);   // the leg really is the nearer of the two...
    expect(toPad).toBeLessThan(R);       // ...and the pad really is inside the radius the HOST gave.
    // Wider than a radius that ignored the host and used this fixture's usual value, so a snap that read
    // its radius from nowhere would miss the pad and fall through to the leg.
    expect(toPad).toBeGreaterThan(SNAP);

    tap(tool, at);
    tap(tool, { x: 0.3, y: 1.6 });
    tool.onKey(key("Enter"));
    expect(h.now().wires![0]!.pts[0]).toEqual({ kind: "pad", part: 0, pad: "2" });
  });

  it("never takes the wire's net from an LED leg", () => {
    // Which leg carries which rail is a routing OUTPUT — the router flips LEDs to clear crossings — so a
    // wire that read a net off a leg would depend on the plan it exists to constrain. `manual-wire` guards
    // this where a leg RESOLVES; this is the same property where a leg NAMES.
    const circuit: Circuit = { leds: [ledOf(0, 1)], battery: null };
    const { tool, ctx, now } = armed(circuit);
    const leg = resolveVertex({ kind: "led", led: 0, leg: 0 }, ctx)!;
    tap(tool, leg);
    tap(tool, { x: leg.x + 0.6, y: leg.y + 0.6 });
    tool.onKey(key("Enter"));
    const w = now().wires![0]!;
    expect(w.pts[0]!.kind).toBe("led"); // it really did snap to the leg
    expect(w.net).toBeUndefined();
  });

  it("takes the wire's net from a snapped pad's netlist assignment", () => {
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const pad = terminals(comp.footprint)[0]![0];
    const circuit: Circuit = {
      leds: [],
      battery: null,
      nets: [{ id: "n1", name: "SIG" }],
      terminals: [{ part: 0, pad, net: "n1" }],
      parts: [{ component: comp.id, x: 0.5, y: 0.5 }],
    };
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    tap(tool, padAt);
    tap(tool, { x: padAt.x + 0.6, y: padAt.y + 0.6 });
    tool.onKey(key("Enter"));
    expect(now().wires![0]!.net).toBe("n1");
  });

  it("leaves the net unset when nothing the wire touches names one", () => {
    const { tool, now } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    tool.onKey(key("Enter"));
    expect(now().wires![0]!.net).toBeUndefined();
  });
});

describe("WireTool editing", () => {
  /** Draw and commit a straight two-vertex wire, then select it. */
  function drawn(): ReturnType<typeof armed> {
    const h = armed();
    tap(h.tool, { x: 0.2, y: 0.2 });
    tap(h.tool, { x: 1.6, y: 0.2 });
    h.tool.onKey(key("Enter"));
    return h;
  }

  it("selects a committed wire by a tap on its body", () => {
    const { tool, commits } = drawn();
    tool.onKey(key("Escape")); // clear the selection the commit left
    expect(tool.selected()).toBeNull();
    tap(tool, { x: 0.9, y: 0.2 }); // midway along the run, not on either end
    expect(tool.selected()).toBe("w1");
    expect(commits).toHaveLength(1); // selecting is not an edit
  });

  it("moves exactly one vertex on a handle drag, and commits once", () => {
    const { tool, commits, now } = drawn();
    expect(tool.selected()).toBe("w1");
    const before = now().wires![0]!.pts;
    drag(tool, { x: 1.6, y: 0.2 }, { x: 1.6, y: 1.4 });
    expect(commits).toHaveLength(2); // the draw, then the drag
    const after = now().wires![0]!.pts;
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ kind: "free", x: 1.6, y: 1.4 });
  });

  it("commits nothing until the drag ends", () => {
    const { tool, commits } = drawn();
    const ev = (p: Vec2): PointerEvent =>
      ({ button: 0, clientX: p.x * PX, clientY: p.y * PX, pointerId: 1 }) as unknown as PointerEvent;
    tool.onPointerDown(ev({ x: 1.6, y: 0.2 }));
    for (let i = 0; i < 10; i++) tool.onPointerMove(ev({ x: 1.6, y: 0.2 + i * 0.1 }));
    expect(commits).toHaveLength(1); // still just the draw
    tool.onPointerUp(ev({ x: 1.6, y: 1.2 }));
    expect(commits).toHaveLength(2);
  });

  it("deletes one vertex on X plus a tap on its handle", () => {
    const { tool, now } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.9, y: 0.2 });
    tap(tool, { x: 1.6, y: 0.2 });
    tool.onKey(key("Enter"));
    expect(now().wires![0]!.pts).toHaveLength(3);
    tool.onKey(key("x"));
    tap(tool, { x: 0.9, y: 0.2 });
    tool.onKey(key("x", "keyup"));
    const pts = now().wires![0]!.pts;
    expect(pts).toHaveLength(2);
    expect(pts).toEqual([
      { kind: "free", x: 0.2, y: 0.2 },
      { kind: "free", x: 1.6, y: 0.2 },
    ]);
  });

  it("takes the whole wire away when a vertex deletion leaves under two", () => {
    const { tool, now } = drawn();
    tool.onKey(key("x"));
    tap(tool, { x: 0.2, y: 0.2 });
    tool.onKey(key("x", "keyup"));
    expect(now().wires).toEqual([]);
    expect(tool.selected()).toBeNull();
  });

  it("does not consume a tap on bare canvas while X is held", () => {
    const { tool } = drawn();
    tool.onKey(key("x"));
    const e = { button: 0, clientX: 15 * PX, clientY: 15 * PX, pointerId: 1 } as unknown as PointerEvent;
    expect(tool.onPointerDown(e)).toBe(false);
  });

  it("removes the selected wire on Delete", () => {
    const { tool, commits, now } = drawn();
    expect(tool.selected()).toBe("w1");
    expect(tool.onKey(key("Delete"))).toBe(true);
    expect(now().wires).toEqual([]);
    expect(commits).toHaveLength(2);
    expect(tool.selected()).toBeNull();
  });

  it("ignores Delete with nothing selected, and mid-draw", () => {
    const { tool, commits } = drawn();
    tool.onKey(key("Escape"));
    expect(tool.onKey(key("Delete"))).toBe(false);
    tap(tool, { x: 0.3, y: 1.4 });
    expect(tool.onKey(key("Delete"))).toBe(false);
    expect(commits).toHaveLength(1);
  });

  it("leaves the rest of the circuit alone when it commits a wire", () => {
    // A wire is an ADDITION to the circuit, never a replacement of it. Every other test here reads only
    // `.wires` off the commit, so a `commit` that dropped the parts, the chips and the netlist would look
    // exactly like one that did not.
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const circuit: Circuit = {
      leds: [ledOf(0, 1)],
      battery: { face: 0 },
      nets: [{ id: "n1", name: "SIG" }],
      terminals: [{ part: 0, pad: terminals(comp.footprint)[0]![0], net: "n1" }],
      parts: [{ component: comp.id, x: 1.4, y: 1.4 }],
    };
    const { tool, now } = armed(circuit);
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.8 });
    tool.onKey(key("Enter"));
    const after = now();
    expect(after.parts).toEqual(circuit.parts);
    expect(after.leds).toEqual(circuit.leds);
    expect(after.battery).toEqual(circuit.battery);
    expect(after.nets).toEqual(circuit.nets);
    expect(after.terminals).toEqual(circuit.terminals);
    expect(after.wires).toHaveLength(1);
  });

  it("gives consecutive wires distinct ids", () => {
    const { tool, now } = drawn();
    tap(tool, { x: 0.3, y: 1.4 });
    tap(tool, { x: 1.5, y: 1.4 });
    tool.onKey(key("Enter"));
    expect((now().wires ?? []).map((w) => w.id)).toEqual(["w1", "w2"]);
  });
});

describe("WireTool faults", () => {
  it("reports an off-sheet wire as a fault while it is being drawn, and marks it on the live layer", () => {
    const { tool, live } = armed();
    // The pattern is the 2x2 unit grid, so this run is nowhere near material — the wire cannot be built.
    tap(tool, { x: 6, y: 6 });
    tap(tool, { x: 7, y: 6.5 });
    expect(tool.faults().map((f) => f.kind)).toContain("off-body");
    expect(live.innerHTML).toContain("el-wire-fault");
  });

  it("clears the faults when the offending vertex is taken back, and when the draft is finished", () => {
    const { tool } = armed();
    tap(tool, { x: 0.4, y: 0.4 });
    tap(tool, { x: 6, y: 6 });
    expect(tool.faults()).not.toHaveLength(0);
    tool.onKey(key("Backspace"));
    expect(tool.faults()).toHaveLength(0); // one vertex left: nothing to check
    tap(tool, { x: 6, y: 6 });
    expect(tool.faults()).not.toHaveLength(0);
    tool.onKey(key("Enter"));
    expect(tool.faults()).toHaveLength(0);
  });

  it("charges a wire drawn on the sheet with nothing that would stop it being built", () => {
    const { tool } = armed();
    tap(tool, { x: 0.4, y: 0.4 });
    tap(tool, { x: 1.5, y: 1.5 });
    // Both its ends are loose, which is a warning and not an error: the author can still cut this.
    expect(tool.faults().map((f) => f.kind)).toEqual(["dangling", "dangling"]);
    expect(isBuildable(tool.faults())).toBe(true);
  });
});

describe("WireTool nets on an edit", () => {
  /** A part whose first pad is assigned to net `n1`, and a wire already carrying a net of its own. */
  function netted(): { circuit: Circuit; pad: string } {
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const pad = terminals(comp.footprint)[0]![0];
    return {
      pad,
      circuit: {
        leds: [],
        battery: null,
        nets: [{ id: "n1", name: "SIG" }],
        terminals: [{ part: 0, pad, net: "n1" }],
        parts: [{ component: comp.id, x: 1.4, y: 1.4 }],
        wires: [
          {
            id: "w1",
            net: "gnd",
            pts: [
              { kind: "free", x: 0.2, y: 0.2 },
              { kind: "free", x: 0.2, y: 1.0 },
            ],
          },
        ],
      },
    };
  }

  it("keeps the net the wire already carries when an edit lands a vertex on a pad of another net", () => {
    const { circuit, pad } = netted();
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    expect(padAt).not.toBeNull();
    tap(tool, { x: 0.2, y: 0.6 }); // select by its body
    expect(tool.selected()).toBe("w1");
    drag(tool, { x: 0.2, y: 1.0 }, padAt);
    const w = now().wires![0]!;
    expect(w.pts[1]).toEqual({ kind: "pad", part: 0, pad }); // the edit did land on the pad
    expect(w.net).toBe("gnd"); // and the author's net survived it
  });

  it("fills in a net on an edit when the wire had none", () => {
    const { circuit, pad } = netted();
    delete circuit.wires![0]!.net;
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    tap(tool, { x: 0.2, y: 0.6 });
    drag(tool, { x: 0.2, y: 1.0 }, padAt);
    expect(now().wires![0]!.net).toBe("n1");
  });
});

describe("WireTool handles", () => {
  /** Two committed wires well apart, with `w1` selected and `w2` not. */
  function pair(): ReturnType<typeof armed> {
    const h = armed();
    tap(h.tool, { x: 0.2, y: 0.2 });
    tap(h.tool, { x: 1.6, y: 0.2 });
    h.tool.onKey(key("Enter"));
    tap(h.tool, { x: 0.2, y: 1.6 });
    tap(h.tool, { x: 1.6, y: 1.6 });
    h.tool.onKey(key("Enter"));
    tap(h.tool, { x: 0.9, y: 0.2 }); // select w1 by its body
    return h;
  }

  it("offers no handle on an unselected wire, so a drag across one leaves it alone", () => {
    const { tool, commits, now } = pair();
    expect(tool.selected()).toBe("w1");
    const before = JSON.stringify(now().wires);
    drag(tool, { x: 1.6, y: 1.6 }, { x: 1.6, y: 0.9 }); // starts on w2's own end vertex
    expect(JSON.stringify(now().wires)).toBe(before);
    expect(commits).toHaveLength(2); // the two draws, and nothing since
  });

  it("offers no handle on an unselected wire under X either, so its vertices cannot be dropped", () => {
    const { tool, commits, now } = pair();
    tool.onKey(key("x"));
    const e = { button: 0, clientX: 1.6 * PX, clientY: 1.6 * PX, pointerId: 1 } as unknown as PointerEvent;
    expect(tool.onPointerDown(e)).toBe(false);
    tool.onKey(key("x", "keyup"));
    expect(now().wires![1]!.pts).toHaveLength(2);
    expect(commits).toHaveLength(2);
  });

  it("moves the selected wire's own vertex on the same gesture", () => {
    const { tool, now } = pair();
    drag(tool, { x: 1.6, y: 0.2 }, { x: 1.6, y: 0.9 });
    expect(now().wires![0]!.pts[1]).toEqual({ kind: "free", x: 1.6, y: 0.9 });
  });
});

describe("WireTool dangling vertices", () => {
  /** A three-vertex wire whose middle vertex names a part the circuit does not have. */
  function withDeadMiddle(): Circuit {
    return {
      leds: [],
      battery: null,
      wires: [
        {
          id: "w1",
          pts: [
            { kind: "free", x: 0.2, y: 0.2 },
            { kind: "pad", part: 7, pad: "1" }, // no such part: this vertex resolves to nothing
            { kind: "free", x: 1.6, y: 0.2 },
          ],
        },
      ],
    };
  }

  it("marks a vertex that no longer resolves instead of hiding it", () => {
    const { tool, live } = armed(withDeadMiddle());
    tap(tool, { x: 0.9, y: 0.2 });
    expect(tool.selected()).toBe("w1");
    expect(live.innerHTML).toContain("el-wire-dangling");
  });

  it("keeps the drawn copper to the vertices that do resolve, exactly as the export resolves them", () => {
    const { tool, live } = armed(withDeadMiddle());
    tap(tool, { x: 0.9, y: 0.2 });
    // Two points, not three: the dangling vertex is a marker beside the wire, never a bend in it.
    expect(live.innerHTML).toContain("M 2 2 L 16 2");
  });

  it("lets the author grab the dangling vertex and re-attach it to a pad", () => {
    const comp = LIBRARY.find((c) => terminals(c.footprint).length >= 2)!;
    const pad = terminals(comp.footprint)[0]![0];
    const circuit: Circuit = { ...withDeadMiddle(), parts: [{ component: comp.id, x: 0.9, y: 1.2 }] };
    const { tool, ctx, now } = armed(circuit);
    const padAt = resolveVertex({ kind: "pad", part: 0, pad }, ctx)!;
    tap(tool, { x: 0.9, y: 0.2 });
    // Halfway between the two neighbours by index, which is where the marker is drawn.
    drag(tool, { x: 0.9, y: 0.2 }, padAt);
    const pts = now().wires![0]!.pts;
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ kind: "free", x: 0.2, y: 0.2 });
    expect(pts[1]).toEqual({ kind: "pad", part: 0, pad }); // re-attached, and symbolically
    expect(pts[2]).toEqual({ kind: "free", x: 1.6, y: 0.2 });
  });

  it("lets the author drop the dangling vertex with X", () => {
    const { tool, now } = armed(withDeadMiddle());
    tap(tool, { x: 0.9, y: 0.2 });
    tool.onKey(key("x"));
    tap(tool, { x: 0.9, y: 0.2 });
    tool.onKey(key("x", "keyup"));
    expect(now().wires![0]!.pts).toEqual([
      { kind: "free", x: 0.2, y: 0.2 },
      { kind: "free", x: 1.6, y: 0.2 },
    ]);
  });

  it("stands a dangling end vertex off past the last one that resolves, where it can be grabbed", () => {
    const circuit: Circuit = {
      leds: [],
      battery: null,
      wires: [
        {
          id: "w1",
          pts: [
            { kind: "free", x: 0.2, y: 0.2 },
            { kind: "free", x: 0.9, y: 0.2 },
            { kind: "pad", part: 7, pad: "1" },
          ],
        },
      ],
    };
    const { tool, now } = armed(circuit);
    tap(tool, { x: 0.5, y: 0.2 });
    expect(tool.selected()).toBe("w1");
    // One step past the last resolvable vertex, along the run's own last step.
    drag(tool, { x: 1.6, y: 0.2 }, { x: 1.4, y: 1.5 });
    expect(now().wires![0]!.pts[2]).toEqual({ kind: "free", x: 1.4, y: 1.5 });
  });

  it("shows nothing for a wire no vertex of which resolves", () => {
    const circuit: Circuit = {
      leds: [],
      battery: null,
      wires: [{ id: "w1", pts: [{ kind: "pad", part: 7, pad: "1" }, { kind: "pad", part: 8, pad: "1" }] }],
    };
    const { tool, live } = armed(circuit);
    tap(tool, { x: 0.9, y: 0.2 });
    expect(tool.selected()).toBeNull(); // there is no body to tap: the tap starts a wire instead
    expect(live.innerHTML).not.toContain("el-wire-dangling");
  });
});

describe("WireTool painting", () => {
  it("writes only to the live layer, and clears it when put away", () => {
    const { tool, live } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tool.onPointerMove({ clientX: 8, clientY: 2, button: 0, pointerId: 1 } as unknown as PointerEvent);
    expect(live.innerHTML).toContain("el-wire-band");
    expect(live.innerHTML).toContain("el-wire-handle");
    tool.setActive(false);
    expect(live.innerHTML).toBe("");
  });

  it("strokes the draft at the tape width, scaled through the host transform", () => {
    // `worldScale` is MEASURED through `tp` rather than asked for, so the strip is drawn at the width it
    // will be cut at whatever the canvas zoom. The path-data tests above pin where the draft goes; this
    // pins how wide it is, which nothing else here reads.
    const { tool, live, ctx } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.2 });
    expect(live.innerHTML).toContain(`stroke-width="${ctx.tapeW * PX}"`);
  });

  it("paints the draft through the host transform", () => {
    const { tool, live } = armed();
    tap(tool, { x: 0.2, y: 0.2 });
    tap(tool, { x: 0.8, y: 0.2 });
    // tp multiplies by PX, so the draft path is written in world units and not in pattern units.
    expect(live.innerHTML).toContain("el-wire-draft");
    expect(live.innerHTML).toContain("M 2 2 L 8 2");
  });
});
