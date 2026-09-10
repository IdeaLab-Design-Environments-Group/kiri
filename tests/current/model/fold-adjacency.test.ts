/**
 * The lip pairing, on the bundled patterns and on two inline files that isolate the key path.
 *
 * The counts pinned here were arrived at independently of the implementation, by welding each file's
 * declared folded form: desk-lamp-shade's 112 "C" edges collapse to 56 pairs, house 9, church 6,
 * puffin 49, akde-hex 6, kirigami-flap none (its slits keep both lips on one face), and
 * akde-square-pyramid carries no goal frame at all. What makes them worth pinning is not the number
 * but the shape of the failure they would catch: a tolerance that welds too eagerly merges distinct
 * rim vertices and the pairs collapse; one that welds too little leaves singles and the count drops.
 *
 * The ordering assertions matter more than the counts. `lipA[i]` must weld to `lipB[i]`, not merely
 * to *some* endpoint of lip B, because a hop across a seam lands at the same parameter along both
 * lips and would otherwise arrive at the far end of the edge. On desk-lamp-shade the crossed pairing
 * is checked to be wrong, so the test would fail if the correspondence were assigned arbitrarily.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, type FlatFace, type Vec2 } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  EMPTY_ADJACENCY,
  LIP_PEER_KEY,
  foldAdjacency,
  lipPairsFromGoalFrame,
  lipPairsFromKey,
  pairContaining,
  type LipPairFlat,
} from "../../../src/model/fold-adjacency.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string): { fold: FoldFile; faces: FlatFace[] } {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8")) as FoldFile;
  return { fold, faces: flatFaces(fold) };
}

/** The goal frame's coordinates, and the weld tolerance the module derives from them. */
function goalOf(fold: FoldFile): { g: number[][]; tol: number } {
  const frames = (fold as { file_frames?: Array<{ frame_classes?: string[]; vertices_coords?: number[][] }> })
    .file_frames;
  const g = frames?.find((fr) => (fr.frame_classes ?? []).includes("foldedForm"))?.vertices_coords ?? [];
  let span = 0;
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity, hi = -Infinity;
    for (const p of g) {
      const v = p[axis] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > span) span = hi - lo;
  }
  return { g, tol: 1e-3 * span };
}

const goalDist = (g: number[][], i: number, j: number): number => {
  const a = g[i] ?? [0, 0, 0], b = g[j] ?? [0, 0, 0];
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
};

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lipSeparation = (p: LipPairFlat): number => {
  const a = mid(p.lipA[0], p.lipA[1]), b = mid(p.lipB[0], p.lipB[1]);
  return Math.hypot(a.x - b.x, a.y - b.y);
};

describe("model/fold-adjacency › welding the declared folded form", () => {
  it("finds every cut's peer on desk-lamp-shade, half of them far apart in the flat pattern", () => {
    const { fold, faces } = load("desk-lamp-shade.fkld");
    const adj = foldAdjacency(fold, faces);
    expect(adj.source).toBe("goal-frame");
    expect(adj.pairs).toHaveLength(56);
    // The shade is a strip whose two short edges are one rim: those lips sit a whole sheet apart.
    expect(adj.pairs.filter((p) => lipSeparation(p) > 5)).toHaveLength(27);
    expect(Math.max(...adj.pairs.map(lipSeparation))).toBeGreaterThan(250);
  });

  it.each([
    ["house.fkld", 9],
    ["church.fkld", 6],
    ["akde-hex.fkld", 6],
    ["kirigami-flap.fkld", 0],
  ])("pairs %s into %i seams", (name, count) => {
    const { fold, faces } = load(name);
    const adj = foldAdjacency(fold, faces);
    expect(adj.pairs).toHaveLength(count);
  });

  it("pairs puffin into 49 seams", { timeout: 20_000 }, () => {
    const { fold, faces } = load("puffin.fkld");
    expect(foldAdjacency(fold, faces).pairs).toHaveLength(49);
  });

  it("never uses one edge in two pairs -- a lip has exactly one peer", () => {
    const { fold, faces } = load("akde-hex.fkld");
    const seen = new Set<number>();
    for (const p of foldAdjacency(fold, faces).pairs) {
      for (const e of [p.edgeA, p.edgeB]) {
        expect(seen.has(e)).toBe(false);
        seen.add(e);
      }
    }
  });

  it("reports no adjacency for a pattern with neither key nor goal frame", () => {
    const { fold, faces } = load("akde-square-pyramid.fkld");
    const adj = foldAdjacency(fold, faces);
    expect(adj.source).toBe("none");
    expect(adj.pairs).toEqual([]);
    expect(EMPTY_ADJACENCY.source).toBe("none");
    expect(EMPTY_ADJACENCY.pairs).toEqual([]);
  });

  it.each(["desk-lamp-shade.fkld", "house.fkld"])(
    "%s: every pair is two cut lips on different faces, welded endpoint to endpoint",
    (name) => {
      const { fold, faces } = load(name);
      const assign = fold.edges_assignment!;
      const { g, tol } = goalOf(fold);
      const pairs = foldAdjacency(fold, faces).pairs;
      expect(pairs.length).toBeGreaterThan(0);
      for (const p of pairs) {
        expect(assign[p.edgeA]).toBe("C");
        expect(assign[p.edgeB]).toBe("C");
        expect(p.faceA).not.toBe(p.faceB);
        expect(goalDist(g, p.vA[0], p.vB[0])).toBeLessThanOrEqual(tol);
        expect(goalDist(g, p.vA[1], p.vB[1])).toBeLessThanOrEqual(tol);
      }
    },
  );

  it("orders the endpoints -- the crossed pairing is wrong on at least one desk-lamp-shade seam", () => {
    const { fold, faces } = load("desk-lamp-shade.fkld");
    const { g, tol } = goalOf(fold);
    const crossed = foldAdjacency(fold, faces).pairs.filter((p) => goalDist(g, p.vA[0], p.vB[1]) > tol);
    expect(crossed.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const { fold, faces } = load("house.fkld");
    expect(JSON.stringify(foldAdjacency(fold, faces))).toBe(JSON.stringify(foldAdjacency(fold, faces)));
  });
});

/** Two separate quads, each with one "C" edge facing the other -- the WEDGE of `gap-bridge.test.ts`. */
const TWO_TILES: FoldFile = {
  vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [11, 0], [21, 0], [21, 10], [18, 10]],
  faces_vertices: [[0, 1, 2, 3], [4, 5, 6, 7]],
  edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]],
  edges_assignment: ["B", "C", "B", "B", "B", "B", "B", "C"],
};

/** Edge 1 is `[1,2]`, edge 7 is `[7,4]`; `aligned` picks which way the two run. */
const withKey = (aligned: 0 | 1): FoldFile => ({
  ...TWO_TILES,
  [LIP_PEER_KEY]: [null, [7, aligned], null, null, null, null, null, [1, aligned]],
});

/** The same tiles folded so that vertex 4 lands on 1 and vertex 7 lands on 2. */
const withGoal = (extra: Partial<FoldFile> = {}): FoldFile => ({
  ...TWO_TILES,
  ...extra,
  file_frames: [
    {
      frame_classes: ["foldedForm"],
      vertices_coords: [
        [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
        [10, 0, 0], [19, 0, 5], [19, 10, 5], [10, 10, 0],
      ],
    },
  ],
});

describe("model/fold-adjacency › the declared key", () => {
  it("is read in preference to a weld, and needs no folded form at all", () => {
    const fold = withKey(0);
    const adj = foldAdjacency(fold, flatFaces(fold));
    expect(adj.source).toBe("key");
    expect(adj.pairs).toHaveLength(1);
    const p = adj.pairs[0]!;
    expect([p.edgeA, p.edgeB]).toEqual([1, 7]);
    expect([p.faceA, p.faceB]).toEqual([0, 1]);
    // aligned = 0: edges_vertices[1][0] corresponds to edges_vertices[7][1].
    expect(p.vA).toEqual([1, 2]);
    expect(p.vB).toEqual([4, 7]);
    expect(p.lipB[0]).toEqual({ x: 11, y: 0 });
  });

  it("reverses the correspondence when the key says the lips run the same way", () => {
    const fold = withKey(1);
    const p = lipPairsFromKey(fold, flatFaces(fold))![0]!;
    expect(p.vA).toEqual([1, 2]);
    expect(p.vB).toEqual([7, 4]);
    expect(p.lipB[0]).toEqual({ x: 18, y: 10 });
  });

  it("falls back to the folded form when the key is asymmetric rather than trusting it", () => {
    const fold = withGoal({ [LIP_PEER_KEY]: [null, [7, 0], null, null, null, null, null, null] });
    const faces = flatFaces(fold);
    expect(lipPairsFromKey(fold, faces)).toBeNull();
    const adj = foldAdjacency(fold, faces);
    expect(adj.source).toBe("goal-frame");
    expect(adj.pairs).toHaveLength(1);
    // The weld finds the same correspondence the well-formed key declares.
    expect(adj.pairs[0]!.vA).toEqual([1, 2]);
    expect(adj.pairs[0]!.vB).toEqual([4, 7]);
  });

  it("rejects a key of the wrong length, and one an edge points at itself through", () => {
    const faces = flatFaces(TWO_TILES);
    expect(lipPairsFromKey({ ...TWO_TILES, [LIP_PEER_KEY]: [null, [7, 0]] }, faces)).toBeNull();
    const selfPeer = { ...TWO_TILES, [LIP_PEER_KEY]: [null, [1, 1], null, null, null, null, null, null] };
    expect(lipPairsFromKey(selfPeer, faces)).toBeNull();
    expect(lipPairsFromKey(TWO_TILES, faces)).toBeNull();
  });

  it("reports no adjacency when the file carries neither", () => {
    expect(foldAdjacency(TWO_TILES, flatFaces(TWO_TILES))).toEqual({ pairs: [], source: "none" });
  });

  it("welds the folded form on its own when asked directly", () => {
    const fold = withGoal();
    expect(lipPairsFromGoalFrame(fold, flatFaces(fold))).toHaveLength(1);
  });
});

describe("model/fold-adjacency › pairContaining", () => {
  const fold = withGoal();
  const adj = foldAdjacency(fold, flatFaces(fold));

  it("finds the lip a point sits beside, and where along it", () => {
    // Lip A runs (10,0) → (10,10); this point is just inside face A, three tenths up.
    const hit = pairContaining(adj, { x: 9.8, y: 3 }, 1);
    expect(hit).not.toBeNull();
    expect(hit!.pair).toBe(0);
    expect(hit!.side).toBe("A");
    expect(hit!.u).toBeCloseTo(0.3, 2);
  });

  it("finds the peer lip from the other side", () => {
    // Lip B runs (11,0) → (18,10); this point is three tenths along it, nudged into face B.
    const hit = pairContaining(adj, { x: 13.35, y: 2.83 }, 1);
    expect(hit!.side).toBe("B");
    expect(hit!.u).toBeCloseTo(0.3, 2);
  });

  it("returns nothing beyond reach", () => {
    expect(pairContaining(adj, { x: 1, y: 5 }, 1)).toBeNull();
    expect(pairContaining(EMPTY_ADJACENCY, { x: 9.8, y: 3 }, 1)).toBeNull();
  });
});
