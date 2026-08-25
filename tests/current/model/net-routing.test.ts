/**
 * Multi-net routing: N named nets, each joining its own terminals, no two ever touching.
 *
 * The load-bearing test here is the no-overlap one. Everything else is about being honest when the
 * condition cannot be met — a net reported unroutable is useful, a net quietly crossed is a short the user
 * finds after laying the copper.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import { DEFAULT_SHEET, minWebMm } from "../../../src/model/fold-strain.js";
import { planNets } from "../../../src/model/net-routing.js";
import { TAPE_MM, planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import type { ResolvedNet } from "../../../src/model/netlist.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { fold, faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces) };
}

/** A net whose terminals sit at the centroids of the given faces. */
function netOn(id: string, name: string, faces: { centroid: Vec2 }[], on: number[]): ResolvedNet {
  return {
    id,
    name,
    points: on.map((f, k) => ({ part: k, pad: String(k + 1), at: faces[f]!.centroid })),
  };
}

/**
 * The closest two DIFFERENT nets come, centreline to centreline.
 *
 * Distance, not crossings, and the difference is the point of the whole exercise. Two runs can approach to
 * nothing without ever *crossing* — meeting at a point, or running alongside — and a segment-intersection
 * test calls both of those clean. Laid as tape they are one piece of copper. The first version of this
 * router passed a crossing count while putting two nets 0.0000 apart under a 0.0997 tape.
 *
 * Same-net runs are skipped: a net meeting its own copper is a join.
 */
function nearestBetweenNets(traces: { net: string; pts: Vec2[] }[]): number {
  const ptSeg = (a: Vec2, b: Vec2, c: Vec2): number => {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L)) : 0;
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
  };
  const segSeg = (p: Vec2, q: Vec2, r: Vec2, s: Vec2): number =>
    Math.min(ptSeg(p, q, r), ptSeg(p, q, s), ptSeg(r, s, p), ptSeg(r, s, q));
  let min = Infinity;
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const a = traces[i]!, b = traces[j]!;
      if (a.net === b.net) continue;
      for (let p = 1; p < a.pts.length; p++) {
        for (let q = 1; q < b.pts.length; q++) {
          min = Math.min(min, segSeg(a.pts[p - 1]!, a.pts[p]!, b.pts[q - 1]!, b.pts[q]!));
        }
      }
    }
  }
  return min;
}

/** The closest a run in `a` comes to a run in `b`. Only across the two groups, never within one. */
function nearestAcross(a: { pts: Vec2[] }[], b: { pts: Vec2[] }[]): number {
  const ptSeg = (p: Vec2, q: Vec2, c: Vec2): number => {
    const dx = q.x - p.x, dy = q.y - p.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / L)) : 0;
    return Math.hypot(c.x - (p.x + t * dx), c.y - (p.y + t * dy));
  };
  let min = Infinity;
  for (const x of a) {
    for (const y of b) {
      for (let i = 1; i < x.pts.length; i++) {
        for (let j = 1; j < y.pts.length; j++) {
          const [p, q, r, t] = [x.pts[i - 1]!, x.pts[i]!, y.pts[j - 1]!, y.pts[j]!];
          min = Math.min(min, ptSeg(p, q, r), ptSeg(p, q, t), ptSeg(r, t, p), ptSeg(r, t, q));
        }
      }
    }
  }
  return min;
}

describe("model/net-routing", () => {
  it("routes nothing when there is nothing to route", () => {
    const { faces, gaps, tapeW } = load("house.fkld");
    expect(planNets([], faces, gaps, tapeW)).toEqual({ nets: [], traces: [], orders: 0 });
  });

  it("joins a net's terminals, and tags every run with that net's id", () => {
    const { faces, gaps, tapeW } = load("house.fkld");
    const r = planNets([netOn("n1", "PWR", faces, [0, 4, 8])], faces, gaps, tapeW);
    expect(r.nets).toHaveLength(1);
    expect(r.nets[0]!.stranded).toEqual([]);
    // A tree over three points is two edges, so two runs, all carrying the net's own id.
    expect(r.traces).toHaveLength(2);
    expect(new Set(r.traces.map((t) => t.net))).toEqual(new Set(["n1"]));
    // Every run has real length: a route that collapsed to a point would "succeed" while joining nothing.
    for (const t of r.traces) {
      expect(t.pts.length).toBeGreaterThanOrEqual(2);
      let len = 0;
      for (let i = 1; i < t.pts.length; i++) {
        len += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
      }
      expect(len).toBeGreaterThan(0);
    }
  });

  describe("the no-overlap condition", () => {
    it("keeps three nets off each other on a real pattern", () => {
      // The whole point of the exercise. Three nets, interleaved terminals so a naive router would run them
      // straight through one another.
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [
        netOn("a", "PWR", faces, [0, 3, 6]),
        netOn("b", "GND", faces, [1, 4, 7]),
        netOn("c", "SIG", faces, [2, 5, 8]),
      ];
      const r = planNets(nets, faces, gaps, tapeW);
      // A whole tape width apart: each strip reaches half a width either side of its centreline, so this is
      // the two strips exactly touching, and anything closer is overlap.
      expect(nearestBetweenNets(r.traces)).toBeGreaterThanOrEqual(tapeW);
    });

    it("keeps them off each other on the crowded patterns too", () => {
      // house is small enough that a router could get lucky. These are not.
      for (const name of ["church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
        const { faces, gaps, tapeW } = load(name);
        const pick = (o: number): number[] =>
          [0, 1, 2, 3].map((k) => (o + k * 4) % faces.length);
        const r = planNets(
          [
            netOn("a", "PWR", faces, pick(0)),
            netOn("b", "GND", faces, pick(1)),
            netOn("c", "SIG", faces, pick(2)),
          ],
          faces,
          gaps,
          tapeW,
        );
        expect(nearestBetweenNets(r.traces), `${name} net-to-net clearance`).toBeGreaterThanOrEqual(tapeW);
      }
    });

    it("strands a terminal rather than overlapping another net to reach it", () => {
      // The condition has to bite, or "always clear" is only ever a statement about easy inputs.
      //
      // Crowd the pattern: several nets, terminals interleaved across it, so the copper genuinely runs out
      // of room. Copper tape is single-sided — no second layer to cross on, no via to get there with — so
      // when a pad cannot be reached with a tape width of clearance the whole way, it cannot be reached.
      // Saying so beats laying a short and letting it be found after the tape is down.
      //
      // Measured on house at three nets of three terminals: 2 of 9 stranded, the other 7 routed clear.
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [0, 1, 2].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({
          part: m,
          pad: "1",
          at: faces[(n + m * 3) % faces.length]!.centroid,
        })),
      }));
      const r = planNets(nets, faces, gaps, tapeW);

      // Whatever it chose to lay is clear. That is the guarantee, and it holds regardless of how much of
      // the netlist survived.
      expect(nearestBetweenNets(r.traces)).toBeGreaterThanOrEqual(tapeW);
      // Something had to give, and it was reported rather than overlapped.
      const stranded = r.nets.reduce((n, x) => n + x.stranded.length, 0);
      expect(stranded).toBeGreaterThan(0);
      const told = r.nets.find((n) => n.stranded.length)!;
      expect(told.why).toMatch(/could not be reached/);
      expect(told.why).toMatch(/single-sided/);
      // And the rest still got their copper: one impossible connection must not cost the user everything.
      expect(r.traces.length).toBeGreaterThan(0);
    });
  });

  it("reaches most of the netlist, not merely a clear part of it", () => {
    // The no-overlap guarantee is trivially satisfiable by routing almost nothing, so it has to be pinned
    // alongside how much actually got connected. Without this, a router that strands half the netlist and
    // one that strands two terminals both look identical to every other test in this file — which is
    // exactly what mutation testing found: relaxing the corridor search to a non-strict one left the
    // guarantee intact (the final clearance check still catches everything) while quietly stranding more.
    //
    // Recorded, not aspirational — these are what the router gives today, and a change that lowers one is a
    // regression to look at rather than a budget to raise. Each pattern is here because it pays for a
    // specific piece of the router: `akde-hex` for the order search (6 rather than 7 with only the first
    // ordering tried), `church` for the node exclusion (6 rather than 7 when a net may reuse another's
    // corridor nodes).
    for (const [name, want] of [
      ["house.fkld", 7],
      ["church.fkld", 7],
      ["akde-hex.fkld", 7],
    ] as [string, number][]) {
      const { faces, gaps, tapeW } = load(name);
      const nets = [0, 1, 2].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({
          part: m,
          pad: "1",
          at: faces[(n + m * 3) % faces.length]!.centroid,
        })),
      }));
      const r = planNets(nets, faces, gaps, tapeW);
      const reached = 9 - r.nets.reduce((a, x) => a + x.stranded.length, 0);
      expect(reached, `${name} terminals reached`).toBeGreaterThanOrEqual(want);
      expect(nearestBetweenNets(r.traces), `${name} clearance`).toBeGreaterThanOrEqual(tapeW);
    }
  });

  it("lays the copper it can and reports only the terminals it could not reach", () => {
    // Partial, not all-or-nothing: four pads reached out of five is worth having, and throwing the four
    // away to signal failure helps nobody.
    const { faces, gaps, tapeW } = load("house.fkld");
    const off: ResolvedNet = {
      id: "n",
      name: "SIG",
      points: [
        { part: 0, pad: "1", at: faces[0]!.centroid },
        { part: 1, pad: "1", at: faces[1]!.centroid },
        { part: 2, pad: "1", at: { x: -1e6, y: -1e6 } }, // nowhere near the material
      ],
    };
    const r = planNets([off], faces, gaps, tapeW);
    expect(r.nets[0]!.stranded).toEqual([2]);
    expect(r.traces.length).toBeGreaterThan(0); // the reachable pair still got their copper
  });

  it("never moves a terminal onto the material to make it reachable", () => {
    // Snapping an off-tile pad to the nearest face would route copper to somewhere the part is not, and the
    // user would never be told their part had been moved.
    const { faces, gaps, tapeW } = load("house.fkld");
    const at = { x: -1e6, y: -1e6 };
    const r = planNets(
      [{ id: "n", name: "SIG", points: [{ part: 0, pad: "1", at }, { part: 1, pad: "1", at: faces[0]!.centroid }] }],
      faces,
      gaps,
      tapeW,
    );
    for (const t of r.traces) for (const p of t.pts) expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeGreaterThan(1);
  });

  it("routes the same circuit the same way however the nets were declared", () => {
    // Nets are put in a canonical order before routing, so the plan depends on the circuit and not on the
    // sequence the author happened to add things in. Without it, renaming a net or deleting and re-adding
    // one silently re-plans the whole board — copper moving for a reason the user cannot see.
    //
    // Five nets of five different sizes, which is what makes this able to detect anything: with three, the
    // order search tries every cyclic order anyway, so both arrangements come out the same whether or not
    // there is a canonical order at all. The first version of this test had three and passed on a router
    // with the sort removed.
    const { faces, gaps, tapeW } = load("house.fkld");
    const sizes: [string, number][] = [["a", 4], ["b", 3], ["c", 3], ["d", 2], ["e", 2]];
    const nets = sizes.map(([id, n], k) => ({
      id,
      name: id.toUpperCase(),
      points: Array.from({ length: n }, (_, m) => ({
        part: m,
        pad: "1",
        at: faces[(k + m * 5) % faces.length]!.centroid,
      })),
    }));
    const plan = (order: typeof nets): string =>
      sizes
        .map(([id]) => JSON.stringify(planNets(order, faces, gaps, tapeW).nets.find((n) => n.id === id)!.traces))
        .join("|");
    expect(plan([...nets].reverse())).toBe(plan(nets));
    expect(plan([nets[2]!, nets[0]!, nets[4]!, nets[1]!, nets[3]!])).toBe(plan(nets));
  });

  it("routes a declared netlist through planRoutes, clear of the bus it shares the sheet with", () => {
    // The end-to-end path: a circuit with nets goes in, and the copper comes out on the same sheet as the
    // LED bus without touching it. Routing the nets first and the bus second would be the wrong order —
    // the bus's LEDs and battery are pinned to hinges and faces and have nowhere else to go, while a net
    // can take any path — so the bus is laid and handed over as an obstacle.
    const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    const tapeW = tapeWidthFor(faces);
    const led = ledOf(gaps[0]!.faceA, gaps[0]!.faceB);

    const bus: Circuit = { leds: [led], battery: { face: 0 } };
    const withNets: Circuit = {
      ...bus,
      parts: [
        { component: "R_1206", x: faces[5]!.centroid.x, y: faces[5]!.centroid.y },
        { component: "C_1206", x: faces[9]!.centroid.x, y: faces[9]!.centroid.y },
      ],
      nets: [{ id: "s", name: "SIG" }],
      terminals: [
        { part: 0, pad: "1", net: "s" },
        { part: 1, pad: "1", net: "s" },
      ],
    };

    const plain = planRoutes(faces, gaps, bus);
    const r = planRoutes(faces, gaps, withNets);
    expect(plain.nets).toEqual([]); // a circuit with no nets pays nothing for the netlist path
    expect(plain.netFaults).toEqual([]);

    // The netlist was routed, and reported.
    expect(r.nets.map((n) => n.name)).toEqual(["SIG"]);
    expect(r.netFaults).toEqual([]);
    expect(r.traces.length).toBeGreaterThan(plain.traces.length);

    // Every declared net keeps clear of the bus copper AND of the other nets.
    //
    // Honest limit of THIS assertion: it passes even with the bus withheld as an obstacle. On every bundled
    // pattern, at up to four LEDs, no two-terminal net between face centres routes within a tape width of
    // the bus anyway — the corridors are far enough apart — so this pins the property and not the
    // mechanism. Putting both terminals on the faces the bus occupies does exercise it, and the net is then
    // refused outright.
    //
    // The mechanism is exercised elsewhere, by hand-drawn copper, which is the case that can put a wall
    // across the only corridor a net had: see `manual-override.test.ts`.
    //
    // Measured against the bus's runs specifically, not across the whole sheet. The bus's own PWR and GND
    // are allowed closer than a tape width to each other — `landingWidth` deliberately pinches both where
    // they meet an LED's two legs, which is how a chip gets one net on each pad — so a sheet-wide minimum
    // would be measuring that, not this. What the netlist router promises is that IT does not touch
    // anything, and that is what this asserts.
    const busKeys = new Set(plain.traces.map((t) => t.net));
    const netRuns = r.traces.filter((t) => !busKeys.has(t.net));
    const others = r.traces.filter((t) => busKeys.has(t.net));
    expect(netRuns.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    expect(nearestBetweenNets(netRuns)).toBeGreaterThanOrEqual(tapeW);
    expect(nearestAcross(netRuns, others), "netlist against bus").toBeGreaterThanOrEqual(tapeW);
  });

  it("reports a malformed netlist through planRoutes rather than dropping it", () => {
    // The faults have to reach the app, or a pad wired to nothing looks identical to a pad wired correctly.
    const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    // With an LED, so this goes down the ordinary routing path and not the no-LED early return. Both
    // return faults and they are separate lines of code; testing only one leaves the other free to drop
    // them silently.
    const led = ledOf(gaps[0]!.faceA, gaps[0]!.faceB);
    const bad = {
      parts: [{ component: "R_1206", x: faces[5]!.centroid.x, y: faces[5]!.centroid.y }],
      nets: [{ id: "s", name: "SIG" }],
      terminals: [{ part: 0, pad: "nope", net: "s" }],
    };
    const withLed = planRoutes(faces, gaps, { leds: [led], battery: { face: 0 }, ...bad });
    expect(withLed.netFaults.some((f) => f.kind === "no-such-pad"), "with an LED").toBe(true);
    const noLed = planRoutes(faces, gaps, { leds: [], battery: { face: 0 }, ...bad });
    expect(noLed.netFaults.some((f) => f.kind === "no-such-pad"), "with no LED").toBe(true);
  });

  it("plans the same routes twice for the same input", () => {
    // The cut file and the preview each plan independently, so anything nondeterministic here shows up as
    // an export that does not match what the user approved on screen.
    const { faces, gaps, tapeW } = load("church.fkld");
    const nets = [netOn("a", "PWR", faces, [0, 5, 9]), netOn("b", "GND", faces, [1, 6, 10])];
    const one = planNets(nets, faces, gaps, tapeW);
    const two = planNets(nets, faces, gaps, tapeW);
    expect(JSON.stringify(two.traces)).toBe(JSON.stringify(one.traces));
  });

  describe("how far apart the sheet makes them stay", () => {
    it("holds nets further apart on a sheet too thin to weed at a tape width, and pays for it", () => {
      // The clearance the router works to is a tape width unless the substrate cannot spare it: what is
      // left between two runs is a web of bare material that has to survive being weeded out, and a web's
      // tear strength goes with its thickness. On 0.4mm the tape is the wider of the two and nothing
      // changes; on a 0.05mm film the web wants 2.8 tape widths and takes over.
      //
      // Four nets on `house`, because that is a case where the ordinary rule really does bring two runs
      // closer than the film would allow -- asserted below, so this cannot quietly become a test of a
      // constraint that was never up against anything.
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [0, 1, 2, 3].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({
          part: m,
          pad: "1",
          at: faces[(n + m * 3) % faces.length]!.centroid,
        })),
      }));
      const thin = { ...DEFAULT_SHEET, substrateMm: 0.05 };
      const want = (minWebMm(thin) * tapeW) / TAPE_MM;
      expect(want, "the thin sheet did not ask for more than the tape").toBeGreaterThan(tapeW);

      const ordinary = planNets(nets, faces, gaps, tapeW);
      const filmy = planNets(nets, faces, gaps, tapeW, [], thin);
      const stranded = (r: { nets: { stranded: number[] }[] }): number =>
        r.nets.reduce((a, x) => a + x.stranded.length, 0);

      // Each is laid to its own rule...
      expect(nearestBetweenNets(ordinary.traces)).toBeGreaterThanOrEqual(tapeW);
      expect(nearestBetweenNets(filmy.traces)).toBeGreaterThanOrEqual(want);
      // ...and the rules genuinely differ here, or the assertion above proves nothing.
      expect(
        nearestBetweenNets(ordinary.traces),
        "the ordinary sheet already cleared the film's floor, so this case tests nothing",
      ).toBeLessThan(want);
      // Honest about the trade: the room has to come from somewhere, and it comes out of reach.
      expect(stranded(filmy)).toBeGreaterThan(stranded(ordinary));
    });
  });

  describe("rip-up, and what it is worth", () => {
    it("names the net that is in the way, not merely that one was", () => {
      // The blame is computed for the reordering; spending it on the message costs nothing and turns
      // "could not be reached" into something the author can act on.
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [0, 1, 2, 3].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({ part: m, pad: "1", at: faces[(n + m * 3) % faces.length]!.centroid })),
      }));
      const r = planNets(nets, faces, gaps, tapeW);
      const lost = r.nets.filter((n) => n.stranded.length);
      expect(lost.length, "this fixture no longer strands anything").toBeGreaterThan(0);
      const named = lost.filter((n) => /crossing N\d/.test(n.why ?? ""));
      expect(named.length, "no stranded net named what blocked it").toBeGreaterThan(0);
    });

    it("tries orders the failures asked for, beyond the blind rotations", () => {
      // Guards the machinery, not the outcome — the outcome is that it changes nothing, which is exactly
      // why the count has to be reported: a search whose effect is invisible in the routes cannot be
      // tested through them, and would rot without anyone noticing.
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [0, 1, 2].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({ part: m, pad: "1", at: faces[(n + m * 3) % faces.length]!.centroid })),
      }));
      const r = planNets(nets, faces, gaps, tapeW);
      expect(r.nets.filter(Boolean)).toHaveLength(3);
      expect(r.nets.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
      // Three nets give three rotations; anything past that is an order the blame asked for.
      expect(r.orders, "the rip-up search tried nothing the rotations had not").toBeGreaterThan(3);
    });

    it("stops the moment nothing is stranded, so a circuit that routes pays nothing for it", () => {
      const { faces, gaps, tapeW } = load("house.fkld");
      const nets = [0, 1].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1].map((m) => ({ part: m, pad: "1", at: faces[(n + m * 6) % faces.length]!.centroid })),
      }));
      const r = planNets(nets, faces, gaps, tapeW);
      if (r.nets.every((n) => !n.stranded.length)) expect(r.orders).toBe(1);
    });

    it("plans the same circuit identically however many orders it tried", () => {
      // Determinism has to survive the added search: the victim is chosen by a total order and the
      // blockers are tried in the order blame was assigned, so two runs cannot diverge.
      const { faces, gaps, tapeW } = load("church.fkld");
      const nets = [0, 1, 2, 3].map((n) => ({
        id: `n${n}`,
        name: `N${n}`,
        points: [0, 1, 2].map((m) => ({ part: m, pad: "1", at: faces[(n + m * 3) % faces.length]!.centroid })),
      }));
      const a = planNets(nets, faces, gaps, tapeW);
      const b = planNets(nets, faces, gaps, tapeW);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });
});
