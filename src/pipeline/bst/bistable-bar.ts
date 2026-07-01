/**
 * Bistable bar elements (BST, paper Sec 2.2–2.4).
 *
 * Each parallelogram void ABCD gets a bar EF (connectors ABE, CDF; E,F point-symmetric about the
 * void barycenter G) that makes the linkage stable both contracted and deployed. Inverse design
 * (Sec 2.3): from the void's local scale factor s and a target bar strain ε (compression, ε<0),
 * solve the bar endpoint polar coords (R, φ) — Eq 2 for R, Eq 3 φ=(α+β)/2 — where β is the local
 * deployed slit angle giving s. A void is skipped (no bar) when there is no real solution, when
 * φ≤0, or when the bar/connectors would intersect a flanking tile (Sec 2.4).
 *
 * Scope: bars are emitted as rigid members for fabrication; the kinematic sim shows deployment, not
 * the bistable snap-through (energy double-well) — that is a material property.
 *
 * Limitation (square-first geometry): bar POPULATION requires the concave-star tile profile (α<0)
 * whose contracted voids stay open. On the square approximation (α=0) the contracted voids close and
 * the Eq-2 placement self-intersects the flanking tiles across the whole (s,ε) sweep, so every void
 * is (correctly, per Sec 2.4) skipped and the emitted pattern carries 0 bars. The inverse-design math
 * (Eqs 2/3, localBeta), placement, and self-intersection rejection are all implemented and tested;
 * populating bars is unlocked by adding the star tile profile in star-tiling.ts.
 */
import type { Vec2 } from "../types.js";
import { type Vec3, add, scale, sub as sub3, cross, length as len3, normalize } from "../../core/vec3.js";
import { tileSpacing } from "./star-tiling.js";
import type { BstTiling } from "./types.js";

/** Local deployed slit angle β giving scale factor s from contracted angle α (inverse of Eq 1). */
export function localBeta(gamma: number, alpha: number, s: number): number | null {
  const La2 = tileSpacing(gamma, alpha) ** 2; // 1+γ²+2γ sinα
  const sinB = (s * s * La2 - (1 + gamma * gamma)) / (2 * gamma);
  if (sinB < -1 || sinB > 1) return null; // s outside the achievable range
  return Math.asin(sinB);
}

/** Eq 2 (R) + Eq 3 (φ). Returns null when there is no real bar (negative discriminant). */
export function solveBar(alpha: number, beta: number, gamma: number, epsilon: number): { R: number; phi: number } | null {
  const e = epsilon;
  const denom = e * (e + 2);
  if (Math.abs(denom) < 1e-12) return null; // ε=0 → no compliant bar
  const cos = Math.cos((beta - alpha) / 2);
  const disc = ((e + 1) ** 2 * cos - 1) ** 2 - e * e * (e + 2) ** 2;
  if (disc < 0) return null;
  const R = (gamma - gamma * (e + 1) ** 2 * cos) / denom - Math.sqrt(disc) / denom;
  const phi = (alpha + beta) / 2;
  return { R, phi };
}

export interface PlacedBar {
  voidIndex: number;
  /** Contracted (flat crease pattern) endpoints. */
  Ec: Vec2;
  Fc: Vec2;
  R: number;
  phi: number;
  skipped: boolean;
  reason?: "few-corners" | "scale-out-of-range" | "no-solution" | "phi-nonpositive" | "self-intersection";
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const lenV = (a: Vec2): number => Math.hypot(a.x, a.y);
const centroid = (ps: Vec2[]): Vec2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/**
 * Place E at polar (R·|AB|, φ) about O=midpoint(AB) in the void's A→B frame (paper's frame), with F
 * point-symmetric about the barycenter G: F = 2G − E, which lands F about midpoint(CD). E ends up
 * near the AB side (connector ABE), F near CD (connector CDF). `clampFit` shrinks the offset so the
 * endpoints stay inside the void (Eq 2's R can exceed the void; an oversized bar would self-intersect
 * the tiles, so we fit it — the bistability magnitude is approximated, the placement is valid).
 */
function placeEF(corners: Vec2[], R: number, phi: number, clampFit = true): { E: Vec2; F: Vec2; G: Vec2 } {
  const G = centroid(corners);
  const oAB = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  const ax = sub(corners[1], corners[0]); // A→B axis
  const al = lenV(ax) || 1;
  const ux = { x: ax.x / al, y: ax.y / al };
  const uy = { x: -ux.y, y: ux.x };
  let r = R * al; // R is in slit-edge units; scale to the void
  if (clampFit) {
    // keep the offset within ~half the void's smaller extent so E,F sit inside it
    const halfDiag = 0.45 * Math.min(al, lenV(sub(corners[2], corners[1])) || al);
    if (Math.abs(r) > halfDiag) r = Math.sign(r) * halfDiag;
  }
  const off = { x: (ux.x * Math.cos(phi) + uy.x * Math.sin(phi)) * r, y: (ux.y * Math.cos(phi) + uy.y * Math.sin(phi)) * r };
  const E = { x: oAB.x + off.x, y: oAB.y + off.y };
  return { E, F: { x: 2 * G.x - E.x, y: 2 * G.y - E.y }, G };
}

/** Deployed (3D) E,F: same paper frame (O=midpoint(AB), F=2G−E, clamped) in the void's 3D plane. */
export function placeEF3D(corners3: Vec3[], R: number, phi: number): { E: Vec3; F: Vec3 } {
  const G: Vec3 = { x: corners3.reduce((s, p) => s + p.x, 0) / corners3.length, y: corners3.reduce((s, p) => s + p.y, 0) / corners3.length, z: corners3.reduce((s, p) => s + p.z, 0) / corners3.length };
  const oAB: Vec3 = { x: (corners3[0].x + corners3[1].x) / 2, y: (corners3[0].y + corners3[1].y) / 2, z: (corners3[0].z + corners3[1].z) / 2 };
  const ab = sub3(corners3[1], corners3[0]);
  const al = len3(ab) || 1;
  const u = scale(ab, 1 / al);
  const n = normalize(cross(ab, sub3(corners3[corners3.length - 1], corners3[0])));
  const v = cross(n, u);
  let r = R * al;
  const halfDiag = 0.45 * Math.min(al, len3(sub3(corners3[2], corners3[1])) || al);
  if (Math.abs(r) > halfDiag) r = Math.sign(r) * halfDiag;
  const off = add(scale(u, Math.cos(phi) * r), scale(v, Math.sin(phi) * r));
  const E = add(oAB, off);
  return { E, F: sub3(scale(G, 2), E) };
}

/** Point strictly inside polygon (ray cast). */
function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * True if either bar endpoint lands inside a flanking tile (Sec 2.4 self-intersection). Endpoints
 * clamped into the void won't be inside a tile; an over-reaching bar will be. Endpoint-in-tile is
 * robust where segment-vs-boundary over-flags (the void boundary edges ARE the flanking tile edges).
 */
function barIntersectsTiles(E: Vec2, F: Vec2, voidCorners: number[], tiling: BstTiling): boolean {
  const cs = new Set(voidCorners);
  for (const tile of tiling.tiles) {
    if (!tile.some((v) => cs.has(v))) continue; // only tiles flanking this void
    const poly = tile.map((v) => tiling.vertices[v]);
    if (pointInPoly(E, poly) || pointInPoly(F, poly)) return true;
  }
  return false;
}

/**
 * Solve a bar per void from the contracted + deployed tilings. `localScale(i)` gives the void's
 * deployed/contracted scale factor (varies spatially after surface relaxation).
 */
export function solveBars(
  contracted: BstTiling,
  localScale: (voidIndex: number) => number,
  alpha: number,
  gamma: number,
  epsilon: number,
): PlacedBar[] {
  const bars: PlacedBar[] = [];
  contracted.voids.forEach((vc, i) => {
    const corners = vc.corners.map((id) => contracted.vertices[id]);
    if (vc.corners.length !== 4) { bars.push({ voidIndex: i, Ec: corners[0], Fc: corners[0], R: 0, phi: 0, skipped: true, reason: "few-corners" }); return; }
    const beta = localBeta(gamma, alpha, Math.max(1, localScale(i)));
    if (beta === null) { bars.push({ voidIndex: i, Ec: corners[0], Fc: corners[0], R: 0, phi: 0, skipped: true, reason: "scale-out-of-range" }); return; }
    const sol = solveBar(alpha, beta, gamma, epsilon);
    if (!sol) { bars.push({ voidIndex: i, Ec: corners[0], Fc: corners[0], R: 0, phi: 0, skipped: true, reason: "no-solution" }); return; }
    if (sol.phi <= 0) { bars.push({ voidIndex: i, Ec: corners[0], Fc: corners[0], R: sol.R, phi: sol.phi, skipped: true, reason: "phi-nonpositive" }); return; }
    const { E, F } = placeEF(corners, sol.R, sol.phi);
    if (barIntersectsTiles(E, F, vc.corners, contracted)) { bars.push({ voidIndex: i, Ec: E, Fc: F, R: sol.R, phi: sol.phi, skipped: true, reason: "self-intersection" }); return; }
    bars.push({ voidIndex: i, Ec: E, Fc: F, R: sol.R, phi: sol.phi, skipped: false });
  });
  return bars;
}
