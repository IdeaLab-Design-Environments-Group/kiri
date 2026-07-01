/**
 * 1:1 TypeScript port of Amanda Ghassaei's Origami Simulator SVG importer
 * (`OrigamiSimulator-master/js/pattern.js` `loadSVG`/`parseSVG`, plus the FOLD-library graph ops
 * it calls from `dependencies/fold.js`). This is the missing front half of the engine: it turns a
 * raw Origami Simulator crease-pattern **SVG** into a FOLD/FKLD object with faces, which the
 * existing physics port (`fold-ops.ts` → `origami-import.ts` → `solver.ts`) then folds. With it,
 * the engine can simulate **anything** drawn in the Origami Simulator SVG convention — the
 * Miyamoto RES square tower (`assets/Kirigami/miyamotoTower.svg`) being the worked example.
 *
 * Faithful to the original:
 *   - Stroke COLOUR → assignment (pattern.js `typeForStroke`): black B, red M, blue V, green C,
 *     yellow F (triangulation), magenta U (hinge).
 *   - Stroke OPACITY → target fold angle (pattern.js `mountainFilter`/`valleyFilter`):
 *     mountain θ = −opacity·π, valley θ = +opacity·π. So opacity 0.5 ⇒ ±90°, opacity 1 ⇒ ±180°.
 *   - The exact `parseSVG` clean-up + topology pipeline: collapseNearbyVertices(vertTol=3) →
 *     removeLoopEdges → removeDuplicateEdges → findIntersections → (repeat clean-up) →
 *     edges→vertices_vertices → removeStrayVertices → removeRedundantVertices(0.01) →
 *     sort_vertices_vertices (CCW) → vertices_vertices_to_faces_vertices → removeBorderFaces →
 *     reverseFaceOrder.
 *
 * No DOM and no Three.js, so it runs in the browser (drag-drop an SVG) **and** headless in
 * vitest/vite-node (used to regenerate `public/examples/res-square-tower.fkld` from the OS asset).
 * The downstream `processFold` (splitCuts/triangulate) and `assembleModel` are unchanged.
 */
import type { FoldFile } from "../model/fold-file.js";

// --- Working FOLD structure (2D until handed downstream) ---------------------------------------
interface Fold {
  vertices_coords: number[][]; // [x, y] in SVG units
  edges_vertices: number[][];
  edges_assignment: string[]; // B/M/V/C/F/U
  edges_foldAngles: (number | null)[]; // radians (OS convention); null for B/C/U
  vertices_vertices?: number[][];
  vertices_edges?: number[][];
  faces_vertices?: number[][];
}

const PI = Math.PI;
const modulo = (a: number, b: number): number => ((a % b) + b) % b;
const next = (i: number, n: number): number => (i + 1) % n;

/** Default vertex merge tolerance, in SVG units (globals.js `vertTol: 3`). */
export const DEFAULT_VERT_TOL = 3;

// ===============================================================================================
// SVG parsing — colour→assignment, opacity→angle, element→segments (pattern.js:66–338)
// ===============================================================================================

type EdgeType = "border" | "mountain" | "valley" | "cut" | "triangulation" | "hinge";

/** pattern.js `typeForStroke`: map a normalized stroke colour to a crease type (null = ignored). */
function typeForStroke(stroke: string | null): EdgeType | null {
  if (stroke == null) return null;
  const s = stroke.replace(/\s/g, "").toLowerCase();
  if (s === "#000000" || s === "#000" || s === "black" || s === "rgb(0,0,0)") return "border";
  if (s === "#ff0000" || s === "#f00" || s === "red" || s === "rgb(255,0,0)") return "mountain";
  if (s === "#0000ff" || s === "#00f" || s === "blue" || s === "rgb(0,0,255)") return "valley";
  if (s === "#00ff00" || s === "#0f0" || s === "green" || s === "rgb(0,255,0)") return "cut";
  if (s === "#ffff00" || s === "#ff0" || s === "yellow" || s === "rgb(255,255,0)") return "triangulation";
  if (s === "#ff00ff" || s === "#f0f" || s === "magenta" || s === "rgb(255,0,255)") return "hinge";
  return null;
}

/** Parse `key="value"` attributes (and inline `style="a:b;c:d"`) from one element's opening tag. */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) attrs[m[1].toLowerCase()] = m[2];
  if (attrs.style) {
    for (const decl of attrs.style.split(";")) {
      const idx = decl.indexOf(":");
      if (idx > 0) attrs[decl.slice(0, idx).trim().toLowerCase()] = decl.slice(idx + 1).trim();
    }
  }
  return attrs;
}

/** pattern.js `getStroke`: attribute, then inline `style`. */
function getStroke(attrs: Record<string, string>): string | null {
  return attrs.stroke ?? null;
}

/** pattern.js `getOpacity`: opacity → style.opacity → stroke-opacity → style.stroke-opacity → 1. */
function getOpacity(attrs: Record<string, string>): number {
  let o = attrs.opacity ?? attrs["stroke-opacity"];
  const f = parseFloat(o ?? "");
  return Number.isNaN(f) ? 1 : f;
}

/** Target fold angle a mountain/valley element encodes in its opacity (pattern.js:75,85). */
function targetAngleFor(type: EdgeType, opacity: number): number | undefined {
  if (type === "mountain") return -opacity * PI;
  if (type === "valley") return opacity * PI;
  return undefined;
}

interface Segment {
  a: number; // vertex index into vertsRaw
  b: number;
  angle?: number; // radians, for M/V
}

const numbersIn = (s: string): number[] => (s.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

/** Parse a `<path d="…">` into segments (pattern.js `parsePath`: M/m L/l H/h V/v Z/z). */
function parsePath(d: string, angle: number | undefined, vertsRaw: number[][], out: Segment[]): void {
  const tokens = d.match(/[MmLlHhVvZzCcSsQqTtAa][^MmLlHhVvZzCcSsQqTtAa]*/g);
  if (!tokens) return;
  let cur: [number, number] = [0, 0];
  let curIdx = -1;
  let startIdx = -1;
  const pushVert = (x: number, y: number): number => {
    cur = [x, y];
    vertsRaw.push([x, y]);
    return vertsRaw.length - 1;
  };
  const lineTo = (x: number, y: number): void => {
    const ni = pushVert(x, y);
    out.push({ a: curIdx, b: ni, angle });
    curIdx = ni;
  };
  for (const tok of tokens) {
    const cmd = tok[0];
    const v = numbersIn(tok.slice(1));
    switch (cmd) {
      case "M":
        curIdx = pushVert(v[0], v[1]);
        startIdx = curIdx;
        for (let i = 2; i + 1 < v.length; i += 2) lineTo(v[i], v[i + 1]); // implicit L
        break;
      case "m":
        curIdx = pushVert(cur[0] + v[0], cur[1] + v[1]);
        startIdx = curIdx;
        for (let i = 2; i + 1 < v.length; i += 2) lineTo(cur[0] + v[i], cur[1] + v[i + 1]);
        break;
      case "L":
        for (let i = 0; i + 1 < v.length; i += 2) lineTo(v[i], v[i + 1]);
        break;
      case "l":
        for (let i = 0; i + 1 < v.length; i += 2) lineTo(cur[0] + v[i], cur[1] + v[i + 1]);
        break;
      case "H":
        for (const x of v) lineTo(x, cur[1]);
        break;
      case "h":
        for (const dx of v) lineTo(cur[0] + dx, cur[1]);
        break;
      case "V":
        for (const y of v) lineTo(cur[0], y);
        break;
      case "v":
        for (const dy of v) lineTo(cur[0], cur[1] + dy);
        break;
      case "Z":
      case "z":
        if (startIdx >= 0 && curIdx !== startIdx) out.push({ a: curIdx, b: startIdx, angle });
        curIdx = startIdx;
        break;
      // Curves are not part of the crease-pattern convention; treat endpoint as a lineto so the
      // graph stays connected rather than dropping the segment.
      default: {
        if (v.length >= 2) lineTo(v[v.length - 2], v[v.length - 1]);
        break;
      }
    }
  }
}

/** Parse all simple SVG primitives of one element type into raw segments + shared vertices. */
function parseElement(
  tag: string,
  attrs: Record<string, string>,
  type: EdgeType,
  angle: number | undefined,
  vertsRaw: number[][],
  out: Segment[],
): void {
  const push = (x: number, y: number): number => {
    vertsRaw.push([x, y]);
    return vertsRaw.length - 1;
  };
  switch (tag) {
    case "line": {
      const a = push(Number(attrs.x1), Number(attrs.y1));
      const b = push(Number(attrs.x2), Number(attrs.y2));
      out.push({ a, b, angle });
      break;
    }
    case "rect": {
      const x = Number(attrs.x), y = Number(attrs.y);
      const w = Number(attrs.width), h = Number(attrs.height);
      const p0 = push(x, y), p1 = push(x + w, y), p2 = push(x + w, y + h), p3 = push(x, y + h);
      out.push({ a: p0, b: p1, angle }, { a: p1, b: p2, angle }, { a: p2, b: p3, angle }, { a: p3, b: p0, angle });
      break;
    }
    case "polygon":
    case "polyline": {
      const nums = numbersIn(attrs.points ?? "");
      const idx: number[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) idx.push(push(nums[i], nums[i + 1]));
      for (let i = 0; i + 1 < idx.length; i++) out.push({ a: idx[i], b: idx[i + 1], angle });
      if (tag === "polygon" && idx.length > 2) out.push({ a: idx[idx.length - 1], b: idx[0], angle });
      break;
    }
    case "path":
      parsePath(attrs.d ?? "", angle, vertsRaw, out);
      break;
  }
  void type;
}

/** loadSVG step 1: read the SVG text into raw vertices + per-type segment buckets.
 *  `includePaths=false` skips `<path>` elements (the dashed corner creases Illustrator emits as
 *  paths) — reproducing a line-only import like the original offline `svg2fold.py`. */
function readSvg(svgText: string, includePaths = true): { verts: number[][]; buckets: Record<EdgeType, Segment[]> } {
  const verts: number[][] = [];
  const buckets: Record<EdgeType, Segment[]> = {
    border: [], mountain: [], valley: [], cut: [], triangulation: [], hinge: [],
  };
  const elementRe = /<(line|rect|polygon|polyline|path)\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(svgText)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag === "path" && !includePaths) continue;
    const attrs = parseAttrs(m[2]);
    const type = typeForStroke(getStroke(attrs));
    if (type == null) continue;
    const angle = targetAngleFor(type, getOpacity(attrs));
    parseElement(tag, attrs, type, angle, verts, buckets[type]);
  }
  return { verts, buckets };
}

// ===============================================================================================
// FOLD-library graph ops (dependencies/fold.js) + pattern.js helpers, ported faithfully
// ===============================================================================================

const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1]];
const ang2D = (a: number[]): number => Math.atan2(a[1], a[0]);

/** geom.twiceSignedArea / polygonOrientation (fold.js:885,899). */
function polygonOrientation(points: number[][]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const v0 = points[i], v1 = points[next(i, points.length)];
    s += v0[0] * v1[1] - v1[0] * v0[1];
  }
  return Math.sign(s);
}

/** filter.collapseNearbyVertices (fold.js:461) via the RepeatedPointsDS hash grid (fold.js:392). */
function collapseNearbyVertices(fold: Fold, epsilon: number): void {
  const coords: number[][] = [];
  const hash = new Map<string, number[]>();
  const key = (x: number, y: number): string => `${Math.round(x / epsilon)},${Math.round(y / epsilon)}`;
  const dist = (p: number[], q: number[]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const lookup = (c: number[]): number | null => {
    const xr = Math.round(c[0] / epsilon), yr = Math.round(c[1] / epsilon);
    for (const xt of [xr, xr - 1, xr + 1]) {
      for (const yt of [yr, yr - 1, yr + 1]) {
        for (const v of hash.get(`${xt},${yt}`) ?? []) {
          if (epsilon > dist(coords[v], c)) return v;
        }
      }
    }
    return null;
  };
  const insert = (c: number[]): number => {
    const found = lookup(c);
    if (found != null) return found;
    const v = coords.length;
    coords.push(c);
    const k = key(c[0], c[1]);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k)!.push(v);
    return v;
  };
  const old2new = fold.vertices_coords.map((c) => insert(c));
  fold.vertices_coords = coords;
  for (const e of fold.edges_vertices) {
    e[0] = old2new[e[0]];
    e[1] = old2new[e[1]];
  }
}

/** filter.removeLoopEdges (fold.js:477): drop zero-length edges. */
function removeLoopEdges(fold: Fold): void {
  keepEdges(fold, fold.edges_vertices.map((e) => e[0] !== e[1]));
}

/** filter.removeDuplicateEdges_vertices (fold.js:354): collapse coincident (undirected) edges. */
function removeDuplicateEdges(fold: Fold): void {
  const seen = new Set<string>();
  keepEdges(
    fold,
    fold.edges_vertices.map(([v, w]) => {
      const k = v < w ? `${v},${w}` : `${w},${v}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  );
}

/** Subset edge arrays in place (filter.remapFieldSubset for the `edges` field). */
function keepEdges(fold: Fold, keep: boolean[]): void {
  const ev: number[][] = [], ea: string[] = [], ef: (number | null)[] = [];
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    ev.push(fold.edges_vertices[i]);
    ea.push(fold.edges_assignment[i]);
    ef.push(fold.edges_foldAngles[i]);
  }
  fold.edges_vertices = ev;
  fold.edges_assignment = ea;
  fold.edges_foldAngles = ef;
}

/** pattern.js `line_intersect` (Paul Bourke) — returns intersection params t1,t2 or null. */
function lineIntersect(
  v1: number[], v2: number[], v3: number[], v4: number[],
): { x: number; y: number; t1: number; t2: number } | null {
  const [x1, y1] = v1, [x2, y2] = v2, [x3, y3] = v3, [x4, y4] = v4;
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return null;
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  return { x: x1 + ua * (x2 - x1), y: y1 + ua * (y2 - y1), t1: ua, t2: ub };
}

const getDistFromEnd = (t: number, length: number, tol: number): number | null => {
  const dist = t * length;
  if (dist < -tol) return null;
  if (dist > length + tol) return null;
  return dist;
};

/** pattern.js `findIntersections` (1065): split edges that cross in their interior, adding a vertex. */
function findIntersections(fold: Fold, tol: number): void {
  const verts = fold.vertices_coords;
  const edges = fold.edges_vertices;
  const fa = fold.edges_foldAngles;
  const asg = fold.edges_assignment;
  for (let i = edges.length - 1; i >= 0; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const v1 = verts[edges[i][0]], v2 = verts[edges[i][1]];
      const v3 = verts[edges[j][0]], v4 = verts[edges[j][1]];
      const data = lineIntersect(v1, v2, v3, v4);
      if (!data) continue;
      const length1 = Math.hypot(v2[0] - v1[0], v2[1] - v1[1]);
      const length2 = Math.hypot(v4[0] - v3[0], v4[1] - v3[1]);
      const d1 = getDistFromEnd(data.t1, length1, tol);
      const d2 = getDistFromEnd(data.t2, length2, tol);
      if (d1 === null || d2 === null) continue;
      const seg1Int = d1 > tol && d1 < length1 - tol;
      const seg2Int = d2 > tol && d2 < length2 - tol;
      if (!seg1Int && !seg2Int) continue;
      let vertIndex: number;
      if (seg1Int && seg2Int) {
        vertIndex = verts.length;
        verts.push([data.x, data.y]);
      } else if (seg1Int) {
        vertIndex = d2 <= tol ? edges[j][0] : edges[j][1];
      } else {
        vertIndex = d1 <= tol ? edges[i][0] : edges[i][1];
      }
      if (seg1Int) {
        const a = fa[i], s = asg[i];
        edges.splice(i, 1, [vertIndex, edges[i][0]], [vertIndex, edges[i][1]]);
        fa.splice(i, 1, a, a);
        asg.splice(i, 1, s, s);
        i++;
      }
      if (seg2Int) {
        const a = fa[j], s = asg[j];
        edges.splice(j, 1, [vertIndex, edges[j][0]], [vertIndex, edges[j][1]]);
        fa.splice(j, 1, a, a);
        asg.splice(j, 1, s, s);
        j++;
        i++;
      }
    }
  }
}

/** filter.edges_vertices_to_vertices_vertices (fold.js:578) — unsorted adjacency. */
function buildVerticesVertices(fold: Fold): void {
  const vv: number[][] = fold.vertices_coords.map(() => []);
  for (const [v, w] of fold.edges_vertices) {
    vv[v].push(w);
    vv[w].push(v);
  }
  fold.vertices_vertices = vv;
}

/** pattern.js `removeStrayVertices` (914): drop vertices with no incident edges, then remap. */
function removeStrayVertices(fold: Fold): void {
  const vv = fold.vertices_vertices!;
  const old2new: (number | null)[] = [];
  let newIndex = 0;
  let strays = 0;
  for (let i = 0; i < vv.length; i++) {
    if (vv[i] === undefined || vv[i].length === 0) {
      strays++;
      old2new.push(null);
    } else old2new.push(newIndex++);
  }
  if (strays === 0) return;
  remapVertices(fold, old2new);
}

/** pattern.js `removeRedundantVertices` (814): merge degree-2 collinear vertices. */
function removeRedundantVertices(fold: Fold, epsilon: number): void {
  const vv = fold.vertices_vertices!;
  const old2new: (number | null)[] = [];
  let newIndex = 0;
  let numRedundant = 0;
  for (let i = 0; i < vv.length; i++) {
    const nbrs = vv[i];
    if (!nbrs || nbrs.length !== 2) {
      old2new.push(newIndex++);
      continue;
    }
    const vc = fold.vertices_coords[i];
    const n0 = fold.vertices_coords[nbrs[0]];
    const n1 = fold.vertices_coords[nbrs[1]];
    const vec0 = [n0[0] - vc[0], n0[1] - vc[1]];
    const vec1 = [n1[0] - vc[0], n1[1] - vc[1]];
    const mag0 = vec0[0] * vec0[0] + vec0[1] * vec0[1];
    const mag1 = vec1[0] * vec1[0] + vec1[1] * vec1[1];
    let dot = vec0[0] * vec1[0] + vec0[1] * vec1[1];
    dot /= Math.sqrt(mag0 * mag1);
    if (Math.abs(dot + 1.0) < epsilon && mergeEdge(fold, nbrs[0], i, nbrs[1])) {
      numRedundant++;
      old2new.push(null);
    } else old2new.push(newIndex++);
  }
  if (numRedundant === 0) return;
  remapVertices(fold, old2new);
}

/** pattern.js `mergeEdge` (867): replace the two edges at center v2 with a single (v1,v3) edge. */
function mergeEdge(fold: Fold, v1: number, v2: number, v3: number): boolean {
  let angleAvg = 0, avgSum = 0;
  const angles: (number | null)[] = [];
  let edgeAssignment: string | null = null;
  const edgeIndices: number[] = [];
  for (let i = fold.edges_vertices.length - 1; i >= 0; i--) {
    const e = fold.edges_vertices[i];
    if (e.indexOf(v2) >= 0 && (e.indexOf(v1) >= 0 || e.indexOf(v3) >= 0)) {
      if (edgeAssignment === null) edgeAssignment = fold.edges_assignment[i];
      else if (edgeAssignment !== fold.edges_assignment[i]) return false; // different assignments
      const angle = fold.edges_foldAngles[i];
      angles.push(angle);
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
  fold.edges_assignment.push(edgeAssignment!);
  fold.edges_foldAngles.push(avgSum > 0 ? angleAvg / avgSum : null);
  const vv = fold.vertices_vertices!;
  vv[v1].splice(vv[v1].indexOf(v2), 1);
  vv[v1].push(v3);
  vv[v3].splice(vv[v3].indexOf(v2), 1);
  vv[v3].push(v1);
  return true;
}

/** Remap/drop vertices by old→new (null = drop). Updates coords + edge endpoints; vv recomputed. */
function remapVertices(fold: Fold, old2new: (number | null)[]): void {
  const newCoords: number[][] = [];
  for (let i = 0; i < old2new.length; i++) {
    const j = old2new[i];
    if (j != null) newCoords[j] = fold.vertices_coords[i];
  }
  fold.vertices_coords = newCoords;
  for (const e of fold.edges_vertices) {
    if (old2new[e[0]] != null) e[0] = old2new[e[0]]!;
    if (old2new[e[1]] != null) e[1] = old2new[e[1]]!;
  }
  delete fold.vertices_vertices; // stale after a remap; callers recompute
}

/** convert.sort_vertices_vertices (fold.js:30): CCW order each vertex's neighbours by angle. */
function sortVerticesVertices(fold: Fold): void {
  const vv = fold.vertices_vertices!;
  fold.vertices_vertices = vv.map((nbrs, v) => {
    const origin = fold.vertices_coords[v];
    return nbrs.slice().sort((p, q) => ang2D(sub(fold.vertices_coords[p], origin)) - ang2D(sub(fold.vertices_coords[q], origin)));
  });
}

/** convert.vertices_vertices_to_faces_vertices (fold.js:56): trace CCW faces of the planar graph. */
function verticesVerticesToFaces(fold: Fold): void {
  const vv = fold.vertices_vertices!;
  const nextMap = new Map<string, number | null>();
  for (let v = 0; v < vv.length; v++) {
    const nbrs = vv[v];
    for (let i = 0; i < nbrs.length; i++) {
      nextMap.set(`${nbrs[i]},${v}`, nbrs[modulo(i - 1, nbrs.length)]);
    }
  }
  const faces: number[][] = [];
  for (const uv of Array.from(nextMap.keys())) {
    let w = nextMap.get(uv);
    if (w == null) continue;
    nextMap.set(uv, null);
    const parts = uv.split(",");
    let u = parseInt(parts[0], 10);
    let v = parseInt(parts[1], 10);
    const face = [u, v];
    while (w !== face[0]) {
      if (w == null) break; // open / confused face
      face.push(w);
      [u, v] = [v, w];
      w = nextMap.get(`${u},${v}`) ?? null;
      nextMap.set(`${u},${v}`, null);
    }
    nextMap.set(`${face[face.length - 1]},${face[0]}`, null);
    if (w != null && polygonOrientation(face.map((x) => fold.vertices_coords[x])) > 0) {
      faces.push(face);
    }
  }
  fold.faces_vertices = faces;
}

/** pattern.js `edgesVerticesToVerticesEdges` (569). */
function buildVerticesEdges(fold: Fold): void {
  const ve: number[][] = fold.vertices_coords.map(() => []);
  for (let i = 0; i < fold.edges_vertices.length; i++) {
    ve[fold.edges_vertices[i][0]].push(i);
    ve[fold.edges_vertices[i][1]].push(i);
  }
  fold.vertices_edges = ve;
}

/** pattern.js `removeBorderFaces` (737): drop faces whose every edge is a "B" boundary. */
function removeBorderFaces(fold: Fold): void {
  const ve = fold.vertices_edges!;
  for (let i = fold.faces_vertices!.length - 1; i >= 0; i--) {
    const face = fold.faces_vertices![i];
    let allBorder = true;
    for (let j = 0; j < face.length; j++) {
      const vi = face[j];
      const nvi = face[(j + 1) % face.length];
      for (const ei of ve[vi]) {
        const e = fold.edges_vertices[ei];
        if ((e[0] === vi && e[1] === nvi) || (e[1] === vi && e[0] === nvi)) {
          if (fold.edges_assignment[ei] !== "B") {
            allBorder = false;
            break;
          }
        }
      }
      if (!allBorder) break;
    }
    if (allBorder) fold.faces_vertices!.splice(i, 1);
  }
}

/** pattern.js `reverseFaceOrder` (562): orient faces CCW. */
function reverseFaceOrder(fold: Fold): void {
  for (const f of fold.faces_vertices!) f.reverse();
}

// ===============================================================================================
// Top level — parseSVG (pattern.js:447) assembled from the ops above
// ===============================================================================================

/** Edge-assembly order matches pattern.js `parseSVG`: B, M, V, F, U, C (first wins on dedup). */
const ASSEMBLE_ORDER: { type: EdgeType; assignment: string; angle: (s: Segment) => number | null }[] = [
  { type: "border", assignment: "B", angle: () => null },
  { type: "mountain", assignment: "M", angle: (s) => s.angle ?? null },
  { type: "valley", assignment: "V", angle: (s) => s.angle ?? null },
  { type: "triangulation", assignment: "F", angle: () => 0 },
  { type: "hinge", assignment: "U", angle: () => null },
  { type: "cut", assignment: "C", angle: () => null },
];

export interface SvgImportStats {
  vertices: number;
  faces: number;
  mountains: number;
  valleys: number;
  facets: number;
  cuts: number;
  borders: number;
}

/** Parse + clean + find faces — the 2D Fold ready for downstream processFold. */
function svgToFold(svgText: string, vertTol = DEFAULT_VERT_TOL, includePaths = true): Fold {
  const { verts, buckets } = readSvg(svgText, includePaths);

  const fold: Fold = { vertices_coords: verts, edges_vertices: [], edges_assignment: [], edges_foldAngles: [] };
  for (const { type, assignment, angle } of ASSEMBLE_ORDER) {
    for (const s of buckets[type]) {
      fold.edges_vertices.push([s.a, s.b]);
      fold.edges_assignment.push(assignment);
      fold.edges_foldAngles.push(angle(s));
    }
  }
  if (fold.vertices_coords.length === 0 || fold.edges_vertices.length === 0) {
    throw new Error("No valid geometry found in SVG (check stroke colours: M=red, V=blue, C=green, F=yellow, B=black).");
  }

  collapseNearbyVertices(fold, vertTol);
  removeLoopEdges(fold);
  removeDuplicateEdges(fold);

  findIntersections(fold, vertTol);
  collapseNearbyVertices(fold, vertTol);
  removeLoopEdges(fold);
  removeDuplicateEdges(fold);

  buildVerticesVertices(fold);
  removeStrayVertices(fold);
  buildVerticesVertices(fold);
  removeRedundantVertices(fold, 0.01);

  buildVerticesVertices(fold); // fresh adjacency from the cleaned edge set
  sortVerticesVertices(fold);
  verticesVerticesToFaces(fold);

  buildVerticesEdges(fold);
  removeBorderFaces(fold);
  reverseFaceOrder(fold);
  return fold;
}

/** Round to a sane number of decimals so the emitted FKLD stays small + diffable. */
const round = (x: number, dp = 5): number => {
  const p = 10 ** dp;
  return Math.round(x * p) / p;
};

export interface SvgImportOptions {
  vertTol?: number;
  /** Parse `<path>` creases (default true = faithful to OS). False = line-only, like svg2fold.py. */
  includePaths?: boolean;
  /** Centre the net on its bounding-box centre (cosmetic; the solver recenters anyway). */
  recenter?: boolean;
  title?: string;
  creator?: string;
  description?: string;
  author?: string;
  unit?: string;
}

/**
 * Import an Origami Simulator crease-pattern SVG into an FKLD/FOLD object the kirigamizer engine
 * folds. Fold angles are emitted in **degrees** (`edges_foldAngle`, FOLD convention) — e.g. ±90 for
 * the Miyamoto tower's opacity-0.5 strokes. No driven footprint, so it **free-folds** like OS.
 */
export function importOrigamiSimulatorSvg(svgText: string, opts: SvgImportOptions = {}): FoldFile & { stats: SvgImportStats } {
  const fold = svgToFold(svgText, opts.vertTol, opts.includePaths ?? true);

  let coords = fold.vertices_coords;
  if (opts.recenter) {
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const c of coords) for (let d = 0; d < 2; d++) { lo[d] = Math.min(lo[d], c[d]); hi[d] = Math.max(hi[d], c[d]); }
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    coords = coords.map((c) => [c[0] - cx, c[1] - cy]);
  }

  const edges_foldAngle = fold.edges_foldAngles.map((a) =>
    a == null ? null : round((a * 180) / PI, 3),
  );

  const stats: SvgImportStats = {
    vertices: coords.length,
    faces: fold.faces_vertices!.length,
    mountains: fold.edges_assignment.filter((a) => a === "M").length,
    valleys: fold.edges_assignment.filter((a) => a === "V").length,
    facets: fold.edges_assignment.filter((a) => a === "F").length,
    cuts: fold.edges_assignment.filter((a) => a === "C").length,
    borders: fold.edges_assignment.filter((a) => a === "B").length,
  };

  const file: FoldFile & { stats: SvgImportStats } = {
    file_spec: 1,
    file_creator: opts.creator ?? "kirigamizer: Origami Simulator SVG → FOLD (svg-import.ts, 1:1 loadSVG port)",
    file_description: opts.description ?? "Imported from an Origami Simulator crease-pattern SVG.",
    file_author: opts.author ?? "",
    frame_title: opts.title ?? "Imported crease pattern",
    frame_classes: ["creasePattern"],
    frame_attributes: ["2D"],
    frame_unit: opts.unit ?? "mm",
    vertices_coords: coords.map((c) => [round(c[0]), round(c[1])]),
    edges_vertices: fold.edges_vertices as [number, number][],
    edges_assignment: fold.edges_assignment,
    edges_foldAngle,
    faces_vertices: fold.faces_vertices,
    stats,
  } as FoldFile & { stats: SvgImportStats };
  // A crease pattern with cut ("C") strokes is kirigami — stamp an `fkld:` provenance key so the
  // scene router treats it as such (FKLD is FOLD + the `fkld:` namespace). Pure origami stays plain.
  if (stats.cuts > 0) {
    (file as Record<string, unknown>)["fkld:import"] = { source: "origami-simulator-svg" };
  }
  return file;
}
