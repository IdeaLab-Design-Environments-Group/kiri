/**
 * **Model** — the *secondary* "draw a crease pattern" design path (the primary
 * being mesh → kirigami conversion via the convert panel). A square lattice the
 * user paints with Origami-Simulator-style crease assignments, compiled to a
 * triangulated FOLD draft that the service then wraps into FKLD.
 *
 * The crease vocabulary is lifted 1:1 from Origami Simulator's `js/pattern.js`
 * (its `typeForStroke` + import policy): mountain (red, fold angle −π), valley
 * (blue, +π), border (black), cut (green), facet (flat, angle 0). The viewer +
 * free-fold sim already default M→−π / V→+π from `edges_assignment`, so a
 * correctly-assigned flat pattern folds with no extra metadata.
 *
 * Two diagonals per cell are paintable, so RES / waterbomb-style stars are
 * drawable. The build always emits a triangulated 2-manifold (every quad split
 * along its creased diagonal, or — when both diagonals are creased — around a
 * cell-centre vertex), which is what the viewer body fill and the bar-and-hinge
 * sim both require.
 *
 * Pure: no DOM, no FKLD keys (the service owns the `fkld:` namespace). The view
 * imports this for rendering/editing; `src/services/pattern-service.ts` imports
 * `gridToFold` to build the FKLD object.
 */

/** FOLD edge assignment letters this editor produces (subset of the FOLD spec). */
export type CreaseAssignment = "M" | "V" | "B" | "C" | "F";

/** Lattice-edge geometry kind: horizontal/vertical side, main "\" or anti "/" diagonal. */
export type EdgeKind = "h" | "v" | "d" | "a";

/** A clickable lattice edge: two vertex ids and its geometry kind. */
export interface CandidateEdge {
  a: number;
  b: number;
  kind: EdgeKind;
}

/** A plain (non-FKLD) FOLD draft — the service stamps the `fkld:` keys on top. */
export interface FoldDraft {
  vertices_coords: number[][];
  edges_vertices: [number, number][];
  edges_assignment: CreaseAssignment[];
  faces_vertices: number[][];
  /** Parallel to edges: "seam" for cut (C) edges, null otherwise (FKLD cut subtype). */
  cutType: (string | null)[];
  counts: Record<CreaseAssignment, number>;
}

const MIN_DIM = 1;
const MAX_DIM = 40;

/**
 * A paintable square lattice of `cols × rows` cells with `(cols+1) × (rows+1)`
 * lattice vertices. Crease assignments live in a sparse map keyed by the
 * canonical (unordered) vertex pair, so an unpainted edge is simply absent.
 */
export class PatternGrid {
  cols: number;
  rows: number;
  cellMm: number;
  private readonly assign = new Map<string, CreaseAssignment>();

  constructor(cols = 6, rows = 6, cellMm = 10) {
    this.cols = clampDim(cols);
    this.rows = clampDim(rows);
    this.cellMm = cellMm > 0 ? cellMm : 10;
  }

  /** Lattice vertex index for grid coordinate (i, j), 0 ≤ i ≤ cols, 0 ≤ j ≤ rows. */
  vid(i: number, j: number): number {
    return j * (this.cols + 1) + i;
  }

  /** Inverse of {@link vid}: grid coordinate (i, j) for a lattice vertex index. */
  ij(vid: number): [number, number] {
    const w = this.cols + 1;
    return [vid % w, Math.floor(vid / w)];
  }

  private key(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  get(a: number, b: number): CreaseAssignment | undefined {
    return this.assign.get(this.key(a, b));
  }

  has(a: number, b: number): boolean {
    return this.assign.has(this.key(a, b));
  }

  /** Set (or, with `null`, clear) the assignment of the edge between two lattice vertices. */
  set(a: number, b: number, asg: CreaseAssignment | null): void {
    const k = this.key(a, b);
    if (asg == null) this.assign.delete(k);
    else this.assign.set(k, asg);
  }

  clear(): void {
    this.assign.clear();
  }

  get paintedCount(): number {
    return this.assign.size;
  }

  /** True for the outer-perimeter axis-aligned sides (auto-assigned "B" in the build). */
  isPerimeterSide(a: number, b: number): boolean {
    const [ai, aj] = this.ij(a);
    const [bi, bj] = this.ij(b);
    if (aj === bj) return aj === 0 || aj === this.rows; // horizontal side
    if (ai === bi) return ai === 0 || ai === this.cols; // vertical side
    return false;
  }

  /** Every clickable lattice edge: all H/V grid sides plus both per-cell diagonals. */
  candidates(): CandidateEdge[] {
    const out: CandidateEdge[] = [];
    for (let j = 0; j <= this.rows; j++)
      for (let i = 0; i < this.cols; i++)
        out.push({ a: this.vid(i, j), b: this.vid(i + 1, j), kind: "h" });
    for (let i = 0; i <= this.cols; i++)
      for (let j = 0; j < this.rows; j++)
        out.push({ a: this.vid(i, j), b: this.vid(i, j + 1), kind: "v" });
    for (let cj = 0; cj < this.rows; cj++)
      for (let ci = 0; ci < this.cols; ci++) {
        out.push({ a: this.vid(ci, cj + 1), b: this.vid(ci + 1, cj), kind: "d" }); // "\" TL–BR
        out.push({ a: this.vid(ci, cj), b: this.vid(ci + 1, cj + 1), kind: "a" }); // "/" BL–TR
      }
    return out;
  }
}

function clampDim(n: number): number {
  const r = Math.round(n);
  if (!Number.isFinite(r)) return 6;
  return Math.max(MIN_DIM, Math.min(MAX_DIM, r));
}

/**
 * Compile a painted lattice to a triangulated FOLD draft (flat, z = 0, mm).
 *
 * - Lattice vertices are emitted in `vid` order; both 2D coordinates are mm.
 * - Axis-aligned sides are emitted once (shared between cells). Unpainted ones
 *   default to "B" on the perimeter and "F" inside (the Origami-Simulator
 *   triangulation convention: interior facet edges stay flat).
 * - Each cell is split along whichever diagonal(s) the user creased. A cell with
 *   no creased diagonal still gets a flat "\" facet so the output is always
 *   triangles. A cell with *both* diagonals creased gains a centre vertex and
 *   four triangles, the two diagonals becoming collinear half-edges through it —
 *   the only valid manifold when two creases cross.
 */
export function gridToFold(grid: PatternGrid): FoldDraft {
  const { cols, rows, cellMm } = grid;
  const W = cols + 1;
  const vid = (i: number, j: number) => j * W + i;

  const vertices_coords: number[][] = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= cols; i++) vertices_coords.push([i * cellMm, j * cellMm]);

  const edges_vertices: [number, number][] = [];
  const edges_assignment: CreaseAssignment[] = [];
  const cutType: (string | null)[] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number, asg: CreaseAssignment): void => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges_vertices.push([a, b]);
    edges_assignment.push(asg);
    cutType.push(asg === "C" ? "seam" : null);
  };

  // Pass 1 — axis-aligned sides (enumerated once, so shared edges dedupe).
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i < cols; i++) {
      const a = vid(i, j);
      const b = vid(i + 1, j);
      addEdge(a, b, grid.get(a, b) ?? (j === 0 || j === rows ? "B" : "F"));
    }
  for (let i = 0; i <= cols; i++)
    for (let j = 0; j < rows; j++) {
      const a = vid(i, j);
      const b = vid(i, j + 1);
      addEdge(a, b, grid.get(a, b) ?? (i === 0 || i === cols ? "B" : "F"));
    }

  // Pass 2 — diagonals + triangulation, per cell.
  const faces_vertices: number[][] = [];
  for (let cj = 0; cj < rows; cj++)
    for (let ci = 0; ci < cols; ci++) {
      const BL = vid(ci, cj);
      const BR = vid(ci + 1, cj);
      const TL = vid(ci, cj + 1);
      const TR = vid(ci + 1, cj + 1);
      const mAsg = grid.get(TL, BR); // "\" main diagonal
      const aAsg = grid.get(BL, TR); // "/" anti-diagonal

      if (mAsg != null && aAsg != null) {
        const c = vertices_coords.length;
        vertices_coords.push([(ci + 0.5) * cellMm, (cj + 0.5) * cellMm]);
        addEdge(TL, c, mAsg);
        addEdge(c, BR, mAsg);
        addEdge(BL, c, aAsg);
        addEdge(c, TR, aAsg);
        faces_vertices.push([BL, BR, c], [BR, TR, c], [TR, TL, c], [TL, BL, c]);
      } else if (aAsg != null) {
        addEdge(BL, TR, aAsg);
        faces_vertices.push([BL, BR, TR], [BL, TR, TL]);
      } else {
        addEdge(TL, BR, mAsg ?? "F");
        faces_vertices.push([BL, BR, TL], [BR, TR, TL]);
      }
    }

  const counts: Record<CreaseAssignment, number> = { M: 0, V: 0, B: 0, C: 0, F: 0 };
  for (const a of edges_assignment) counts[a]++;

  return { vertices_coords, edges_vertices, edges_assignment, faces_vertices, cutType, counts };
}

// ---- presets (foldable demos that also exercise both build paths) ----------

/** Accordion: interior verticals alternate M / V — folds to a pleated fan. */
export function presetAccordion(grid: PatternGrid): void {
  grid.clear();
  for (let i = 1; i < grid.cols; i++) {
    const asg: CreaseAssignment = i % 2 === 1 ? "M" : "V";
    for (let j = 0; j < grid.rows; j++) grid.set(grid.vid(i, j), grid.vid(i, j + 1), asg);
  }
}

/** Square waterbomb tessellation: interior grid lines mountain, both diagonals valley. */
export function presetWaterbomb(grid: PatternGrid): void {
  grid.clear();
  for (let i = 1; i < grid.cols; i++)
    for (let j = 0; j < grid.rows; j++) grid.set(grid.vid(i, j), grid.vid(i, j + 1), "M");
  for (let j = 1; j < grid.rows; j++)
    for (let i = 0; i < grid.cols; i++) grid.set(grid.vid(i, j), grid.vid(i + 1, j), "M");
  for (let cj = 0; cj < grid.rows; cj++)
    for (let ci = 0; ci < grid.cols; ci++) {
      grid.set(grid.vid(ci, cj + 1), grid.vid(ci + 1, cj), "V"); // "\"
      grid.set(grid.vid(ci, cj), grid.vid(ci + 1, cj + 1), "V"); // "/"
    }
}

/** A vent slit demo: a row of central cut (C) edges flanked by valley folds. */
export function presetCutWindow(grid: PatternGrid): void {
  grid.clear();
  const jMid = Math.floor(grid.rows / 2);
  for (let i = 1; i < grid.cols - 1; i++) {
    grid.set(grid.vid(i, jMid), grid.vid(i + 1, jMid), "C");
  }
  // hinge the flap above and below the slit so it opens when folded
  for (let i = 1; i < grid.cols - 1; i++) {
    if (jMid - 1 >= 0) grid.set(grid.vid(i, jMid - 1), grid.vid(i + 1, jMid - 1), "V");
    if (jMid + 1 <= grid.rows) grid.set(grid.vid(i, jMid + 1), grid.vid(i + 1, jMid + 1), "V");
  }
}
