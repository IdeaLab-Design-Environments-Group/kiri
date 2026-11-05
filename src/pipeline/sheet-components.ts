/**
 * Connected pieces of a cut sheet: face-connectivity over shared edges.
 *
 * Pattern: functional core. The relief search labels a trial sheet thousands
 * of times per pass, so this is one union-find pass with no string edge keys.
 */

import type { TriMesh } from "./types.js";

/**
 * Face-connectivity labeling over shared edges of a TriMesh. Labels are
 * canonical: components are numbered in order of their lowest face index.
 */
export function labelComponents(mesh: TriMesh): { count: number; label: number[] } {
  const { faces } = mesh;
  const n = faces.length;
  const parent: number[] = [];
  for (let f = 0; f < n; f++) parent.push(f);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  // First face seen on each undirected edge (numeric key); later faces on it join that face.
  const span = mesh.vertices.length + 1;
  const firstOnEdge = new Map<number, number>();
  for (let f = 0; f < n; f++) {
    const t = faces[f];
    for (let s = 0; s < 3; s++) {
      const a = t[s];
      const b = t[s === 2 ? 0 : s + 1];
      const key = a < b ? a * span + b : b * span + a;
      const g = firstOnEdge.get(key);
      if (g === undefined) {
        firstOnEdge.set(key, f);
        continue;
      }
      const ra = find(g);
      const rb = find(f);
      if (ra !== rb) parent[ra > rb ? ra : rb] = ra > rb ? rb : ra; // root = lowest face index
    }
  }
  const label: number[] = [];
  let count = 0;
  for (let f = 0; f < n; f++) {
    const r = find(f);
    label.push(r === f ? count++ : label[r]);
  }
  return { count, label };
}
