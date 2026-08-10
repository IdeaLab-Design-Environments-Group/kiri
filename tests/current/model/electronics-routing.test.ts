import { describe, expect, it } from "vitest";
import { planRoutes } from "../../../src/model/electronics-routing.js";
import {
  type Circuit,
  type Vec2,
  boundsDiagonal,
  flatFaces,
  gapGraph,
  tapeWidthForDiag,
} from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/**
 * A 1×3 strip of unit squares (faces 0-1-2, gaps {0,1} and {1,2}) plus a
 * disconnected pair of squares far away (faces 3-4, gap {3,4}) that shares no
 * edge with the strip — so an LED on {3,4} can never be routed to a battery on
 * the strip.
 */
function strip(): FoldFile {
  return {
    vertices_coords: [
      [0, 0], [10, 0], [10, 10], [0, 10], // square 0
      [20, 0], [20, 10], // + square 1
      [30, 0], [30, 10], // + square 2
      [100, 0], [110, 0], [110, 10], [100, 10], // square 3
      [120, 0], [120, 10], // + square 4
    ],
    faces_vertices: [
      [0, 1, 2, 3], // 0
      [1, 4, 5, 2], // 1
      [4, 6, 7, 5], // 2
      [8, 9, 10, 11], // 3 (far)
      [9, 12, 13, 10], // 4 (far)
    ],
    edges_vertices: [
      [1, 2], // gap 0|1
      [4, 5], // gap 1|2
      [9, 10], // gap 3|4
    ],
    edges_assignment: ["M", "M", "M"],
  };
}

const circuit = (over: Partial<Circuit>): Circuit => ({ leds: [], battery: null, ...over });
const near = (a: Vec2, b: Vec2, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;

describe("model/electronics-routing: two-net PWR/GND", () => {
  it("routes a PWR bus to the LED's a-leg and a GND bus to its b-leg", () => {
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    const pwr = r.traces.filter((t) => t.net === "pwr");
    const gnd = r.traces.filter((t) => t.net === "gnd");
    expect(pwr.length).toBeGreaterThan(0);
    expect(gnd.length).toBeGreaterThan(0);

    // Each net TERMINATES exactly on the LED's leg pad — the leg stub is the last segment of a
    // continuous chain, and the offset is tapered to zero there, so the tape lands on the pad rather
    // than beside it.
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 1 && g.faceB === 2)!;
    const endsOn = (net: typeof pwr, leg: Vec2) =>
      net.some((t) => {
        const e = t.points[t.points.length - 1]!;
        return Math.hypot(e.x - leg.x, e.y - leg.y) < 1e-9;
      });
    expect(endsOn(pwr, gap.legA)).toBe(true);
    expect(endsOn(gnd, gap.legB)).toBe(true);
    expect(r.unreachable).toEqual([]);
  });

  it("keeps every copper trace inside the body (never flies out into empty space)", () => {
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    // The connected strip spans x∈[0,30], y∈[0,10]; allow a small rail-offset slack.
    const m = 1;
    for (const t of r.traces) for (const p of t.points) {
      expect(p.x).toBeGreaterThanOrEqual(0 - m);
      expect(p.x).toBeLessThanOrEqual(30 + m);
      expect(p.y).toBeGreaterThanOrEqual(0 - m);
      expect(p.y).toBeLessThanOrEqual(10 + m);
    }
  });

  it("keeps a healthy margin on that slack (canary for the miter limit)", () => {
    // The mitered offset can push a joint at most miterLimit·RAIL_OFFSET outside a ring node, and ring
    // nodes sit ~0.79 mm inside the tile. If a future offset/miter bump eats the 1 mm slack above, this
    // fails first and loudly instead of the bounds test silently going red.
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    const m = 0.5;
    for (const t of r.traces) for (const p of t.points) {
      expect(p.x).toBeGreaterThanOrEqual(0 - m);
      expect(p.x).toBeLessThanOrEqual(30 + m);
      expect(p.y).toBeGreaterThanOrEqual(0 - m);
      expect(p.y).toBeLessThanOrEqual(10 + m);
    }
  });

  it("flags an LED whose face-pair shares no gap as unreachable", () => {
    // faces 0 and 2 are not adjacent, so {0,2} has no legs to land on.
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }, { a: 0, b: 2 }] }));
    expect(r.unreachable).toContain(1); // {0,2} (index 1 in circuit.leds)
    expect(r.unreachable).not.toContain(0);
    expect(r.traces.some((t) => t.net === "pwr")).toBe(true); // the valid LED still routes
  });

  it("flags an LED in a disconnected body component as unreachable", () => {
    // The far pair (faces 3,4) shares a real gap but is not connected to the battery's body.
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 3, b: 4 }] }));
    expect(r.unreachable).toContain(0);
  });

  it("emits only PWR and GND nets — no series chain", () => {
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    expect(r.traces.every((t) => t.net === "pwr" || t.net === "gnd")).toBe(true);
  });
});

describe("model/electronics-routing: continuous, straightened traces", () => {
  /** Two squares sharing one interior edge with the given assignment. */
  function pair(assignment: string): FoldFile {
    return {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [20, 0], [20, 10]],
      faces_vertices: [[0, 1, 2, 3], [1, 4, 5, 2]],
      edges_vertices: [[1, 2]],
      edges_assignment: [assignment],
    };
  }

  it("emits continuous polylines — no endpoint is left staggered beside its neighbour", () => {
    // The regression test for the original bug: each tree edge used to be offset independently and
    // emitted as its own 2-point trace, so consecutive runs were split by up to 2×the rail offset at
    // every bend. Now a trace endpoint is either a pad/terminal or exactly shared with another trace.
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 1 && g.faceB === 2)!;
    const anchors = [gap.legA, gap.legB, r.terminals!.pwr, r.terminals!.gnd];
    const isAnchor = (p: Vec2) => anchors.some((a) => Math.hypot(a.x - p.x, a.y - p.y) < 1e-9);

    const ends = r.traces.flatMap((t) => [
      { p: t.points[0]!, net: t.net },
      { p: t.points[t.points.length - 1]!, net: t.net },
    ]);
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i]!;
      if (isAnchor(a.p)) continue; // a pad or battery terminal legitimately ends a chain
      const joined = ends.some(
        (b, j) => j !== i && b.net === a.net && Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) < 1e-9,
      );
      expect(joined).toBe(true);
    }
  });

  it("has at least two points in every trace and no repeated vertex", () => {
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    for (const t of r.traces) {
      expect(t.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1]!, b = t.points[i]!;
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(1e-7);
      }
    }
  });

  it("crosses a pass-through tile in one straight run instead of hugging its ring", () => {
    // GND runs from the battery (face 0) to face 2, straight through face 1 (x∈[10,20]). The router
    // graph has a waypoint at face 1's bottom-edge midpoint (x≈15); string-pulling must remove it, so
    // no vertex is left sitting on that edge mid-span.
    const r = planRoutes(strip(), circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] }));
    const gnd = r.traces.filter((t) => t.net === "gnd");
    const stopped = gnd.some((t) => t.points.some((p) => p.x > 12 && p.x < 18 && p.y < 1));
    expect(stopped).toBe(false);
  });

  it("spaces the two rails in proportion to the tape width at any model scale", () => {
    // The rail gap is a fixed fraction of the DRAWN tape width, so the two rails read as adjacent
    // strips whether the pattern is 3 units or 300. Scaling the pattern 10× must scale the gap 10×
    // too — the ratio to the tape width is what has to stay put.
    const scale = (f: FoldFile, k: number): FoldFile => ({
      ...f,
      vertices_coords: f.vertices_coords!.map((c) => [c[0]! * k, c[1]! * k]),
    });
    const led = circuit({ battery: { face: 0 }, leds: [{ a: 1, b: 2 }] });
    const gapInTapeWidths = (f: FoldFile): number => {
      const res = planRoutes(f, led);
      const pwr = res.traces.filter((t) => t.net === "pwr").flatMap((t) => t.points);
      const gnd = res.traces.filter((t) => t.net === "gnd").flatMap((t) => t.points);
      let best = Infinity;
      for (const a of pwr) for (const b of gnd) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
      const diag = boundsDiagonal(flatFaces(f).flatMap((x) => x.poly));
      return best / tapeWidthForDiag(diag);
    };
    const one = gapInTapeWidths(strip());
    const ten = gapInTapeWidths(scale(strip(), 10));
    // Both ≈ 2 × 0.55 tape-widths apart.
    expect(one).toBeCloseTo(1.1, 1);
    expect(ten).toBeCloseTo(1.1, 1);
    // Close, but deliberately not tight: the waypoint clearance in `cornerRouteGraph` is capped by the
    // absolute `TAPE_W * 0.7`, so a scaled pattern is not geometrically *similar*, and this closest-
    // approach measure picks up that difference (amplified wherever an inner miter trims a corner).
    // The assertions above are the real substance — a pattern-proportional offset would put one of them
    // near 11 instead of 1.1. This bound just has to stay far below that.
    expect(Math.abs(one - ten) / one).toBeLessThan(0.25);
  });

  it("reaches a pad on the battery's own tile directly, without detouring via a corner", () => {
    // The battery is wired to every waypoint on its own tile's ring, not just the corners. With corners
    // only, a pad whose nearest waypoint was an edge midpoint of that same tile forced the route out to
    // a corner and back — a doubling-back that swept across the other net's lead and produced a
    // criss-cross beside the battery.
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }] }));
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 0 && g.faceB === 1)!;
    // The PWR leg sits on face 0 — the battery's tile. Its whole route must stay short: no excursion
    // further from the battery than the pad itself is.
    const b = r.batteryPoint!;
    const padDist = Math.hypot(gap.legA.x - b.x, gap.legA.y - b.y);
    const pwr = r.traces.filter((t) => t.net === "pwr");
    const routeLen = pwr.reduce((sum, t) => {
      let l = 0;
      for (let i = 1; i < t.points.length; i++) {
        l += Math.hypot(t.points[i]!.x - t.points[i - 1]!.x, t.points[i]!.y - t.points[i - 1]!.y);
      }
      return sum + l;
    }, 0);
    // Route length, not distance-from-battery: the detour is roughly tangential, so it barely changes
    // how far the tape gets from the pack but nearly doubles how much of it there is. Measured on this
    // fixture against a 3.40 straight line — 4.19 wired to the whole ring, 8.05 wired to corners only.
    expect(routeLen).toBeLessThan(padDist * 1.6);
  });

  it("does not route across a cut (C) edge — the tape would be severed", () => {
    // An `M` hinge is joinable, so the LED routes…
    expect(planRoutes(pair("M"), circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }] })).unreachable)
      .toEqual([]);
    // …but the same geometry with the shared edge CUT leaves face 1 unreachable rather than silently
    // producing a circuit that the cutter would slice through.
    expect(planRoutes(pair("C"), circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }] })).unreachable)
      .toContain(0);
  });
});

describe("model/electronics-routing: degenerate", () => {
  it("returns LED/battery points but no traces when there is no battery", () => {
    const r = planRoutes(strip(), circuit({ leds: [{ a: 1, b: 2 }] }));
    expect(r.traces).toEqual([]);
    expect(r.ledPoints).toHaveLength(1);
    expect(r.batteryPoint).toBeNull();
  });
});
