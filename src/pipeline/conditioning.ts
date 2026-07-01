/**
 * Mesh conditioning (M1): raw imported mesh → pipeline-usable target Q.
 *
 * Pattern: pipeline-of-passes with audit reports — each pass is a pure
 * `TriMesh → { mesh, report }` so the UI can show what was repaired and tests
 * can exercise passes in isolation. `condition()` composes them.
 *
 * Scope decision (v1): genus-0 only. `assertGenusZero` rejects handles —
 * 2g handle-loop cutting is deferred (no acceptance target behind it).
 * Decimation is also out of scope: acceptance targets are already coarse;
 * the pipeline documents "coarse flat-faceted input required".
 */

import { length, sub, cross } from "../core/vec3.js";
import { buildTopology, countBoundaryLoops, countComponents, eulerCharacteristic } from "./mesh.js";
import { PipelineError, type ConditionReport, type MeshTopology, type TriMesh } from "./types.js";

/** Weld key quantization: 1e-4 mm (AKDE `vid()` precedent). */
const WELD_TOL_MM = 1e-4;

/** Merge coincident vertices (position quantized to `tolMm`); drop unused vertices. */
export function weldVertices(mesh: TriMesh, tolMm = WELD_TOL_MM): { mesh: TriMesh; report: ConditionReport } {
  const key = (v: { x: number; y: number; z: number }): string =>
    `${Math.round(v.x / tolMm)},${Math.round(v.y / tolMm)},${Math.round(v.z / tolMm)}`;
  const lookup = new Map<string, number>();
  const remap: number[] = [];
  const vertices: TriMesh["vertices"] = [];
  for (const v of mesh.vertices) {
    const k = key(v);
    let id = lookup.get(k);
    if (id === undefined) {
      id = vertices.length;
      vertices.push({ ...v });
      lookup.set(k, id);
    }
    remap.push(id);
  }
  const faces = mesh.faces.map(([i, j, k]) => [remap[i], remap[j], remap[k]] as [number, number, number]);
  const changed = mesh.vertices.length - vertices.length;
  return { mesh: { vertices, faces }, report: { pass: "weld", changed } };
}

/**
 * Make face windings consistent by BFS across shared edges (two faces sharing
 * edge (a,b) must traverse it in opposite directions). Throws if the surface
 * is non-orientable. Connected-component seeds keep their first face's winding.
 */
export function orientFaces(mesh: TriMesh): { mesh: TriMesh; report: ConditionReport } {
  const faces = mesh.faces.map((f) => [...f] as [number, number, number]);
  // Undirected edge → list of face ids (lightweight; full topology comes later).
  const edgeFaces = new Map<string, number[]>();
  const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let f = 0; f < faces.length; f++) {
    const [i, j, k] = faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const list = edgeFaces.get(ekey(a, b)) ?? [];
      list.push(f);
      edgeFaces.set(ekey(a, b), list);
    }
  }
  const dirIn = (f: number, a: number, b: number): boolean => {
    // true if face f traverses a->b in its winding
    const [i, j, k] = faces[f];
    return (i === a && j === b) || (j === a && k === b) || (k === a && i === b);
  };
  const visited = new Array<boolean>(faces.length).fill(false);
  let flipped = 0;
  for (let seed = 0; seed < faces.length; seed++) {
    if (visited[seed]) continue;
    visited[seed] = true;
    const queue = [seed];
    while (queue.length > 0) {
      const f = queue.pop()!;
      const [i, j, k] = faces[f];
      for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
        for (const g of edgeFaces.get(ekey(a, b)) ?? []) {
          if (g === f) continue;
          const consistent = dirIn(g, b, a); // neighbor must traverse opposite
          if (!visited[g]) {
            if (!consistent) {
              faces[g] = [faces[g][0], faces[g][2], faces[g][1]];
              flipped++;
            }
            visited[g] = true;
            queue.push(g);
          } else if (!consistent) {
            throw new PipelineError("conditioning", "surface is non-orientable", { faces: [f, g] });
          }
        }
      }
    }
  }
  return { mesh: { vertices: mesh.vertices, faces }, report: { pass: "orient", changed: flipped } };
}

/**
 * Keep only the largest connected component (faces joined through a shared edge), dropping smaller
 * disjoint shells (stray debris, or a second body). v1 conditions a **single** watertight surface
 * — a multi-shell mesh has χ = 2C − b, which the genus formula would otherwise mis-read as a
 * negative genus. No-op for an already-connected mesh. The drop is recorded in the audit trail, not
 * silent, so a meaningfully-dropped body is visible. Runs pre-orient on the welded mesh (uses
 * undirected-edge adjacency, so winding need not be consistent yet).
 */
export function keepLargestComponent(mesh: TriMesh): { mesh: TriMesh; report: ConditionReport } {
  const nf = mesh.faces.length;
  if (nf === 0) return { mesh, report: { pass: "components", changed: 0 } };
  const parent = Array.from({ length: nf }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const ekey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const firstFaceOnEdge = new Map<string, number>();
  for (let f = 0; f < nf; f++) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = ekey(a, b);
      const prev = firstFaceOnEdge.get(key);
      if (prev === undefined) firstFaceOnEdge.set(key, f);
      else {
        const ra = find(prev), rb = find(f);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    const r = find(f);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(f);
  }
  if (groups.size <= 1) return { mesh, report: { pass: "components", changed: 0 } };

  let largest: number[] = [];
  for (const g of groups.values()) if (g.length > largest.length) largest = g;
  const keep = new Set(largest);
  const keptFaces = mesh.faces.filter((_f, i) => keep.has(i));
  const used = new Set<number>();
  for (const f of keptFaces) for (const v of f) used.add(v);
  const remap = new Map<number, number>();
  const vertices: TriMesh["vertices"] = [];
  for (let v = 0; v < mesh.vertices.length; v++) {
    if (used.has(v)) {
      remap.set(v, vertices.length);
      vertices.push(mesh.vertices[v]);
    }
  }
  const faces = keptFaces.map(([i, j, k]) => [remap.get(i)!, remap.get(j)!, remap.get(k)!] as [number, number, number]);
  const droppedFaces = nf - keptFaces.length;
  return {
    mesh: { vertices, faces },
    report: {
      pass: "components",
      changed: droppedFaces,
      notes: `kept largest of ${groups.size} components (${largest.length} faces); dropped ${groups.size - 1} (${droppedFaces} faces)`,
    },
  };
}

/** Drop zero-area faces and (then-)unreferenced vertices. */
export function dropDegenerates(mesh: TriMesh, areaEpsMm2 = 1e-8): { mesh: TriMesh; report: ConditionReport } {
  const p = mesh.vertices;
  const area2 = ([i, j, k]: [number, number, number]): number =>
    length(cross(sub(p[j], p[i]), sub(p[k], p[i])));
  const kept = mesh.faces.filter((f) => f[0] !== f[1] && f[1] !== f[2] && f[2] !== f[0] && area2(f) > 2 * areaEpsMm2);
  const used = new Set<number>();
  for (const f of kept) for (const v of f) used.add(v);
  const remap = new Map<number, number>();
  const vertices: TriMesh["vertices"] = [];
  for (let v = 0; v < p.length; v++) {
    if (used.has(v)) {
      remap.set(v, vertices.length);
      vertices.push(p[v]);
    }
  }
  const faces = kept.map(([i, j, k]) => [remap.get(i)!, remap.get(j)!, remap.get(k)!] as [number, number, number]);
  const changed = mesh.faces.length - kept.length + (p.length - vertices.length);
  return { mesh: { vertices, faces }, report: { pass: "degenerate", changed } };
}

/** Weld → degenerate-drop → keep-largest-shell → orient, with the audit trail. */
export function condition(mesh: TriMesh): { mesh: TriMesh; reports: ConditionReport[] } {
  const reports: ConditionReport[] = [];
  const w = weldVertices(mesh);
  reports.push(w.report);
  const d = dropDegenerates(w.mesh);
  reports.push(d.report);
  const c = keepLargestComponent(d.mesh);
  reports.push(c.report);
  const o = orientFaces(c.mesh);
  reports.push(o.report);
  return { mesh: o.mesh, reports };
}

/**
 * Genus gate (v1 scope): accept a single genus-0 shell only. The Euler relation for C connected
 * components is χ = 2C − 2g − b, so g = (2C − b − χ)/2. Two failure modes are distinguished (the
 * old single-component formula conflated them, mislabelling a disjoint 2-shell mesh as "genus −1"):
 *   • C > 1  → disconnected shells; v1 conditions one watertight surface (`keepLargestComponent`
 *     already reduces to the largest in `condition()`, so this fires only on a raw multi-shell mesh);
 *   • g > 0  → real handles; handle-loop cutting is deferred (`handle-cut.ts` slits them up front).
 */
export function assertGenusZero(mesh: TriMesh, topo: MeshTopology): void {
  const chi = eulerCharacteristic(mesh, topo);
  const b = countBoundaryLoops(mesh, topo);
  const components = countComponents(mesh, topo);
  const genus = (2 * components - b - chi) / 2;
  if (components > 1) {
    throw new PipelineError(
      "conditioning",
      `mesh has ${components} disconnected components (χ=${chi}, boundary loops=${b}) — v1 conditions a single watertight shell; keep the largest component`,
      { chi, boundaryLoops: b, components },
    );
  }
  if (genus > 0) {
    throw new PipelineError(
      "conditioning",
      `genus ${genus} > 0 unsupported in v1 (χ=${chi}, boundary loops=${b}) — handle-loop cutting is deferred`,
      { chi, boundaryLoops: b },
    );
  }
}
