import { describe, expect, it } from "vitest";
import { KEYS, parseFkld, serializeFkld } from "@dayangac/fkld";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { DRIVEN_KEY, LIP_PEER_KEY, emitFkld } from "../../../src/pipeline/emit.js";
import { buildTopology } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { placeSheet } from "../../../src/pipeline/route-seams.js";
import { seamedUnfold } from "../../../src/pipeline/unfold.js";
import { isFkld, type FoldFile } from "../../../src/model/fold-file.js";
import { isFoldable } from "../../../src/sim/fold-adapter.js";
import { buildScene, canSimulate } from "../../../src/sim/scene.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeCube, makeOctahedron, makeSaddleFan } from "./fixtures/targets.js";

function emitFor(mesh: TriMesh, strategy: "dart" | "tuck-all" = "dart", tuckSet: number[] = []) {
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy });
  const unfold = seamedUnfold(mesh, topo, plan, defects);
  const sheet = placeSheet(unfold, { mesh, topo, defects });
  const fkld = emitFkld(sheet, {
    defects,
    target: mesh,
    topo,
    tuckSet,
    actions: plan.perVertexAction,
    strategy,
  });
  return { topo, defects, plan, unfold, sheet, fkld };
}

describe("emitFkld — cube", () => {
  const { sheet, fkld } = emitFor(makeCube());

  it("is FKLD, parallel arrays aligned, and round-trips through io", () => {
    expect(isFkld(fkld)).toBe(true);
    const nE = (fkld.edges_vertices as unknown[]).length;
    const nV = (fkld.vertices_coords as unknown[]).length;
    for (const key of [
      "edges_assignment",
      "edges_foldAngle",
      KEYS.edges.cutType,
      KEYS.edges.dihedralTarget,
      KEYS.edges.moleculeTheta,
      KEYS.edges.moleculeWidth,
    ]) {
      expect((fkld[key] as unknown[]).length).toBe(nE);
    }
    for (const key of [KEYS.vertices.angleDefect, KEYS.vertices.curvatureClass, KEYS.vertices.reliefStrategy, DRIVEN_KEY]) {
      expect((fkld[key] as unknown[]).length).toBe(nV);
    }
    const round = parseFkld(serializeFkld(fkld)) as FoldFile;
    expect(round).toEqual(JSON.parse(JSON.stringify(fkld)));
  });

  it("fold angles are degrees with the AKDE M+ convention", () => {
    const fa = fkld.edges_foldAngle as (number | null)[];
    const ea = fkld.edges_assignment as string[];
    for (let e = 0; e < ea.length; e++) {
      if (ea[e] === "M") expect(fa[e]!).toBeCloseTo(90, 6);
      if (ea[e] === "C" || ea[e] === "B") expect(fa[e]).toBeNull();
    }
  });

  it("loads in the sim/viewer path (isFoldable + buildScene)", () => {
    expect(isFoldable(fkld)).toBe(true);
    expect(canSimulate(fkld)).toBe(true);
    expect(buildScene(fkld)).not.toBeNull();
  });

  it("fkld:meta_architecture carries the placeSheet paper rectangle", () => {
    const meta = fkld[KEYS.meta.architecture] as { sheet: Record<string, number> };
    expect(meta.sheet).toEqual(sheet.sheetRect);
    expect(meta.sheet.marginMm).toBe(5);
  });

  it("carries the guided-fold contract: foldedForm goal frame + driven boundary", () => {
    const frames = fkld.file_frames as { frame_classes: string[]; vertices_coords: number[][] }[];
    expect(frames.length).toBe(1);
    expect(frames[0].frame_classes).toContain("foldedForm");
    const goal = frames[0].vertices_coords;
    expect(goal.length).toBe((fkld.vertices_coords as unknown[]).length);
    for (const g of goal) expect(g.length).toBe(3);
    // the goal frame is exactly the sheet's goalPos (folded-target positions)
    goal.forEach((g, i) => {
      expect(g[0]).toBeCloseTo(sheet.goalPos[i].x, 12);
      expect(g[1]).toBeCloseTo(sheet.goalPos[i].y, 12);
      expect(g[2]).toBeCloseTo(sheet.goalPos[i].z, 12);
    });
    // ... which for the (vent-free) cube are exactly Q vertices (±50 mm corners)
    for (const g of goal) for (const c of g) expect(Math.abs(c)).toBeCloseTo(50, 9);

    const driven = fkld[DRIVEN_KEY] as number[];
    // driven = every sheet-boundary vertex (lips + ∂Q) — the DETC forward
    // process; verification leans on strain + crease residuals (see emit.ts).
    const expected = new Set<number>();
    sheet.edges.forEach((e, i) => {
      if (sheet.assignment[i] === "C" || sheet.assignment[i] === "B") {
        expected.add(e.a);
        expected.add(e.b);
      }
    });
    driven.forEach((d, v) => expect(d).toBe(expected.has(v) ? 1 : 0));
    expect(driven.some((d) => d === 1)).toBe(true);
  });

  it("Σ source-distinct angle defects = 4π (Gauss–Bonnet through provenance)", () => {
    const defect = fkld[KEYS.vertices.angleDefect] as number[];
    const seen = new Map<number, number>(); // source vertex → defect
    (fkld[KEYS.vertices.curvatureClass] as string[]).forEach((_, i) => {
      if (sheetSource(i) >= 0) seen.set(sheetSource(i), defect[i]); // skip synthesized −1
    });
    const sum = [...seen.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(4 * Math.PI, 9);
  });

  const sheetSource = (i: number): number => sheet.origVertex[i];
});

describe("emitFkld — saddle fan (vents and synthesized vertices)", () => {
  const { sheet, fkld } = emitFor(makeSaddleFan());

  it("origVertex −1 vertices carry defect 0 / class 'boundary'; vent edges emitted as C/vent", () => {
    const defect = fkld[KEYS.vertices.angleDefect] as number[];
    const cls = fkld[KEYS.vertices.curvatureClass] as string[];
    const synthesized = sheet.origVertex
      .map((src, i) => ({ src, i }))
      .filter((x) => x.src === -1)
      .map((x) => x.i);
    expect(synthesized.length).toBeGreaterThanOrEqual(1); // the vent split point
    for (const i of synthesized) {
      expect(defect[i]).toBe(0);
      expect(cls[i]).toBe("boundary");
    }
    const cutTypes = fkld[KEYS.edges.cutType] as (string | null)[];
    expect(cutTypes.filter((c) => c === "vent").length).toBeGreaterThanOrEqual(1);
    expect(isFkld(fkld)).toBe(true);
  });

  it("driven flags follow the sheet-boundary rule (B or C edge endpoints)", () => {
    const driven = fkld[DRIVEN_KEY] as number[];
    const expected = new Set<number>();
    sheet.edges.forEach((e, i) => {
      if (sheet.assignment[i] === "C" || sheet.assignment[i] === "B") {
        expected.add(e.a);
        expected.add(e.b);
      }
    });
    driven.forEach((d, v) => expect(d).toBe(expected.has(v) ? 1 : 0));
  });
});

describe("emitFkld — tuck annotation (octahedron)", () => {
  it("tucked vertices carry θ = δ/deg and paired widths; validators pass", () => {
    // Cut with dart strategy so it unfolds, but annotate vertex 4 as a tuck —
    // a pure unit test of the metadata path (full tuck creases deferred).
    const octa = makeOctahedron();
    const { fkld, defects, topo } = emitFor(octa, "dart", [4]);
    const theta = fkld[KEYS.edges.moleculeTheta] as (number | null)[];
    const width = fkld[KEYS.edges.moleculeWidth] as (number | null)[];
    const expected = defects.defects[4] / topo.vertexEdges[4].length;
    let annotated = 0;
    for (let e = 0; e < theta.length; e++) {
      if (theta[e] !== null) {
        expect(theta[e]!).toBeCloseTo(expected, 12);
        expect(width[e]).not.toBeNull();
        annotated++;
      } else {
        expect(width[e]).toBeNull();
      }
    }
    expect(annotated).toBeGreaterThan(0);
  });
});

// --- lip-peer key (fkld:edges_lipPeer) --------------------------------------

type LipPeer = ([number, 0 | 1] | null)[];

/**
 * Independent oracle for the emitted key: weld the foldedForm goal frame at
 * 1e-3 × span (the algorithm `sim/origami-import.ts#buildSeams` uses) and pair
 * the one-face "C" edges whose welded endpoint classes coincide.
 * TODO: switch to `lipPairsFromGoalFrame` from src/model/fold-adjacency.ts
 * once that module lands (P0-E) — it is not on disk yet.
 */
function weldedLipPairs(fkld: FoldFile, tolRel = 1e-3): { pairs: [number, number][]; cls: number[]; tol: number } {
  const goal = (fkld.file_frames as { vertices_coords: number[][] }[])[0].vertices_coords;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const g of goal) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], g[k]); hi[k] = Math.max(hi[k], g[k]); }
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = tolRel * span;

  const parent = goal.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < goal.length; i++) {
    for (let j = i + 1; j < goal.length; j++) {
      const d = Math.hypot(goal[i][0] - goal[j][0], goal[i][1] - goal[j][1], goal[i][2] - goal[j][2]);
      if (d <= tol) parent[find(i)] = find(j);
    }
  }
  const cls = goal.map((_, i) => find(i));

  const edges = fkld.edges_vertices as [number, number][];
  const assign = fkld.edges_assignment as string[];
  const faceCount = new Map<string, number>();
  for (const f of fkld.faces_vertices as number[][]) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      faceCount.set(k, (faceCount.get(k) ?? 0) + 1);
    }
  }
  const byClassPair = new Map<string, number[]>();
  edges.forEach(([a, b], e) => {
    if (assign[e] !== "C") return;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (faceCount.get(k) !== 1) return;
    const [ca, cb] = [cls[a], cls[b]].sort((x, y) => x - y);
    const key = `${ca}_${cb}`;
    byClassPair.set(key, [...(byClassPair.get(key) ?? []), e]);
  });
  const pairs: [number, number][] = [];
  for (const group of byClassPair.values()) {
    if (group.length === 2) pairs.push([group[0], group[1]]);
  }
  return { pairs, cls, tol };
}

const unordered = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

describe.each([
  ["cube", makeCube()],
  ["octahedron", makeOctahedron()],
])("emitFkld — fkld:edges_lipPeer (%s)", (_name, mesh) => {
  const { fkld } = emitFor(mesh);
  const peer = fkld[LIP_PEER_KEY] as LipPeer;
  const edges = fkld.edges_vertices as [number, number][];
  const assign = fkld.edges_assignment as string[];

  it("is parallel to edges_vertices and symmetric on C edges only", () => {
    expect(peer.length).toBe(edges.length);
    let paired = 0;
    peer.forEach((entry, e) => {
      if (entry === null) return;
      paired++;
      const [p, aligned] = entry;
      expect(assign[e]).toBe("C");
      expect([0, 1]).toContain(aligned);
      expect(p).not.toBe(e);
      expect(peer[p]).not.toBeNull();
      expect(peer[p]![0]).toBe(e);
      expect(peer[p]![1]).toBe(aligned);
    });
    expect(paired).toBeGreaterThan(0);
  });

  it("pairs exactly the goal-frame weld's pairs", () => {
    const mine = new Set<string>();
    peer.forEach((entry, e) => { if (entry !== null) mine.add(unordered(e, entry[0])); });
    const theirs = new Set(weldedLipPairs(fkld).pairs.map(([a, b]) => unordered(a, b)));
    expect([...mine].sort()).toEqual([...theirs].sort());
  });

  it("`aligned` names the vertices that meet in the goal frame", () => {
    const goal = (fkld.file_frames as { vertices_coords: number[][] }[])[0].vertices_coords;
    const { tol } = weldedLipPairs(fkld);
    const dist = (u: number, v: number): number =>
      Math.hypot(goal[u][0] - goal[v][0], goal[u][1] - goal[v][1], goal[u][2] - goal[v][2]);
    let crossedFails = 0;
    peer.forEach((entry, e) => {
      if (entry === null || entry[0] < e) return;
      const [p, aligned] = entry;
      const mate = (i: 0 | 1): number => edges[p][aligned === 1 ? i : (1 - i) as 0 | 1];
      expect(dist(edges[e][0], mate(0))).toBeLessThanOrEqual(tol);
      expect(dist(edges[e][1], mate(1))).toBeLessThanOrEqual(tol);
      // the crossed reading must not also hold, or the ordering carries nothing
      const crossed = Math.max(dist(edges[e][0], mate(1)), dist(edges[e][1], mate(0)));
      if (crossed > tol) crossedFails++;
    });
    expect(crossedFails).toBeGreaterThan(0);
  });

  it("survives parseFkld(serializeFkld(...))", () => {
    const round = parseFkld(serializeFkld(fkld)) as FoldFile;
    expect(round[LIP_PEER_KEY]).toEqual(peer);
  });
});
