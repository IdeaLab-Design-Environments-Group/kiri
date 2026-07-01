/**
 * FOLD preprocessing — a 1:1 TypeScript port of Amanda Ghassaei's Origami Simulator
 * (`js/pattern.js`, MIT). This is the pipeline that turns a raw FOLD/FKLD crease pattern into
 * the triangulated, cut-split mesh + per-crease `creaseParams` the bar-and-hinge solver consumes.
 *
 * The two pieces that make the simulator handle **any origami AND kirigami uniformly**:
 *
 *   1. `splitCuts` — the kirigami mechanism. Every `"C"` (cut) edge is duplicated into two
 *      boundary edges and the shared vertices around each cut discontinuity are duplicated, so
 *      the two lips of a cut become topologically independent nodes that **open into a gap** as
 *      the sheet folds. (Origami Simulator `js/pattern.js:621` `splitCuts`.)
 *   2. `getFacesAndVerticesForEdges` — extracts, for each M/V/F crease, its two incident faces
 *      and their opposite "wing" vertices in a **winding-consistent order** (the reorder at
 *      `pattern.js:797`). This is what makes the measured dihedral sign reliable, so a plain
 *      forward fold (mountain → −π, valley → +π) folds correctly without any goal-mesh guidance.
 *
 * Reference for FOLD spec helpers ported here (`FOLD.convert.*` / `FOLD.filter.*`):
 * https://github.com/edemaine/fold .
 */

/** Working copy of the FOLD arrays we mutate during preprocessing. */
export interface WorkFold {
  vertices_coords: number[][];
  edges_vertices: number[][];
  edges_assignment: string[];
  /** Target dihedral per edge (radians); null for unassigned/cut/boundary. */
  edges_foldAngles: (number | null)[];
  faces_vertices: number[][];
  vertices_vertices?: number[][];
  vertices_edges?: number[][];
  vertices_faces?: number[][];
  /**
   * Provenance: `originOf[v]` is the index of the source vertex (in the ORIGINAL, pre-split fold)
   * that model vertex `v` came from. `splitCuts` duplicates vertices around cuts; this lets a
   * caller map an original-indexed declaration (e.g. a `foldedForm` goal + `fkld:vertices_driven`)
   * onto the split mesh. Identity until `processFold` runs.
   */
  originOf?: number[];
}

/** `[face1, wing1, face2, wing2, edgeIndex, targetTheta]` — Origami Simulator crease record. */
export type CreaseParams = [number, number, number, number, number, number];

// --- FOLD.convert / FOLD.filter helpers (ported) -------------------------------------------

function edgesVerticesToVerticesVerticesUnsorted(fold: WorkFold): void {
  const vv: number[][] = fold.vertices_coords.map(() => []);
  for (const [a, b] of fold.edges_vertices) {
    vv[a].push(b);
    vv[b].push(a);
  }
  fold.vertices_vertices = vv;
}

function edgesVerticesToVerticesEdges(fold: WorkFold): void {
  const ve: number[][] = fold.vertices_coords.map(() => []);
  for (let i = 0; i < fold.edges_vertices.length; i++) {
    const edge = fold.edges_vertices[i];
    ve[edge[0]].push(i);
    ve[edge[1]].push(i);
  }
  fold.vertices_edges = ve;
}

function facesVerticesToVerticesFaces(fold: WorkFold): void {
  const vf: number[][] = fold.vertices_coords.map(() => []);
  for (let i = 0; i < fold.faces_vertices.length; i++) {
    for (const v of fold.faces_vertices[i]) vf[v].push(i);
  }
  fold.vertices_faces = vf;
}

/** Reorder `vertices_edges[i]` so entry j is the edge joining i to `vertices_vertices[i][j]`. */
function sortVerticesEdges(fold: WorkFold): void {
  const vv = fold.vertices_vertices!;
  const ve = fold.vertices_edges!;
  for (let i = 0; i < vv.length; i++) {
    const verticesVertices = vv[i];
    const verticesEdges = ve[i];
    const sorted: number[] = [];
    for (let j = 0; j < verticesVertices.length; j++) {
      let index = -1;
      for (let k = 0; k < verticesEdges.length; k++) {
        const edgeIndex = verticesEdges[k];
        if (fold.edges_vertices[edgeIndex].indexOf(verticesVertices[j]) >= 0) {
          index = edgeIndex;
          break;
        }
      }
      sorted.push(index);
    }
    ve[i] = sorted;
  }
}

function connectedByFace(fold: WorkFold, verticesFaces: number[], vert1: number, vert2: number): boolean {
  if (vert1 === vert2) return false;
  for (const fi of verticesFaces) {
    const face = fold.faces_vertices[fi];
    if (face.indexOf(vert1) >= 0 && face.indexOf(vert2) >= 0) return true;
  }
  return false;
}

/**
 * Split every `"C"` cut edge into two boundary edges and duplicate the vertices around each cut
 * discontinuity, so the two sides of a cut separate freely. Direct port of `pattern.js:621`.
 */
export function splitCuts(fold: WorkFold): void {
  edgesVerticesToVerticesVerticesUnsorted(fold);
  edgesVerticesToVerticesEdges(fold);
  sortVerticesEdges(fold);
  facesVerticesToVerticesFaces(fold);

  for (let i = 0; i < fold.vertices_edges!.length; i++) {
    let groups: number[][] = [[]];
    let groupIndex = 0;
    const verticesEdges = fold.vertices_edges![i];
    const verticesFaces = fold.vertices_faces![i];

    for (let j = 0; j < verticesEdges.length; j++) {
      const edgeIndex = verticesEdges[j];
      const assignment = fold.edges_assignment[edgeIndex];
      groups[groupIndex].push(edgeIndex);
      if (assignment === "C") {
        // Split cut edge into two boundary edges.
        groups.push([fold.edges_vertices.length]);
        groupIndex++;
        const newEdgeIndex = fold.edges_vertices.length;
        const edge = fold.edges_vertices[edgeIndex];
        fold.edges_vertices.push([edge[0], edge[1]]);
        fold.edges_assignment[edgeIndex] = "B";
        fold.edges_foldAngles.push(null);
        fold.edges_assignment.push("B");
        // Add new boundary edge to the other vertex's edge list.
        let otherVertex = edge[0];
        if (otherVertex === i) otherVertex = edge[1];
        const otherVertexEdges = fold.vertices_edges![otherVertex];
        const otherVertexEdgeIndex = otherVertexEdges.indexOf(edgeIndex);
        otherVertexEdges.splice(otherVertexEdgeIndex, 0, newEdgeIndex);
      } else if (assignment === "B") {
        if (j === 0 && verticesEdges.length > 1) {
          // Check if the next edge is also boundary and not connected by a face.
          const nextEdgeIndex = verticesEdges[1];
          if (fold.edges_assignment[nextEdgeIndex] === "B") {
            const edge = fold.edges_vertices[edgeIndex];
            let otherVertex = edge[0];
            if (otherVertex === i) otherVertex = edge[1];
            const nextEdge = fold.edges_vertices[nextEdgeIndex];
            let nextVertex = nextEdge[0];
            if (nextVertex === i) nextVertex = nextEdge[1];
            if (connectedByFace(fold, verticesFaces, otherVertex, nextVertex)) {
              // same group
            } else {
              groups.push([]);
              groupIndex++;
            }
          }
        } else if (groups[groupIndex].length > 1) {
          groups.push([]);
          groupIndex++;
        }
      }
    }

    if (groups.length <= 1) continue;
    // Put the remainder of the last group at the front of the first group (wrap-around).
    for (let k = groups[groupIndex].length - 1; k >= 0; k--) {
      groups[0].unshift(groups[groupIndex][k]);
    }
    groups.pop();

    for (let j = 1; j < groups.length; j++) {
      const currentVertex = fold.vertices_coords[i];
      const vertIndex = fold.vertices_coords.length;
      fold.vertices_coords.push(currentVertex.slice());
      if (fold.originOf) fold.originOf.push(fold.originOf[i]); // duplicate inherits i's origin
      const connectingIndices: number[] = [];
      for (let k = 0; k < groups[j].length; k++) {
        const edgeIndex = groups[j][k];
        const edge = fold.edges_vertices[edgeIndex];
        let otherIndex = edge[0];
        if (edge[0] === i) {
          edge[0] = vertIndex;
          otherIndex = edge[1];
        } else {
          edge[1] = vertIndex;
        }
        connectingIndices.push(otherIndex);
      }
      if (connectingIndices.length < 2) continue;
      for (let k = 1; k < connectingIndices.length; k++) {
        const thisConnectingVertIndex = connectingIndices[k];
        const previousConnectingVertIndex = connectingIndices[k - 1];
        for (let a = 0; a < verticesFaces.length; a++) {
          const face = fold.faces_vertices[verticesFaces[a]];
          const index1 = face.indexOf(thisConnectingVertIndex);
          const index2 = face.indexOf(previousConnectingVertIndex);
          if (index1 >= 0 && index2 >= 0 && (index1 - index2 === 2 || index1 - index2 === -(face.length - 2))) {
            const b = face.indexOf(i);
            if (b >= 0) face[b] = vertIndex;
            break;
          }
        }
      }
    }
  }

  delete fold.vertices_faces;
  delete fold.vertices_edges;
  delete fold.vertices_vertices;
}

/**
 * Remove degree-2 collinear vertices that merely split an edge. Port of `pattern.js:814`, with one
 * guard: a vertex that is a **corner of a face** is never merged. Without it, a thin sliver
 * triangle (e.g. an AKDE molecule dart, whose outer corner is a near-180° degree-2 vertex after
 * `splitCuts`) gets its corner merged away, collapsing the triangle to two vertices —
 * `triangulatePolys` then silently drops it, punching a hole in the folded surface.
 */
export function removeRedundantVertices(fold: WorkFold, epsilon: number): void {
  edgesVerticesToVerticesVerticesUnsorted(fold);
  const vv = fold.vertices_vertices!;
  const inFace = new Uint8Array(fold.vertices_coords.length);
  for (const face of fold.faces_vertices) for (const v of face) inFace[v] = 1;
  const old2new: (number | null)[] = [];
  let numRedundant = 0;
  let newIndex = 0;
  for (let i = 0; i < vv.length; i++) {
    const vertexVertices = vv[i];
    if (vertexVertices.length !== 2 || inFace[i]) {
      old2new.push(newIndex++);
      continue;
    }
    const vc = fold.vertices_coords[i];
    const n0 = fold.vertices_coords[vertexVertices[0]];
    const n1 = fold.vertices_coords[vertexVertices[1]];
    const threeD = vc.length === 3;
    const vec0 = [n0[0] - vc[0], n0[1] - vc[1], threeD ? n0[2] - vc[2] : 0];
    const vec1 = [n1[0] - vc[0], n1[1] - vc[1], threeD ? n1[2] - vc[2] : 0];
    const magSq0 = vec0[0] * vec0[0] + vec0[1] * vec0[1] + vec0[2] * vec0[2];
    const magSq1 = vec1[0] * vec1[0] + vec1[1] * vec1[1] + vec1[2] * vec1[2];
    let dot = vec0[0] * vec1[0] + vec0[1] * vec1[1] + vec0[2] * vec1[2];
    dot /= Math.sqrt(magSq0 * magSq1);
    if (Math.abs(dot + 1.0) < epsilon && mergeEdge(fold, vertexVertices[0], i, vertexVertices[1])) {
      numRedundant++;
      old2new.push(null);
    } else {
      old2new.push(newIndex++);
    }
  }
  if (numRedundant === 0) return;
  remapVertices(fold, old2new);
}

/** Merge the two edges meeting at center vertex v2 into a single (v1,v3) edge. Port. */
function mergeEdge(fold: WorkFold, v1: number, v2: number, v3: number): boolean {
  let angleAvg = 0;
  let avgSum = 0;
  let edgeAssignment: string | null = null;
  const edgeIndices: number[] = [];
  for (let i = fold.edges_vertices.length - 1; i >= 0; i--) {
    const edge = fold.edges_vertices[i];
    if (edge.indexOf(v2) >= 0 && (edge.indexOf(v1) >= 0 || edge.indexOf(v3) >= 0)) {
      if (edgeAssignment === null) edgeAssignment = fold.edges_assignment[i];
      else if (edgeAssignment !== fold.edges_assignment[i]) return false;
      const angle = fold.edges_foldAngles[i];
      if (angle) {
        angleAvg += angle;
        avgSum++;
      }
      edgeIndices.push(i);
    }
  }
  for (const index of edgeIndices) {
    fold.edges_vertices.splice(index, 1);
    fold.edges_assignment.splice(index, 1);
    fold.edges_foldAngles.splice(index, 1);
  }
  fold.edges_vertices.push([v1, v3]);
  fold.edges_assignment.push(edgeAssignment as string);
  fold.edges_foldAngles.push(avgSum > 0 ? angleAvg / avgSum : null);
  const vv = fold.vertices_vertices!;
  let idx = vv[v1].indexOf(v2);
  vv[v1].splice(idx, 1);
  vv[v1].push(v3);
  idx = vv[v3].indexOf(v2);
  vv[v3].splice(idx, 1);
  vv[v3].push(v1);
  return true;
}

/** Apply an old→new vertex index remap (null = drop), updating coords/origin/edges/faces. */
function remapVertices(fold: WorkFold, old2new: (number | null)[]): void {
  const newCoords: number[][] = [];
  const newOrigin: number[] = [];
  for (let i = 0; i < fold.vertices_coords.length; i++) {
    if (old2new[i] !== null) {
      newCoords[old2new[i] as number] = fold.vertices_coords[i];
      if (fold.originOf) newOrigin[old2new[i] as number] = fold.originOf[i];
    }
  }
  fold.vertices_coords = newCoords;
  if (fold.originOf) fold.originOf = newOrigin;
  for (const edge of fold.edges_vertices) {
    edge[0] = old2new[edge[0]] as number;
    edge[1] = old2new[edge[1]] as number;
  }
  for (let i = 0; i < fold.faces_vertices.length; i++) {
    const face = fold.faces_vertices[i];
    for (let j = 0; j < face.length; j++) face[j] = old2new[face[j]] as number;
    for (let j = face.length - 1; j >= 0; j--) {
      if (face[j] === null || face[j] === undefined) face.splice(j, 1);
    }
  }
}

/**
 * Triangulate every polygon face into triangles, appending facet (`"F"`) edges for the new
 * diagonals. Triangles pass through; quads split along the shorter diagonal (Origami Simulator
 * exact); n-gons fan from vertex 0 (crease-pattern faces are convex). Port of `pattern.js:933`.
 */
export function triangulatePolys(fold: WorkFold): void {
  const vertices = fold.vertices_coords;
  const faces = fold.faces_vertices;
  const edges = fold.edges_vertices;
  const foldAngles = fold.edges_foldAngles;
  const assignments = fold.edges_assignment;
  const triangulatedFaces: number[][] = [];

  for (const face of faces) {
    if (face.length === 3) {
      triangulatedFaces.push(face);
      continue;
    }
    if (face.length === 4) {
      const d1sq = distSq(vertices[face[0]], vertices[face[2]]);
      const d2sq = distSq(vertices[face[1]], vertices[face[3]]);
      if (d2sq < d1sq) {
        edges.push([face[1], face[3]]);
        foldAngles.push(0);
        assignments.push("F");
        triangulatedFaces.push([face[0], face[1], face[3]]);
        triangulatedFaces.push([face[1], face[2], face[3]]);
      } else {
        edges.push([face[0], face[2]]);
        foldAngles.push(0);
        assignments.push("F");
        triangulatedFaces.push([face[0], face[1], face[2]]);
        triangulatedFaces.push([face[0], face[2], face[3]]);
      }
      continue;
    }

    // n-gon: fan triangulate, adding any missing edge as a facet crease (mirrors the
    // earcut branch's add-missing-edge logic in pattern.js).
    const faceEdges: number[] = [];
    for (let j = 0; j < edges.length; j++) {
      const e = edges[j];
      if (face.indexOf(e[0]) >= 0 && face.indexOf(e[1]) >= 0) faceEdges.push(j);
    }
    for (let k = 1; k + 1 < face.length; k++) {
      const tri = [face[0], face[k], face[k + 1]];
      const found = [false, false, false]; // ab, bc, ca
      for (const fe of faceEdges) {
        const e = edges[fe];
        const aI = e.indexOf(tri[0]);
        const bI = e.indexOf(tri[1]);
        const cI = e.indexOf(tri[2]);
        if (aI >= 0 && bI >= 0) found[0] = true;
        else if (aI >= 0 && cI >= 0) found[2] = true;
        else if (bI >= 0 && cI >= 0) found[1] = true;
      }
      const pairs: [number, number][] = [
        [tri[0], tri[1]],
        [tri[1], tri[2]],
        [tri[2], tri[0]],
      ];
      for (let e = 0; e < 3; e++) {
        if (found[e]) continue;
        faceEdges.push(edges.length);
        edges.push([pairs[e][0], pairs[e][1]]);
        foldAngles.push(0);
        assignments.push("F");
      }
      triangulatedFaces.push(tri);
    }
  }
  fold.faces_vertices = triangulatedFaces;
}

/**
 * For every M/V/F edge, find its two incident triangles and their opposite ("wing") vertices,
 * ordered so the dihedral sign is consistent. Port of `pattern.js:769`.
 * Returns `[face1, wing1, face2, wing2, edgeIndex, targetTheta]` per crease.
 */
export function getFacesAndVerticesForEdges(fold: WorkFold): CreaseParams[] {
  const all: CreaseParams[] = [];
  const faces = fold.faces_vertices;
  for (let i = 0; i < fold.edges_vertices.length; i++) {
    const assignment = fold.edges_assignment[i];
    if (assignment !== "M" && assignment !== "V" && assignment !== "F") continue;
    const v1 = fold.edges_vertices[i][0];
    const v2 = fold.edges_vertices[i][1];
    let params: number[] = [];
    let firstV1Index = 0;
    let firstV2Index = 0;
    let count = 0;
    for (let j = 0; j < faces.length; j++) {
      const faceVerts = [faces[j][0], faces[j][1], faces[j][2]];
      const v1Index = faceVerts.indexOf(v1);
      if (v1Index < 0) continue;
      const v2Index = faceVerts.indexOf(v2);
      if (v2Index < 0) continue;
      params.push(j);
      if (v2Index > v1Index) {
        faceVerts.splice(v2Index, 1);
        faceVerts.splice(v1Index, 1);
      } else {
        faceVerts.splice(v1Index, 1);
        faceVerts.splice(v2Index, 1);
      }
      params.push(faceVerts[0]);
      count++;
      if (count === 2) {
        // Use the SECOND face's edge winding to orient face1/face2 consistently.
        if (v2Index - v1Index === 1 || v2Index - v1Index === -2) {
          params = [params[2], params[3], params[0], params[1]];
        }
        const angle = fold.edges_foldAngles[i] ?? 0;
        all.push([params[0], params[1], params[2], params[3], i, angle]);
        break;
      }
    }
  }
  return all;
}

function distSq(a: number[], b: number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Lift 2D coords to 3D. Origami Simulator embeds the flat sheet in the x-z plane (`[x, 0, y]`);
 * we embed it in the **x-y plane (`[x, y, 0]`)** so the fold lifts along **+z**. This is a pure
 * axis relabel (physically identical) chosen to match the rest of the app: the Three.js viewer is
 * z-up and AKDE pyramids rise along z, and a declared `foldedForm` goal is authored z-up — so the
 * flat sheet and the goal share the z-up frame and the translation-only goal alignment is valid.
 */
function make3D(fold: WorkFold): void {
  for (let i = 0; i < fold.vertices_coords.length; i++) {
    const v = fold.vertices_coords[i];
    if (v.length === 2) fold.vertices_coords[i] = [v[0], v[1], 0];
  }
}

/**
 * Full preprocessing for a FOLD/FKLD crease pattern (`processFold` for FOLD imports): make 3D,
 * split cuts (if any), triangulate, then extract winding-consistent crease params. Mutates and
 * returns `fold` plus the crease records.
 */
export function processFold(
  fold: WorkFold,
  opts: { splitCuts?: boolean } = {},
): { fold: WorkFold; creaseParams: CreaseParams[] } {
  const split = opts.splitCuts ?? true;
  make3D(fold);
  fold.originOf = fold.vertices_coords.map((_v, i) => i); // identity until splitCuts duplicates
  const hasCuts = split && fold.edges_assignment.some((a) => a === "C");
  if (hasCuts) {
    splitCuts(fold);
    removeRedundantVertices(fold, 0.01);
  }
  delete fold.vertices_vertices;
  delete fold.vertices_edges;
  delete fold.vertices_faces;
  triangulatePolys(fold);
  make3D(fold);
  const creaseParams = getFacesAndVerticesForEdges(fold);
  return { fold, creaseParams };
}
