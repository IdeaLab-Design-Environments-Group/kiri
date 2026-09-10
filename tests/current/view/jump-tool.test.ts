/**
 * The jump tool's gesture grammar, driven against a fake host with no DOM and no router.
 *
 * `wire-tool.test.ts` is the model for the shape of this: {@link JumpHost} is faked down to the methods
 * the tool actually calls, `live` is an object with an `innerHTML`, and `commit` is a recorder, so every
 * gesture can be driven and every commit counted.
 *
 * The fixture is **desk-lamp-shade**, and it has to be a real one. A jump only means anything against a
 * fold adjacency, and the grid the wire tool tests on has no severed edges at all — its cuts would have to
 * be invented, and an invented pairing would test the tool against a relation the pipeline never produces.
 * The pattern's most-separated rim pair has its two lips 305 units apart in the flat sheet and touching in
 * the folded shade, which is exactly the case the whole feature exists for.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JumpTool, type JumpHost } from "../../../src/view/jump-tool.js";
import { flatFaces, gapGraph, pointInFace, type Circuit, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";
import { tapeMmFor, tapeWidthFor, type RoutedCircuit } from "../../../src/model/electronics-routing.js";
import { DEFAULT_SHEET } from "../../../src/model/fold-strain.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  foldAdjacency,
  pairContaining,
  type FoldAdjacency,
  type LipPairFlat,
} from "../../../src/model/fold-adjacency.js";
import { manualJumps, resolveJump, type JumpContext } from "../../../src/model/manual-jump.js";
import { checkJump } from "../../../src/model/jump-rules.js";
import type { WireContext } from "../../../src/model/manual-wire.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** Pixels per flat unit in the fake host. One, so a pattern point is a pointer coordinate unchanged. */
const PX = 1;
/** The modal's own snap radius on this pattern: `max(2mm, ...)` in flat units, which comes out at 2. */
const SNAP = 2;

const EMPTY_ROUTE: RoutedCircuit = {
  traces: [], pads: [], unreachable: [], unseated: [], resistors: [], switches: [], parts: [], nets: [], netFaults: [],
};

const SHADE = (): FoldFile =>
  JSON.parse(readFileSync(`${EXAMPLES}desk-lamp-shade.fkld`, "utf8")) as FoldFile;

function midOf(lip: [Vec2, Vec2]): Vec2 {
  return { x: (lip[0].x + lip[1].x) / 2, y: (lip[0].y + lip[1].y) / 2 };
}

/**
 * The editor, faked down to the ten methods the tool uses.
 *
 * `counts.routed` is what makes the pointer-move test possible: `routed()` is read only by `recheck`, so
 * counting the calls counts the fault passes — the expensive work a gesture must not repeat.
 */
function makeHost(circuit: Circuit): {
  host: JumpHost;
  commits: Circuit[];
  faces: FlatFace[];
  adjacency: FoldAdjacency;
  tapeW: number;
  ctx: JumpContext;
  now: () => Circuit;
  live: { innerHTML: string };
  counts: { routed: number };
} {
  const fold = SHADE();
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const adjacency = foldAdjacency(fold, faces);
  const tapeW = tapeWidthFor(faces, 130, DEFAULT_SHEET, circuit);
  let current = circuit;
  const commits: Circuit[] = [];
  const live = { innerHTML: "" };
  const counts = { routed: 0 };
  const wire: WireContext = { faces, gaps, circuit: current, tapeW, tapeMm: tapeMmFor(faces, 130) };
  const ctx: JumpContext = { ...wire, adjacency };
  const host: JumpHost = {
    clientToFlat: (e) => ({ x: e.clientX / PX, y: e.clientY / PX }),
    tp: (p) => ({ x: p.x * PX, y: p.y * PX }),
    snapRadiusFlat: () => SNAP,
    circuit: () => current,
    commit: (next) => {
      current = next;
      wire.circuit = next;
      ctx.circuit = next;
      commits.push(next);
    },
    context: () => wire,
    live: () => live,
    routed: () => { counts.routed++; return EMPTY_ROUTE; },
    adjacency: () => adjacency,
    sheet: () => DEFAULT_SHEET,
    drawnJumps: () => current.jumps ?? [],
  };
  return { host, commits, faces, adjacency, tapeW, ctx, now: () => current, live, counts };
}

/** A press-and-release that stays put: the tool's tap. */
function tap(tool: JumpTool, at: Vec2): void {
  const e = { button: 0, clientX: at.x * PX, clientY: at.y * PX, pointerId: 1 } as unknown as PointerEvent;
  tool.onPointerDown(e);
  tool.onPointerUp(e);
}

function ev(p: Vec2): PointerEvent {
  return { button: 0, clientX: p.x * PX, clientY: p.y * PX, pointerId: 1 } as unknown as PointerEvent;
}

function key(name: string, type: "keydown" | "keyup" = "keydown"): KeyboardEvent {
  return { key: name, type } as unknown as KeyboardEvent;
}

function armed(circuit: Circuit = { leds: [], battery: null }): ReturnType<typeof makeHost> & { tool: JumpTool } {
  const h = makeHost(circuit);
  const tool = new JumpTool(h.host);
  tool.setActive(true);
  return { ...h, tool };
}

/** The rim pair whose two lips are furthest apart in the flat sheet — the one a jump is drawn for. */
function widestPair(adj: FoldAdjacency): { index: number; pair: LipPairFlat } {
  let index = 0;
  let best = -1;
  adj.pairs.forEach((pair, i) => {
    const d = Math.hypot(pair.lipA[0].x - pair.lipB[0].x, pair.lipA[0].y - pair.lipB[0].y);
    if (d > best) {
      best = d;
      index = i;
    }
  });
  return { index, pair: adj.pairs[index]! };
}

/** A point inside a face that is on no lip at all — the second tap that cannot be a jump. */
function offSeam(faces: FlatFace[], adj: FoldAdjacency, tapeW: number): Vec2 {
  for (let i = 0; i < faces.length; i++) {
    const c = faces[i]!.centroid;
    if (pointInFace(faces, c) !== i) continue;
    if (pairContaining(adj, c, tapeW)) continue;
    return c;
  }
  throw new Error("desk-lamp-shade should have a face whose centroid is on no lip");
}

describe("JumpTool drawing", () => {
  it("makes one jump from two taps on corresponding rim points", () => {
    const { tool, commits, now, adjacency, ctx } = armed();
    const { index, pair } = widestPair(adjacency);

    tap(tool, midOf(pair.lipA));
    expect(commits).toHaveLength(0); // one end down is not a connection, and nothing is committed for it
    expect(tool.drawing()).toBe(true);

    tap(tool, midOf(pair.lipB));
    expect(commits).toHaveLength(1);
    expect(tool.drawing()).toBe(false);

    const jumps = now().jumps ?? [];
    expect(jumps).toHaveLength(1);
    // Both ends were snapped to a lip and set back into their own faces, so the jump resolves onto the
    // pair the author tapped rather than onto no pair at all.
    const resolved = resolveJump(jumps[0]!, ctx)!;
    expect(resolved.pair).toBe(index);
    expect(resolved.pair).toBeGreaterThanOrEqual(0);
    // Set back, not on the lip: a land laid from the edge itself hangs its ribbon corners off the sheet.
    for (const p of [resolved.a, resolved.b]) expect(pointInFace(ctx.faces, p)).toBeGreaterThanOrEqual(0);
    expect(checkJump(resolved, {
      adjacency, tapeW: ctx.tapeW, tapeMm: ctx.tapeMm!, sheet: DEFAULT_SHEET, faces: ctx.faces,
    }, [], [])).toEqual([]);
  });

  it("abandons the half-drawn jump on Escape, committing nothing", () => {
    const { tool, commits, now, adjacency } = armed();
    const { pair } = widestPair(adjacency);
    tap(tool, midOf(pair.lipA));
    expect(tool.onKey(key("Escape"))).toBe(true);
    expect(tool.drawing()).toBe(false);
    expect(commits).toHaveLength(0);
    expect(now().jumps ?? []).toHaveLength(0);
  });

  it("abandons it when the tool is disarmed, rather than committing copper nobody asked for", () => {
    const { tool, commits, adjacency } = armed();
    const { pair } = widestPair(adjacency);
    tap(tool, midOf(pair.lipA));
    tool.setActive(false);
    expect(tool.drawing()).toBe(false);
    expect(commits).toHaveLength(0);
  });

  it("still commits a jump to nowhere, and reports why it will not work", () => {
    const { tool, commits, now, ctx, adjacency, faces, tapeW } = armed();
    const { pair } = widestPair(adjacency);
    tap(tool, midOf(pair.lipA));
    tap(tool, offSeam(faces, adjacency, tapeW));

    // Drawn is drawn. Refusing the second tap would delete the evidence, and the author would be left with
    // a tool that silently does nothing rather than a fault that says what is wrong.
    expect(commits).toHaveLength(1);
    const resolved = resolveJump((now().jumps ?? [])[0]!, ctx)!;
    expect(resolved.pair).toBe(-1);
    const faults = checkJump(resolved, {
      adjacency, tapeW: ctx.tapeW, tapeMm: ctx.tapeMm!, sheet: DEFAULT_SHEET, faces: ctx.faces,
    }, [], []);
    expect(faults.map((f) => f.kind)).toContain("jump-not-adjacent");
    // And the tool has read the same list for itself, so the status line can say so.
    expect(tool.faults().map((f) => f.kind)).toContain("jump-not-adjacent");
  });

  it("reads no plan on a pointer move — the rubber band must not cost a fault pass", () => {
    const { tool, counts, commits, adjacency } = armed();
    const { pair } = widestPair(adjacency);
    tap(tool, midOf(pair.lipA));
    const before = counts.routed;
    for (let i = 0; i < 20; i++) tool.onPointerMove(ev({ x: 100 + i, y: 40 }));
    expect(counts.routed).toBe(before);
    expect(commits).toHaveLength(0);
  });

  it("highlights the peer lip once the first end is down", () => {
    const { tool, live, adjacency } = armed();
    const { pair } = widestPair(adjacency);
    expect(live.innerHTML).not.toContain("el-jump-peer");

    tap(tool, midOf(pair.lipA));
    expect(live.innerHTML).toContain("el-jump-peer");
    // The lip it welds to, not the one under the hand: the highlight is what tells the author where the
    // second tap goes on a pattern where that edge is three hundred units away.
    const b = midOf(pair.lipB);
    const drawn = [...live.innerHTML.matchAll(/M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/g)]
      .map((m) => ({ a: { x: +m[1]!, y: +m[2]! }, b: { x: +m[3]!, y: +m[4]! } }));
    const peer = drawn.find((d) =>
      Math.hypot(midOf([d.a, d.b]).x - b.x, midOf([d.a, d.b]).y - b.y) < 0.05);
    expect(peer, "the peer lip should be drawn where lip B is").toBeDefined();

    tool.onKey(key("Escape"));
    expect(live.innerHTML).not.toContain("el-jump-peer");
  });

  it("removes the selected jump on Delete, and never one that is still being drawn", () => {
    const { tool, now, ctx, adjacency, faces, tapeW } = armed();
    const { pair } = widestPair(adjacency);
    tap(tool, midOf(pair.lipA));
    tap(tool, midOf(pair.lipB));
    // The jump just committed is the selected one, so `Delete` has something to act on without a
    // second gesture to pick it up.
    expect(tool.selected()).toBe((now().jumps ?? [])[0]!.id);

    // Mid-draw `Delete` is a slip, and taking a finished jump off the sheet for one is not an edit the
    // author can see coming. Starting a draft also drops the selection, which is what makes it a slip.
    tap(tool, offSeam(faces, adjacency, tapeW));
    expect(tool.drawing()).toBe(true);
    expect(tool.onKey(key("Delete"))).toBe(false);
    expect(now().jumps ?? []).toHaveLength(1);
    tool.onKey(key("Escape"));

    // Tapping a committed jump's land picks it up again — the same rule as tapping a wire's body.
    const end = resolveJump((now().jumps ?? [])[0]!, ctx)!.a;
    tap(tool, end);
    expect(tool.selected()).toBe("j1");
    expect(tool.onKey(key("Delete"))).toBe(true);
    expect(now().jumps ?? []).toHaveLength(0);
  });

  it("gives each jump its own id, and keeps both on the circuit", () => {
    const { tool, now, adjacency, ctx } = armed();
    const pairs = adjacency.pairs;
    const first = widestPair(adjacency);
    const second = pairs.findIndex((p, i) =>
      i !== first.index && Math.hypot(p.lipA[0].x - p.lipB[0].x, p.lipA[0].y - p.lipB[0].y) > 100);
    expect(second).toBeGreaterThanOrEqual(0);

    tap(tool, midOf(first.pair.lipA));
    tap(tool, midOf(first.pair.lipB));
    tool.onKey(key("Escape")); // drop the selection, so the next tap starts a jump rather than picking one
    tap(tool, midOf(pairs[second]!.lipA));
    tap(tool, midOf(pairs[second]!.lipB));

    const jumps = now().jumps ?? [];
    expect(jumps.map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(manualJumps({ ...ctx, circuit: now() }).map((j) => j.pair)).toEqual([first.index, second]);
  });
});
