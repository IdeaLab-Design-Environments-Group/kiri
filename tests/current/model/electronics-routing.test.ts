import { describe, expect, it } from "vitest";
import { planRoutes } from "../../../src/model/electronics-routing.js";
import {
  type Circuit,
  type Vec2,
  boundsDiagonal,
  flatFaces,
  gapGraph,
  segsProperlyIntersect,
  tapeWidthForDiag,
  tilePolys,
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

    // Each net TERMINATES exactly on one of the LED's two leg pads — the leg stub is the last segment
    // of a continuous chain, and the offset is tapered to zero there, so the tape lands on the pad
    // rather than beside it. *Which* pad is PWR is the router's choice (it reverses an LED where that
    // saves a crossing), so the invariant is that the two nets take opposite legs and so bridge the LED.
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 1 && g.faceB === 2)!;
    const endsOn = (net: typeof pwr, leg: Vec2) =>
      net.some((t) => {
        const e = t.points[t.points.length - 1]!;
        return Math.hypot(e.x - leg.x, e.y - leg.y) < 1e-9;
      });
    const pwrOnA = endsOn(pwr, gap.legA), pwrOnB = endsOn(pwr, gap.legB);
    const gndOnA = endsOn(gnd, gap.legA), gndOnB = endsOn(gnd, gap.legB);
    expect(pwrOnA || pwrOnB).toBe(true);
    expect(gndOnA || gndOnB).toBe(true);
    expect(pwrOnA).toBe(!gndOnA); // opposite legs — the LED is bridged, not shorted
    expect(pwrOnB).toBe(!gndOnB);
    // And the reported pads agree with where the copper actually went.
    expect(endsOn(pwr, r.ledPads[0]!.pwr)).toBe(true);
    expect(endsOn(gnd, r.ledPads[0]!.gnd)).toBe(true);
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
    // Measured in tape-widths, the layout is now *exactly* invariant: tape width, rail offset and the
    // waypoint erosion are all fractions of the pattern, so a 10× pattern is geometrically similar.
    // (It used to drift by a few percent because the waypoint clearance was capped by the absolute
    // TAPE_W.) An offset that tracked the bounding box rather than the tape would put these two values
    // a factor of 10 apart, so equality to this precision is a strong guard.
    expect(one).toBeCloseTo(ten, 9);
    // Sanity: the separation is on the order of a tape width, not orders of magnitude off. This is a
    // vertex-to-vertex closest approach across the two nets, not a rail-to-rail spacing — the nets
    // deliberately cross, so it is not a clearance measure and is not pinned to the 1.1 rail spacing.
    expect(one).toBeGreaterThan(0.01);
    expect(one).toBeLessThan(10);
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

  it("lays few long strips rather than a piece per junction", () => {
    // Tape bends, so a strip carries straight through a junction and only the *other* branches there
    // need a fresh piece. This needs a net that actually branches: a 4-tile row with an LED on every
    // hinge and the battery in the middle, so each net serves three pads off a shared trunk.
    // Measured: 6 strips carrying through, 7 when every junction splits.
    const fold: FoldFile = {
      vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [20, 0], [20, 10],
                        [30, 0], [30, 10], [40, 0], [40, 10]],
      faces_vertices: [[0, 1, 2, 3], [1, 4, 5, 2], [4, 6, 7, 5], [6, 8, 9, 7]],
      edges_vertices: [[1, 2], [4, 5], [6, 7]],
      edges_assignment: ["M", "M", "M"],
    };
    const r = planRoutes(fold, circuit({
      battery: { face: 1 },
      leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }],
    }));
    expect(r.unreachable).toEqual([]);
    expect(r.traces.length).toBeLessThanOrEqual(6);
    // No sliver pieces: every strip should be a real run, not a stub left over from a split.
    const lengths = r.traces.map((t) => {
      let l = 0;
      for (let i = 1; i < t.points.length; i++) {
        l += Math.hypot(t.points[i]!.x - t.points[i - 1]!.x, t.points[i]!.y - t.points[i - 1]!.y);
      }
      return l;
    });
    expect(Math.min(...lengths)).toBeGreaterThan(0.5);
  });

  /** A 2×2 block of unit tiles: four hinges meeting at the centre vertex. */
  function block2x2(): FoldFile {
    return {
      vertices_coords: [[0, 0], [10, 0], [20, 0], [0, 10], [10, 10], [20, 10], [0, 20], [10, 20], [20, 20]],
      faces_vertices: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]],
      edges_vertices: [[1, 4], [4, 5], [3, 4], [4, 7]],
      edges_assignment: ["M", "M", "M", "M"],
    };
  }
  const allGapLeds = (fold: FoldFile) =>
    gapGraph(fold).gaps.map((g) => ({ a: Math.min(g.faceA, g.faceB), b: Math.max(g.faceA, g.faceB) }));

  const countCrossings = (r: ReturnType<typeof planRoutes>): number => {
    const segs: { a: Vec2; b: Vec2; net: string }[] = [];
    for (const t of r.traces) {
      for (let i = 1; i < t.points.length; i++) segs.push({ a: t.points[i - 1]!, b: t.points[i]!, net: t.net });
    }
    let n = 0;
    for (const p of segs.filter((s) => s.net === "pwr")) {
      for (const g of segs.filter((s) => s.net === "gnd")) {
        if (segsProperlyIntersect(p.a, p.b, g.a, g.b)) n++;
      }
    }
    return n;
  };

  it("uses the far corner of a hinge to get under the other net's rail", () => {
    // Each net can now reach a leg pad through the hinge's own dent node *or* around either of its end
    // corners. A corner approach makes the shared tree enter that tile with the opposite rotational
    // sense, which flips which side of the rail pair the pad lands on — the one thing reversing the LED
    // cannot do. Measured on this fixture: 4 crossings when only the dent is offered, 3 with the corners.
    const fold = block2x2();
    const r = planRoutes(fold, circuit({ battery: { face: 1 }, leds: allGapLeds(fold) }));
    expect(r.unreachable).toEqual([]);
    expect(countCrossings(r)).toBeLessThanOrEqual(3);
  });

  it("beats the dent-only routing from either authored polarity", () => {
    // `ledOf` normalises an LED to `a < b`, so the authored polarity is an artefact of face numbering and
    // must not decide the quality of the result. It does still influence it — this is a greedy descent, so
    // the two seeds stop at different local optima (measured: 3 from the authored seed, 2 from the
    // reversed one). What must hold from *either* seed is that we end up better than the 4 crossings the
    // dent-only routing is stuck with.
    const fold = block2x2();
    const asIs = allGapLeds(fold);
    const flipped = asIs.map((l) => ({ a: l.b, b: l.a }));
    for (const leds of [asIs, flipped]) {
      const r = planRoutes(fold, circuit({ battery: { face: 1 }, leds }));
      expect(r.unreachable).toEqual([]);
      expect(countCrossings(r)).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic — the preview and the exported copper are planned independently", () => {
    // `resolveSvgExport` runs `planRoutes` a second time on the same circuit. If the search were not
    // deterministic the cut file would not match what the modal drew.
    const fold = block2x2();
    const leds = allGapLeds(fold);
    const a = planRoutes(fold, circuit({ battery: { face: 1 }, leds }));
    const b = planRoutes(fold, circuit({ battery: { face: 1 }, leds }));
    expect(b.traces).toEqual(a.traces);
    expect(b.ledPads).toEqual(a.ledPads);
    expect(b.terminals).toEqual(a.terminals);
  });

  it("still strands only the LEDs that are genuinely cut off", () => {
    // The far pair in `strip()` shares a real gap but no path to the battery. The search must not rescue
    // it, and must not strand the reachable one while trying.
    const r = planRoutes(strip(), circuit({
      battery: { face: 0 },
      leds: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    }));
    expect(r.unreachable).toEqual([1]);
    expect(r.traces.some((t) => t.net === "pwr")).toBe(true);
    expect(r.traces.some((t) => t.net === "gnd")).toBe(true);
  });

  it("reports each LED's pads as its two real legs, one per net", () => {
    // The router may reverse an LED to save a crossing, so `ledPads` — not `led.a` — is the source of
    // truth for which pad is +. Whatever it picks must still be the gap's own two legs, one each.
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }] }));
    const same = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;
    expect(r.ledPads).toHaveLength(2);
    [{ a: 0, b: 1 }, { a: 1, b: 2 }].forEach((led, i) => {
      const gap = gapGraph(fold).gaps.find(
        (g) => (g.faceA === led.a && g.faceB === led.b) || (g.faceA === led.b && g.faceB === led.a),
      )!;
      const pads = r.ledPads[i]!;
      // One pad on each leg, in either assignment, and never both on the same leg.
      const straddles =
        (same(pads.pwr, gap.legA) && same(pads.gnd, gap.legB)) ||
        (same(pads.pwr, gap.legB) && same(pads.gnd, gap.legA));
      expect(straddles).toBe(true);
    });
  });

  it("keeps the tape on the gray tiles rather than over the gap openings", () => {
    // Waypoints are eroded perpendicular to each tile edge by the full width the tape occupies (rail
    // offset + half a tape), so the offset strip stays on the gray. Pulling waypoints toward the
    // centroid instead only clears an edge by cos(θ) of that, and the tape spilled over the openings.
    const fold = strip();
    const r = planRoutes(fold, circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }] }));
    const tiles = tilePolys(fold);
    const inPoly = (p: Vec2, poly: Vec2[]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!, b = poly[j]!;
        if ((a.y > p.y) !== (b.y > p.y) &&
            p.x < ((b.x - a.x) * (p.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x) inside = !inside;
      }
      return inside;
    };
    const onTile = (p: Vec2) => tiles.some((t) => t.ring.length >= 3 && inPoly(p, t.ring));

    let total = 0, off = 0;
    for (const t of r.traces) {
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1]!, b = t.points[i]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(2, Math.ceil(len / 0.05));
        for (let k = 0; k < steps; k++) {
          const s = (k + 0.5) / steps;
          if (!onTile({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s })) off += len / steps;
        }
        total += len;
      }
    }
    // Some overhang is unavoidable: a leg pad *is* a point on the tile edge, and two tiles meet only at
    // a corner, so the tape has to touch open space where it lands and where it hops. The guard is that
    // the bulk of the copper sits on gray.
    expect(off / total).toBeLessThan(0.2);
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
