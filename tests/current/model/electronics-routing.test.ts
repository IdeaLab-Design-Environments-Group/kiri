import { describe, expect, it } from "vitest";
import { planRoutes } from "../../../src/model/electronics-routing.js";
import { gapGraph, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
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

    // Each net reaches the LED's leg pad (a stub lands within the rail offset of the pad).
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 1 && g.faceB === 2)!;
    const reaches = (net: typeof pwr, leg: Vec2) =>
      net.some((t) => t.points.some((p) => Math.hypot(p.x - leg.x, p.y - leg.y) < 1)); // off = diag*0.006 ≈ 0.19
    expect(reaches(pwr, gap.legA)).toBe(true);
    expect(reaches(gnd, gap.legB)).toBe(true);
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

describe("model/electronics-routing: degenerate", () => {
  it("returns LED/battery points but no traces when there is no battery", () => {
    const r = planRoutes(strip(), circuit({ leds: [{ a: 1, b: 2 }] }));
    expect(r.traces).toEqual([]);
    expect(r.ledPoints).toHaveLength(1);
    expect(r.batteryPoint).toBeNull();
  });
});
