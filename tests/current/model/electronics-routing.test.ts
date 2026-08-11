import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Circuit,
  type Led,
  flatFaces,
  gapGraph,
  ledOf,
  pointInFace,
} from "../../../src/model/electronics.js";
import {
  batteryTerminals,
  countNetCrossings,
  countOverLed,
  overlapLength,
  patternDiag,
  planRoutes,
  segsCross,
  totalLength,
} from "../../../src/model/electronics-routing.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  return { fold, faces, gaps };
}

/** Up to `max` LEDs on distinct gaps. */
function ledsOn(gaps: ReturnType<typeof load>["gaps"], max: number): Led[] {
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

describe("model/electronics-routing", () => {
  it("never runs copper over an LED chip, on any bundled pattern", () => {
    // The one destructive constraint: tape over the chip shorts the part. Checked on the real patterns,
    // not a toy grid, because a toy grid satisfies it by construction.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces, gaps } = load(name);
      const circuit: Circuit = { leds: ledsOn(gaps, 12), battery: { face: 0 } };
      const r = planRoutes(faces, gaps, circuit);
      expect(countOverLed(r.traces, r.pads), `${name} runs over a chip`).toBe(0);
    }
  });

  it("emits exactly two strips however many LEDs there are", () => {
    // The point of the bus topology: one PWR strip and one GND strip, not two per LED.
    const { faces, gaps } = load("puffin.fkld");
    for (const n of [1, 4, 12]) {
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, n), battery: { face: 0 } });
      expect(r.traces).toHaveLength(2);
      expect(r.traces.map((t) => t.net).sort()).toEqual(["gnd", "pwr"]);
    }
  });

  it("starts each net on its own battery terminal", () => {
    const { faces, gaps } = load("house.fkld");
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 6), battery: { face: 0 } });
    const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces));
    const pwr = r.traces.find((t) => t.net === "pwr")!;
    const gnd = r.traces.find((t) => t.net === "gnd")!;
    expect(pwr.pts[0]).toEqual(term.pwr);
    expect(gnd.pts[0]).toEqual(term.gnd);
  });

  it("lands one rail on each of every LED's two pads", () => {
    const { faces, gaps } = load("church.fkld");
    const leds = ledsOn(gaps, 5);
    const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
    const pwr = r.traces.find((t) => t.net === "pwr")!;
    const gnd = r.traces.find((t) => t.net === "gnd")!;
    leds.forEach((_, i) => {
      const pad = r.pads[i]!;
      // Each pad is a vertex of its own net's strip, and the two pads differ.
      expect(pwr.pts.some((p) => p.x === pad.pwr.x && p.y === pad.pwr.y)).toBe(true);
      expect(gnd.pts.some((p) => p.x === pad.gnd.x && p.y === pad.gnd.y)).toBe(true);
      expect(pad.pwr).not.toEqual(pad.gnd);
    });
  });

  it("reports every LED unreachable when there is no battery, and plans nothing", () => {
    const { faces, gaps } = load("house.fkld");
    const leds = ledsOn(gaps, 3);
    const r = planRoutes(faces, gaps, { leds, battery: null });
    expect(r.traces).toEqual([]);
    expect(r.unreachable).toEqual([0, 1, 2]);
  });

  it("reports an LED whose gap no longer exists as unreachable but still routes the others", () => {
    const { faces, gaps } = load("house.fkld");
    const leds = [...ledsOn(gaps, 3), { a: 900, b: 901 }];
    const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
    expect(r.unreachable).toEqual([3]);
    expect(r.traces).toHaveLength(2);
    // Index alignment with circuit.leds must hold including the unroutable one.
    expect(r.pads).toHaveLength(4);
    expect(r.pads[3]).toEqual({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } });
  });

  it("is deterministic — the preview and the SVG export each plan independently and must agree", () => {
    const { faces, gaps } = load("akde-hex.fkld");
    const circuit: Circuit = { leds: ledsOn(gaps, 10), battery: { face: 0 } };
    const a = planRoutes(faces, gaps, circuit);
    const b = planRoutes(faces, gaps, circuit);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps crossings far below the graph-search router it replaces", () => {
    // Pins the measured improvement so a regression is visible. The old router scored 78 here and 36 on
    // puffin, on these same configurations, while also running over chips.
    const cases: [string, number][] = [["akde-hex.fkld", 1], ["puffin.fkld", 5], ["church.fkld", 8]];
    for (const [name, budget] of cases) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      expect(countNetCrossings(r.traces), name).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps every trace inside the body", () => {
    // Copper must lie on material. Sampling along each segment catches a span that leaves the silhouette
    // between its endpoints -- which endpoint-only checks miss, and which is exactly what straight
    // pad-to-pad hops used to do.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      let off = 0;
      for (const t of r.traces) {
        for (let i = 1; i < t.pts.length; i++) {
          const a = t.pts[i - 1]!, b = t.pts[i]!;
          for (let k = 1; k <= 9; k++) {
            const u = k / 10;
            const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
            if (pointInFace(faces, p) < 0) off++;
          }
        }
      }
      expect(off, `${name} has copper off the body`).toBe(0);
    }
  });

  it("routes every LED on a connected pattern rather than reporting it unreachable", () => {
    // Guards the corridor's adjacency: building it from hinged edges alone makes the two triangles of one
    // flat panel look disconnected, and 10 of 12 LEDs then get dropped as unreachable.
    const { faces, gaps } = load("akde-hex.fkld");
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
    expect(r.unreachable).toEqual([]);
  });

  it("keeps PWR/GND overlap from getting worse", () => {
    // Overlap is NOT solved -- both nets share the pattern's only spine -- but it is measured, so pin it.
    const { faces, gaps } = load("akde-hex.fkld");
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
    const diag = patternDiag(faces);
    const share = overlapLength(r.traces, diag * 0.008) / totalLength(r.traces);
    expect(share).toBeLessThanOrEqual(0.2);
  });

  it("scales with the pattern: geometry scaled by k gives copper scaled by k", () => {
    // Every length in the router is a fraction of the pattern diagonal, so there is no absolute-mm term
    // that would behave differently on a 4-unit kirigamized pattern than on an 80mm one.
    const { fold } = load("house.fkld");
    const k = 7.5;
    const big = JSON.parse(JSON.stringify(fold));
    big.vertices_coords = big.vertices_coords.map((v: number[]) => v.map((c) => c * k));

    const f1 = flatFaces(fold), g1 = gapGraph(fold, f1).gaps;
    const f2 = flatFaces(big), g2 = gapGraph(big, f2).gaps;
    const leds = ledsOn(g1, 6);
    const r1 = planRoutes(f1, g1, { leds, battery: { face: 0 } });
    const r2 = planRoutes(f2, g2, { leds, battery: { face: 0 } });
    expect(totalLength(r2.traces) / totalLength(r1.traces)).toBeCloseTo(k, 6);
  });

  describe("segsCross", () => {
    const A = { x: 0, y: 0 }, B = { x: 10, y: 0 };

    it("finds a proper crossing", () => {
      expect(segsCross(A, B, { x: 5, y: -5 }, { x: 5, y: 5 })).toBe(true);
    });

    it("ignores a shared endpoint — same-net tape may touch", () => {
      expect(segsCross(A, B, { x: 10, y: 0 }, { x: 10, y: 9 })).toBe(false);
    });

    it("ignores collinear overlap", () => {
      expect(segsCross(A, B, { x: 4, y: 0 }, { x: 14, y: 0 })).toBe(false);
    });

    it("ignores segments that miss", () => {
      expect(segsCross(A, B, { x: 5, y: 1 }, { x: 5, y: 9 })).toBe(false);
    });
  });
});
