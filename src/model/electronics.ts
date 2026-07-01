/**
 * **Model** — pure flat-pattern geometry for the LED electronics tool. No DOM,
 * no services: it reads a flat FKLD/FOLD pattern and exposes the structures the
 * auto-router and the 2D interface need.
 *
 * The build is the printed kirigami one: each face is a rigid tile, and the bare
 * membrane between two adjacent tiles is a gap (a living hinge at an `M`/`V` fold,
 * or an open `C` cut). LEDs sit at the *middle* of a face (its tile); copper-tape
 * traces run through the gaps, crossing each hinge at its midpoint so the tape can
 * flex. We therefore model routing on the **dual gap graph**: nodes are face
 * centroids plus gap-edge midpoints, and a centroid only connects to a neighbour's
 * centroid *through* the midpoint of the gap they share. `F` (facet) and `B`
 * (boundary) edges carry no gap and are not traversable.
 *
 * All coordinates are the flat pattern's 2D `vertices_coords` in millimetres (the
 * same space the SVG cut/score export uses), so a routed trace drops straight into
 * a copper layer with the cut/score layers.
 */
import type { FoldFile } from "./fold-file.js";
import { TILE_INSET_FRAC } from "./tile-subdiv.js";

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * An LED that bridges the gap between two adjacent tiles — one leg landing on
 * face `a`, the other on face `b` (the gray rigid parts, not the cloth backing).
 * `a < b` by convention so the pair identifies the gap uniquely. The body sits at
 * the shared-hinge midpoint; the legs reach onto each tile's pinched edge.
 */
export interface Led {
  a: number;
  b: number;
}

/** The single power source, pinned to a face (its two terminals are derived around it). */
export interface Battery {
  face: number;
}

/**
 * The two-net circuit. There is no series chain: every LED bridges PWR↔GND, so the only nets are
 * power and ground. Copper tape may freely cross (its underside is insulated), so the router needs
 * no crossing avoidance.
 */
export interface Circuit {
  leds: Led[];
  battery: Battery | null;
}

/** A routed copper trace as a flat-mm polyline, tagged by the net it belongs to (PWR or GND). */
export interface Trace2D {
  net: "pwr" | "gnd";
  points: Vec2[];
}

/** Copper-tape width (mm) — "semi thin"; the rectangle ribbons are this wide. Shared by view + export. */
export const TAPE_W = 1.6;

/** The planner's output: where LEDs/battery sit and the traces connecting them. */
export interface RoutedCircuit {
  /** Body centre (gap midpoint, flat mm) of each LED, in `circuit.leds` order. */
  ledPoints: Vec2[];
  /** Centroid (flat mm) of the battery face, or null. */
  batteryPoint: Vec2 | null;
  /** The battery's two terminal pads (flat mm): PWR (+) and GND (−) — each net's tape leaves its own. */
  terminals: { pwr: Vec2; gnd: Vec2 } | null;
  traces: Trace2D[];
  /** Indices into `circuit.leds` the planner could not connect to the battery. */
  unreachable: number[];
}

export const EMPTY_CIRCUIT: Circuit = { leds: [], battery: null };

/** A single flat face: its polygon (mm) and centroid (mm). */
export interface FlatFace {
  /** Vertex indices into `vertices_coords`. */
  verts: number[];
  /** Polygon corners in flat mm. */
  poly: Vec2[];
  centroid: Vec2;
}

/** One traversable gap between two tiles: the midpoint node and the faces it joins. */
export interface GapEdge {
  /** Node index of this gap's midpoint in {@link GapGraph.pos}. */
  mid: number;
  faceA: number;
  faceB: number;
  /** Midpoint of the shared edge (flat mm) — where the trace crosses the hinge. */
  point: Vec2;
  /** The shared edge's two endpoints (flat mm), for lateral rail offsetting. */
  ends: [Vec2, Vec2];
  /** Pinched edge-midpoint on `faceA`'s tile — the leg landing pad on that gray tile. */
  legA: Vec2;
  /** Pinched edge-midpoint on `faceB`'s tile — the leg landing pad on that gray tile. */
  legB: Vec2;
}

/** One gray rigid tile (the printed inset hexagon/polygon) in flat mm, aligned 1:1 with the faces. */
export interface TilePoly {
  face: number;
  /** Pinched-inward polygon ring (corners full, joint-edge midpoints pulled in to open the gaps). */
  ring: Vec2[];
}

/**
 * The dual gap graph. Nodes `0..F-1` are face centroids; nodes `F..F+G-1` are
 * gap-edge midpoints. `adj[n]` lists weighted neighbours (Euclidean flat distance).
 */
export interface GapGraph {
  faceCount: number;
  pos: Vec2[];
  adj: { to: number; w: number }[][];
  gaps: GapEdge[];
}

const GAP_ASSIGNMENTS = new Set(["M", "V", "C"]);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export function mid2(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** Read flat 2D points (x,y; z ignored) from a FoldFile. */
export function flatPoints(fold: FoldFile): Vec2[] {
  const coords = fold.vertices_coords;
  if (!Array.isArray(coords)) return [];
  return coords.map((c) => ({ x: num(c?.[0]), y: num(c?.[1]) }));
}

/** Build the flat-face polygons + centroids, aligned 1:1 with `faces_vertices`. */
export function flatFaces(fold: FoldFile): FlatFace[] {
  const pts = flatPoints(fold);
  const faces = fold.faces_vertices;
  if (!Array.isArray(faces) || pts.length === 0) return [];
  const out: FlatFace[] = [];
  for (const f of faces) {
    if (!Array.isArray(f) || f.length < 3) {
      out.push({ verts: [], poly: [], centroid: { x: 0, y: 0 } });
      continue;
    }
    const poly: Vec2[] = [];
    let cx = 0, cy = 0;
    for (const vi of f) {
      const p = pts[vi] ?? { x: 0, y: 0 };
      poly.push(p);
      cx += p.x;
      cy += p.y;
    }
    out.push({ verts: f.slice(), poly, centroid: { x: cx / f.length, y: cy / f.length } });
  }
  return out;
}

/** edgeKey → { incident face indices, endpoint vertex ids } over the flat faces. */
function sharedEdges(faces: FlatFace[]): Map<string, { faces: number[]; a: number; b: number }> {
  const shared = new Map<string, { faces: number[]; a: number; b: number }>();
  faces.forEach((f, fi) => {
    const v = f.verts;
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!, b = v[(k + 1) % v.length]!;
      const key = edgeKey(a, b);
      let rec = shared.get(key);
      if (!rec) shared.set(key, (rec = { faces: [], a, b }));
      rec.faces.push(fi);
    }
  });
  return shared;
}

/** edgeKey → assignment string, read from the explicit FOLD edge list. */
function assignmentMap(fold: FoldFile): Map<string, string> {
  const assignOf = new Map<string, string>();
  const ev = fold.edges_vertices;
  const ea = (fold.edges_assignment as string[] | undefined) ?? [];
  if (Array.isArray(ev)) {
    ev.forEach((e, i) => {
      if (Array.isArray(e) && e.length >= 2) assignOf.set(edgeKey(e[0]!, e[1]!), String(ea[i] ?? ""));
    });
  }
  return assignOf;
}

/**
 * Is this shared edge a real, openable gap (a tile pinches there and the router may cross it)?
 * True iff exactly two faces share it AND its assignment is a joint (`M`/`V`/`C`) or untagged —
 * closed nets emit cut lips without always tagging every interior edge, so an untagged interior edge
 * defaults to traversable. `F` (facet diagonal) and `B` (boundary) edges are explicitly NOT gaps.
 */
function isGapEdge(rec: { faces: number[] }, asg: string | undefined): boolean {
  if (rec.faces.length !== 2) return false;
  if (asg != null && asg !== "" && !GAP_ASSIGNMENTS.has(asg)) return false;
  return true;
}

/** Inward pinch distance for a tile: `gap·inradius·2` (inradius ≈ area×2 / perimeter) — matches printed-joinery. */
function tilePinch(poly: Vec2[], gap: number): number {
  let peri = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    peri += dist2(a, b);
  }
  let area2 = 0; // shoelace ×2 (unsigned)
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    area2 += a.x * b.y - b.x * a.y;
  }
  area2 = Math.abs(area2);
  return peri > 0 ? gap * (area2 / peri) * 2 : 0;
}

/**
 * Pinch an edge's midpoint perpendicular-inward toward centroid `g` by `d` — the leg/tile landing
 * point on the gray tile. Mirrors `printed-joinery.ts`/`sim-canvas` so preview ↔ print register.
 */
export function pinchMid(p: Vec2, q: Vec2, g: Vec2, d: number): Vec2 {
  const m = mid2(p, q);
  if (d <= 0) return m;
  let px = -(q.y - p.y), py = q.x - p.x; // in-plane ⟂ to the edge
  const l = Math.hypot(px, py) || 1;
  px /= l;
  py /= l;
  if (px * (g.x - m.x) + py * (g.y - m.y) < 0) {
    px = -px;
    py = -py;
  }
  return { x: m.x + px * d, y: m.y + py * d };
}

/**
 * Turn a route polyline into copper-tape rectangles: **one filled quad per straight segment**, each
 * `width` wide and centred on the segment (offset ±width/2 along the segment's perpendicular). This
 * is the physical tape — a strip laid along each run. Consecutive quads overlap slightly at bends
 * (same net, so harmless); zero-length segments are skipped. Returned as CCW-ish corner lists in flat
 * mm, ready to drop into the SVG copper layer or the modal preview.
 */
export function tapeQuads(points: Vec2[], width: number): Vec2[][] {
  const quads: Vec2[][] = [];
  const h = width / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i]!, p1 = points[i + 1]!;
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue; // degenerate hop — no rectangle
    const nx = (-dy / len) * h, ny = (dx / len) * h; // perpendicular, scaled to half-width
    quads.push([
      { x: p0.x + nx, y: p0.y + ny },
      { x: p1.x + nx, y: p1.y + ny },
      { x: p1.x - nx, y: p1.y - ny },
      { x: p0.x - nx, y: p0.y - ny },
    ]);
  }
  return quads;
}

/**
 * The gray rigid tiles: one pinched polygon per face (corners full, joint-edge midpoints pulled
 * inward by {@link tilePinch} to open the diamonds between tiles). This is the printed build flattened
 * to 0% fold — exactly what is cut — drawn over the cloth backing (the full flat faces).
 */
export function tilePolys(
  fold: FoldFile,
  faces: FlatFace[] = flatFaces(fold),
  gap: number = TILE_INSET_FRAC,
): TilePoly[] {
  const shared = sharedEdges(faces);
  const assignOf = assignmentMap(fold);
  const pinches = (a: number, b: number): boolean => {
    const key = edgeKey(a, b);
    const rec = shared.get(key);
    return rec ? isGapEdge(rec, assignOf.get(key)) : false;
  };
  return faces.map((f, fi) => {
    if (f.poly.length < 3) return { face: fi, ring: [] };
    const d = tilePinch(f.poly, gap);
    const v = f.verts;
    const ring: Vec2[] = [];
    for (let k = 0; k < v.length; k++) {
      const a = v[k]!, b = v[(k + 1) % v.length]!;
      const pa = f.poly[k]!, pb = f.poly[(k + 1) % v.length]!;
      ring.push(pa);
      ring.push(pinches(a, b) ? pinchMid(pa, pb, f.centroid, d) : mid2(pa, pb));
    }
    return { face: fi, ring };
  });
}

/**
 * Build the dual gap graph. An edge is a traversable gap iff {@link isGapEdge}. Each gap also carries
 * the pinched leg pads (`legA`/`legB`) where an LED's legs land on the two gray tiles it bridges.
 */
export function gapGraph(
  fold: FoldFile,
  faces: FlatFace[] = flatFaces(fold),
  gap: number = TILE_INSET_FRAC,
): GapGraph {
  const pts = flatPoints(fold);
  const faceCount = faces.length;
  const pos: Vec2[] = faces.map((f) => f.centroid);
  const adj: { to: number; w: number }[][] = faces.map(() => []);
  const gaps: GapEdge[] = [];

  const shared = sharedEdges(faces);
  const assignOf = assignmentMap(fold);
  const pinchD = faces.map((f) => (f.poly.length >= 3 ? tilePinch(f.poly, gap) : 0));

  for (const [key, rec] of shared) {
    if (!isGapEdge(rec, assignOf.get(key))) continue;
    const pa = pts[rec.a] ?? { x: 0, y: 0 };
    const pb = pts[rec.b] ?? { x: 0, y: 0 };
    const point = mid2(pa, pb);
    const [fA, fB] = rec.faces as [number, number];
    const legA = pinchMid(pa, pb, faces[fA]!.centroid, pinchD[fA]!);
    const legB = pinchMid(pa, pb, faces[fB]!.centroid, pinchD[fB]!);
    const midNode = pos.length;
    pos.push(point);
    adj.push([]);
    const link = (face: number) => {
      const w = dist2(pos[face]!, point);
      adj[face]!.push({ to: midNode, w });
      adj[midNode]!.push({ to: face, w });
    };
    link(fA);
    link(fB);
    gaps.push({ mid: midNode, faceA: fA, faceB: fB, point, ends: [pa, pb], legA, legB });
  }

  return { faceCount, pos, adj, gaps };
}

/** A graph for routing copper INSIDE the body: face centroids + every interior-edge midpoint. */
export interface RouteGraph {
  faceCount: number;
  /** Node positions (flat mm): `0..faceCount-1` are centroids, the rest are interior-edge midpoints. */
  pos: Vec2[];
  adj: { to: number; w: number }[][];
}

/**
 * Build the in-body route graph: like {@link gapGraph} but links faces across **every** interior edge
 * shared by two faces (F facets too, not only gaps), crossing at the edge midpoint. Routing on this
 * keeps copper strictly inside the pattern silhouette — every hop steps across an interior boundary,
 * so a trace never leaves the body the way a free straight line can.
 */
export function faceRouteGraph(fold: FoldFile, faces: FlatFace[] = flatFaces(fold)): RouteGraph {
  const pts = flatPoints(fold);
  const pos: Vec2[] = faces.map((f) => f.centroid);
  const adj: { to: number; w: number }[][] = faces.map(() => []);
  const shared = sharedEdges(faces);
  for (const [, rec] of shared) {
    if (rec.faces.length !== 2) continue; // boundary or non-manifold — no interior crossing
    const pa = pts[rec.a] ?? { x: 0, y: 0 };
    const pb = pts[rec.b] ?? { x: 0, y: 0 };
    const mid = mid2(pa, pb);
    const [fA, fB] = rec.faces as [number, number];
    const midNode = pos.length;
    pos.push(mid);
    adj.push([]);
    const link = (face: number) => {
      const w = dist2(pos[face]!, mid);
      adj[face]!.push({ to: midNode, w });
      adj[midNode]!.push({ to: face, w });
    };
    link(fA);
    link(fB);
  }
  return { faceCount: faces.length, pos, adj };
}

/**
 * A **corner/edge** routing graph that keeps copper on the gray tiles, off the cloth. For each tile we
 * trace an **inset copy of its pinched ring** — corner, edge-midpoint (dented at a gap), corner, … —
 * each node pulled toward the centroid by a tape clearance and linked in ring order. So a trace follows
 * the gray boundary instead of cutting the straight chord that would dip across a dent onto the cloth.
 * Tiles join only at their **shared corners** (where panels touch, gap ≈ 0), so the bus hops tile→tile
 * right at a corner — almost no copper on the cloth, and never over a hinge midpoint where the LED
 * sits. `cornerNodes[face]` are the crossing corners; `ringNodes[face]` is the whole gray ring (used to
 * land each leg stub on the tile).
 */
export interface CornerRouteGraph {
  faceCount: number;
  pos: Vec2[];
  adj: { to: number; w: number }[][];
  cornerNodes: number[][];
  ringNodes: number[][];
}

/** Move `p` toward `g`, but never past ~halfway — keeps the waypoint on the gray near the boundary. */
function insetToward(p: Vec2, g: Vec2, d: number): Vec2 {
  const dx = g.x - p.x, dy = g.y - p.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9 || d <= 0) return { x: p.x, y: p.y };
  const t = Math.min(d, l * 0.45) / l;
  return { x: p.x + dx * t, y: p.y + dy * t };
}

export function cornerRouteGraph(
  fold: FoldFile,
  faces: FlatFace[] = flatFaces(fold),
  gap: number = TILE_INSET_FRAC,
): CornerRouteGraph {
  const pos: Vec2[] = [];
  const adj: { to: number; w: number }[][] = [];
  const cornerNodes: number[][] = [];
  const ringNodes: number[][] = [];
  const cornerAt = new Map<string, number>(); // `${face}_${vertId}` -> corner node id

  const addNode = (p: Vec2): number => {
    const n = pos.length;
    pos.push(p);
    adj.push([]);
    return n;
  };
  const link = (u: number, v: number): void => {
    const w = dist2(pos[u]!, pos[v]!);
    adj[u]!.push({ to: v, w });
    adj[v]!.push({ to: u, w });
  };

  const shared = sharedEdges(faces);
  const assignOf = assignmentMap(fold);
  const edgeIsGap = (a: number, b: number): boolean => {
    const k = edgeKey(a, b);
    const rec = shared.get(k);
    return rec ? isGapEdge(rec, assignOf.get(k)) : false;
  };

  // 1) Per tile: an inset copy of the pinched gray ring (corner, edge-mid, corner, …) toward the
  //    centroid by a tape clearance, linked in ring order — so copper follows the gray, not the chord.
  faces.forEach((f, fi) => {
    if (f.poly.length < 3) {
      cornerNodes.push([]);
      ringNodes.push([]);
      return;
    }
    const g = f.centroid;
    const d = tilePinch(f.poly, gap);
    const clear = Math.min(TAPE_W * 0.7, d);
    const v = f.verts;
    const corners: number[] = [];
    const ring: number[] = [];
    for (let k = 0; k < v.length; k++) {
      const Pa = f.poly[k]!, Pb = f.poly[(k + 1) % v.length]!;
      const cNode = addNode(insetToward(Pa, g, clear));
      cornerAt.set(`${fi}_${v[k]}`, cNode);
      corners.push(cNode);
      ring.push(cNode);
      const m = edgeIsGap(v[k]!, v[(k + 1) % v.length]!) ? pinchMid(Pa, Pb, g, d) : mid2(Pa, Pb);
      ring.push(addNode(insetToward(m, g, clear)));
    }
    for (let k = 0; k < ring.length; k++) link(ring[k]!, ring[(k + 1) % ring.length]!);
    cornerNodes.push(corners);
    ringNodes.push(ring);
  });

  // 2) Join tiles only at their shared corners (panels touch, gap ≈ 0) — F facets included so a
  //    triangulated quad stays one connected panel. The hop is at the corner: off the cloth, and off
  //    the hinge midpoint where the LED sits.
  for (const [, rec] of shared) {
    if (rec.faces.length !== 2) continue; // boundary / non-manifold — nothing to cross to
    const [fA, fB] = rec.faces as [number, number];
    for (const vid of [rec.a, rec.b]) {
      const na = cornerAt.get(`${fA}_${vid}`);
      const nb = cornerAt.get(`${fB}_${vid}`);
      if (na != null && nb != null) link(na, nb);
    }
  }

  return { faceCount: faces.length, pos, adj, cornerNodes, ringNodes };
}

/** The gap that an LED straddles (matching its unordered face pair), or null if that gap is gone. */
export function gapForLed(gaps: GapEdge[], led: Led): GapEdge | null {
  return (
    gaps.find(
      (g) => (g.faceA === led.a && g.faceB === led.b) || (g.faceA === led.b && g.faceB === led.a),
    ) ?? null
  );
}

/** Nearest gap to point `p` (by its hinge midpoint), or null when there are no gaps. */
export function nearestGap(gaps: GapEdge[], p: Vec2): { gap: GapEdge; dist: number } | null {
  let best: GapEdge | null = null;
  let bestD = Infinity;
  for (const g of gaps) {
    const d = dist2(g.point, p);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best ? { gap: best, dist: bestD } : null;
}

/** Normalise a face pair into an `Led` with `a < b`. */
export function ledOf(faceA: number, faceB: number): Led {
  return faceA < faceB ? { a: faceA, b: faceB } : { a: faceB, b: faceA };
}

/** Index of the flat face containing point `p` (even-odd ray test), or -1. */
export function pointInFace(faces: FlatFace[], p: Vec2): number {
  for (let i = 0; i < faces.length; i++) {
    if (pointInPoly(p, faces[i]!.poly)) return i;
  }
  return -1;
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
