/**
 * Printed-kirigami tile geometry — the single source of truth shared by the STL export
 * (`stl-export.ts`) and the house/door generator (`scripts/gen-house-door.ts`), matched to the 3D-Sim
 * render (`sim-canvas.ts` `updatePrintedTiles`) so **what you see is what you cut**.
 *
 * Each triangular face → a hexagonal tile `[A, mAB, B, mBC, C, mCA]`. The three CORNERS stay full —
 * neighbouring tiles meet there (the pinpoint pivots of the rotating-units kirigami). A midpoint is
 * pinched perpendicular-inward by `gap·inradius·2` — opening the empty diamond between two tiles —
 * ONLY where the edge is a genuine joint: a real fold hinge ("M"/"V" interior fold) or a "C" cut.
 * A flat-facet ("F") edge is the triangulation diagonal interior to ONE logical polygon, so it does
 * NOT pinch: its coplanar triangles stay merged into a single rigid tile (else a flat polygon shatters
 * into triangles that fold along the facet lines instead of at the real 3D joints). Outer-boundary
 * edges stay straight for a clean perimeter. Tiles are full extruded bricks `v_top = v + t·n`. The
 * export closes the bottom (a watertight prism per tile) — the only difference from the sim, whose
 * open bottoms are hidden by the cloth backing.
 */
export type V3 = [number, number, number];
export type EdgeRole = "cut" | "merge" | "boundary";

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Role of a face edge from its FOLD assignment and how many faces share it. */
export function edgeRole(assignment: string | undefined, faceCount: number): EdgeRole {
  if (assignment === "C") return "cut"; // a cut — pinched open (the kirigami opening)
  if (assignment === "F") return "boundary"; // flat-facet triangulation diagonal interior to ONE polygon —
  //   NOT a joint: stays full so coplanar triangles merge into a single rigid tile (matches the sim)
  if (faceCount <= 1) return "boundary"; // outer rim (incl. "B") — stays straight, clean perimeter
  return "merge"; // real M/V interior fold — pinched open, the hinge the tiles fold about (corners meet)
}

export interface JoineryOptions {
  /** Rigid tile thickness (model units) — the extrude height `v_top = v + t·n`. */
  thickness: number;
  /** Gap: each pinched edge midpoint is pulled inward by `gap·inradius·2` (the sim's "Gap" slider). */
  gap: number;
  /** "flat" → tiles in the z = 0 plane extruded +z (the print); "folded" → per-face normal (gallery). */
  layout: "flat" | "folded";
}

/**
 * Build the printed-tile triangle soup (every 3 vertices = one CCW-outward facet) for a whole
 * kirigamized model: one closed hexagonal-prism tile per face, pinched on every non-boundary edge,
 * exactly matching the sim's `updatePrintedTiles` (plus a closed bottom). `roleOf(a,b)` classifies an
 * undirected edge so boundary edges stay straight.
 */
export function buildFoldableJoinery(
  faces: number[][],
  coords: V3[],
  roleOf: (a: number, b: number) => EdgeRole,
  opts: JoineryOptions,
): V3[] {
  const { thickness: t, gap, layout } = opts;
  const out: V3[] = [];
  const tri = (a: V3, b: V3, c: V3): void => { out.push(a, b, c); };

  faces.forEach((f0) => {
    if (f0.length < 3) return;
    // a flat face wound clockwise in xy would extrude/wind the wrong way → swap to CCW about +z
    const rawN = cross(sub(coords[f0[1]], coords[f0[0]]), sub(coords[f0[2]], coords[f0[0]]));
    const f = layout === "flat" && rawN[2] < 0 ? [f0[0], f0[2], f0[1]] : f0;
    const A = coords[f[0]], B = coords[f[1]], C = coords[f[2]];
    const n: V3 = layout === "flat" ? [0, 0, 1] : norm(cross(sub(B, A), sub(C, A)));
    const G: V3 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    const area2 = len(cross(sub(B, A), sub(C, A)));
    const peri = len(sub(B, A)) + len(sub(C, B)) + len(sub(A, C)) || 1;
    const d = gap * (area2 / peri) * 2; // = gap·inradius·2, exactly as the sim

    // midpoint of an edge, pinched perpendicular-inward by d unless that edge is an outer boundary
    const mid = (P: V3, Q: V3, pinch: boolean): V3 => {
      const m: V3 = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, (P[2] + Q[2]) / 2];
      if (!pinch) return m;
      let p = norm(cross(n, sub(Q, P))); // in-plane ⟂ to the edge
      if (dot(p, sub(G, m)) < 0) p = [-p[0], -p[1], -p[2]]; // point inward, toward the centroid
      return [m[0] + p[0] * d, m[1] + p[1] * d, m[2] + p[2] * d];
    };
    const pAB = roleOf(f[0], f[1]) !== "boundary";
    const pBC = roleOf(f[1], f[2]) !== "boundary";
    const pCA = roleOf(f[2], f[0]) !== "boundary";
    const ring: V3[] = [A, mid(A, B, pAB), B, mid(B, C, pBC), C, mid(C, A, pCA)]; // corners full + edge midpoints
    const top = ring.map((v) => add(v, mul(n, t)));
    const gT = add(G, mul(n, t));
    for (let e = 0; e < 6; e++) { const j = (e + 1) % 6; tri(gT, top[e], top[j]); tri(G, ring[j], ring[e]); } // top + bottom caps
    for (let e = 0; e < 6; e++) { const j = (e + 1) % 6; tri(ring[e], ring[j], top[j]); tri(ring[e], top[j], top[e]); } // side walls
  });
  return out;
}

function norm(a: V3): V3 { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
