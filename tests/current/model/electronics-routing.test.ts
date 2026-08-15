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
  countUnderLed,
  countUnderTerminal,
  overlapLength,
  selfOverlapLength,
  tapeWidthFor,
  terminalHalfWidth,
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

  it("emits a handful of strips, not two per LED", () => {
    // The point of the bus topology: both nets are a few long runs whatever the LED count, rather than a pair
    // of strips per LED. A net is a tree, so it is laid as one run per branch -- retraced segments are dropped
    // instead of being taped twice.
    const { faces, gaps } = load("puffin.fkld");
    for (const n of [1, 4, 12]) {
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, n), battery: { face: 0 } });
      expect(r.traces.length).toBeGreaterThanOrEqual(2);
      expect(r.traces.length).toBeLessThanOrEqual(2 * n); // never two per LED
      expect(new Set(r.traces.map((t) => t.net))).toEqual(new Set(["gnd", "pwr"]));
    }
  });

  it("starts each net on its own battery terminal", () => {
    const { faces, gaps } = load("house.fkld");
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 6), battery: { face: 0 } });
    const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeWidthFor(faces));
    // The supply run for each net starts at that net's own terminal.
    const pwr = r.traces.find((t) => t.net === "pwr")!;
    const gnd = r.traces.find((t) => t.net === "gnd")!;
    expect(pwr.pts[0]).toEqual(term.pwr);
    expect(gnd.pts[0]).toEqual(term.gnd);
    // And no strip of either net is left dangling from a point no other strip of that net touches.
    for (const net of ["pwr", "gnd"] as const) {
      const runs = r.traces.filter((t) => t.net === net);
      const seen = new Set(runs.flatMap((t) => t.pts.map((p) => `${p.x}_${p.y}`)));
      for (const t of runs.slice(1)) {
        const touches = t.pts.filter((p) => seen.has(`${p.x}_${p.y}`)).length;
        expect(touches, `${net} run is connected`).toBeGreaterThan(0);
      }
    }
  });

  it("lands one rail on each of every LED's two pads", () => {
    const { faces, gaps } = load("church.fkld");
    const leds = ledsOn(gaps, 5);
    const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
    // A net is laid as several runs, so gather all of its points.
    const pwrPts = r.traces.filter((t) => t.net === "pwr").flatMap((t) => t.pts);
    const gndPts = r.traces.filter((t) => t.net === "gnd").flatMap((t) => t.pts);
    leds.forEach((_, i) => {
      const pad = r.pads[i]!;
      // Each pad is a vertex of its own net's strip, and the two pads differ.
      expect(pwrPts.some((p) => p.x === pad.pwr.x && p.y === pad.pwr.y)).toBe(true);
      expect(gndPts.some((p) => p.x === pad.gnd.x && p.y === pad.gnd.y)).toBe(true);
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
    // Both nets are still laid -- how many runs each is cut into is a routing detail, not the property here.
    expect(new Set(r.traces.map((t) => t.net))).toEqual(new Set(["pwr", "gnd"]));
    expect(r.traces.length).toBeGreaterThanOrEqual(2);
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
    const cases: [string, number][] = [["akde-hex.fkld", 0], ["puffin.fkld", 5], ["church.fkld", 0]];
    for (const [name, budget] of cases) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      expect(countNetCrossings(r.traces), name).toBeLessThanOrEqual(budget);
    }
  });

  it("prefers valleys and flat panels over mountain folds", () => {
    // After Nakaya et al., "4D Leaf Circuits" (SCF '25), Algorithm 1. Their fatigue test is the reason: a trace
    // carried over a mountain fold shows a sharp rise in resistance and fractures within a hundred folding
    // cycles, where the same trace on a valley stays flat. Crossing a crease is charged the pattern's bounding
    // box diagonal, so a route takes any detour it can rather than going over a mountain.
    //
    // Some crossings are unavoidable -- every tile-to-tile move on a kirigami crosses something -- so this pins
    // the measured counts rather than demanding zero.
    const budget: Record<string, number> = {
      "akde-decagon-pyramid.fkld": 25,
      "akde-hex.fkld": 22,
      "house.fkld": 11,
    };
    for (const [name, want] of Object.entries(budget)) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const mountains = gaps.filter((g) => g.assignment === "M");
      let crossed = 0;
      for (const t of r.traces) {
        for (let i = 1; i < t.pts.length; i++) {
          for (const g of mountains) {
            if (segsCross(t.pts[i - 1]!, t.pts[i]!, g.ends[0], g.ends[1])) crossed++;
          }
        }
      }
      expect(crossed, `${name} crosses mountain folds`).toBeLessThanOrEqual(want);
    }
  });

  it("keeps the whole width of every strip inside the shape", () => {
    // Tape has width, so checking the centreline is not enough: a run tracking the boundary keeps its centre on
    // the material while half the strip hangs off. Both edges are sampled here, which is what the router now
    // plans to -- its containment test and its corridor chords both account for the width.
    //
    // The battery's own surroundings are no longer excluded: the pads are half a trace wide now and fit inside
    // their tile, so there is nothing left to except.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld", "akde-decagon-pyramid.fkld"]) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const half = tapeWidthFor(faces) * 0.5;
      let off = 0;
      for (const t of r.traces) {
        for (let i = 1; i < t.pts.length; i++) {
          const a = t.pts[i - 1]!, b = t.pts[i]!;
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          if (L < 1e-9) continue;
          const nx = (-(b.y - a.y) / L) * half, ny = ((b.x - a.x) / L) * half;
          for (let k = 1; k <= 9; k++) {
            const u = k / 10;
            const m = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
            if (pointInFace(faces, { x: m.x + nx, y: m.y + ny }) < 0) off++;
            if (pointInFace(faces, { x: m.x - nx, y: m.y - ny }) < 0) off++;
          }
        }
      }
      expect(off, `${name} has copper hanging off the shape`).toBe(0);
    }
  });

  it("keeps the battery pads inside their own tile", () => {
    // Every corner of both pads, not just their centres: a pad proud of the tile is copper off the shape too.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces } = load(name);
      const tapeW = tapeWidthFor(faces);
      const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeW);
      const hw = term.half; // the size after clamping to the tile — what is actually drawn
      for (const p of [term.pwr, term.gnd]) {
        for (const [dx, dy] of [[hw, hw], [hw, -hw], [-hw, hw], [-hw, -hw]] as [number, number][]) {
          expect(pointInFace(faces, { x: p.x + dx, y: p.y + dy }), `${name} pad corner`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("routes every LED on a connected pattern rather than reporting it unreachable", () => {
    // Guards the corridor's adjacency: building it from hinged edges alone makes the two triangles of one
    // flat panel look disconnected, and 10 of 12 LEDs then get dropped as unreachable.
    const { faces, gaps } = load("akde-hex.fkld");
    const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
    expect(r.unreachable).toEqual([]);
  });

  it("keeps copper out from under the chips once tape width is counted", () => {
    // The real constraint: tape is wide, so a centreline merely *not crossing* the chip is not enough. This
    // was 6-12 chips per model until the bus was allowed to cross a shared edge away from its midpoint,
    // which is where the chip sits.
    // Zero everywhere but puffin. Halving the tape to 3.25mm gives the router more room, and it spends it on a
    // route that runs one GND span about 0.8mm from a chip where 1.6mm is wanted. At 6.5mm puffin is clean, so
    // this is the cost of the narrower strip on the densest pattern -- a real fault, pinned rather than hidden.
    const budget: Record<string, number> = {
      "house.fkld": 0,
      "church.fkld": 0,
      "akde-hex.fkld": 0,
      "akde-square-pyramid.fkld": 0,
      "puffin.fkld": 1,
    };
    for (const [name, want] of Object.entries(budget)) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const tapeW = tapeWidthFor(faces); // the width the router, preview and cutter all use
      expect(countUnderLed(r.traces, r.pads, tapeW * 0.5, tapeW * 0.6), name).toBe(want);
      expect(countOverLed(r.traces, r.pads), name).toBe(0);
    }
  });

  it("gives each net exactly one path to every pad — no double connections", () => {
    // A net that reaches a point two ways has both routes taped for no gain. The walk through the pads makes
    // that easy to produce: go out one way, come back another, and the union contains a cycle. Each net is
    // reduced to a spanning tree, so its cyclomatic number must be zero.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      for (const net of ["pwr", "gnd"] as const) {
        const verts = new Set<string>();
        const edges = new Set<string>();
        for (const t of r.traces.filter((x) => x.net === net)) {
          for (let i = 1; i < t.pts.length; i++) {
            const a = t.pts[i - 1]!, b = t.pts[i]!;
            const ka = `${a.x}_${a.y}`, kb = `${b.x}_${b.y}`;
            verts.add(ka);
            verts.add(kb);
            edges.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
          }
        }
        // components, by union-find
        const parent = new Map([...verts].map((v) => [v, v]));
        const find = (k: string): string => {
          while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k)!)!); k = parent.get(k)!; }
          return k;
        };
        for (const e of edges) {
          const [a, b] = e.split("|") as [string, string];
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent.set(ra, rb);
        }
        const comps = new Set([...verts].map(find)).size;
        expect(edges.size - verts.size + comps, `${name} ${net} has a loop`).toBe(0);
      }
    }
  });

  it("keeps every pad connected to its own terminal", () => {
    // The guard on the tree pruning: dropping a cycle edge or a dead-end branch must never cut a pad off.
    for (const name of ["house.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const term = batteryTerminals(faces[0]!.centroid, patternDiag(faces), faces[0]!.poly, tapeWidthFor(faces));
      for (const net of ["pwr", "gnd"] as const) {
        const adj = new Map<string, Set<string>>();
        const add = (a: string, b: string): void => {
          if (!adj.has(a)) adj.set(a, new Set());
          adj.get(a)!.add(b);
        };
        for (const t of r.traces.filter((x) => x.net === net)) {
          for (let i = 1; i < t.pts.length; i++) {
            const ka = `${t.pts[i - 1]!.x}_${t.pts[i - 1]!.y}`;
            const kb = `${t.pts[i]!.x}_${t.pts[i]!.y}`;
            add(ka, kb);
            add(kb, ka);
          }
        }
        const start = net === "pwr" ? term.pwr : term.gnd;
        const seen = new Set([`${start.x}_${start.y}`]);
        const queue = [`${start.x}_${start.y}`];
        while (queue.length) {
          const at = queue.shift()!;
          for (const n of adj.get(at) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
        }
        for (const pad of r.pads) {
          const p = net === "pwr" ? pad.pwr : pad.gnd;
          if (p.x === 0 && p.y === 0) continue;
          expect(seen.has(`${p.x}_${p.y}`), `${name} ${net} pad is orphaned`).toBe(true);
        }
      }
    }
  });

  it("keeps each net off the other net's battery terminal", () => {
    // The two terminals sit a couple of millimetres apart, so a run leaving one can sweep across the other and
    // short the battery at the source.
    //
    // A run leaving one pad can sweep across the other and short the battery at the source. Chords are
    // forbidden from sweeping a terminal, shortcuts are refused, and a repair pass pushes landing segments
    // aside.
    //
    // Zero everywhere but puffin, whose battery tile is small enough that a run leaving one pad has nowhere to
    // go but past the other, and whose sidestep cannot stay on the tile. church used to be the one holding a
    // fault and is now clean: with the pads half a trace wide the keep-out shrank with them.
    const budget: Record<string, number> = {
      "house.fkld": 0,
      "akde-hex.fkld": 0,
      "akde-square-pyramid.fkld": 0,
      "church.fkld": 0,
      "puffin.fkld": 1,
    };
    for (const [name, want] of Object.entries(budget)) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const diag = patternDiag(faces);
      const term = batteryTerminals(faces[0]!.centroid, diag, faces[0]!.poly, tapeWidthFor(faces));
      // The pad's own half-width plus half a strip — the same clearance the router plans to. It used to be a
      // hardcoded diag * 0.0114 here, which stopped matching the code once the pad became tape-derived.
      const tapeW = tapeWidthFor(faces);
      expect(
        countUnderTerminal(r.traces, term, terminalHalfWidth(tapeW) + tapeW * 0.5),
        name,
      ).toBe(want);
    }
  });

  it("separates the battery terminals by more than a tape width where the tile allows", () => {
    // A strip has to be able to pass between them; at the original spacing it could not.
    for (const name of ["house.fkld", "church.fkld", "akde-hex.fkld", "puffin.fkld"]) {
      const { faces } = load(name);
      const diag = patternDiag(faces);
      const term = batteryTerminals(faces[0]!.centroid, diag, faces[0]!.poly, tapeWidthFor(faces));
      const tapeW = tapeWidthFor(faces);
      // term.half, not the wanted size: on a tight tile the pad shrinks to fit, and the gap has to be measured
      // between the pads that actually get drawn.
      const gap = Math.hypot(term.pwr.x - term.gnd.x, term.pwr.y - term.gnd.y) - 2 * term.half;
      expect(gap, `${name} terminal gap`).toBeGreaterThan(tapeWidthFor(faces));
    }
  });

  it("does not lay a net twice over itself", () => {
    // Repeated tape: a net running back alongside where it has already been. It was invisible to the search --
    // only the two nets shadowing *each other* was scored -- so nothing had reason to stop it, and akde-square
    // was laying 29% of its length twice. Now scored, and pinned here.
    const budget: Record<string, number> = {
      "house.fkld": 0.02,
      "church.fkld": 0.02,
      "akde-decagon-pyramid.fkld": 0.05,
      "akde-hex.fkld": 0.14,
      "akde-square-pyramid.fkld": 0.2,
    };
    for (const [name, share] of Object.entries(budget)) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const tapeW = tapeWidthFor(faces);
      const got = selfOverlapLength(r.traces, tapeW * 0.75) / totalLength(r.traces);
      expect(got, `${name} lays itself twice`).toBeLessThanOrEqual(share);
    }
  });

  it("keeps the two nets off each other", () => {
    // Overlap was 11-41% of copper when both nets were forced through the same face centres and the same
    // edge midpoints. akde-decagon is included deliberately: it is the pattern where the shared-route toll
    // actually changes the answer, so testing only akde-hex would leave that knob unguarded.
    const budget: Record<string, number> = {
      "house.fkld": 0.04,
      "church.fkld": 0.06,
      "akde-hex.fkld": 0.05,
      "akde-decagon-pyramid.fkld": 0.12,
    };
    for (const [name, share] of Object.entries(budget)) {
      const { faces, gaps } = load(name);
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      const got = overlapLength(r.traces, patternDiag(faces) * 0.008) / totalLength(r.traces);
      expect(got, name).toBeLessThanOrEqual(share);
    }
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
    // What must hold is that no *threshold* behaves differently at a different scale, and that is checked
    // directly: the constraint counts come out identical. This test has caught two real bugs that way.
    //
    // Copper length is only bounded loosely. Two things stop it being exact, both by design. The tape is an
    // absolute width measured against an assumed sheet, so a strip is not a fixed fraction of the pattern and
    // the ratio moves as the pattern crosses that size. And node identity is keyed on coordinates rounded to a
    // fixed precision, so its tolerance relative to the pattern shifts with scale and the straightening takes a
    // slightly different set of shortcuts. Tighten this if node identity is ever keyed on edge ids.
    const tape1 = tapeWidthFor(f1), tape2 = tapeWidthFor(f2);
    expect(countNetCrossings(r1.traces)).toBe(countNetCrossings(r2.traces));
    expect(countUnderLed(r1.traces, r1.pads, tape1 * 0.5, tape1 * 0.6)).toBe(
      countUnderLed(r2.traces, r2.pads, tape2 * 0.5, tape2 * 0.6),
    );
    expect(countOverLed(r1.traces, r1.pads)).toBe(countOverLed(r2.traces, r2.pads));
    expect(r1.unreachable).toEqual(r2.unreachable);
    expect(Math.abs(totalLength(r2.traces) / totalLength(r1.traces) / k - 1)).toBeLessThan(0.25);
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
