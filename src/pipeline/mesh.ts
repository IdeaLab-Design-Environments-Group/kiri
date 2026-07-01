/**
 * Mesh substrate (M1): derived topology over a TriMesh.
 *
 * Pattern: functional core, immutable derived topology — `buildTopology`
 * derives adjacency from a mesh and never mutates it; any stage that changes
 * the mesh (conditioning, cutting) produces a fresh TriMesh and re-derives.
 *
 * Representation decision: ordered one-ring fans (`vertexFaces`), not a full
 * half-edge structure — the fans are all that defect math (M2) and wedge
 * splitting at cut vertices (M3) need on coarse meshes.
 *
 * Requires consistent CCW winding (run `conditioning.ts#orientFaces` first);
 * a directed edge appearing twice means inconsistent winding and throws.
 */

import { sub, cross, dot, length } from "../core/vec3.js";
import { PipelineError, type MeshEdge, type MeshTopology, type TriMesh } from "./types.js";

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Derive edges, ordered vertex fans, and boundary sets. Throws PipelineError
 * on non-manifold input: an edge with >2 faces, a duplicated directed edge
 * (inconsistent winding), or a vertex whose incident faces don't form a
 * single fan (bowtie vertex).
 */
export function buildTopology(mesh: TriMesh): MeshTopology {
  const { vertices, faces } = mesh;
  const edges: MeshEdge[] = [];
  const edgeIndex = new Map<string, number>();

  // Directed edge (v -> next(v) in face winding) → face id. Used to walk fans.
  const directed = new Map<string, number>();

  for (let f = 0; f < faces.length; f++) {
    const [i, j, k] = faces[f];
    if (i === j || j === k || k === i) {
      throw new PipelineError("mesh", `face ${f} repeats a vertex`, { face: faces[f] });
    }
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const dKey = `${a}>${b}`;
      if (directed.has(dKey)) {
        throw new PipelineError("mesh", `directed edge ${a}->${b} appears twice — inconsistent winding or non-manifold`, { faces: [directed.get(dKey), f] });
      }
      directed.set(dKey, f);
      const key = edgeKey(a, b);
      let e = edgeIndex.get(key);
      if (e === undefined) {
        e = edges.length;
        edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
        edgeIndex.set(key, e);
      }
      if (!edges[e].faces.includes(f)) edges[e].faces.push(f);
      if (edges[e].faces.length > 2) {
        throw new PipelineError("mesh", `edge ${a}-${b} has >2 incident faces — non-manifold`, { edge: e });
      }
    }
  }

  const vertexEdges: number[][] = vertices.map(() => []);
  for (let e = 0; e < edges.length; e++) {
    vertexEdges[edges[e].a].push(e);
    vertexEdges[edges[e].b].push(e);
  }

  const boundaryVertices = new Set<number>();
  for (const e of edges) {
    if (e.faces.length === 1) {
      boundaryVertices.add(e.a);
      boundaryVertices.add(e.b);
    }
  }

  // Ordered fan per vertex. In a CCW-wound face (v, a, b) the corner at v
  // spans from edge (v,a) to edge (v,b); the next face counterclockwise is
  // the one whose corner starts at (v,b), i.e. directed edge v->b.
  const vertexFaces: number[][] = vertices.map(() => []);
  const incident: number[][] = vertices.map(() => []);
  for (let f = 0; f < faces.length; f++) {
    for (const v of faces[f]) incident[v].push(f);
  }

  /** Corner of face f at vertex v: returns [next(v), prev(v)] in winding order. */
  const corner = (f: number, v: number): [number, number] => {
    const [i, j, k] = faces[f];
    if (v === i) return [j, k];
    if (v === j) return [k, i];
    return [i, j];
  };

  for (let v = 0; v < vertices.length; v++) {
    const inc = incident[v];
    if (inc.length === 0) continue; // isolated vertex tolerated here; conditioning drops them
    // Start face: for boundary vertices, the fan must start at the face whose
    // leading edge (v -> next) has no CW predecessor, i.e. directed edge
    // next->v ... we want the face whose corner's *first* edge (v,a) is a
    // boundary edge in the walking direction: no face has directed edge a->v? —
    // The CW-previous face of f at v is the face containing directed edge a->v
    // reversed: face with directed edge (v <- a) means directed.get(`${a}>${v}`).
    let start = inc[0];
    if (boundaryVertices.has(v)) {
      const starts = inc.filter((f) => {
        const [a] = corner(f, v);
        return !directed.has(`${a}>${v}`); // no CW predecessor → fan start
      });
      if (starts.length !== 1) {
        throw new PipelineError("mesh", `vertex ${v} has ${starts.length} fan starts — non-manifold (bowtie) vertex`, { vertex: v });
      }
      start = starts[0];
    }
    const fan: number[] = [];
    let f: number | undefined = start;
    const seen = new Set<number>();
    while (f !== undefined && !seen.has(f)) {
      fan.push(f);
      seen.add(f);
      const [, b] = corner(f, v);
      f = directed.get(`${v}>${b}`); // CCW-next face shares edge (v,b)
    }
    if (fan.length !== inc.length) {
      throw new PipelineError("mesh", `vertex ${v} fan covers ${fan.length}/${inc.length} faces — non-manifold (bowtie) vertex`, { vertex: v });
    }
    vertexFaces[v] = fan;
  }

  return { edges, edgeIndex, vertexFaces, vertexEdges, boundaryVertices };
}

/** Interior angles of face f at its three vertices, in face-vertex order (rad). */
export function faceAngles(mesh: TriMesh, f: number): [number, number, number] {
  const [i, j, k] = mesh.faces[f];
  const p = mesh.vertices;
  const angle = (at: number, u: number, w: number): number => {
    const e1 = sub(p[u], p[at]);
    const e2 = sub(p[w], p[at]);
    // atan2(|e1×e2|, e1·e2): numerically stable for thin triangles.
    return Math.atan2(length(cross(e1, e2)), dot(e1, e2));
  };
  return [angle(i, j, k), angle(j, k, i), angle(k, i, j)];
}

/** Euler characteristic χ = V − E + F. */
export function eulerCharacteristic(mesh: TriMesh, topo: MeshTopology): number {
  return mesh.vertices.length - topo.edges.length + mesh.faces.length;
}

/**
 * Number of connected components (faces joined through shared manifold edges). A single watertight
 * shell is 1; two disjoint closed surfaces are 2. Used by the genus gate: the Euler relation is
 * χ = 2C − 2g − b, so the single-component formula (C=1) under-reports genus as negative when the
 * mesh is actually several disjoint shells.
 */
export function countComponents(mesh: TriMesh, topo: MeshTopology): number {
  const nf = mesh.faces.length;
  if (nf === 0) return 0;
  const parent = Array.from({ length: nf }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const e of topo.edges) {
    for (let i = 1; i < e.faces.length; i++) {
      const ra = find(e.faces[0]), rb = find(e.faces[i]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const roots = new Set<number>();
  for (let f = 0; f < nf; f++) roots.add(find(f));
  return roots.size;
}

/** Length of edge e in mm. */
export function edgeLength(mesh: TriMesh, topo: MeshTopology, e: number): number {
  const { a, b } = topo.edges[e];
  return length(sub(mesh.vertices[b], mesh.vertices[a]));
}

/**
 * Split vertex v's ordered fan into wedges separated by "separator" edges
 * (cut edges and boundary edges). Returns one entry per wedge with the fan
 * faces in order and the summed interior angle at v.
 *
 * Interior vertex, no separators → a single wedge spanning the full ring.
 * Used by the M2 wedge rule (every wedge at a δ<0 vertex must span < 2π)
 * and by M3's `cutAlongEdges` (one vertex copy per wedge).
 */
export function vertexWedges(
  mesh: TriMesh,
  topo: MeshTopology,
  v: number,
  isSeparator: (edge: number) => boolean,
): { faces: number[]; angle: number }[] {
  const fan = topo.vertexFaces[v];
  if (fan.length === 0) return [];
  const angleAt = (f: number): number => {
    const idx = mesh.faces[f].indexOf(v);
    return faceAngles(mesh, f)[idx];
  };
  // Separator edge id between consecutive fan faces (shared edge through v).
  const between = (f1: number, f2: number): number => {
    const shared = mesh.faces[f1].filter((x) => mesh.faces[f2].includes(x) && x !== v);
    return topo.edgeIndex.get(edgeKey(v, shared[0]))!;
  };
  const isBoundaryVertex = topo.boundaryVertices.has(v);
  const n = fan.length;
  // Find wedge break positions: index i means "break before fan[i]".
  const breaks: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0 && isBoundaryVertex) {
      breaks.push(0); // open fan starts at a boundary edge
      continue;
    }
    const prev = fan[(i - 1 + n) % n];
    if (i === 0 && !isBoundaryVertex) {
      if (isSeparator(between(prev, fan[0]))) breaks.push(0);
      continue;
    }
    if (isSeparator(between(fan[i - 1], fan[i]))) breaks.push(i);
  }
  if (breaks.length === 0) {
    return [{ faces: [...fan], angle: fan.reduce((acc, f) => acc + angleAt(f), 0) }];
  }
  const wedges: { faces: number[]; angle: number }[] = [];
  for (let w = 0; w < breaks.length; w++) {
    const start = breaks[w];
    const end = w + 1 < breaks.length ? breaks[w + 1] : (isBoundaryVertex ? n : breaks[0] + n);
    const faces: number[] = [];
    for (let i = start; i < end; i++) faces.push(fan[i % n]);
    wedges.push({ faces, angle: faces.reduce((acc, f) => acc + angleAt(f), 0) });
  }
  return wedges;
}

/**
 * Count boundary loops by walking boundary edges. Used by the genus gate:
 * for a genus-0 surface with b boundary loops, χ = 2 − b.
 */
export function countBoundaryLoops(mesh: TriMesh, topo: MeshTopology): number {
  // vertex → boundary edges at that vertex
  const atVertex = new Map<number, number[]>();
  const boundaryEdges = new Set<number>();
  for (let e = 0; e < topo.edges.length; e++) {
    if (topo.edges[e].faces.length === 1) {
      boundaryEdges.add(e);
      for (const v of [topo.edges[e].a, topo.edges[e].b]) {
        const list = atVertex.get(v) ?? [];
        list.push(e);
        atVertex.set(v, list);
      }
    }
  }
  let loops = 0;
  const visited = new Set<number>();
  for (const e0 of boundaryEdges) {
    if (visited.has(e0)) continue;
    loops++;
    // Walk the loop.
    let e = e0;
    let v = topo.edges[e].a;
    while (!visited.has(e)) {
      visited.add(e);
      const next = topo.edges[e].a === v ? topo.edges[e].b : topo.edges[e].a;
      const candidates = (atVertex.get(next) ?? []).filter((x) => x !== e && !visited.has(x));
      if (candidates.length === 0) break;
      e = candidates[0];
      v = next;
    }
  }
  return loops;
}
