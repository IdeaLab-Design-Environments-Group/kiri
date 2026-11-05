/**
 * countFlatOverlaps: the overlap-pair count the relief search and the vent
 * ranking minimise. Pinned against a plain all-pairs count so the x-sweep can
 * never drop or double a pair.
 */

import { describe, expect, it } from "vitest";
import { countFlatOverlaps, trianglesOverlap } from "../../../src/pipeline/flat-layout.js";
import type { Vec2 } from "../../../src/pipeline/types.js";

/** Reference: every pair, vertex-sharing pairs skipped. */
function allPairs(flat: Vec2[], faces: [number, number, number][]): number {
  let n = 0;
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[i].some((v) => faces[j].includes(v))) continue;
      if (trianglesOverlap(faces[i].map((v) => flat[v]), faces[j].map((v) => flat[v]))) n++;
    }
  }
  return n;
}

/** Deterministic LCG so the random layouts are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** `n` triangles scattered in a box; every third one reuses a vertex of the previous. */
function scatter(seed: number, n: number): { flat: Vec2[]; faces: [number, number, number][] } {
  const r = rng(seed);
  const flat: Vec2[] = [];
  const faces: [number, number, number][] = [];
  for (let f = 0; f < n; f++) {
    const cx = r() * 100;
    const cy = r() * 100;
    const base = flat.length;
    for (let k = 0; k < 3; k++) flat.push({ x: cx + (r() - 0.5) * 20, y: cy + (r() - 0.5) * 20 });
    const a = f % 3 === 2 ? faces[f - 1][0] : base;
    faces.push([a, base + 1, base + 2]);
  }
  return { flat, faces };
}

describe("countFlatOverlaps", () => {
  it("matches the all-pairs count on random layouts", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { flat, faces } = scatter(seed, 60);
      expect(countFlatOverlaps(flat, faces)).toBe(allPairs(flat, faces));
    }
  });

  it("empty and single-face layouts have no overlaps", () => {
    expect(countFlatOverlaps([], [])).toBe(0);
    expect(countFlatOverlaps([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], [[0, 1, 2]])).toBe(0);
  });

  it("counts boxes that only touch at x (equal minX/maxX) like the all-pairs scan", () => {
    // Two overlapping triangles whose x-extents are identical, plus a far one starting exactly at their maxX.
    const flat: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 },
      { x: 0, y: 1 }, { x: 10, y: 1 }, { x: 0, y: 11 },
      { x: 10, y: 50 }, { x: 20, y: 50 }, { x: 10, y: 60 },
    ];
    const faces: [number, number, number][] = [[0, 1, 2], [3, 4, 5], [6, 7, 8]];
    expect(countFlatOverlaps(flat, faces)).toBe(1);
    expect(countFlatOverlaps(flat, faces)).toBe(allPairs(flat, faces));
  });

  it("vertex-sharing pairs articulate legally and are not counted", () => {
    const flat: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 8, y: 8 }];
    expect(countFlatOverlaps(flat, [[0, 1, 2], [0, 3, 1]])).toBe(0);
  });

  it("stops at cap + 1 once the count passes the cap", () => {
    const { flat, faces } = scatter(7, 80);
    const full = countFlatOverlaps(flat, faces);
    expect(full).toBeGreaterThan(3);
    expect(countFlatOverlaps(flat, faces, 2)).toBe(3);
    expect(countFlatOverlaps(flat, faces, full)).toBe(full);
  });

  it("NaN vertices fall back to the all-pairs scan", () => {
    const { flat, faces } = scatter(3, 120);
    for (let v = 5; v < flat.length; v += 37) flat[v] = { x: Number.NaN, y: Number.NaN };
    expect(countFlatOverlaps(flat, faces)).toBe(allPairs(flat, faces));
  });
});
