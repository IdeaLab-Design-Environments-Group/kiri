import { describe, expect, it } from "vitest";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts, shortestPaths } from "../../../src/pipeline/plan-cuts.js";
import type { MeshTopology } from "../../../src/pipeline/types.js";
import { makeCube, makeGrid, makeOctahedron, makePyramid, makeSaddleFan } from "./fixtures/targets.js";

function isForest(topo: MeshTopology, cutEdges: number[]): boolean {
  // union-find over the cut edges; a cycle-closing edge makes it not-a-forest
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of cutEdges) {
    const { a, b } = topo.edges[e];
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
  }
  return true;
}

function cutDegree(topo: MeshTopology, cutEdges: number[], v: number): number {
  const set = new Set(cutEdges);
  return topo.vertexEdges[v].filter((e) => set.has(e)).length;
}

describe("shortestPaths", () => {
  it("computes geodesic-along-edges distances on the grid", () => {
    const grid = makeGrid(2, 2, 10);
    const topo = buildTopology(grid);
    const res = shortestPaths(grid, topo, [0]); // corner
    expect(res.dist[0]).toBe(0);
    expect(res.dist[2]).toBeCloseTo(20, 9); // two cells along an axis
  });

  it("noTransit vertices are reachable as endpoints but never passed through", () => {
    const grid = makeGrid(2, 2, 10);
    const topo = buildTopology(grid);
    // forbid transit through every vertex except the source's row: any path
    // to vertex 2 (two cells along x) must then go straight along the row.
    const noTransit = new Set([...grid.vertices.keys()].filter((v) => v !== 0 && v !== 1 && v !== 2));
    const res = shortestPaths(grid, topo, [0], undefined, noTransit);
    expect(res.dist[1]).toBeCloseTo(10, 9); // endpoint: still reachable
    expect(res.dist[2]).toBeCloseTo(20, 9); // routed along the allowed row
    expect(res.prevVertex[2]).toBe(1); // ... not through a forbidden vertex
  });
});

describe("planCuts — dart strategy (default)", () => {
  it("cube: spanning tree of the 8 corners — exactly 7 cut edges, classic net", () => {
    const cube = makeCube();
    const topo = buildTopology(cube);
    const defects = angleDefects(cube, topo);
    const plan = planCuts(cube, topo, defects, { lambda: 0, strategy: "dart" });
    expect(plan.cutEdges.length).toBe(7);
    expect(isForest(topo, plan.cutEdges)).toBe(true);
    // necessity: every corner is touched by ≥1 cut edge
    for (let v = 0; v < 8; v++) {
      expect(plan.perVertexAction[v]).toBe("dart");
      expect(cutDegree(topo, plan.cutEdges, v)).toBeGreaterThanOrEqual(1);
    }
    expect(plan.cost.length).toBeCloseTo(7 * 100, 6); // corner-adjacent paths are single 100mm edges
  });

  it("saddle fan: a single slit reaches the δ<0 center — vents handle closure (no wedge rule)", () => {
    const saddle = makeSaddleFan();
    const topo = buildTopology(saddle);
    const defects = angleDefects(saddle, topo);
    const plan = planCuts(saddle, topo, defects, { lambda: 0, strategy: "dart" });
    expect(plan.perVertexAction[0]).toBe("slit");
    // necessity: a slit must REACH the center (cut-degree ≥ 1) — the old
    // fan-splitting cut-degree ≥ 2 wedge rule is retired (K1 vents close 2π)
    expect(cutDegree(topo, plan.cutEdges, 0)).toBeGreaterThanOrEqual(1);
    expect(isForest(topo, plan.cutEdges)).toBe(true);
    // and nothing beyond the shortest center→boundary slit is cut
    expect(plan.cutEdges.length).toBe(1);
  });

  it("open pyramid: apex darted via a single slit to the boundary", () => {
    const pyr = makePyramid(4, 50, 30);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, { lambda: 0, strategy: "dart" });
    expect(plan.perVertexAction[0]).toBe("dart");
    expect(plan.cutEdges.length).toBe(1); // shortest path apex→boundary = 1 edge
    expect(cutDegree(topo, plan.cutEdges, 0)).toBe(1); // dart: single wedge 2π−δ < 2π suffices
  });

  it("flat grid: no terminals → empty plan", () => {
    const grid = makeGrid();
    const topo = buildTopology(grid);
    const defects = angleDefects(grid, topo);
    const plan = planCuts(grid, topo, defects, { lambda: 0, strategy: "dart" });
    expect(plan.cutEdges).toEqual([]);
    expect(plan.perVertexAction.every((a) => a === "none")).toBe(true);
  });

  it("cut paths are valid edge walks (forest invariant on the sphere too)", () => {
    const octa = makeOctahedron();
    const topo = buildTopology(octa);
    const defects = angleDefects(octa, topo);
    const plan = planCuts(octa, topo, defects, { lambda: 0, strategy: "dart" });
    expect(isForest(topo, plan.cutEdges)).toBe(true);
    expect(plan.cutEdges.length).toBe(5); // spanning tree of 6 vertices
    for (let v = 0; v < 6; v++) expect(cutDegree(topo, plan.cutEdges, v)).toBeGreaterThanOrEqual(1);
  });
});

describe("planCuts — tuck-all strategy (Origamizer reduction)", () => {
  it("convex polytope: C = ∅, every vertex tucked", () => {
    const octa = makeOctahedron();
    const topo = buildTopology(octa);
    const defects = angleDefects(octa, topo);
    const plan = planCuts(octa, topo, defects, { lambda: 0, strategy: "tuck-all" });
    expect(plan.cutEdges).toEqual([]);
    for (let v = 0; v < 6; v++) expect(plan.perVertexAction[v]).toBe("tuck");
  });

  it("saddle still forces a cut under tuck-all (tucks cannot add angle)", () => {
    const saddle = makeSaddleFan();
    const topo = buildTopology(saddle);
    const defects = angleDefects(saddle, topo);
    const plan = planCuts(saddle, topo, defects, { lambda: 0, strategy: "tuck-all" });
    expect(plan.perVertexAction[0]).toBe("slit");
    expect(plan.cutEdges.length).toBeGreaterThanOrEqual(1); // a slit reaching the center
    expect(cutDegree(topo, plan.cutEdges, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("planCuts — single isolated terminal on a closed mesh", () => {
  it("adds a dangling slit so the lone defect vertex reaches a boundary", () => {
    // Closed "spindle": double pyramid sharing a flat equator won't give a
    // lone terminal easily — craft instead a cube whose defects are tucked
    // except one corner (simulating one cut terminal via extraTerminals).
    const cube = makeCube();
    const topo = buildTopology(cube);
    const defects = angleDefects(cube, topo);
    const plan = planCuts(cube, topo, defects, {
      lambda: 0,
      strategy: "tuck-all",
      extraTerminals: [3],
    });
    expect(plan.cutEdges.length).toBe(1);
    expect(cutDegree(topo, plan.cutEdges, 3)).toBe(1);
  });
});

describe("planCuts — vis(e) seam-visibility routing (λ > 0)", () => {
  it("cost.visibility is 0 at lambda=0 regardless of shape", () => {
    const pyr = makePyramid(4, 50, 30);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, { lambda: 0, strategy: "dart" });
    expect(plan.cost.visibility).toBe(0);
  });

  it("cost.visibility is positive at lambda>0 on a non-flat mesh", () => {
    const pyr = makePyramid(4, 50, 30);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, { lambda: 1, strategy: "dart" });
    expect(plan.cost.visibility).toBeGreaterThan(0);
  });

  it("cost.length is the same as lambda=0 when all edges have equal dihedral", () => {
    // A flat grid has zero dihedral everywhere → vis(e) = 1 for all e, so
    // the routing is len(e) + λ·1 = len(e) + λ. The MST topology is the
    // same as λ=0 (ties broken identically). But on a flat grid there are no
    // defect vertices, so the plan is empty regardless.
    const grid = makeGrid();
    const topo = buildTopology(grid);
    const defects = angleDefects(grid, topo);
    const p0 = planCuts(grid, topo, defects, { lambda: 0, strategy: "dart" });
    const p1 = planCuts(grid, topo, defects, { lambda: 5, strategy: "dart" });
    expect(p0.cutEdges).toEqual([]);
    expect(p1.cutEdges).toEqual([]);
  });

  it("cost.lambda records the weight used", () => {
    const pyr = makePyramid(4, 50, 30);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, { lambda: 2.5, strategy: "dart" });
    expect(plan.cost.lambda).toBe(2.5);
  });
});

describe("planCuts — hybrid dart-vs-tuck strategy", () => {
  it("nearly-flat apex: high tuckCostScale → dart (cheap path beats high tuck cost)", () => {
    // A very shallow pyramid: apex δ ≈ 0.009 rad, nearest-boundary path = 1 edge.
    // With large tuckCostScale the tuck cost (scale·δ·r̄) greatly exceeds the
    // single-edge dart path → hybrid chooses dart.
    const pyr = makePyramid(4, 50, 1);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, {
      lambda: 0,
      strategy: "hybrid",
      tuckCostScale: 1000,
    });
    expect(plan.perVertexAction[0]).toBe("dart");
    expect(plan.cutEdges.length).toBeGreaterThan(0);
  });

  it("nearly-flat apex: tiny tuckCostScale → tuck (molecule is cheaper than the cut path)", () => {
    // Same pyramid: with tuckCostScale ≈ 0 the tuck cost → 0, which is always
    // less than the dart path → hybrid chooses tuck.
    const pyr = makePyramid(4, 50, 1);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, {
      lambda: 0,
      strategy: "hybrid",
      tuckCostScale: 0.0001,
    });
    expect(plan.perVertexAction[0]).toBe("tuck");
    expect(plan.cutEdges).toEqual([]); // apex is the only terminal; tucked → no cut
  });

  it("saddle vertex is always slit regardless of hybrid tuck cost", () => {
    const saddle = makeSaddleFan();
    const topo = buildTopology(saddle);
    const defects = angleDefects(saddle, topo);
    // tuckCostScale=0 would try to tuck everything, but δ<0 must be slit.
    const plan = planCuts(saddle, topo, defects, {
      lambda: 0,
      strategy: "hybrid",
      tuckCostScale: 0,
    });
    expect(plan.perVertexAction[0]).toBe("slit");
    expect(plan.cutEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("hybrid with tuckCostScale=∞ behaves like dart (always dart)", () => {
    const octa = makeOctahedron();
    const topo = buildTopology(octa);
    const defects = angleDefects(octa, topo);
    const planDart = planCuts(octa, topo, defects, { lambda: 0, strategy: "dart" });
    const planHybrid = planCuts(octa, topo, defects, {
      lambda: 0,
      strategy: "hybrid",
      tuckCostScale: Infinity,
    });
    // On a closed mesh dart cost = Infinity → hybrid falls back to dart for all.
    expect(planHybrid.perVertexAction).toEqual(planDart.perVertexAction);
  });
});

describe("planCuts — leaf pruning", () => {
  it("leafPruning=false (default) keeps all dart leaves intact", () => {
    const pyr = makePyramid(4, 50, 1); // nearly-flat apex, δ ≈ 0.009 rad
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, {
      lambda: 0,
      strategy: "dart",
      leafPruning: false,
    });
    expect(plan.perVertexAction[0]).toBe("dart");
    expect(plan.cutEdges.length).toBe(1);
  });

  it("leafPruning=true demotes a small-δ degree-1 dart to tuck and removes its branch", () => {
    // The apex of a nearly-flat pyramid has δ ≈ 0.009 rad, which is well below
    // the default leafPruneDeltaMax = π/4 ≈ 0.785. After MST the apex is a
    // degree-1 leaf — it should be promoted to tuck and the cut edge dropped.
    const pyr = makePyramid(4, 50, 1);
    const topo = buildTopology(pyr);
    const defects = angleDefects(pyr, topo);
    const plan = planCuts(pyr, topo, defects, {
      lambda: 0,
      strategy: "dart",
      leafPruning: true,
    });
    expect(plan.perVertexAction[0]).toBe("tuck"); // demoted
    expect(plan.cutEdges).toEqual([]); // leaf branch removed
  });

  it("leafPruning=true does not prune a large-δ leaf (δ > leafPruneDeltaMax)", () => {
    // The cube's corners have δ = π/2 ≈ 1.57 rad > π/4 — they should NOT be pruned.
    const cube = makeCube();
    const topo = buildTopology(cube);
    const defects = angleDefects(cube, topo);
    const plan = planCuts(cube, topo, defects, {
      lambda: 0,
      strategy: "dart",
      leafPruning: true,
      leafPruneDeltaMax: Math.PI / 4, // 45° — cube corners are 90° → not pruned
    });
    // All 8 corners should remain dart; leaf pruning leaves cube unchanged.
    for (let v = 0; v < 8; v++) expect(plan.perVertexAction[v]).toBe("dart");
    expect(plan.cutEdges.length).toBe(7);
  });

  it("leafPruning=true never prunes slit (δ<0) vertices", () => {
    const saddle = makeSaddleFan();
    const topo = buildTopology(saddle);
    const defects = angleDefects(saddle, topo);
    const plan = planCuts(saddle, topo, defects, {
      lambda: 0,
      strategy: "dart",
      leafPruning: true,
      leafPruneDeltaMax: Math.PI * 2, // would prune anything — but slits are exempt
    });
    expect(plan.perVertexAction[0]).toBe("slit"); // must NOT be demoted to tuck
    expect(plan.cutEdges.length).toBeGreaterThanOrEqual(1);
  });
});
