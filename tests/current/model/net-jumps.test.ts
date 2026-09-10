/**
 * Router-emitted jumps: a declared net rejoining itself across a cut the folded artifact brings back
 * together.
 *
 * Two things are being pinned here, and they pull in opposite directions. The first is that **nothing
 * changed**: `planNets` with no adjacency and no prejoins must produce byte-identical output to the
 * router that had never heard of a jump, because every shipped call site is that call. The second is that
 * with an adjacency the thing actually works — desk-lamp-shade's rim, where the two ends of one strip are
 * one edge folded and 300 units apart flat, is the case the feature exists for.
 *
 * The load-bearing one is neither of those on its own but the pair at the end: `checkJump` run on the
 * router's own jumps. `corridor-jumps.ts` puts its lip nodes at `u ∈ {¼, ¾}` and `jump-rules.ts` refuses
 * ends skewed along the seam by more than a tape width; the two were written apart, and a route the rules
 * call broken is worse than no route at all.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, pointInFace, type Vec2 } from "../../../src/model/electronics.js";
import { DEFAULT_SHEET } from "../../../src/model/fold-strain.js";
import { foldAdjacency, type FoldAdjacency, type LipPairFlat } from "../../../src/model/fold-adjacency.js";
import { planNets, type PreJoin } from "../../../src/model/net-routing.js";
import { checkJump } from "../../../src/model/jump-rules.js";
import { countJumpClashes } from "../../../src/model/route-metrics.js";
import {
  TAPE_MM,
  countNetCrossings,
  planRoutes,
  tapeWidthFor,
} from "../../../src/model/electronics-routing.js";
import type { Jump, Trace2D } from "../../../src/model/trace-types.js";
import type { ResolvedNet } from "../../../src/model/netlist.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { fold, faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces) };
}

/** A net whose terminals sit at the centroids of the given faces — `net-routing.test.ts`'s own fixture. */
function netOn(id: string, name: string, faces: { centroid: Vec2 }[], on: number[]): ResolvedNet {
  return {
    id,
    name,
    points: on.map((f, k) => ({ part: k, pad: String(k + 1), at: faces[f]!.centroid })),
  };
}

/** Total centreline length of a plan, in pattern units. */
function copperOf(traces: Trace2D[]): number {
  let total = 0;
  for (const t of traces) {
    for (let k = 1; k < t.pts.length; k++) {
      total += Math.hypot(t.pts[k]!.x - t.pts[k - 1]!.x, t.pts[k]!.y - t.pts[k - 1]!.y);
    }
  }
  return total;
}

/**
 * The closest two DIFFERENT nets come, centreline to centreline — `net-routing.test.ts`, restated here
 * because it is the guarantee jumps must not weaken and a copy is cheaper than exporting a test helper.
 * A crossing reads as zero, which the four-projection minimum alone cannot see.
 */
function nearestBetweenNets(traces: { net: string; pts: Vec2[] }[]): number {
  const ptSeg = (a: Vec2, b: Vec2, c: Vec2): number => {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L)) : 0;
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
  };
  const crosses = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
    const o = (p: Vec2, q: Vec2, r: Vec2): number =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return ((o(a, b, c) > 0) !== (o(a, b, d) > 0)) && ((o(c, d, a) > 0) !== (o(c, d, b) > 0));
  };
  const segSeg = (p: Vec2, q: Vec2, r: Vec2, s: Vec2): number =>
    crosses(p, q, r, s) ? 0 : Math.min(ptSeg(p, q, r), ptSeg(p, q, s), ptSeg(r, s, p), ptSeg(r, s, q));
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

/** The pair whose two lips lie furthest apart in the FLAT pattern: the most a jump can be worth. */
function widestPair(adj: FoldAdjacency): number {
  const mid = (l: [Vec2, Vec2]): Vec2 => ({ x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 });
  let best = -1, far = -1;
  adj.pairs.forEach((p, i) => {
    const a = mid(p.lipA), b = mid(p.lipB);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > far) { far = d; best = i; }
  });
  return best;
}

/** A terminal just inside the face that owns one lip, at parameter `u` along it. */
function insideLip(
  faces: { centroid: Vec2 }[], pair: LipPairFlat, side: "A" | "B", u: number, by: number,
): Vec2 {
  const lip = side === "A" ? pair.lipA : pair.lipB;
  const f = faces[side === "A" ? pair.faceA : pair.faceB]!;
  const on = { x: lip[0].x + (lip[1].x - lip[0].x) * u, y: lip[0].y + (lip[1].y - lip[0].y) * u };
  const dx = f.centroid.x - on.x, dy = f.centroid.y - on.y, L = Math.hypot(dx, dy);
  return { x: on.x + (dx / L) * by, y: on.y + (dy / L) * by };
}

/** desk-lamp-shade with its widest rim pair already found — the fixture every jump case below uses. */
function rimFixture() {
  const { faces, gaps, tapeW } = load("desk-lamp-shade.fkld");
  const fold = JSON.parse(readFileSync(`${EXAMPLES}desk-lamp-shade.fkld`, "utf8"));
  const adjacency = foldAdjacency(fold, faces);
  const which = widestPair(adjacency);
  const pair = adjacency.pairs[which]!;
  const at = (side: "A" | "B", u: number): Vec2 => insideLip(faces, pair, side, u, tapeW * 2);
  return { faces, gaps, tapeW, adjacency, which, pair, at };
}

/** `planNets` with the two new arguments, which every case here wants and none wants to spell out. */
function route(
  nets: ResolvedNet[],
  f: { faces: ReturnType<typeof flatFaces>; gaps: ReturnType<typeof gapGraph>["gaps"]; tapeW: number },
  adjacency: FoldAdjacency | null,
  prejoined: PreJoin[] = [],
) {
  return planNets(
    nets, f.faces, f.gaps, f.tapeW, [], undefined, undefined, [], [], [], undefined, undefined,
    adjacency, prejoined,
  );
}

describe("router-emitted jumps", () => {
  it("plans exactly as before when it is given no adjacency", { timeout: 20_000 }, () => {
    // The whole feature is off by default, and "off" has to mean bit-identical rather than merely
    // similar: every shipped call site passes neither of the new arguments, so any drift here is drift in
    // circuits nobody asked to change.
    for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
      const { faces, gaps, tapeW } = load(name);
      const pick = (o: number): number[] => [0, 1, 2, 3].map((k) => (o + k * 4) % faces.length);
      const nets = [
        netOn("a", "PWR", faces, pick(0)),
        netOn("b", "GND", faces, pick(1)),
        netOn("c", "SIG", faces, pick(2)),
      ];
      const old = planNets(nets, faces, gaps, tapeW);
      const now = planNets(
        nets, faces, gaps, tapeW, [], undefined, undefined, [], [], [], undefined, undefined, null, []);
      expect(JSON.stringify(now), `${name} default-identical`).toBe(JSON.stringify(old));
      // And nothing was jumped, on a call that was given nothing to jump across.
      expect(now.jumps).toEqual([]);
    }
  });

  it("rejoins the two ends of desk-lamp-shade's rim instead of paying for the whole sheet",
    { timeout: 20_000 }, () => {
      // The clean case, and the reason the feature exists. The shade is a strip whose two short edges are
      // ONE edge of the folded lamp: a net crossing that rim travels the width of the pattern flat and
      // nothing at all folded.
      //
      // **The copper is the measurement; the stranded counts are only a guard.** On every bundled example
      // the flat sheet is one connected patch, so an adjacency changes how FAR a net travels and never
      // whether it arrives — measured on the corridor, where this rim path costs 2728.8 without one and
      // 349.3 with, a difference of exactly one `JUMP_TOLL_DIAGS`. Anyone tempted to pin recovered
      // terminals here will be pinning a number that is zero for a reason that has nothing to do with
      // jumps. The two `stranded` assertions below say only that neither figure is the copper of a net
      // that gave up, which is what would otherwise let the "under 60 units" bound pass vacuously.
      const f = rimFixture();
      const net: ResolvedNet = {
        id: "n", name: "N",
        points: [{ part: 0, pad: "1", at: f.at("A", 0.5) }, { part: 1, pad: "2", at: f.at("B", 0.5) }],
      };

      const off = route([net], f, null);
      // Routable the long way round — this is a detour, not a rescue — and it costs most of the pattern.
      expect(off.nets[0]!.stranded).toEqual([]);
      expect(off.jumps).toEqual([]);
      expect(copperOf(off.traces)).toBeGreaterThan(250);

      const on = route([net], f, f.adjacency);
      expect(on.nets[0]!.stranded).toEqual([]);
      expect(on.jumps).toHaveLength(1);
      expect(copperOf(on.traces)).toBeLessThan(60);

      const jump = on.jumps[0]!;
      expect(jump.source).toBe("routed");
      expect(jump.net).toBe("n");
      expect(jump.pair).toBe(f.which);
      // The lands are where the ribbon hangs from, so the folded overlay needs both lip directions.
      expect(jump.dirA).toBeDefined();
      expect(jump.dirB).toBeDefined();

      // Two pieces of copper, each ending AT a land centre — that is what makes the land, laid separately,
      // actually cover the end of the run rather than sitting beside it.
      expect(on.traces).toHaveLength(2);
      const ends = on.traces.map((t) => t.pts[t.pts.length - 1]!);
      const near = (p: Vec2, q: Vec2): boolean => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;
      expect(ends.some((p) => near(p, jump.a))).toBe(true);
      expect(on.traces.some((t) => near(t.pts[0]!, jump.b))).toBe(true);
      // Both pieces are on the material, one face each — no piece straddles the cut.
      for (const t of on.traces) {
        for (const p of t.pts) expect(pointInFace(f.faces, p)).toBeGreaterThanOrEqual(0);
      }
    });

  it("gives two nets crossing one rim their own lands", { timeout: 20_000 }, () => {
    // Two nodes per lip (`corridor-jumps.ts › EDGE_CROSSINGS`) exist for exactly this: a second net
    // rejoining the same cut must not be sent to the same solder land as the first, which would be a
    // short the moment the wires go on.
    const f = rimFixture();
    const nets: ResolvedNet[] = [
      { id: "a", name: "A", points: [{ part: 0, pad: "1", at: f.at("A", 0.2) }, { part: 1, pad: "1", at: f.at("B", 0.2) }] },
      { id: "b", name: "B", points: [{ part: 2, pad: "1", at: f.at("A", 0.8) }, { part: 3, pad: "1", at: f.at("B", 0.8) }] },
    ];
    const r = route(nets, f, f.adjacency);
    expect(r.jumps).toHaveLength(2);
    expect(new Set(r.jumps.map((j) => j.net))).toEqual(new Set(["a", "b"]));
    for (const j of r.jumps) expect(j.pair).toBe(f.which);

    // Distinct lands, and by a real distance rather than merely not being the same object.
    const [x, y] = r.jumps as [Jump, Jump];
    expect(Math.hypot(x.a.x - y.a.x, x.a.y - y.a.y)).toBeGreaterThan(f.tapeW);
    expect(Math.hypot(x.b.x - y.b.x, x.b.y - y.b.y)).toBeGreaterThan(f.tapeW);
    // Which is what `countJumpClashes` says in one number — see `route-metrics.ts`, D7.
    expect(countJumpClashes(r.jumps, f.tapeW)).toBe(0);

    // The planar guarantee is untouched: jumps buy separation, they do not spend it.
    expect(nearestBetweenNets(r.traces)).toBeGreaterThanOrEqual(f.tapeW);
    expect(countNetCrossings(r.traces)).toBe(0);
  });

  it("takes the author's own jump as a connection already made", { timeout: 20_000 }, () => {
    // A drawn jump reaches the router as a `PreJoin` and nothing else. The tree is built knowing those two
    // places are joined, so the net routes onto each land and stops — it does not lay a second rejoin of
    // its own beside the one the author drew.
    const f = rimFixture();
    const seed: ResolvedNet = {
      id: "a", name: "A",
      points: [{ part: 0, pad: "1", at: f.at("A", 0.2) }, { part: 1, pad: "1", at: f.at("B", 0.2) }],
    };
    const drawn = route([seed], f, f.adjacency).jumps[0]!;

    const withLands: ResolvedNet = {
      ...seed,
      points: [...seed.points, { part: -1, pad: "jump", at: drawn.a }, { part: -1, pad: "jump", at: drawn.b }],
    };
    const r = route([withLands], f, f.adjacency, [{ net: "a", a: drawn.a, b: drawn.b }]);

    expect(r.jumps).toEqual([]);
    expect(r.nets[0]!.stranded).toEqual([]);
    // One leg onto each land, and no copper spent crossing between them.
    expect(r.traces).toHaveLength(2);
    const touches = (p: Vec2): boolean =>
      r.traces.some((t) => [t.pts[0]!, t.pts[t.pts.length - 1]!].some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9));
    expect(touches(drawn.a)).toBe(true);
    expect(touches(drawn.b)).toBe(true);
    expect(copperOf(r.traces)).toBeLessThan(20);
  });

  it("plans the same jumps twice running", { timeout: 20_000 }, () => {
    const f = rimFixture();
    const nets: ResolvedNet[] = [
      { id: "a", name: "A", points: [{ part: 0, pad: "1", at: f.at("A", 0.2) }, { part: 1, pad: "1", at: f.at("B", 0.2) }] },
      { id: "b", name: "B", points: [{ part: 2, pad: "1", at: f.at("A", 0.8) }, { part: 3, pad: "1", at: f.at("B", 0.8) }] },
    ];
    expect(JSON.stringify(route(nets, f, f.adjacency))).toBe(JSON.stringify(route(nets, f, f.adjacency)));
  });

  it("lays jumps the jump rules call clean", { timeout: 20_000 }, () => {
    // The agreement between two files written apart: `corridor-jumps.ts` lands at `u ∈ {¼, ¾}` of each
    // lip, and `jump-rules.ts` refuses ends skewed along the seam by more than one tape width. If the
    // corridor's reading of "the same point on the folded edge" and the rule's ever part company, the
    // router will happily emit jumps the author is told are broken.
    const f = rimFixture();
    const nets: ResolvedNet[] = [
      { id: "a", name: "A", points: [{ part: 0, pad: "1", at: f.at("A", 0.2) }, { part: 1, pad: "1", at: f.at("B", 0.2) }] },
      { id: "b", name: "B", points: [{ part: 2, pad: "1", at: f.at("A", 0.8) }, { part: 3, pad: "1", at: f.at("B", 0.8) }] },
    ];
    const r = route(nets, f, f.adjacency);
    expect(r.jumps.length).toBeGreaterThan(0);
    const ctx = { adjacency: f.adjacency, tapeW: f.tapeW, tapeMm: TAPE_MM, sheet: DEFAULT_SHEET, faces: f.faces };
    for (const j of r.jumps) {
      expect(checkJump(j, ctx, r.traces, r.jumps.filter((x) => x !== j)), `${j.net} jump`).toEqual([]);
    }
  });

  it("leaves the bus router's crossing budgets exactly where they were", { timeout: 60_000 }, () => {
    // D9: `planRoutes` hands the adjacency to the declared nets and to nothing else — the two-rail bus is
    // planned jump-free. These are `electronics-routing.test.ts`'s own pinned budgets, re-run with the
    // adjacency passed, and they hold by construction rather than by luck.
    const cases: [string, number][] = [
      ["akde-hex.fkld", 0], ["puffin.fkld", 1], ["church.fkld", 0], ["house.fkld", 0],
      ["akde-square-pyramid.fkld", 0], ["akde-decagon-pyramid.fkld", 1],
    ];
    for (const [name, budget] of cases) {
      const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
      const faces = flatFaces(fold);
      const gaps = gapGraph(fold, faces).gaps;
      const leds = gaps.slice(0, 12).map((g) => ({ a: g.verts[0], b: g.verts[1] }));
      const adjacency = foldAdjacency(fold, faces);
      const r = planRoutes(
        faces, gaps, { leds, battery: { face: 0 } }, undefined, undefined, undefined, undefined, undefined,
        adjacency);
      expect(countNetCrossings(r.traces), name).toBeLessThanOrEqual(budget);
      // A circuit of LEDs and a battery declares no nets, so there is nothing for a jump to be found on.
      expect(r.jumps ?? []).toEqual([]);
    }
  });
});
