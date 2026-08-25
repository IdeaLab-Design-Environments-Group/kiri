/**
 * Copper the author drew by hand, and what the router owes it.
 *
 * A drawn wire is **fixed**: the router may not move it, shorten it, or re-plan it. It routes AROUND it and
 * hands it on to everything downstream unchanged. That is one trailing `fixed: Trace2D[]` parameter on
 * {@link planRoutes}, and a handful of obligations that are easy to state and easy to get wrong.
 *
 * Three of those are worth naming here, because none of them is obvious:
 *
 *  - **A fixed wire on its own net must cost nothing.** Running a `pwr` stub onto the `pwr` rail is HOW a
 *    drawn wire joins the bus. `selfOverlapLength` groups by net and charges same-net overlap at weight 1
 *    against a 1e-6 length tie-break, so scored naively the router pays a million times the length of the
 *    stub to get its own rail out from under the wire drawn to touch it. The symptom is not a crash; it is
 *    routing that quietly got worse.
 *  - **A fixed wire far from everything must change nothing at all.** The router is documented as
 *    deterministic, and the canvas, the cut file and the folded model each route independently and must
 *    agree. A `fixed` parameter that perturbs the plan breaks that for every drawing that touches nothing.
 *  - **The two halves of the router owe different guarantees.** The netlist half routes through `planNets`,
 *    whose `clearOf` enforces a full tape width against immovable copper, so it either clears the wire or
 *    reports the terminal stranded. The bus half has no clearance predicate at all -- only a proper-crossing
 *    count and a sampled overlap term in a soft objective -- so it can promise not to cross drawn copper but
 *    not to stay a tape width off it. Both are stated below, each as what it actually is.
 *
 * The `fixed` parameter has not landed yet, so all but the first test are gated behind a runtime probe:
 * they turn themselves on the moment the router supports it, and until then the suite stays green. The
 * first test is the baseline -- it passes against the current four-argument signature and guards it.
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
  countNetCrossings,
  planRoutes,
  selfOverlapLength,
  tapeOnBody,
  tapeWidthFor,
  totalLength,
  type RoutedCircuit,
  type Trace2D,
} from "../../../src/model/electronics-routing.js";
import { buildCopperSvgExport } from "../../../src/model/copper-svg-export.js";
import { anchorOverlay } from "../../../src/model/trace-anchor.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/**
 * {@link planRoutes} as it is about to be -- with the trailing `fixed` parameter.
 *
 * Declared here rather than waited for, so this file states the contract and typechecks against both the
 * signature that exists today and the one that is coming. When the parameter lands this alias becomes a
 * no-op and should be deleted.
 */
type PlanWithFixed = (
  faces: FlatFace[],
  gaps: GapEdge[],
  circuit: Circuit,
  sheetMm?: number,
  fixed?: Trace2D[],
) => RoutedCircuit;
const plan = planRoutes as unknown as PlanWithFixed;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  return { fold, faces, gaps };
}

/** Up to `max` LEDs on distinct gaps -- the fixture the rest of the routing tests use. */
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

/** One drawn wire, as the router will receive it. */
function wire(net: string, ...pts: [number, number][]): Trace2D {
  return { net, pts: pts.map(([x, y]) => ({ x, y })) };
}

const samePts = (a: Vec2[], b: Vec2[]): boolean =>
  a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);

/** Is this exact wire in the plan, unmoved and unshortened? */
const carries = (traces: Trace2D[], w: Trace2D): boolean =>
  traces.some((t) => t.net === w.net && samePts(t.pts, w.pts));

/** The plan minus the fixed copper -- the part the router is actually responsible for. */
const routedOnly = (r: RoutedCircuit, fixed: Trace2D[]): Trace2D[] =>
  r.traces.filter((t) => !fixed.some((w) => t.net === w.net && samePts(t.pts, w.pts)));

// ---- geometry, measured the way net-clearance.test.ts measures it ------------
// Distance, not crossings: two runs can approach to nothing without ever crossing -- meeting at a point, or
// running alongside -- and a segment-intersection test calls both of those clean. Laid as tape they are one
// piece of copper.
function ptSeg(a: Vec2, b: Vec2, c: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L)) : 0;
  return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
}
const segSeg = (p: Vec2, q: Vec2, r: Vec2, s: Vec2): number =>
  Math.min(ptSeg(p, q, r), ptSeg(p, q, s), ptSeg(r, s, p), ptSeg(r, s, q));

/** Closest any of `traces` comes to the polyline `w`, centreline to centreline. */
function nearest(traces: Trace2D[], w: Trace2D): number {
  let min = Infinity;
  for (const t of traces) {
    for (let i = 1; i < t.pts.length; i++) {
      for (let j = 1; j < w.pts.length; j++) {
        min = Math.min(min, segSeg(t.pts[i - 1]!, t.pts[i]!, w.pts[j - 1]!, w.pts[j]!));
      }
    }
  }
  return min;
}

// ---- the fixture ------------------------------------------------------------
// house.fkld. Its copper occupies x 5.25-8.31, y 6.23-7.65 of a pattern spanning x 5.00-8.99, y 5.00-8.70,
// and both routers run their traffic along the spine at y = 7.13. Each wire below was placed against a
// dumped plan rather than guessed, and each was checked to be on the sheet -- a wire hanging off the
// material would be testing the wrong thing. Two of them carry an explicit precondition in their test
// asserting that they really are in the router's way, because a wire the router was never going to go near
// makes a test that passes for no reason.

/** Far from every run: on face 4, six tape widths clear of the nearest copper. */
const FAR = wire("pwr", [5.45, 5.62], [5.55, 5.62]);
/**
 * Lying along the PWR rail, which at six LEDs runs (6.00,7.125) -> (7.4933,7.125). How a drawn wire joins a bus.
 *
 * Mid-segment on purpose: it shares no vertex with the rail, so it gets none of the `sharesEnd` forgiveness
 * the boundary tests below map out. That is the case a person drawing a wire actually produces.
 */
const ON_RAIL = wire("pwr", [6.2, 7.125], [6.6, 7.125]);
/** A short GND wall standing across the PWR rail's path through face 8 -- the bus half's obstacle. */
const WALL = wire("gnd", [6.4, 7.05], [6.4, 7.21]);
/** A PWR wall across the declared net's path along the same spine -- the netlist half's obstacle. */
const NET_WALL = wire("pwr", [6.9, 6.95], [6.9, 7.3]);

const house = (leds: number) => {
  const { fold, faces, gaps } = load("house.fkld");
  return { fold, faces, gaps, circuit: { leds: ledsOn(gaps, leds), battery: { face: 0 } } as Circuit };
};

/** Two parts either end of the spine on one declared net, and no bus at all. */
const netlistCircuit = (): Circuit => ({
  leds: [],
  battery: null,
  parts: [
    { component: "R_1206", x: 5.67, y: 7.03 },
    { component: "R_1206", x: 7.99, y: 7.03 },
  ],
  nets: [{ id: "n1", name: "SIG" }],
  terminals: [
    { part: 0, pad: "1", net: "n1" },
    { part: 1, pad: "1", net: "n1" },
  ],
});

/**
 * Does the router take fixed copper yet?
 *
 * A probe, rather than `it.fails` or `describe.skip`. `it.fails` inverts the moment the parameter lands -- a
 * passing test marked failing is itself a failure -- which would leave the session that lands it with a red
 * suite and someone else's file to edit. A plain `.skip` never turns itself back on. This asks the router
 * directly, so the gated tests stay quiet today and start enforcing the contract the moment it is real.
 */
const SUPPORTS_FIXED = ((): boolean => {
  const { faces, gaps, circuit } = house(1);
  return carries(plan(faces, gaps, circuit, PRINT_SHEET_MM, [FAR]).traces, FAR);
})();

describe("model/manual-override", () => {
  it("leaves the plan untouched when the drawn wire is nowhere near the copper", { timeout: 20_000 }, () => {
    // The baseline, and the only test here that passes today: its control arm is the current four-argument
    // call, so it guards the change rather than waiting for it. A `fixed` parameter that perturbs a plan it
    // does not touch would break the router's determinism -- the canvas, the cut file and the folded model
    // each route independently and are only equal because routing is a pure function of the geometry.
    const { faces, gaps, circuit } = house(6);
    const tapeW = tapeWidthFor(faces);
    expect(tapeOnBody(faces, tapeW, FAR.pts[0]!, FAR.pts[1]!), "the drawn wire is on the sheet").toBe(true);

    const before = planRoutes(faces, gaps, circuit);
    expect(nearest(before.traces, FAR), "the fixture wire is far from all copper").toBeGreaterThan(tapeW * 3);

    const after = plan(faces, gaps, circuit, PRINT_SHEET_MM, [FAR]);
    expect(routedOnly(after, [FAR])).toEqual(before.traces);
    expect(after.pads).toEqual(before.pads);
    expect(after.unreachable).toEqual(before.unreachable);
  });

  /**
   * Where the exemption the router needs already exists, and where it stops.
   *
   * `selfOverlapLength` skips a segment pair when `sharesEnd` says they coincide at an endpoint
   * (`electronics-routing.ts:2883`, inside the function; the helper itself is at `:2896`). That is a real
   * same-net exemption and it is exact -- `Math.abs(p.x - q.x) < 1e-9`. So a drawn wire whose endpoint is
   * the very `Vec2` the rail already has costs nothing even today, and none of the router change is needed
   * for it.
   *
   * The knife edge is the point. A wire a millionth of a unit off that vertex, or one drawn along the rail
   * without touching a vertex at all, is charged in full -- and the near-miss costs slightly MORE than the
   * mid-segment case, because being off the vertex also loses it the adjacent-segment forgiveness.
   *
   * This matters beyond the router: the exemption only ever applies if the wire tool resolves a snapped
   * endpoint to the identical `Vec2` the router emits. A free-hand vertex, or one rounded through a display
   * value on the way, silently pays the full penalty. These are pure measurements of `selfOverlapLength`,
   * so they need no router change and run today.
   */
  describe("what selfOverlapLength already forgives", () => {
    /** The plan's own PWR spine, at full precision -- rounded fixture coordinates would miss the 1e-9 test. */
    const spine = () => {
      const { faces, gaps, circuit } = house(6);
      const tapeW = tapeWidthFor(faces);
      const traces = planRoutes(faces, gaps, circuit).traces;
      const rail = traces.find((t) => t.net === "pwr")!;
      const [v, w2] = [rail.pts[2]!, rail.pts[3]!];
      const along = (u: number): Vec2 => ({ x: v.x + (w2.x - v.x) * u, y: v.y + (w2.y - v.y) * u });
      const tol = tapeW * 0.75;
      const cost = (pts: Vec2[]): number =>
        selfOverlapLength([...traces, { net: "pwr", pts }], tol) - selfOverlapLength(traces, tol);
      return { v, along, cost };
    };

    it("charges nothing for a wire snapped to the exact vertex it joins", { timeout: 20_000 }, () => {
      const { v, along, cost } = spine();
      expect(cost([{ ...v }, along(0.6)]), "along the rail from its vertex").toBe(0);
      expect(cost([{ ...v }, { x: v.x, y: v.y + 0.25 }]), "away from the rail from its vertex").toBe(0);
    });

    it("charges in full for a wire that misses the vertex, however narrowly", { timeout: 20_000 }, () => {
      // This is the hazard the router change has to answer, and the reason a same-net exemption for fixed
      // copper cannot just lean on `sharesEnd`.
      const { v, along, cost } = spine();
      expect(cost([{ x: v.x + 1e-6, y: v.y }, along(0.6)]), "a millionth off the vertex").toBeGreaterThan(1);
      expect(cost([along(0.2), along(0.8)]), "drawn along the rail, touching no vertex").toBeGreaterThan(1);
    });
  });

  // Everything below needs the router to accept fixed copper. See SUPPORTS_FIXED.
  describe.skipIf(!SUPPORTS_FIXED)("with fixed copper", () => {
    it("returns every drawn wire in the plan, exactly as it was drawn", { timeout: 20_000 }, () => {
      // Immovable means immovable. `trimAtOwnJoins` shortens a run where another run of its own net meets it,
      // and `landPads`, `breakRuns` and `seatLedLegs` all rewrite the plan in place -- so fixed copper merged
      // into the candidate set rather than composed alongside it would come back altered. ON_RAIL is the one
      // that would: it meets the PWR rail, which is exactly what `trimAtOwnJoins` looks for.
      const { faces, gaps, circuit } = house(6);
      const r = plan(faces, gaps, circuit, PRINT_SHEET_MM, [FAR, ON_RAIL]);
      expect(carries(r.traces, FAR), "the far wire survived").toBe(true);
      expect(carries(r.traces, ON_RAIL), "the wire on the rail survived").toBe(true);
    });

    it("lays no copper through a drawn wire of another net", { timeout: 20_000 }, () => {
      // The bus half's obstacle guarantee, stated as what the bus router can actually promise: no proper
      // crossing. See the clearance test below for what it cannot.
      //
      // The precondition is load-bearing. Leaving the untouched plan where it is puts one crossing through
      // this wire, so the wire really is in the way and the router really did move for it -- without that
      // arm this test passes just as well when `fixed` never reaches the objective at all.
      const { faces, gaps, circuit } = house(6);
      const before = planRoutes(faces, gaps, circuit);
      expect(countNetCrossings([...before.traces, WALL]), "the wall is in the router's way").toBeGreaterThan(0);

      const after = plan(faces, gaps, circuit, PRINT_SHEET_MM, [WALL]);
      expect(countNetCrossings(after.traces)).toBe(0);
    });

    it("cannot yet hold a full tape width off drawn copper on the bus half", { timeout: 20_000 }, () => {
      // A known gap, pinned rather than wished away -- the same treatment the self-overlap and under-chip
      // budgets in electronics-routing.test.ts get.
      //
      // The requirement is a whole tape width: each strip reaches half a width either side of its centreline,
      // so centres a width apart are two strips just touching and anything closer is one piece of copper.
      // The netlist half meets it, because `planNets` routes through `clearOf`, which tests exactly that.
      // The bus half has no clearance predicate -- only `countNetCrossings`, which sees proper crossings and
      // not near misses, and `overlapLength`, a sampled term in a soft objective -- so it slides past the end
      // of a wall rather than standing off it. Measured here at 0.31 tape widths, which as laid tape is a
      // short; and note it is WORSE than the 0.75 the untouched plan happened to leave, because clearing the
      // crossing is what moved it in. Closing this needs a clearance test on the bus half, not a weight.
      const { faces, gaps, circuit } = house(6);
      const tapeW = tapeWidthFor(faces);
      const r = plan(faces, gaps, circuit, PRINT_SHEET_MM, [WALL]);
      const others = routedOnly(r, [WALL]).filter((t) => t.net !== WALL.net);
      const gap = nearest(others, WALL) / tapeW;
      expect(gap, "regressed below the measured floor").toBeGreaterThan(0.25);
      expect(gap, "the bus half now clears a tape width -- delete this test and assert it").toBeLessThan(1);
    });

    it("does not contort the rail away from a drawn wire on its own net", { timeout: 20_000 }, () => {
      // The self-overlap hazard, stated as the property that catches it.
      //
      // `selfOverlapLength` groups traces by net and exempts only adjacent segments of the SAME trace, so a
      // separate `pwr` wire lying on the `pwr` rail reads as tape laid twice -- at weight 1 in the objective,
      // against a 1e-6 length tie-break. Without a same-net exemption for fixed copper the router pays
      // heavily to move its own rail out from under the wire drawn to join it.
      //
      // Asserted as plan identity rather than as a self-overlap measurement, because the measurement does not
      // discriminate: house routes at zero self-overlap either way, and the contortion surfaces as the router
      // taking a longer way round (11.536 -> 11.577 flat units when the exemption is missing) rather than as
      // repeated tape of its own. A same-net wire on the rail is invisible to every other term -- both
      // `countNetCrossings` and `overlapLength` skip same-net pairs -- and its vertices are not corridor
      // nodes, so with the exemption in place there is nothing left for it to change.
      const { faces, gaps, circuit } = house(6);
      const tapeW = tapeWidthFor(faces);

      const before = planRoutes(faces, gaps, circuit);
      expect(nearest(before.traces, ON_RAIL), "the wire really does lie on the rail").toBeLessThan(tapeW * 0.5);

      const after = plan(faces, gaps, circuit, PRINT_SHEET_MM, [ON_RAIL]);
      const routed = routedOnly(after, [ON_RAIL]);
      expect(totalLength(routed), "took a longer way round").toBeCloseTo(totalLength(before.traces), 9);
      expect(routed).toEqual(before.traces);
    });

    it("routes a declared net clear of a drawn wire, or reports it stranded", { timeout: 20_000 }, () => {
      // The netlist half, which is the one that can give the full guarantee: `planNets` already takes
      // immovable copper as its fifth argument and `clearOf` already holds a whole tape width against it, so
      // all this half needs is for the drawn wires to join that list.
      //
      // A disjunction because both outcomes are honest -- a net routed the long way round is wired, and a net
      // reported unroutable is useful. What is not allowed is the third outcome, copper laid across the wire,
      // which is a short nobody sees until the tape is down. On this fixture it resolves as stranded: the
      // wall sits across the only spine, and the far terminal has nowhere else to come from.
      const { faces, gaps } = load("house.fkld");
      const tapeW = tapeWidthFor(faces);
      const circuit = netlistCircuit();

      const before = planRoutes(faces, gaps, circuit);
      expect(before.nets[0]!.stranded, "the net routes freely without the wall").toEqual([]);
      expect(nearest(before.nets[0]!.traces, NET_WALL), "the wall is across its path").toBeLessThan(tapeW);

      const r = plan(faces, gaps, circuit, PRINT_SHEET_MM, [NET_WALL]);
      const net = r.nets[0]!;
      const laid = net.traces.filter((t) => t.net !== NET_WALL.net);
      expect(nearest(laid, NET_WALL) >= tapeW || net.stranded.length > 0).toBe(true);
    });

    it("hands the same drawn copper to the canvas, the cut file and the folded model", { timeout: 20_000 }, () => {
      // The one most likely to be forgotten, and worth a test even though it looks trivial: all three
      // consumers read `RoutedCircuit.traces` -- the modal's `replan`, `buildCopperSvgExport` from that same
      // cached plan, and `app-controller`'s `tracesForSim` -- so putting the fixed wires INTO `traces` is what
      // makes them agree. Anything that returned the drawn copper alongside `traces` instead would reach the
      // canvas and silently miss the cut file and the simulation.
      //
      // What this cannot check is the step above `planRoutes`: the modal plans from `this.circuit` and
      // `tracesForSim` from the store's, so the wires have to live on `Circuit` for both call sites to pass
      // the same ones. That is a `Circuit` change, not a router one.
      const { fold, faces, gaps, circuit } = house(6);
      const tapeW = tapeWidthFor(faces);
      const before = planRoutes(faces, gaps, circuit);
      const after = plan(faces, gaps, circuit, PRINT_SHEET_MM, [FAR]);

      // The canvas: the plan the modal draws from.
      expect(carries(after.traces, FAR)).toBe(true);

      // The cut file: one more PWR strip to peel and lay than the same circuit without the wire.
      const cutBefore = buildCopperSvgExport(fold, before.traces, tapeW, "kiri", before.pads);
      const cutAfter = buildCopperSvgExport(fold, after.traces, tapeW, "kiri", after.pads);
      expect(cutAfter.counts.pwr).toBe(cutBefore.counts.pwr + 1);
      expect(cutAfter.counts.gnd).toBe(cutBefore.counts.gnd);

      // The folded model: one more anchored ribbon, exactly as `tracesForSim` builds it.
      const simBefore = anchorOverlay(before.traces, before.pads, null, tapeW, faces);
      const simAfter = anchorOverlay(after.traces, after.pads, null, tapeW, faces);
      expect(simAfter.length).toBe(simBefore.length + 1);
    });
  });
});
