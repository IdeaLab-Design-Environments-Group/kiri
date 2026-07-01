import { describe, expect, it } from "vitest";
import {
  PatternGrid,
  gridToFold,
  presetAccordion,
  presetWaterbomb,
  presetCutWindow,
  type FoldDraft,
} from "../../src/model/pattern-grid.js";

/** Canonical undirected edge key. */
const ek = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Every triangle edge → how many faces use it (1 = boundary, 2 = interior manifold). */
function faceEdgeCounts(draft: FoldDraft): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of draft.faces_vertices) {
    expect(f).toHaveLength(3); // always triangulated
    for (let i = 0; i < 3; i++) {
      const k = ek(f[i], f[(i + 1) % 3]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

/** Assert the draft is a valid triangulated 2-manifold whose emitted edges match its faces. */
function assertManifold(draft: FoldDraft): void {
  const nV = draft.vertices_coords.length;
  for (const f of draft.faces_vertices)
    for (const v of f) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(nV);

  // Parallel arrays stay aligned.
  expect(draft.edges_assignment).toHaveLength(draft.edges_vertices.length);
  expect(draft.cutType).toHaveLength(draft.edges_vertices.length);

  const emitted = new Set(draft.edges_vertices.map(([a, b]) => ek(a, b)));
  expect(emitted.size).toBe(draft.edges_vertices.length); // no duplicate edges

  const fc = faceEdgeCounts(draft);
  // Every emitted edge is a real triangle edge, and every triangle edge was emitted.
  for (const k of emitted) expect(fc.has(k)).toBe(true);
  for (const k of fc.keys()) expect(emitted.has(k)).toBe(true);
  // No edge is shared by more than two faces (a clean 2-manifold).
  for (const n of fc.values()) expect(n).toBeLessThanOrEqual(2);
}

describe("pattern-grid: gridToFold", () => {
  it("a blank N×M grid is two triangles per cell, all corners on the lattice", () => {
    const g = new PatternGrid(3, 4, 10);
    const d = gridToFold(g);
    expect(d.vertices_coords).toHaveLength((3 + 1) * (4 + 1)); // no centre vertices
    expect(d.faces_vertices).toHaveLength(2 * 3 * 4);
    assertManifold(d);
  });

  it("bare cells default to B on the perimeter and F inside", () => {
    const d = gridToFold(new PatternGrid(2, 2, 10));
    const fc = faceEdgeCounts(d);
    for (let i = 0; i < d.edges_vertices.length; i++) {
      const [a, b] = d.edges_vertices[i];
      const onBoundary = fc.get(ek(a, b)) === 1;
      // A bare grid has only B (boundary) and F (interior facet/diagonal) edges.
      if (onBoundary) expect(d.edges_assignment[i]).toBe("B");
      else expect(d.edges_assignment[i]).toBe("F");
    }
    expect(d.counts.M).toBe(0);
    expect(d.counts.V).toBe(0);
    expect(d.counts.C).toBe(0);
  });

  it("a painted vertical mountain survives into the draft as M", () => {
    const g = new PatternGrid(2, 2, 10);
    const a = g.vid(1, 0);
    const b = g.vid(1, 1);
    g.set(a, b, "M");
    const d = gridToFold(g);
    const idx = d.edges_vertices.findIndex(([x, y]) => ek(x, y) === ek(a, b));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(d.edges_assignment[idx]).toBe("M");
    expect(d.counts.M).toBe(1);
    assertManifold(d);
  });

  it("a cell with both diagonals creased gains a centre vertex and four triangles", () => {
    const g = new PatternGrid(1, 1, 10);
    g.set(g.vid(0, 1), g.vid(1, 0), "V"); // "\"
    g.set(g.vid(0, 0), g.vid(1, 1), "M"); // "/"
    const d = gridToFold(g);
    expect(d.vertices_coords).toHaveLength(4 + 1); // 4 corners + 1 centre
    expect(d.faces_vertices).toHaveLength(4);
    expect(d.counts.M).toBe(2); // "/" split into two half-edges through the centre
    expect(d.counts.V).toBe(2);
    assertManifold(d);
  });

  it("cut edges carry the 'seam' FKLD subtype", () => {
    const g = new PatternGrid(3, 3, 10);
    presetCutWindow(g);
    const d = gridToFold(g);
    expect(d.counts.C).toBeGreaterThan(0);
    for (let i = 0; i < d.edges_assignment.length; i++) {
      if (d.edges_assignment[i] === "C") expect(d.cutType[i]).toBe("seam");
      else expect(d.cutType[i]).toBeNull();
    }
    assertManifold(d);
  });

  it("presets stay manifold and produce real creases", () => {
    for (const preset of [presetAccordion, presetWaterbomb]) {
      const g = new PatternGrid(5, 5, 10);
      preset(g);
      const d = gridToFold(g);
      assertManifold(d);
      expect(d.counts.M + d.counts.V).toBeGreaterThan(0);
    }
    // Waterbomb creases every diagonal → centre vertex per cell.
    const wb = new PatternGrid(5, 5, 10);
    presetWaterbomb(wb);
    const d = gridToFold(wb);
    expect(d.vertices_coords.length).toBe((5 + 1) * (5 + 1) + 5 * 5);
    expect(d.faces_vertices).toHaveLength(4 * 5 * 5);
  });
});
