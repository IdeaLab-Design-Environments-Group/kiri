/**
 * A net may rejoin a cut the folded artifact closes.
 *
 * The flat pattern is a tree of the solid's faces, so every loop the solid had was severed by the
 * unfolder and its two lips lie somewhere else in the sheet — 305 units apart on desk-lamp-shade, and
 * touching once it is folded. `corridor-jumps.ts` gives the search a hop across each such pair: not
 * copper, but a wire the builder solders by hand after folding, so its **flat length is never charged**
 * and it carries no strain band.
 *
 * The load-bearing test here is the first one. Every pinned route in this repo was measured on a
 * corridor built without adjacency, so `adjacency = null` — the default — has to produce the very same
 * graph, node for node.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, pointInFace, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { buildCorridor, reachableFaces, searchCorridor } from "../../../src/model/corridor.js";
import { JUMP_TOLL_DIAGS, jumpHopBetween } from "../../../src/model/corridor-jumps.js";
import { foldAdjacency, type FoldAdjacency } from "../../../src/model/fold-adjacency.js";
import { TAPE_MM, patternDiag, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { ptKey } from "../../../src/model/trace-geometry.js";
import type { Corridor } from "../../../src/model/trace-types.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8")) as FoldFile;
  const faces = flatFaces(fold);
  return { fold, faces, gaps: gapGraph(fold, faces).gaps, tapeW: tapeWidthFor(faces) };
}

/** The crease price `buildCorridor` is given everywhere in these tests; only its scale matters here. */
const FOLD_PENALTY = 100;

function corridorOf(name: string, adjacency?: FoldAdjacency | null): Corridor {
  const { faces, gaps, tapeW } = load(name);
  return adjacency === undefined
    ? buildCorridor(faces, gaps, FOLD_PENALTY, tapeW, undefined, TAPE_MM)
    : buildCorridor(faces, gaps, FOLD_PENALTY, tapeW, undefined, TAPE_MM, undefined, true, adjacency);
}

/** Every jump entry in a corridor, flattened. */
const jumpEntries = (c: Corridor) =>
  [...c.bridges.entries()].flatMap(([from, list]) =>
    list.filter((b) => b.kind === "jump").map((b) => ({ from, ...b })));

/**
 * What the search charges for a path, re-read from the corridor: a step's length plus the fold price of
 * the node it lands on, except across a jump, which costs its price and nothing for its length.
 *
 * `searchCorridor` returns waypoints, not a cost, so the arithmetic is restated here rather than
 * exported — a second reading of one number is the point of the comparison below.
 */
function pathCost(c: Corridor, path: Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!;
    const hop = jumpHopBetween(c, ptKey(a), ptKey(b));
    total += hop ? hop.price : Math.hypot(b.x - a.x, b.y - a.y) + (c.cost.get(ptKey(b)) ?? 0);
  }
  return total;
}

/** How many consecutive pairs of a path are joined by a jump rather than a chord. */
function jumpHopCount(c: Corridor, path: Vec2[]): number {
  let n = 0;
  for (let i = 0; i + 1 < path.length; i++) if (jumpHopBetween(c, ptKey(path[i]!), ptKey(path[i + 1]!))) n++;
  return n;
}

const search = (c: Corridor, from: number, to: number, blocked = new Set<string>()): Vec2[] =>
  searchCorridor(c, from, to, blocked, new Map(), null, false, null, null, null, null);

/**
 * Two tiles twenty units apart — far wider than the tape can bridge — that the declared folded form
 * welds along one edge each.
 *
 * The bundled examples cannot make this case: on every one of them the flat sheet is a single connected
 * patch, so every face already reaches every other the long way round and adjacency changes the *price*
 * of getting there, never the *possibility*. A pattern cut into pieces is the case where it changes the
 * possibility, and it has to be built to be tested.
 */
const SEVERED: FoldFile = {
  vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [30, 0], [40, 0], [40, 10], [30, 10]],
  faces_vertices: [[0, 1, 2, 3], [4, 5, 6, 7]],
  edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]],
  edges_assignment: ["B", "C", "B", "B", "B", "B", "B", "C"],
  file_frames: [{
    frame_classes: ["foldedForm"],
    vertices_coords: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
      [10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]],
  }],
} as unknown as FoldFile;

describe("model/corridor-jumps › off by default", () => {
  it.each(["house.fkld", "church.fkld", "desk-lamp-shade.fkld"])(
    "builds the very same corridor for null as for no adjacency at all -- %s",
    { timeout: 20_000 },
    (name) => {
      const omitted = corridorOf(name);
      const explicit = corridorOf(name, null);
      expect([...explicit.point.keys()]).toEqual([...omitted.point.keys()]);
      expect([...explicit.faceOf.keys()]).toEqual([...omitted.faceOf.keys()]);
      expect([...explicit.bridges.keys()]).toEqual([...omitted.bridges.keys()]);
      for (const [f, set] of omitted.chords) expect(explicit.chords.get(f)!.size).toBe(set.size);
      for (const [k, list] of omitted.bridges) expect(explicit.bridges.get(k)!.length).toBe(list.length);
      expect(jumpEntries(explicit)).toEqual([]);
    },
  );
});

describe("model/corridor-jumps › the links", () => {
  it("adds two hops each way across every one of desk-lamp-shade's 56 rejoined cuts", { timeout: 20_000 }, () => {
    const { fold, faces } = load("desk-lamp-shade.fkld");
    const adj = foldAdjacency(fold, faces);
    expect(adj.pairs).toHaveLength(56);
    const jumps = jumpEntries(corridorOf("desk-lamp-shade.fkld", adj));
    // Two lip nodes per pair (u = 1/4 and 3/4) times both directions. No pair is skipped: every one of
    // the 224 nudged nodes lands on material, which the next case checks one by one.
    expect(jumps).toHaveLength(2 * 56 * 2);
    expect(new Set(jumps.map((j) => j.pair)).size).toBe(56);
    for (const j of jumps) {
      expect(j.band).toBe(0);
      expect(j.price).toBeCloseTo(JUMP_TOLL_DIAGS * patternDiag(faces), 6);
    }
  });

  it("puts each end of a jump inside its own face, a quarter and three quarters along the lip", { timeout: 20_000 }, () => {
    const { fold, faces } = load("desk-lamp-shade.fkld");
    const adj = foldAdjacency(fold, faces);
    const c = corridorOf("desk-lamp-shade.fkld", adj);
    // Where a point falls along a lip, as a fraction of its length.
    const along = (lip: [Vec2, Vec2], p: Vec2): number => {
      const dx = lip[1].x - lip[0].x, dy = lip[1].y - lip[0].y;
      return ((p.x - lip[0].x) * dx + (p.y - lip[0].y) * dy) / (dx * dx + dy * dy);
    };
    const seen = new Map<number, Set<number>>();
    for (const j of jumpEntries(c)) {
      const pair = adj.pairs[j.pair!]!;
      const node = c.point.get(j.from)!;
      const owners = c.faceOf.get(j.from) ?? [];
      const onA = owners.includes(pair.faceA);
      expect(onA || owners.includes(pair.faceB)).toBe(true);
      const fi = onA ? pair.faceA : pair.faceB;
      // Nudged off the lip line into its own tile, so the even-odd test is not a coin toss.
      expect(pointInFace(faces, node)).toBe(fi);
      const u = along(onA ? pair.lipA : pair.lipB, node);
      const quarter = Math.abs(u - 0.25) < 1e-3 ? 0.25 : Math.abs(u - 0.75) < 1e-3 ? 0.75 : NaN;
      expect(quarter, `pair ${j.pair} node at u=${u}`).not.toBeNaN();
      const rec = seen.get(j.pair!) ?? new Set<number>();
      rec.add(quarter);
      seen.set(j.pair!, rec);
    }
    // Both quarter points, on both lips, for every pair.
    expect(seen.size).toBe(56);
    for (const rec of seen.values()) expect([...rec].sort()).toEqual([0.25, 0.75]);
  });

  it("reaches the far piece of a severed sheet only with adjacency", { timeout: 20_000 }, () => {
    const faces: FlatFace[] = flatFaces(SEVERED);
    const gaps = gapGraph(SEVERED, faces).gaps;
    const adj = foldAdjacency(SEVERED, faces);
    expect(adj.source).toBe("goal-frame");
    expect(adj.pairs).toHaveLength(1);
    const plain = buildCorridor(faces, gaps, FOLD_PENALTY, 1.5, undefined, TAPE_MM);
    const joined = buildCorridor(faces, gaps, FOLD_PENALTY, 1.5, undefined, TAPE_MM, undefined, true, adj);
    // Twenty units of nothing between the two tiles: far past what tape bridges, so no bridge hop either.
    expect(jumpEntries(plain)).toEqual([]);
    expect(jumpEntries(joined)).toHaveLength(4);
    expect([...reachableFaces(plain, 0)]).toEqual([0]);
    expect([...reachableFaces(joined, 0)].sort()).toEqual([0, 1]);
  });
});

describe("model/corridor-jumps › the search", () => {
  const { fold, faces, gaps, tapeW } = load("desk-lamp-shade.fkld");
  const adj = foldAdjacency(fold, faces);
  const rim = adj.pairs[0]!;
  const build = (a: FoldAdjacency | null): Corridor =>
    buildCorridor(faces, gaps, FOLD_PENALTY, tapeW, undefined, TAPE_MM, undefined, true, a);

  it("crosses the rim in one hop instead of walking the whole sheet, and is not charged for the gap", { timeout: 20_000 }, () => {
    const plain = build(null), joined = build(adj);
    const round = search(plain, rim.faceA, rim.faceB);
    const over = search(joined, rim.faceA, rim.faceB);
    expect(round.length).toBeGreaterThan(0);
    expect(jumpHopCount(plain, round)).toBe(0);
    expect(jumpHopCount(joined, over)).toBe(1);
    // The two lips are 305 units apart in the flat pattern and touching once folded, so the hop pays its
    // toll and nothing for the distance -- which is what makes it cheaper than going round at all.
    expect(pathCost(joined, over)).toBeLessThan(pathCost(plain, round) - 200);
  });

  it("charges exactly the toll for the hop, and nothing else", { timeout: 20_000 }, () => {
    const paid = build(adj);
    const free = build({ ...adj, tollDiags: 0 });
    const diag = patternDiag(faces);
    const a = pathCost(paid, search(paid, rim.faceA, rim.faceB));
    const b = pathCost(free, search(free, rim.faceA, rim.faceB));
    expect(a - b).toBeCloseTo(JUMP_TOLL_DIAGS * diag, 6);
    expect(b).toBeCloseTo(0, 6); // the whole cost of that route was the toll
  });

  it("gives an occupied land to whoever took it and sends the next net to the other one", { timeout: 20_000 }, () => {
    const c = build(adj);
    const path = search(c, rim.faceA, rim.faceB);
    const landed = ptKey(path[path.length - 1]!);
    // Both of this seam's lands on the far lip.
    const far = [...new Set(jumpEntries(c).filter((j) => j.pair === 0).map((j) => j.from))]
      .filter((k) => (c.faceOf.get(k) ?? []).includes(rim.faceB));
    expect(far).toHaveLength(2);
    expect(far).toContain(landed);

    // Occupied by another net, so refused outright rather than tolled -- a toll would multiply a zero
    // step and cost nothing. The route takes this seam's other land instead.
    const other = far.find((k) => k !== landed)!;
    const dodged = search(c, rim.faceA, rim.faceB, new Set([landed]));
    expect(jumpHopCount(c, dodged)).toBe(1);
    expect(ptKey(dodged[dodged.length - 1]!)).toBe(other);

    // Both taken: this seam is closed to a third net, which goes round or rejoins elsewhere.
    const shut = search(c, rim.faceA, rim.faceB, new Set(far));
    const usedPair0 = shut.slice(0, -1)
      .some((_p, i) => jumpHopBetween(c, ptKey(shut[i]!), ptKey(shut[i + 1]!))?.pair === 0);
    expect(usedPair0).toBe(false);
  });
});
