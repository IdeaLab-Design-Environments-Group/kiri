/**
 * K1 vent semantics, end to end: at δ<0 vertices the unfold removes a VENT
 * sliver of Q-coverage so the flat sheet carries exactly 2π of material at
 * every interior point — the slit is zero-width in flat and opens into a
 * hole when folded. Pins the VentRecord contract, the 2π invariant, the
 * goal-frame provenance of synthesized vertices, the "vent" cut subtype on
 * the placed sheet, the multi-vent dynamic-excess arithmetic, and the
 * no-incident-slit error path.
 */

import { describe, expect, it } from "vitest";
import { condition } from "../../../src/pipeline/conditioning.js";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { kirigamize } from "../../../src/pipeline/kirigamize.js";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import { cutAlongEdges, findSelfOverlap } from "../../../src/pipeline/unfold.js";
import { pointTriangleDistance } from "../../../src/pipeline/verify.js";
import { PipelineError, type TriMesh, type UnfoldResult, type Vec2 } from "../../../src/pipeline/types.js";
import { makeDoubleSaddleFan, makeEnneper, makeSaddleFan, makeSaddleRoof } from "./fixtures/targets.js";

const TAU = 2 * Math.PI;

/** Condition a fixture exactly as kirigamize does and derive its defects. */
function conditioned(fixture: TriMesh) {
  const { mesh } = condition(fixture);
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  return { mesh, topo, defects };
}

/** Set of undirected edge keys present in a face list. */
function faceEdgeKeys(faces: [number, number, number][]): Set<string> {
  const keys = new Set<string>();
  for (const [i, j, k] of faces) {
    keys.add(edgeKey(i, j));
    keys.add(edgeKey(j, k));
    keys.add(edgeKey(k, i));
  }
  return keys;
}

/**
 * Interior vertices of a face list: vertices NOT on any boundary edge, where
 * a boundary edge is one appearing in exactly one face.
 */
function interiorVertices(faces: [number, number, number][]): Set<number> {
  const count = new Map<string, number>();
  for (const [i, j, k] of faces) {
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const onBoundary = new Set<number>();
  for (const [key, n] of count) {
    if (n === 1) for (const v of key.split("_").map(Number)) onBoundary.add(v);
  }
  const interior = new Set<number>();
  for (const f of faces) for (const v of f) if (!onBoundary.has(v)) interior.add(v);
  return interior;
}

/** Σ of flat corner angles incident to any vertex in `at` (rad). */
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

/**
 * THE 2π INVARIANT: every interior vertex of the unfolded sheet (not on any
 * boundary edge) carries exactly 2π of flat corner angle; additionally every
 * vent's source vertex carries exactly 2π summed over ALL its surviving
 * copies (its slit is zero-width, so the material around the point is whole
 * even though the copies sit on topological boundary edges). The copy-sum
 * form is what catches stale-excess multi-vent bugs: vent B must account for
 * whatever material vent A already consumed around B.
 */
function expectTwoPiInvariant(unfold: UnfoldResult): void {
  for (const v of interiorVertices(unfold.faces)) {
    expect(Math.abs(flatAngleAt(unfold.flat, unfold.faces, new Set([v])) - TAU)).toBeLessThan(1e-6);
  }
  for (const vent of unfold.vents) {
    const copies = new Set(
      unfold.origVertex
        .map((src, v) => ({ src, v }))
        .filter((x) => x.src === vent.sourceVertex)
        .map((x) => x.v),
    );
    expect(copies.size).toBeGreaterThanOrEqual(1);
    expect(Math.abs(flatAngleAt(unfold.flat, unfold.faces, copies) - TAU)).toBeLessThan(1e-6);
  }
}

/** Every vent edge of the unfold must exist as an edge of the sheet's faces. */
function expectVentEdgesOnSheet(unfold: UnfoldResult): void {
  const sheetKeys = faceEdgeKeys(unfold.faces);
  expect(unfold.vents.length).toBeGreaterThanOrEqual(1);
  for (const vent of unfold.vents) {
    expect(vent.ventEdges.length).toBeGreaterThanOrEqual(1);
    for (const [a, b] of vent.ventEdges) {
      expect(sheetKeys.has(edgeKey(a, b))).toBe(true);
    }
  }
}

describe("saddle fan — single-vent invariants", () => {
  const fixture = makeSaddleFan();
  const { defects } = conditioned(fixture);
  const center = defects.classes.indexOf("negative");
  const result = kirigamize(makeSaddleFan(), { verify: false });

  it("one connected sheet with exactly one vent of angle |δ(center)|", () => {
    expect(center).toBeGreaterThanOrEqual(0);
    expect(result.unfold.patchCount).toBe(1);
    expect(result.unfold.vents.length).toBe(1);
    expect(result.unfold.vents[0].sourceVertex).toBe(center);
    expect(Math.abs(result.unfold.vents[0].angle - Math.abs(defects.defects[center]))).toBeLessThan(1e-6);
  });

  it("ventEdges are non-empty and all present as edges of the sheet", () => {
    expectVentEdgesOnSheet(result.unfold);
  });

  it("the flat layout has no self-overlap", () => {
    expect(findSelfOverlap(result.unfold.flat, result.unfold.faces)).toBeNull();
  });

  it("THE 2π INVARIANT: every interior sheet vertex carries exactly 2π of flat material", () => {
    expectTwoPiInvariant(result.unfold);
  });

  it("zero-width slit: surviving lip pairs are coincident in flat", () => {
    // The vent may legally consume one side of a slit entirely (the survivor
    // is re-tagged as vent boundary), so the saddle fan can end with zero
    // surviving LipPairs — the coincidence contract applies to each survivor.
    for (const lip of result.unfold.lips) {
      for (const side of [0, 1] as const) {
        const a = result.unfold.flat[lip.lipA[side]];
        const b = result.unfold.flat[lip.lipB[side]];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
      }
    }
    if (result.unfold.lips.length === 0) {
      // Slit fully absorbed: the vent boundary must then touch a copy of the
      // center vertex (the orphaned lip survivor bounds the vent).
      const centerCopies = new Set(
        result.unfold.origVertex
          .map((src, v) => ({ src, v }))
          .filter((x) => x.src === center)
          .map((x) => x.v),
      );
      expect(
        result.unfold.vents[0].ventEdges.some(([a, b]) => centerCopies.has(a) || centerCopies.has(b)),
      ).toBe(true);
    }
  });
});

describe("goalPos provenance — synthesized vertices land ON Q", () => {
  it("every origVertex === −1 vertex has goalPos within 1e-6 of a conditioned-mesh face", () => {
    const { mesh } = conditioned(makeSaddleFan());
    const result = kirigamize(makeSaddleFan(), { verify: false });
    const synthesized = result.unfold.origVertex
      .map((src, v) => ({ src, v }))
      .filter((x) => x.src === -1)
      .map((x) => x.v);
    // The saddle-fan vent splits at least one face → synthesized vertices exist.
    expect(synthesized.length).toBeGreaterThanOrEqual(1);
    for (const v of synthesized) {
      const p = result.unfold.goalPos[v];
      let best = Infinity;
      for (const [i, j, k] of mesh.faces) {
        const d = pointTriangleDistance(p, mesh.vertices[i], mesh.vertices[j], mesh.vertices[k]);
        if (d < best) best = d;
      }
      expect(best).toBeLessThanOrEqual(1e-6);
    }
  });
});

describe("vent subtype flows to the placed sheet", () => {
  it('sheet has ≥1 cutType "vent" edge, exactly matching the unfold ventEdges; sheetRect = bbox + 2×margin', () => {
    const { unfold, sheet } = kirigamize(makeSaddleFan(), { verify: false });

    const sheetVentKeys = sheet.edges
      .map((edge, e) => ({ edge, e }))
      .filter((x) => sheet.cutType[x.e] === "vent")
      .map((x) => edgeKey(x.edge.a, x.edge.b))
      .sort();
    expect(sheetVentKeys.length).toBeGreaterThanOrEqual(1);

    const unfoldVentKeys = [
      ...new Set(unfold.vents.flatMap((vt) => vt.ventEdges.map(([a, b]) => edgeKey(a, b)))),
    ].sort();
    expect(sheetVentKeys).toEqual(unfoldVentKeys);

    // sheetRect = flat bbox + 2×margin in each dimension
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of unfold.flat) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const m = sheet.sheetRect.marginMm;
    expect(sheet.sheetRect.widthMm).toBeCloseTo(maxX - minX + 2 * m, 9);
    expect(sheet.sheetRect.heightMm).toBeCloseTo(maxY - minY + 2 * m, 9);
  });
});

describe("double saddle fan — multi-vent dynamic excess", () => {
  it("fixture sanity: both interior vertices have δ < 0 and share two faces", () => {
    const fixture = makeDoubleSaddleFan();
    const { mesh, defects } = conditioned(fixture);
    expect(defects.classes[0]).toBe("negative");
    expect(defects.classes[1]).toBe("negative");
    // strongly negative, not an epsilon artifact (≈ −1.124 rad each)
    expect(defects.defects[0]).toBeLessThan(-0.5);
    expect(defects.defects[1]).toBeLessThan(-0.5);
    const shared = mesh.faces.filter((f) => f.includes(0) && f.includes(1));
    expect(shared.length).toBe(2);
  });

  it("kirigamize: one sheet, TWO vents, 2π invariant everywhere, no self-overlap", () => {
    const result = kirigamize(makeDoubleSaddleFan(), { verify: false });
    expect(result.unfold.patchCount).toBe(1);
    expect(result.unfold.vents.length).toBe(2);
    expect(new Set(result.unfold.vents.map((vt) => vt.sourceVertex))).toEqual(new Set([0, 1]));
    // THE dynamic-excess regression: vent B must account for the material
    // vent A already consumed around B — stale |δ| arithmetic breaks 2π here.
    expectTwoPiInvariant(result.unfold);
    expect(findSelfOverlap(result.unfold.flat, result.unfold.faces)).toBeNull();
  });
});

// awaiting unfold connectivity fix — these currently throw inside seamedUnfold;
// the assertions below are their final form and must go green once the
// parallel connectivity fix lands. Do not skip.
describe("saddle roof + Enneper — many-vent invariants", () => {
  it("saddle roof: one sheet, ≥7 vents, 2π everywhere, no overlap, ventEdges on sheet", () => {
    const result = kirigamize(makeSaddleRoof(), { verify: false });
    expect(result.unfold.patchCount).toBe(1);
    expect(result.unfold.vents.length).toBeGreaterThanOrEqual(7);
    expectTwoPiInvariant(result.unfold);
    expect(findSelfOverlap(result.unfold.flat, result.unfold.faces)).toBeNull();
    expectVentEdgesOnSheet(result.unfold);
  });

  it("Enneper patch: one sheet, ≥7 vents, 2π everywhere, no overlap, ventEdges on sheet", () => {
    const result = kirigamize(makeEnneper(), { verify: false });
    expect(result.unfold.patchCount).toBe(1);
    expect(result.unfold.vents.length).toBeGreaterThanOrEqual(7);
    expectTwoPiInvariant(result.unfold);
    expect(findSelfOverlap(result.unfold.flat, result.unfold.faces)).toBeNull();
    expectVentEdgesOnSheet(result.unfold);
  });
});

describe("error path — vent vertex with no incident slit", () => {
  it("cutAlongEdges with cutEdges=[] and a vent angle throws PipelineError(unfold)", () => {
    const { mesh, topo, defects } = conditioned(makeSaddleFan());
    const center = defects.classes.indexOf("negative");
    expect(center).toBeGreaterThanOrEqual(0);
    const ventAngles = new Map([[center, Math.abs(defects.defects[center])]]);
    expect(() => cutAlongEdges(mesh, topo, [], ventAngles)).toThrow(PipelineError);
    expect(() => cutAlongEdges(mesh, topo, [], ventAngles)).toThrow(/no incident slit|cut-degree 0/);
  });
});
