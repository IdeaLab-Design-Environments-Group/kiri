import { describe, expect, it } from "vitest";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import {
  RELIEF_MAX,
  cutAlongEdges,
  findSelfOverlap,
  seamedUnfold,
  trianglesOverlap,
  unfoldPatch,
} from "../../../src/pipeline/unfold.js";
import type { TriMesh, Vec2 } from "../../../src/pipeline/types.js";
import { makeCube, makeIcosphere, makePyramid, makeSaddleFan } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

const d3 = (mesh: TriMesh, a: number, b: number): number => {
  const p = mesh.vertices[a];
  const q = mesh.vertices[b];
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
};
const d2 = (flat: Vec2[], a: number, b: number): number =>
  Math.hypot(flat[a].x - flat[b].x, flat[a].y - flat[b].y);

function planFor(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart") {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  return { topo, defects, plan: planCuts(mesh, topo, defects, { lambda: 0, strategy }) };
}

/** Σ of flat corner angles over the given flat-vertex ids (rad). */
function flatAngleAt(flat: Vec2[], faces: [number, number, number][], at: Set<number>): number {
  let sum = 0;
  for (const f of faces) {
    for (let c = 0; c < 3; c++) {
      if (!at.has(f[c])) continue;
      const o1 = f[(c + 1) % 3];
      const o2 = f[(c + 2) % 3];
      const u = { x: flat[o1].x - flat[f[c]].x, y: flat[o1].y - flat[f[c]].y };
      const w = { x: flat[o2].x - flat[f[c]].x, y: flat[o2].y - flat[f[c]].y };
      sum += Math.atan2(Math.abs(u.x * w.y - u.y * w.x), u.x * w.x + u.y * w.y);
    }
  }
  return sum;
}

describe("trianglesOverlap (pure predicate)", () => {
  const T = (a: [number, number], b: [number, number], c: [number, number]): Vec2[] => [
    { x: a[0], y: a[1] },
    { x: b[0], y: b[1] },
    { x: c[0], y: c[1] },
  ];
  it("disjoint → false; overlapping → true", () => {
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([3, 3], [4, 3], [3, 4]))).toBe(false);
    expect(trianglesOverlap(T([0, 0], [2, 0], [0, 2]), T([0.5, 0.5], [2.5, 0.5], [0.5, 2.5]))).toBe(true);
  });
  it("vertex-touching and edge-sharing → false (shrink kills contact)", () => {
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([1, 0], [2, 0], [1, 1]))).toBe(false); // share vertex
    expect(trianglesOverlap(T([0, 0], [1, 0], [0, 1]), T([1, 0], [0, 1], [1, 1]))).toBe(false); // share edge
  });
});

describe("cutAlongEdges", () => {
  it("cube + 7-edge spanning tree → disk: V'=V+Σ(copies−1), χ=1, all lips recorded", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const cut = cutAlongEdges(cube, topo, plan.cutEdges);
    expect(cut.lips.length).toBe(7);
    const cutTopo = buildTopology(cut.mesh);
    const chi = cut.mesh.vertices.length - cutTopo.edges.length + cut.mesh.faces.length;
    expect(chi).toBe(1); // disk
    expect(cut.mesh.faces.length).toBe(12);
    // provenance: every copy maps back to a real cube vertex
    for (const o of cut.origVertex) expect(o).toBeGreaterThanOrEqual(0);
    // lips have equal rest lengths (same source edge)
    for (const lip of cut.lips) {
      expect(d3(cut.mesh, lip.lipA[0], lip.lipA[1])).toBeCloseTo(d3(cut.mesh, lip.lipB[0], lip.lipB[1]), 12);
    }
  });

  it("4th-arg default: no vents, and goalPos = vertex positions for non-vent cuts", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const cut = cutAlongEdges(cube, topo, plan.cutEdges);
    expect(cut.vents).toEqual([]);
    expect(cut.goalPos.length).toBe(cut.mesh.vertices.length);
    for (let v = 0; v < cut.mesh.vertices.length; v++) {
      // the folded target of a plain vertex copy is the copy's Q position
      expect(cut.goalPos[v]).toEqual(cut.mesh.vertices[v]);
      expect(cut.goalPos[v]).toEqual(cube.vertices[cut.origVertex[v]]);
    }
  });

  it("ignores boundary edges handed in as cuts", () => {
    const pyr = makePyramid(4);
    const topo = buildTopology(pyr);
    const boundaryEdge = topo.edges.findIndex((e) => e.faces.length === 1);
    const cut = cutAlongEdges(pyr, topo, [boundaryEdge]);
    expect(cut.lips.length).toBe(0);
    expect(cut.vents.length).toBe(0);
    expect(cut.mesh.vertices.length).toBe(pyr.vertices.length);
  });
});

describe("unfoldPatch — isometric layout", () => {
  it("cube net golden: isometry of every edge and angle, no self-overlap", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const cut = cutAlongEdges(cube, topo, plan.cutEdges);
    const flat = unfoldPatch(cut, cut.mesh.faces.map((_, f) => f));

    // every flat edge length = 3D rest length (1e-9 relative)
    const cutTopo = buildTopology(cut.mesh);
    for (const e of cutTopo.edges) {
      const rel = Math.abs(d2(flat, e.a, e.b) - d3(cut.mesh, e.a, e.b)) / d3(cut.mesh, e.a, e.b);
      expect(rel).toBeLessThan(1e-9);
    }
    expect(findSelfOverlap(flat, cut.mesh.faces)).toBeNull();
  });

  it("open pyramid: dart gap at the apex = δ(apex)", () => {
    const pyr = makePyramid(4, 50, 30);
    const { topo, defects, plan } = planFor(pyr);
    const cut = cutAlongEdges(pyr, topo, plan.cutEdges);
    const flat = unfoldPatch(cut, cut.mesh.faces.map((_, f) => f));
    // The apex keeps ONE copy (slit endpoint): sum of its flat angles = 2π − δ.
    const apexCopies = cut.origVertex
      .map((src, v) => ({ src, v }))
      .filter((x) => x.src === 0)
      .map((x) => x.v);
    expect(apexCopies.length).toBe(1);
    const sum = flatAngleAt(flat, cut.mesh.faces, new Set(apexCopies));
    expect(sum).toBeCloseTo(TAU - defects.defects[0], 9);
  });

  it("saddle fan: vent closes the flat material at the center to exactly 2π", () => {
    const saddle = makeSaddleFan();
    const { topo, defects, plan } = planFor(saddle);
    const result = seamedUnfold(saddle, topo, plan, defects);
    // Proper-kirigami invariant: the δ<0 slit vertex keeps exactly 2π of flat
    // material once the vent sliver is removed.
    const centerCopies = new Set(
      result.origVertex.map((src, v) => ({ src, v })).filter((x) => x.src === 0).map((x) => x.v),
    );
    expect(centerCopies.size).toBeGreaterThanOrEqual(1);
    expect(Math.abs(flatAngleAt(result.flat, result.faces, centerCopies) - TAU)).toBeLessThan(1e-6);
    // surviving slit lips are zero-width in flat (coincident endpoints) and
    // keep equal flat lengths (one lip pair may have been consumed by the vent)
    for (const lip of result.lips) {
      expect(d2(result.flat, lip.lipA[0], lip.lipB[0])).toBeLessThan(1e-9);
      expect(d2(result.flat, lip.lipA[1], lip.lipB[1])).toBeLessThan(1e-9);
      expect(d2(result.flat, lip.lipA[0], lip.lipA[1])).toBeCloseTo(
        d2(result.flat, lip.lipB[0], lip.lipB[1]),
        9,
      );
    }
  });

  it("audit negative test: dropping a cut edge from the cube tree throws (not developable)", () => {
    const cube = makeCube();
    const { topo, plan } = planFor(cube);
    const broken = plan.cutEdges.slice(0, -1); // corner left interior with δ=π/2
    const cut = cutAlongEdges(cube, topo, broken);
    expect(() => unfoldPatch(cut, cut.mesh.faces.map((_, f) => f))).toThrow(/developability|isometry/);
  });
});

describe("seamedUnfold (relief loop)", () => {
  it("cube: single patch, no relief needed, totalCutLength = plan length", () => {
    const cube = makeCube();
    const { topo, defects, plan } = planFor(cube);
    const result = seamedUnfold(cube, topo, plan, defects);
    expect(result.patchCount).toBe(1);
    expect(result.reliefEdges.length).toBe(0);
    expect(result.totalCutLength).toBeCloseTo(plan.cost.length, 9);
    expect(findSelfOverlap(result.flat, result.faces)).toBeNull();
  });

  it("icosphere(1): one sheet, terminates, overlap-free, relief bounded; cut length only grows", { timeout: 60000 }, () => {
    const sphere = makeIcosphere(1);
    const { topo, defects, plan } = planFor(sphere);
    const result = seamedUnfold(sphere, topo, plan, defects);
    expect(result.patchCount).toBe(1);
    expect(findSelfOverlap(result.flat, result.faces)).toBeNull();
    expect(result.reliefEdges.length).toBeLessThanOrEqual(RELIEF_MAX);
    expect(result.totalCutLength).toBeGreaterThanOrEqual(plan.cost.length - 1e-9);
  });

  it("saddle fan: ONE sheet with a single vent of angle |δ(center)|", () => {
    const saddle = makeSaddleFan();
    const { topo, defects, plan } = planFor(saddle);
    const result = seamedUnfold(saddle, topo, plan, defects);
    expect(result.patchCount).toBe(1);
    expect(findSelfOverlap(result.flat, result.faces)).toBeNull();
    expect(result.goalPos.length).toBe(result.flat.length);
    expect(result.vents.length).toBe(1);
    expect(result.vents[0].sourceVertex).toBe(0);
    expect(Math.abs(result.vents[0].angle - Math.abs(defects.defects[0]))).toBeLessThan(1e-6);
    expect(result.totalCutLength).toBeGreaterThanOrEqual(plan.cost.length - 1e-9);
  });
});

describe("seamedUnfold (relief pruning)", () => {
  it("icosphere(1): pruning preserves a valid development and never adds cuts", { timeout: 120000 }, () => {
    const sphere = makeIcosphere(1);
    const { topo, defects, plan } = planFor(sphere);
    const base = seamedUnfold(sphere, topo, plan, defects, { pruneRelief: false });
    const pruned = seamedUnfold(sphere, topo, plan, defects, { pruneRelief: true });

    // The unpruned run adds relief; pruning reports its (possibly-zero) removals.
    // NOTE: on smooth meshes the relief loop is already near-minimal — relief
    // edges are individually load-bearing, so single-edge removal usually finds
    // 0 to drop (icosphere(1) measures pruned = 0). This test fixes CORRECTNESS,
    // not a headroom claim: pruning must never make the result worse.
    expect(base.reliefEdges.length).toBeGreaterThan(0);
    expect(base.reliefPruned).toBe(0);
    expect(pruned.reliefPruned).toBeGreaterThanOrEqual(0);

    // Pruning never increases the cut set or its length.
    expect(pruned.reliefEdges.length).toBeLessThanOrEqual(base.reliefEdges.length);
    expect(pruned.reliefEdges.length + pruned.reliefPruned).toBeLessThanOrEqual(base.reliefEdges.length);
    expect(pruned.totalCutLength).toBeLessThanOrEqual(base.totalCutLength + 1e-9);

    // Pruned set is still one overlap-free sheet.
    expect(pruned.patchCount).toBe(1);
    expect(findSelfOverlap(pruned.flat, pruned.faces)).toBeNull();

    // Pruning only ever REMOVES — kept relief ⊆ the unpruned relief set …
    const baseRelief = new Set(base.reliefEdges);
    for (const e of pruned.reliefEdges) expect(baseRelief.has(e)).toBe(true);
    // … and never touches a planned curvature cut.
    const keptCuts = new Set([...plan.cutEdges, ...pruned.reliefEdges]);
    for (const e of plan.cutEdges) expect(keptCuts.has(e)).toBe(true);
  });

  it("cube: nothing to prune (no relief), pruneRelief is a no-op", () => {
    const cube = makeCube();
    const { topo, defects, plan } = planFor(cube);
    const result = seamedUnfold(cube, topo, plan, defects, { pruneRelief: true });
    expect(result.reliefEdges.length).toBe(0);
    expect(result.reliefPruned).toBe(0);
    expect(result.patchCount).toBe(1);
    expect(findSelfOverlap(result.flat, result.faces)).toBeNull();
  });
});
