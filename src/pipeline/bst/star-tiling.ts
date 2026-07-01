/**
 * Star-tiling unit cell + grid (BST, paper Sec 2.1).
 *
 * Square sub-case (α=0, γ=1) is implemented and validated first (the plan's square-first path);
 * it is the classic rotating-squares auxetic. Tiles are unit squares on a grid, alternately
 * rotated by ±φ where φ=θ/2; adjacent tiles hinge at shared corners and square voids open as θ
 * grows. Lattice spacing P(θ)=cos(θ/2)+sin(θ/2); scale P(π/2)/P(0)=√2 (the paper's square max).
 *
 * The concave-star case (α<0, γ>√2) reuses the same grid/hinge machinery with a star tile profile
 * (dented edges) — marked TODO below; the kinematics (scaleFactor/tileSpacing) are already general.
 *
 * Hinge topology is found NUMERICALLY: at an open reference angle, tile corners that coincide are
 * the pivots (they stay coincident at every θ); corners that separated bound the voids. This avoids
 * hand-deriving the checkerboard hinge pattern and is checked by the unit tests.
 */
import type { Vec2 } from "../types.js";
import type { BstParams, BstTiling, VoidCell } from "./types.js";

/** Eq 1 length between adjacent tile centers at slit angle θ: L_θ = √(1+γ²+2γ·sinθ). */
export function tileSpacing(gamma: number, theta: number): number {
  return Math.sqrt(1 + gamma * gamma + 2 * gamma * Math.sin(theta));
}

/** Eq 1 scale factor between two slit angles: s = L_θb / L_θa. */
export function scaleFactor(gamma: number, thetaA: number, thetaB: number): number {
  return tileSpacing(gamma, thetaB) / tileSpacing(gamma, thetaA);
}

function rot(x: number, y: number, a: number): Vec2 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Square-case lattice spacing (tile side 1): adjacent tiles share a corner at this center spacing. */
function squareSpacing(theta: number): number {
  const phi = theta / 2;
  return Math.cos(phi) + Math.sin(phi);
}

/**
 * Raw (un-merged) tile corners for the square case at angle θ. Tile (i,j) is a unit square centered
 * at (i,j)·P, rotated by (-1)^(i+j)·θ/2. Corners CCW: [BL, BR, TR, TL]. Returns one entry per tile,
 * each a list of 4 Vec2. Indexing: tile index t = j·nx + i; raw corner id = t·4 + localCorner.
 */
function rawTileCorners(nx: number, ny: number, theta: number): Vec2[][] {
  const phi = theta / 2;
  const P = squareSpacing(theta);
  const local: [number, number][] = [
    [-0.5, -0.5], // BL
    [0.5, -0.5], // BR
    [0.5, 0.5], // TR
    [-0.5, 0.5], // TL
  ];
  const out: Vec2[][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const r = (i + j) % 2 === 0 ? phi : -phi;
      const cx = i * P, cy = j * P;
      out.push(local.map(([lx, ly]) => {
        const p = rot(lx, ly, r);
        return { x: cx + p.x, y: cy + p.y };
      }));
    }
  }
  return out;
}

/** Union-find for merging coincident corners into shared pivot vertices. */
class DSU {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_v, i) => i); }
  find(x: number): number { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

/**
 * Establish the hinge/merge map ONCE at an open reference angle: any two tile corners that coincide
 * there are the same pivot (they stay coincident at every θ). Returns, per raw corner id, its
 * deduped vertex id, plus the deduped vertex count.
 */
function hingeMap(nx: number, ny: number, refTheta: number): { vid: number[]; count: number } {
  const raw = rawTileCorners(nx, ny, refTheta).flat();
  const n = raw.length;
  const dsu = new DSU(n);
  // bucket by rounded position for O(n) coincidence detection
  const tol = 1e-6;
  const key = (p: Vec2): string => `${Math.round(p.x / tol)}_${Math.round(p.y / tol)}`;
  const bucket = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = key(raw[i]);
    const j = bucket.get(k);
    if (j === undefined) bucket.set(k, i);
    else dsu.union(i, j);
  }
  const root2vid = new Map<number, number>();
  const vid = new Array<number>(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = dsu.find(i);
    let v = root2vid.get(r);
    if (v === undefined) { v = count++; root2vid.set(r, v); }
    vid[i] = v;
  }
  return { vid, count };
}

/**
 * Build the planar star tiling at slit angle θ over an nx×ny tile grid. Square case (γ=1, α=0) for
 * now. Returns deduped vertices, tile quads (CCW corner vertex ids), and parallelogram voids.
 */
export function buildTiling(params: BstParams, theta: number): BstTiling {
  const { nx, ny } = params.grid;
  // Reference angle for hinge detection: an open state (use π/3 so voids are clearly open).
  const ref = Math.PI / 3;
  const { vid, count } = hingeMap(nx, ny, ref);
  const raw = rawTileCorners(nx, ny, theta).flat();

  // Deduped positions: average the raw corners mapped to each vertex (coincident for hinges).
  const acc = Array.from({ length: count }, () => ({ x: 0, y: 0, n: 0 }));
  for (let i = 0; i < raw.length; i++) { const v = vid[i]; acc[v].x += raw[i].x; acc[v].y += raw[i].y; acc[v].n++; }
  const vertices: Vec2[] = acc.map((a) => ({ x: a.x / a.n, y: a.y / a.n }));

  // Tiles: each tile's 4 corners → vertex ids.
  const tiles: number[][] = [];
  for (let t = 0; t < nx * ny; t++) tiles.push([vid[t * 4], vid[t * 4 + 1], vid[t * 4 + 2], vid[t * 4 + 3]]);

  // Voids: the gaps between tiles. Found by tracing the faces of the tile-boundary-edge planar
  // graph (robust against the checkerboard hinge pattern). Topology is θ-independent, so we trace
  // once at an open reference state and reuse the vertex-id cycles.
  const refVerts = (() => {
    const r = rawTileCorners(nx, ny, ref).flat();
    const a = Array.from({ length: count }, () => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < r.length; i++) { const v = vid[i]; a[v].x += r[i].x; a[v].y += r[i].y; a[v].n++; }
    return a.map((q) => ({ x: q.x / q.n, y: q.y / q.n }));
  })();
  const voids = traceVoids(tiles, refVerts);

  return { vertices, tiles, voids, theta };
}

/**
 * Extract the void polygons by tracing the bounded faces of the tile-boundary-edge planar graph and
 * discarding the tile faces and the outer face. `refVerts` are open-state positions (for the
 * angular half-edge sort); the returned corner cycles are vertex ids valid at any θ.
 */
function traceVoids(tiles: number[][], refVerts: Vec2[]): VoidCell[] {
  // undirected tile edges + adjacency
  const adj = new Map<number, number[]>();
  const addAdj = (a: number, b: number): void => { const l = adj.get(a) ?? []; if (!l.includes(b)) l.push(b); adj.set(a, l); };
  const tileKeySet = new Set<string>(); // canonical sorted-vertex signature of each tile face
  for (const t of tiles) {
    for (let k = 0; k < t.length; k++) { addAdj(t[k], t[(k + 1) % t.length]); addAdj(t[(k + 1) % t.length], t[k]); }
    tileKeySet.add([...t].sort((x, y) => x - y).join(","));
  }
  // sort neighbors CCW around each vertex
  const ang = (u: number, v: number): number => Math.atan2(refVerts[v].y - refVerts[u].y, refVerts[v].x - refVerts[u].x);
  const order = new Map<number, number[]>();
  for (const [u, ns] of adj) order.set(u, [...ns].sort((p, q) => ang(u, p) - ang(u, q)));
  const pos = new Map<number, Map<number, number>>();
  for (const [u, ns] of order) { const m = new Map<number, number>(); ns.forEach((v, i) => m.set(v, i)); pos.set(u, m); }
  const nextHE = (u: number, v: number): [number, number] => { const ns = order.get(v)!; const i = pos.get(v)!.get(u)!; return [v, ns[(i - 1 + ns.length) % ns.length]]; };

  const area = (cyc: number[]): number => {
    let s = 0; for (let i = 0; i < cyc.length; i++) { const a = refVerts[cyc[i]], b = refVerts[cyc[(i + 1) % cyc.length]]; s += a.x * b.y - b.x * a.y; } return s / 2;
  };
  const visited = new Set<string>();
  const faces: number[][] = [];
  for (const [u, ns] of order) for (const v of ns) {
    let he: [number, number] = [u, v];
    const k0 = `${he[0]}_${he[1]}`;
    if (visited.has(k0)) continue;
    const cyc: number[] = [];
    let guard = 0;
    while (!visited.has(`${he[0]}_${he[1]}`) && guard++ < 10000) { visited.add(`${he[0]}_${he[1]}`); cyc.push(he[0]); he = nextHE(he[0], he[1]); }
    if (cyc.length >= 3) faces.push(cyc);
  }
  // voids = bounded faces that are not tiles and not the (largest-|area|) outer face
  let outer = -1, outerA = 0;
  faces.forEach((f, i) => { const a = Math.abs(area(f)); if (a > outerA) { outerA = a; outer = i; } });
  const voids: VoidCell[] = [];
  faces.forEach((f, i) => {
    if (i === outer) return;
    const sig = [...new Set(f)].sort((x, y) => x - y).join(",");
    if (tileKeySet.has(sig)) return; // a tile face
    if (area(f) <= 1e-9) return; // keep CCW positive-area cells only (dedupes CW duplicates)
    voids.push({ corners: f });
  });
  return voids;
}
