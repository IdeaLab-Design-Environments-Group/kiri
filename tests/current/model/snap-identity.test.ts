/**
 * Do a snapped wire endpoint and a routed vertex land on the *same* point — bit for bit?
 *
 * This matters because of one line in the router. {@link selfOverlapLength} charges a net for lying on top
 * of itself, and a stub drawn onto the rail it belongs to is exactly that shape. The only forgiveness is
 * `sharesEnd`, which compares coordinates at 1e-9: two segments that share an endpoint are not charged
 * against each other. So the forgiveness reaches a hand-drawn wire only if its end is the router's own
 * vertex to the last bit. Along the longest run of house at three LEDs, a stub laid on that run from its
 * own vertex costs 0.000000, and the same stub displaced by 1e-6 costs 1.918615. There is nothing gradual
 * in between.
 *
 * **The identity holds.** Every attached thing the router lays copper to resolves to the router's own
 * vertex exactly — `===` on both coordinates, on three patterns at three very different scales. That is not
 * luck: a pad goes through `padPosition`, a leg through `seatLed`, a terminal through `batteryTerminals`,
 * and in each case the wire and the router call the same function with the same arguments, so the two
 * computations are one computation run twice -- a declared net's route begins literally at
 * `net.points[i].at`, which is `padPosition`'s own return value. The identity is by construction rather
 * than by luck, which is why it holds on every pattern and every scale and not just the one measured. The tool's own path preserves it, because what a snap stores
 * is the symbolic vertex and never a coordinate read off the screen.
 *
 * **What the identity buys is narrower than it looks**, and three tests below are limitations rather than
 * successes:
 *
 *  - `sharesEnd` exempts a *pair of segments*. A stub is free while it lies on the one segment whose vertex
 *    it shares; run it past that vertex onto the next and the second pair shares nothing, and the charge
 *    comes back (0.275441 on house at 1.6x the run).
 *  - Exemption from that pair is not exemption from the net. Where another run of the same net passes
 *    within a tape width — which is the ordinary situation at an LED's leg copper — an exactly snapped stub
 *    is still charged for the segments it does not touch (0.108336 on house).
 *  - A pad of a part placed *in series on a rail* never coincides with routed copper at all, and not for
 *    want of precision: the router decides where to break the rail and seats the part on its own span, a
 *    quarter to a third of a tape width from the pad the author's stored point resolves to. Storing the
 *    plan's vertex instead of the pad does not rescue that case either -- it is cheaper and still not free
 *    (0.079113 on house against 0.408955), and it would cost the wire the very thing a symbolic vertex is
 *    for: a wire that follows its part.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  flatFaces,
  gapGraph,
  ledOf,
  type Circuit,
  type FlatFace,
  type GapEdge,
  type Led,
  type Vec2,
} from "../../../src/model/electronics.js";
import {
  PRINT_SHEET_MM,
  TAPE_MM,
  planRoutes,
  selfOverlapLength,
  tapeWidthFor,
  type RoutedCircuit,
  type Trace2D,
} from "../../../src/model/electronics-routing.js";
import { padAt, padNamed } from "../../../src/model/footprint.js";
import { componentById } from "../../../src/model/library.js";
import { resolveVertex, type WireContext } from "../../../src/model/manual-wire.js";
import { WireTool, type WireHost } from "../../../src/view/wire-tool.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** Three real patterns, at three very different scales — house and church route in hundredths of a unit,
 *  akde-hex in whole ones, so a coincidence that survived only one of them would be caught here. */
const PATTERNS = ["house.fkld", "church.fkld", "akde-hex.fkld"];

function load(name: string): { faces: FlatFace[]; gaps: GapEdge[] } {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps };
}

/** Up to `max` LEDs on distinct gaps — the fixture the routing tests use. */
function ledsOn(gaps: GapEdge[], max: number): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(l);
    if (leds.length >= max) break;
  }
  return leds;
}

/** Bit-for-bit, on both coordinates. Never `toBeCloseTo`: `sharesEnd` is a 1e-9 test, and a comparison
 *  that rounds is exactly how the difference this file exists to measure gets hidden. */
const same = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/** Is `at` a vertex the router emitted — and if not, how far is the nearest one? */
function against(traces: Trace2D[], at: Vec2): { exact: boolean; min: number } {
  let min = Infinity;
  let exact = false;
  for (const t of traces) {
    for (const p of t.pts) {
      if (same(p, at)) exact = true;
      min = Math.min(min, Math.hypot(p.x - at.x, p.y - at.y));
    }
  }
  return { exact, min };
}

/** A bus circuit and its plan on one pattern. */
function bus(file: string, leds = 3) {
  const { faces, gaps } = load(file);
  const tapeW = tapeWidthFor(faces, PRINT_SHEET_MM);
  const circuit: Circuit = { leds: ledsOn(gaps, leds), battery: { face: 0 } };
  const routed = planRoutes(faces, gaps, circuit, PRINT_SHEET_MM);
  const ctx: WireContext = { faces, gaps, circuit, tapeW };
  return { faces, gaps, tapeW, circuit, routed, ctx };
}

/**
 * Two parts on one declared net, no bus.
 *
 * Both pads of both parts are on nets, so the router has a reason to lay copper to each — a pad on no net
 * gets none, and would make an "exact" test that could never pass for a reason that is not about precision.
 */
function netlist(file: string) {
  const { faces, gaps } = load(file);
  const tapeW = tapeWidthFor(faces, PRINT_SHEET_MM);
  const circuit: Circuit = {
    leds: [],
    battery: null,
    parts: [
      { component: "R_1206", x: 5.67, y: 7.03 },
      // Flipped. NOTE: the identity tests below cannot see this. Both sides of the identity call
      // `padPosition`, so a flip mishandled there moves the wire's answer and the router's answer together
      // and the comparison still holds — deleting the half-turn from `padPosition` leaves every identity
      // test in this file green. The flip is checked separately, against the footprint, by
      // "puts the flipped part's pad the same distance the other way".
      { component: "R_1206", x: 7.99, y: 7.03, flip: true },
    ],
    nets: [{ id: "n1", name: "A" }],
    terminals: [
      { part: 0, pad: "2", net: "n1" },
      { part: 1, pad: "2", net: "n1" },
    ],
  };
  const routed = planRoutes(faces, gaps, circuit, PRINT_SHEET_MM);
  const ctx: WireContext = { faces, gaps, circuit, tapeW };
  return { faces, gaps, tapeW, circuit, routed, ctx };
}

/** The trace this point is a vertex of, and the segment leading away from it — the copper a wire snapped
 *  here would be drawn along. */
function railAt(traces: Trace2D[], at: Vec2): { net: string; from: Vec2; to: Vec2 } | null {
  for (const t of traces) {
    for (let i = 0; i < t.pts.length; i++) {
      if (!same(t.pts[i]!, at)) continue;
      const away = t.pts[i === 0 ? 1 : i - 1];
      if (away) return { net: t.net, from: at, to: away };
    }
  }
  return null;
}

/** The longest single segment of copper in a plan, with the net it belongs to — a stretch of rail with
 *  room around it, which is where a person draws a stub onto a bus. */
function longestRun(traces: Trace2D[]): { net: string; a: Vec2; b: Vec2 } {
  let best = { net: "", a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, d: 0 };
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > best.d) best = { net: t.net, a, b, d };
    }
  }
  return best;
}

/** A stub from `from` towards `to`, `frac` of the way (or past it), shifted `dx` sideways in x. */
const stub = (net: string, from: Vec2, to: Vec2, frac: number, dx = 0): Trace2D => ({
  net,
  pts: [
    { x: from.x + dx, y: from.y },
    { x: from.x + (to.x - from.x) * frac + dx, y: from.y + (to.y - from.y) * frac },
  ],
});

/** What adding one drawn wire costs the plan in same-net overlap. */
const overlapCost = (routed: RoutedCircuit, tapeW: number, w: Trace2D): number =>
  selfOverlapLength([...routed.traces, w], tapeW) - selfOverlapLength(routed.traces, tapeW);

/** A bus circuit with one library part in series on its longest rail run — placed at the midpoint of that
 *  run, which is a point on copper of the right net and so exactly what the modal's own placement snap
 *  stores. Every coordinate comes off the plan at runtime: a literal here would be measuring the fixture. */
function seriesPart(file: string) {
  const { faces, gaps, tapeW, circuit: busC, routed: first } = bus(file);
  const run = longestRun(first.traces.filter((t) => t.net === "pwr"));
  const circuit: Circuit = {
    ...busC,
    parts: [{ component: "C_1206", x: (run.a.x + run.b.x) / 2, y: (run.a.y + run.b.y) / 2 }],
  };
  const routed = planRoutes(faces, gaps, circuit, PRINT_SHEET_MM);
  return { faces, gaps, tapeW, circuit, routed, ctx: { faces, gaps, circuit, tapeW } as WireContext };
}

/** The plan's nearest vertex to `at`, and the vertex next to it along its own trace. */
function nearestVertex(traces: Trace2D[], at: Vec2): { net: string; at: Vec2; away: Vec2; d: number } {
  let best: { net: string; at: Vec2; away: Vec2; d: number } | null = null;
  for (const t of traces) {
    for (let i = 0; i < t.pts.length; i++) {
      const away = t.pts[i === 0 ? 1 : i - 1];
      if (!away) continue;
      const p = t.pts[i]!;
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (!best || d < best.d) best = { net: t.net, at: p, away, d };
    }
  }
  return best!;
}

describe("model/snap-identity", () => {
  /**
   * The one thing the identity tests structurally cannot check.
   *
   * An identity test compares the wire's answer with the router's, and both are `padPosition`'s answer, so
   * anything wrong *inside* `padPosition` is wrong on both sides at once and cancels. This test compares
   * against the footprint instead: the pad offset is read off the library and the half-turn is written out
   * here by hand, so `padPosition` has no say in what the expected value is. Deleting `const s = part.flip
   * ? -1 : 1` from `src/model/netlist.ts` fails this and nothing else in the wire tests.
   */
  it("puts the flipped part's pad the same distance the other way from its own origin", { timeout: 20_000 }, () => {
    const local = padAt(padNamed(componentById("R_1206")!.footprint, "2"));
    for (const file of PATTERNS) {
      const { circuit, tapeW, ctx } = netlist(file);
      // Millimetres on the footprint into this pattern's units — `toFlat`'s arithmetic, spelled out.
      const dx = (local.x * tapeW) / TAPE_MM, dy = (local.y * tapeW) / TAPE_MM;
      // The offset has to be big enough to be a fact: two ways of writing zero would agree under any flip.
      expect(Math.hypot(dx, dy), file).toBeGreaterThan(tapeW / 100);
      const [p0, p1] = [circuit.parts![0]!, circuit.parts![1]!];
      const at0 = resolveVertex({ kind: "pad", part: 0, pad: "2" }, ctx)!;
      const at1 = resolveVertex({ kind: "pad", part: 1, pad: "2" }, ctx)!;
      expect(at0.x, `${file} unflipped x`).toBeCloseTo(p0.x + dx, 12);
      expect(at0.y, `${file} unflipped y`).toBeCloseTo(p0.y + dy, 12);
      // Half a turn about the part's own origin, not a mirror: BOTH coordinates change sign.
      expect(at1.x, `${file} flipped x`).toBeCloseTo(p1.x - dx, 12);
      expect(at1.y, `${file} flipped y`).toBeCloseTo(p1.y - dy, 12);
    }
  });

  it("resolves a netlist pad to the exact point the router routes that terminal to", { timeout: 20_000 }, () => {
    // What this checks is identity-of-computation: the wire and the router reach the same point. It does
    // NOT check that that point is the right one — both sides call `padPosition`, so a defect inside it
    // (the flip half-turn, the mm-to-units scale, the pad chosen) moves both answers together and the
    // identity survives. The test above is the one that would catch such a defect.
    for (const file of PATTERNS) {
      const { routed, ctx } = netlist(file);
      // Precondition: the copper is actually there. A stranded terminal gets none, and comparing against
      // copper that was never laid would pass or fail for a reason that has nothing to do with precision.
      expect(routed.nets.flatMap((n) => n.stranded), file).toEqual([]);
      for (const part of [0, 1]) {
        const at = resolveVertex({ kind: "pad", part, pad: "2" }, ctx)!;
        expect(at, file).not.toBeNull();
        expect(against(routed.traces, at), `${file} part ${part}`).toEqual({ exact: true, min: 0 });
      }
    }
  });

  it("resolves every LED leg to a vertex the router emits, bit for bit", { timeout: 20_000 }, () => {
    for (const file of PATTERNS) {
      const { circuit, routed, ctx } = bus(file);
      expect(routed.unreachable, file).toEqual([]);
      circuit.leds.forEach((_, i) => {
        for (const leg of [0, 1] as const) {
          const at = resolveVertex({ kind: "led", led: i, leg }, ctx)!;
          expect(against(routed.traces, at), `${file} led ${i} leg ${leg}`).toEqual({ exact: true, min: 0 });
        }
      });
    }
  });

  it("resolves both battery terminals to vertices the router emits, bit for bit", { timeout: 20_000 }, () => {
    for (const file of PATTERNS) {
      const { routed, ctx } = bus(file);
      for (const side of ["pwr", "gnd"] as const) {
        const at = resolveVertex({ kind: "battery", side }, ctx)!;
        expect(against(routed.traces, at), `${file} ${side}`).toEqual({ exact: true, min: 0 });
      }
    }
  });

  it("keeps that identity through the whole tool path, from a tap to the resolved point", { timeout: 20_000 }, () => {
    const { faces, gaps, tapeW, circuit, routed, ctx } = netlist("house.fkld");
    const commits: Circuit[] = [];
    const live = { innerHTML: "" };
    const host: WireHost = {
      // A pointer lands on integer-ish pixels and comes back through a scale — the one place in the path
      // where a coordinate could pick up a rounding step. It cannot: the snap stores the pad, not the point.
      clientToFlat: (e) => ({ x: e.clientX / 100, y: e.clientY / 100 }),
      tp: (p) => ({ x: p.x * 100, y: p.y * 100 }),
      snapRadiusFlat: () => tapeW,
      circuit: () => circuit,
      commit: (next) => { commits.push(next); },
      context: () => ctx,
      live: () => live,
      routed: () => routed,
    };
    const tool = new WireTool(host);
    tool.setActive(true);
    const pad = resolveVertex({ kind: "pad", part: 0, pad: "2" }, ctx)!;
    // A tap a third of a tape width off the pad — near enough to snap, nowhere near equal to it.
    const tap = (at: Vec2) => {
      const e = { button: 0, clientX: at.x * 100, clientY: at.y * 100, pointerId: 1 } as unknown as PointerEvent;
      tool.onPointerDown(e);
      tool.onPointerUp(e);
    };
    tap({ x: pad.x + tapeW / 3, y: pad.y - tapeW / 3 });
    tap({ x: pad.x + 0.4, y: pad.y + 0.4 });
    expect(tool.onKey({ key: "Enter", type: "keydown" } as unknown as KeyboardEvent)).toBe(true);
    const wire = (commits.at(-1)!.wires ?? [])[0]!;
    // Symbolic, not baked: this is what makes the identity hold at all, and what makes the wire follow the
    // part when it moves.
    expect(wire.pts[0]).toEqual({ kind: "pad", part: 0, pad: "2" });
    const back = resolveVertex(wire.pts[0]!, { faces, gaps, circuit, tapeW })!;
    expect(against(routed.traces, back)).toEqual({ exact: true, min: 0 });
  });

  it("charges nothing for a stub drawn from a routed vertex along a long run of its own net", { timeout: 20_000 }, () => {
    // The case the feature is for: the author draws a stub onto the rail its net already occupies, and it
    // costs the plan nothing at all — a quarter of the run, half of it, or the whole of it, on all three
    // patterns. Every sample the stub puts down is nearest the one segment it shares a vertex with, and
    // `sharesEnd` waves that pair through.
    for (const file of PATTERNS) {
      const { tapeW, routed } = bus(file);
      const run = longestRun(routed.traces);
      for (const frac of [0.25, 0.5, 1]) {
        expect(overlapCost(routed, tapeW, stub(run.net, run.a, run.b, frac)), `${file} frac ${frac}`).toBe(0);
      }
    }
  });

  it("charges the same stub in full when it starts a millionth of a unit off the vertex", { timeout: 20_000 }, () => {
    // The knife edge, stated as numbers. `sharesEnd` compares at 1e-9, so 1e-6 is a thousand times too far
    // and the exemption does not fire at all. Along the longest run of each pattern, a whole-segment stub
    // costs 0.000000 snapped and 1.918615 (house), 2.724860 (church), 168.773770 (akde-hex) displaced. There
    // is no gradient between the two: a wire drawn "very nearly" on the vertex gets none of the forgiveness.
    for (const file of PATTERNS) {
      const { tapeW, routed } = bus(file);
      const run = longestRun(routed.traces);
      expect(overlapCost(routed, tapeW, stub(run.net, run.a, run.b, 1)), file).toBe(0);
      // Against the run's own length, so this means "most of the stub was charged" on every scale.
      const off = overlapCost(routed, tapeW, stub(run.net, run.a, run.b, 1, 1e-6));
      expect(off, file).toBeGreaterThan(Math.hypot(run.b.x - run.a.x, run.b.y - run.a.y));
    }
  });

  it("charges a stub again once it runs past the vertex it shares onto the next segment", { timeout: 20_000 }, () => {
    // A limitation, not a success. `sharesEnd` exempts a PAIR of segments, so the exemption ends where the
    // shared segment does. At 1.6x the run — exactly snapped at its start — the stub pays 0.275441 on house,
    // 0.232780 on church and 34.958527 on akde-hex, having paid 0.000000 at 1.0x. A wire drawn along more
    // than one segment of a rail is charged for everything past the first, however exactly it was snapped:
    // it has only one endpoint to share, and it has already spent it.
    for (const file of PATTERNS) {
      const { tapeW, routed } = bus(file);
      const run = longestRun(routed.traces);
      expect(overlapCost(routed, tapeW, stub(run.net, run.a, run.b, 1)), file).toBe(0);
      expect(overlapCost(routed, tapeW, stub(run.net, run.a, run.b, 1.6)), file).toBeGreaterThan(0);
    }
  });

  it("charges an exactly snapped stub where another run of its own net passes within a tape width", { timeout: 20_000 }, () => {
    // The second limitation, and the one that bites where a person actually draws. An LED's leg is a vertex
    // of a short piece of leg copper in a crowded corner, so a stub drawn from it — perfectly snapped, on the
    // right net — still has other segments of that same net within a tape width of it, and those pairs share
    // no endpoint. Half a leg segment costs 0.064901 on house.
    //
    // Excluded deliberately rather than quietly, because the charge is about crowding and not about the
    // snap: akde-hex, whose pattern spans tens of units with nothing else of the net near, has always cost
    // 0.000000 here — and **church joined it when `TAPE_MM` fell to 1.5 on 2026-08-28**. "Within a tape
    // width" is the window, so halving the roll halves what counts as near, and church's nearest same-net
    // segment is now outside it; it takes about six times today's tape before that stub is charged at all.
    //
    // The window is the whole mechanism, and it can be read straight off the numbers: at 2.1667x today's
    // tape — which is 3.25/1.5, the roll these figures were first taken at — house charges 0.108336 and
    // church 0.017598, the two values this comment used to record.
    for (const file of ["house.fkld"]) {
      const { tapeW, routed, ctx } = bus(file);
      const leg = resolveVertex({ kind: "led", led: 0, leg: 0 }, ctx)!;
      const rail = railAt(routed.traces, leg)!;
      expect(rail, file).not.toBeNull();
      expect(overlapCost(routed, tapeW, stub(rail.net, rail.from, rail.to, 0.5)), file).toBeGreaterThan(0);
    }
  });

  it("does not buy freedom by copying the plan's vertex instead of recomputing the pad", { timeout: 20_000 }, () => {
    // The design question, measured: for a pad that does NOT coincide — a part in series on a rail — is a
    // wire better off storing the plan's nearest vertex than resolving the pad?
    //
    // It is cheaper, and **at the 1.5mm roll it is now free**. Copying makes `sharesEnd` fire, and on house
    // the charge falls from 0.359887 to 0.000000. At 2.1667x today's tape — 3.25/1.5, the roll the original
    // figures were taken at — it fell from 0.408955 to 0.079113 and stopped there, because a broken rail put
    // several segments of the same net within a tape width of the break and the exempted pair was only one
    // of them. Narrowing the roll narrowed that window until the exempted pair is the only one left.
    //
    // So the discount is now total, and the argument is unchanged: it was never that copying cost something,
    // but that a baked coordinate makes a wire stop following its part and go stale the moment the router
    // re-plans. This test exists so that the number, not the intuition, is what anyone weighs — and the
    // number now says the temptation is stronger than it was.
    for (const file of ["house.fkld"]) {
      const { tapeW, routed, ctx } = seriesPart(file);
      const pad = resolveVertex({ kind: "pad", part: 0, pad: "1" }, ctx)!;
      const near = nearestVertex(routed.traces, pad);
      const dir = { x: near.away.x - near.at.x, y: near.away.y - near.at.y };
      const to = (o: Vec2): Vec2 => ({ x: o.x + dir.x, y: o.y + dir.y });
      const recomputed = overlapCost(routed, tapeW, { net: near.net, pts: [pad, to(pad)] });
      const copied = overlapCost(routed, tapeW, { net: near.net, pts: [near.at, to(near.at)] });
      // The load-bearing half: copying is strictly cheaper, which is the temptation being weighed.
      expect(copied, `${file} cheaper`).toBeLessThan(recomputed);
      expect(recomputed, `${file} recomputed`).toBeGreaterThan(0);
      // And the discount really is total at this roll, rather than merely small — pinned so that a change
      // restoring a residual charge is noticed rather than silently welcomed.
      expect(copied, `${file} copied`).toBe(0);
      // And the copy itself survives resolution unchanged, so the shortfall is the router's scoring and
      // not a coordinate lost on the way through.
      expect(resolveVertex({ kind: "free", x: near.at.x, y: near.at.y }, ctx)).toEqual(near.at);
    }
  });

  it("puts a pad of a part placed in series on a rail off the copper the router lays for it", { timeout: 20_000 }, () => {
    // The case where the identity does NOT hold, and the reason is not precision: the author stores a point
    // on a rail, and the router then decides for itself where to break that rail and seats the part on its
    // own span. The span comes back near the stored point -- 0.277 tape widths on both patterns below -- but
    // "near" is not "equal", so a wire snapped to this pad gets none of the `sharesEnd` forgiveness, and the
    // pad is not on the copper either: 0.343 tape widths off on house, 0.263 on church.
    for (const file of ["house.fkld", "church.fkld"]) {
      const { tapeW, routed, ctx } = seriesPart(file);
      expect(routed.parts, file).toHaveLength(1); // the part really was placed; otherwise this proves nothing
      const pad = resolveVertex({ kind: "pad", part: 0, pad: "1" }, ctx)!;
      const got = against(routed.traces, pad);
      expect(got.exact, file).toBe(false);
      expect(got.min, file).toBeGreaterThan(tapeW / 5);
      // Nor is the pad where the router seated the part: the span it laid is a different point again.
      expect(same(routed.parts[0]!.a, pad), file).toBe(false);
      expect(same(routed.parts[0]!.b, pad), file).toBe(false);
    }
  });
});
