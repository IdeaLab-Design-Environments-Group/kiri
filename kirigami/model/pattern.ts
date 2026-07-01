import { computeMinorCutLength, MINOR_CUT_FORMULA } from "./geometry.js";
import type { KirigamiState } from "./types.js";

/** SVG segment roles — stroke/fill styling is CSS-only (plan §5–6). */
export type PatternStrokeRole =
  | "polygon"
  | "boundary"
  | "molecule-fill"
  | "molecule"
  | "cut"
  | "fold";

export interface PatternSegment {
  role: PatternStrokeRole;
  /** SVG path `d` attribute (M/L/Z). */
  d: string;
}

export interface PatternNet {
  viewBox: [number, number, number, number];
  segments: PatternSegment[];
}

interface Point2 {
  x: number;
  y: number;
}


/**
 * Figure 2 (DETC) apex-centered fan with major cut at the closure vertex:
 * - Closure vertex O at origin (= 3D apex in M_0).
 * - A small 2N-gon hole around O is the **major cut** (material removed around the shared apex per DETC §3.1).
 * - N lateral-face polygons drawn as **truncated isosceles triangles** (trapezoids): inner chord on the inner 2N-gon at radius rApex, outer base chord (length L) on the outer 2N-gon at radius s; each subtends angle η at O.
 * - N molecule trapezoids in the wedges between adjacent polygons; legs on the shared slant rays; inner chord at radius rApex, outer chord (length w = 2 s sin(θ/2)) at radius s; each subtends angle θ at O.
 * - Inner and outer perimeters are concentric 2N-gons centered at O; inner-side angular vertices coincide between polygons and molecules so the inner 2N-gon (major cut outline) is continuous.
 */
export function buildPatternNet(state: KirigamiState): PatternNet {
  const N = Math.max(3, Math.round(state.inputs.edgeCount));
  const s = state.s;
  const eta = state.eta;
  const tau = state.tau;

  const O: Point2 = { x: 0, y: 0 };

  // Phase offset: center polygon 0 along −y so the pattern faces upward in screen space.
  const phaseOffset = -Math.PI / 2 - eta / 2;

  // Major-cut radius from §2.6.4: rApex = T / sin(θ/2), clamped to ≤ 0.4·s in computeRApex.
  const rApex = state.rApex;

  const ringPoint = (radius: number, angle: number): Point2 => ({
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  });

  // 2N angular rays from O. Polygon k inner span is η (centered at kτ+η/2+φ); molecule k
  // spans [kτ+η+φ, (k+1)τ+φ] at the inner ring.
  const angleLeft = (k: number): number => k * tau + phaseOffset;
  const angleRight = (k: number): number => k * tau + eta + phaseOffset;
  const polyOuterBisector = (k: number): number => k * tau + eta / 2 + phaseOffset;

  // Outer polygon-base length L_o (user input; default = L). It sets the half-span of each
  // polygon's outer base on the radius-s circle (chord = 2·s·sin(outerHalf)); molecule outer
  // chords absorb the remainder so the outer 2N-gon stays closed. L_o = L ⇒ outerHalf = η/2.
  const outerEdgeLength =
    state.inputs.outerEdgeLength && state.inputs.outerEdgeLength > 0
      ? state.inputs.outerEdgeLength
      : state.inputs.edgeLength;
  const maxOuterHalf = tau / 2 - 1e-3; // keep molecule outer span ≥ 0
  const outerHalf = Math.min(
    Math.max(Math.asin(Math.min(1, outerEdgeLength / (2 * s))), 1e-4),
    maxOuterHalf,
  );
  // Rendered molecule outer chord — widens as the polygon outer base narrows and vice versa.
  const wRendered = 2 * s * Math.sin(Math.max(0, tau / 2 - outerHalf));

  const polyInnerL: Point2[] = [];
  const polyInnerR: Point2[] = [];
  const polyOuterL: Point2[] = [];
  const polyOuterR: Point2[] = [];
  for (let k = 0; k < N; k++) {
    polyInnerL.push(ringPoint(rApex, angleLeft(k)));
    polyInnerR.push(ringPoint(rApex, angleRight(k)));
    polyOuterL.push(ringPoint(s, polyOuterBisector(k) - outerHalf));
    polyOuterR.push(ringPoint(s, polyOuterBisector(k) + outerHalf));
  }

  // Molecule k between polygon k's right slant (angle k τ + η) and polygon (k+1)%N's left slant (angle (k+1) τ).
  // Outer corners coincide with adjacent polygons' outer corners; inner corners coincide with adjacent polygons' inner corners.
  const molecules: [Point2, Point2, Point2, Point2][] = [];
  for (let k = 0; k < N; k++) {
    const innerL = polyInnerR[k];
    const innerR = polyInnerL[(k + 1) % N];
    const outerL = polyOuterR[k];
    const outerR = polyOuterL[(k + 1) % N];
    molecules.push([innerL, innerR, outerR, outerL]);
  }

  // Shift to non-negative viewBox.
  const allPts: Point2[] = [
    O,
    ...polyInnerL,
    ...polyInnerR,
    ...polyOuterL,
    ...polyOuterR,
  ];
  const bounds = computeBounds(allPts);
  const margin = 24;
  const ox = -bounds.minX + margin;
  const oy = -bounds.minY + margin;
  const shift = (p: Point2): Point2 => ({ x: p.x + ox, y: p.y + oy });
  const apex = shift(O);

  const polyInnerLS = polyInnerL.map(shift);
  const polyInnerRS = polyInnerR.map(shift);
  const polyOuterLS = polyOuterL.map(shift);
  const polyOuterRS = polyOuterR.map(shift);
  const moleculesS = molecules.map(
    (m) => m.map(shift) as [Point2, Point2, Point2, Point2],
  );

  const segments: PatternSegment[] = [];

  // N polygon triangles: tip on the polygon-inner-edge chord (major-cut boundary).
  const polyTips: Point2[] = polyInnerLS.map((innerL, k) =>
    lerp(innerL, polyInnerRS[k], 0.5),
  );
  for (let k = 0; k < N; k++) {
    segments.push({
      role: "polygon",
      d: closedPolyline([polyTips[k], polyOuterLS[k], polyOuterRS[k]]),
    });
  }

  // N molecules: legs lie on the polygon slants (not radial from O), with the inner-2N-gon
  // portion clipped out. The clipped molecule is a hexagon — the user's 4-corner trapezoid
  // path with polyTip points inserted between innerR/p2 (right) and after p3 (left). The
  // helper-based fold/minor-cut logic still operates on the underlying trapezoid data.
  // T is consulted by the "lie-flat" minor-cut formula; ignored by "tuck-flap".
  const minorLen = computeMinorCutLength(
    state.gamma,
    wRendered,
    state.inputs.materialThickness,
    state.theta,
    state.rApex,
  );

  // Pre-compute the relief-wedge convergence point (foldPt) per molecule. The outer wedge —
  // bounded by the outer chord (between adjacent polygon corners) and the two slit lines that
  // converge at foldPt — is REMOVED from the silhouette: the boundary outline jogs inward to
  // foldPt at each molecule instead of running the chord. So the wedge isn't material at all,
  // not an interior triangle "resting in the body".
  const foldPtS: Point2[] = [];
  for (let k = 0; k < N; k++) {
    const mol = moleculesS[k];
    const molApex = moleculeApex(mol);
    const { foldAtP2 } = moleculeMinorCutEndpoints(mol, minorLen, molApex);
    // For the active fold-reach formula the two slit endpoints converge to one point; foldAtP2
    // and foldAtP3 coincide. Use foldAtP2 as the wedge-vertex / V-notch tip.
    foldPtS.push(foldAtP2);
  }

  for (let k = 0; k < N; k++) {
    const mol = moleculesS[k];
    const polyTipL = polyTips[k];
    const polyTipR = polyTips[(k + 1) % N];
    // Fill traces the wedge-excluded shape (matches the V-notched silhouette).
    segments.push({
      role: "molecule-fill",
      d: closedPolyline(
        injectPolyTipsCW(moleculeFillPolygon(mol, minorLen, apex), polyTipL, polyTipR),
      ),
    });
    // Outline keeps the full trapezoid + polyTips so the canvas legend/helpers still see the
    // four molecule corners (the boundary V-notches the silhouette regardless).
    segments.push({
      role: "molecule",
      d: closedPolyline(
        injectPolyTipsCW([mol[0], mol[1], mol[2], mol[3]], polyTipL, polyTipR),
      ),
    });
  }

  // Major cut: the inner 2N-gon outline around the closure vertex (region inside is removed).
  const majorCutPts: Point2[] = [];
  for (let k = 0; k < N; k++) {
    majorCutPts.push(polyInnerLS[k]);
    majorCutPts.push(polyInnerRS[k]);
  }
  segments.push({
    role: "cut",
    d: closedPolyline(majorCutPts),
  });

  // Valley creases per molecule. Shortened to start at foldPt (the wedge convergence) rather
  // than the outer-chord midpoint — the outer half of the centreline is in the removed wedge.
  for (let k = 0; k < N; k++) {
    const mol = moleculesS[k];
    const molApex = moleculeApex(mol);
    const [innerL, innerR] = moleculeInnerVertices(mol, molApex);
    const innerMid = lerp(innerL, innerR, 0.5);
    const foldPt = foldPtS[k];
    segments.push({
      role: "fold",
      d: `M ${foldPt.x} ${foldPt.y} L ${innerMid.x} ${innerMid.y}`,
    });
  }

  // Outer boundary: 3N-gon V-notched at each molecule. The path threads polyOuterL[k] →
  // polyOuterR[k] (polygon base) → foldPt[k] (V-notch tip) → polyOuterL[k+1] (next polygon),
  // so the relief wedge is OUTSIDE the silhouette — fully cut away in one outline path.
  const boundaryPts: Point2[] = [];
  for (let k = 0; k < N; k++) {
    boundaryPts.push(polyOuterLS[k]);
    boundaryPts.push(polyOuterRS[k]);
    boundaryPts.push(foldPtS[k]);
  }
  segments.push({
    role: "boundary",
    d: closedPolyline(boundaryPts),
  });

  const width = bounds.maxX - bounds.minX + margin * 2;
  const height = bounds.maxY - bounds.minY + margin * 2;

  return { viewBox: [0, 0, width, height], segments };
}

/**
 * Symmetric trapezoid molecule for the Figure 2 fan.
 * Legs lie on the two slants b→outerLeft and b→outerRight; outer corners are at outerLeft/outerRight; inner corners are along the same slants at fraction `innerFraction` of the slant length from b.
 */
export function cornerMoleculeTrapezoid(
  b: Point2,
  outerLeft: Point2,
  outerRight: Point2,
  innerFraction: number = 0.12,
): [Point2, Point2, Point2, Point2] {
  const u0 = unitVector(sub(outerLeft, b));
  const u1 = unitVector(sub(outerRight, b));
  const sLeft = dist(b, outerLeft);
  const sRight = dist(b, outerRight);
  const dIn = innerFraction * Math.min(sLeft, sRight);

  const innerL = { x: b.x + u0.x * dIn, y: b.y + u0.y * dIn };
  const innerR = { x: b.x + u1.x * dIn, y: b.y + u1.y * dIn };

  return [innerL, innerR, outerRight, outerLeft];
}

/**
 * The two vertices on the outer (perimeter) chord — the edge whose endpoints are
 * farthest from the fan apex O (larger radial distance than the inner chord).
 */
export function moleculeOuterVertices(
  molecule: [Point2, Point2, Point2, Point2],
  apex: Point2,
): [Point2, Point2] {
  const min01 = Math.min(dist(molecule[0], apex), dist(molecule[1], apex));
  const min23 = Math.min(dist(molecule[2], apex), dist(molecule[3], apex));
  if (min23 >= min01 - 1e-9) {
    return [molecule[2], molecule[3]];
  }
  return [molecule[0], molecule[1]];
}

/**
 * Underlying trapezoid [innerL, innerR, outerR, outerL] from a rendered molecule path.
 * Hexagon outlines from `injectPolyTipsCW` are [innerL, innerR, polyTipR, outerR, outerL, polyTipL].
 */
export function moleculeTrapezoidFromOutlinePath(
  pathVerts: Point2[],
): [Point2, Point2, Point2, Point2] {
  if (pathVerts.length >= 6) {
    return [pathVerts[0], pathVerts[1], pathVerts[3], pathVerts[4]];
  }
  if (pathVerts.length === 4) {
    return [pathVerts[0], pathVerts[1], pathVerts[2], pathVerts[3]];
  }
  return [
    pathVerts[0],
    pathVerts[1],
    pathVerts[2],
    pathVerts[pathVerts.length - 1],
  ];
}

/** Inner-chord endpoints (closer to apex O than the outer chord). */
export function moleculeInnerVertices(
  molecule: [Point2, Point2, Point2, Point2],
  apex: Point2,
): [Point2, Point2] {
  const min01 = Math.min(dist(molecule[0], apex), dist(molecule[1], apex));
  const min23 = Math.min(dist(molecule[2], apex), dist(molecule[3], apex));
  if (min01 <= min23 + 1e-9) {
    return [molecule[0], molecule[1]];
  }
  return [molecule[2], molecule[3]];
}

/**
 * Outer top vertices on the right / left slants (p2 / p3 in DETC order).
 * Preserves topology: p2 on innerR slant, p3 on innerL slant.
 */
export function moleculeSlantOuterVertices(
  molecule: [Point2, Point2, Point2, Point2],
  apex: Point2,
): { p2: Point2; p3: Point2 } {
  const [a, b] = moleculeOuterVertices(molecule, apex);
  const distToSlantR = (p: Point2) =>
    Math.min(dist(p, molecule[1]), dist(p, molecule[2]));
  if (distToSlantR(a) <= distToSlantR(b) + 1e-9) {
    return { p2: a, p3: b };
  }
  return { p2: b, p3: a };
}

/** Midpoint of the molecule outer chord (farthest from apex O). */
export function moleculeTopEdgeMidpoint(
  molecule: [Point2, Point2, Point2, Point2],
  apex: Point2 = moleculeApex(molecule),
): Point2 {
  const { p2, p3 } = moleculeSlantOuterVertices(molecule, apex);
  return lerp(p3, p2, 0.5);
}

/**
 * Minor-cut endpoints on the two slant legs (p2 = outerR, p3 = outerL in molecule order).
 */
export function moleculeMinorCutEndpoints(
  molecule: [Point2, Point2, Point2, Point2],
  minorLength: number,
  apex: Point2 = moleculeApex(molecule),
): { foldAtP2: Point2; foldAtP3: Point2 } {
  const { p2, p3 } = moleculeSlantOuterVertices(molecule, apex);
  if (minorLength <= 0) {
    return { foldAtP2: p2, foldAtP3: p3 };
  }

  const { minorCuts } = cornerCutFoldSegments(molecule, minorLength, apex);
  let foldAtP2 = p2;
  let foldAtP3 = p3;
  for (const cut of minorCuts) {
    if (dist(cut.start, p2) <= 1e-9) {
      foldAtP2 = cut.end;
    } else if (dist(cut.start, p3) <= 1e-9) {
      foldAtP3 = cut.end;
    }
  }
  return { foldAtP2, foldAtP3 };
}

/**
 * Molecule fill polygon: trapezoid minus the top wedge between the outer chord (p2–p3),
 * the two minor cuts (p2→fold, p3→fold), and the valley-fold segment between the minor
 * endpoints (DETC material removal).
 *
 * CCW boundary: innerL → innerR → p2 (right slant) → fold@p2 → fold@p3 (valley fold) →
 * p3 (left slant) → innerL. When minor cuts meet on the fold, fold@p2 and fold@p3
 * coincide but the slant legs to p2/p3 remain.
 */
export function moleculeFillPolygon(
  molecule: [Point2, Point2, Point2, Point2],
  minorLength: number,
  apex: Point2 = moleculeApex(molecule),
): Point2[] {
  const [innerL, innerR] = moleculeInnerVertices(molecule, apex);
  const { p2, p3 } = moleculeSlantOuterVertices(molecule, apex);

  if (minorLength <= 0) {
    return [innerL, innerR, p2, p3];
  }

  const { foldAtP2, foldAtP3 } = moleculeMinorCutEndpoints(
    molecule,
    minorLength,
    apex,
  );

  const verts: Point2[] = [innerL, innerR];
  if (!pointsEqual(p2, foldAtP2)) {
    verts.push(p2);
  }
  if (!pointsEqual(foldAtP2, foldAtP3)) {
    verts.push(foldAtP2, foldAtP3);
  } else if (!pointsEqual(p2, foldAtP2) || !pointsEqual(p3, foldAtP3)) {
    verts.push(foldAtP2);
  }
  if (!pointsEqual(p3, foldAtP3)) {
    verts.push(p3);
  }

  return dedupeConsecutivePoints(verts);
}

/** Interior sample point for tests/visual checks (inside the fill, away from the top wedge). */
export function moleculeFillInteriorPoint(
  molecule: [Point2, Point2, Point2, Point2],
  minorLength: number,
  apex: Point2 = moleculeApex(molecule),
): Point2 {
  const [innerL, innerR] = moleculeInnerVertices(molecule, apex);
  const innerMid = lerp(innerL, innerR, 0.5);
  if (minorLength <= 0) {
    return innerMid;
  }
  const { foldAtP2, foldAtP3 } = moleculeMinorCutEndpoints(
    molecule,
    minorLength,
    apex,
  );
  const foldMid = lerp(foldAtP2, foldAtP3, 0.5);
  return lerp(innerMid, foldMid, 0.35);
}

/**
 * Molecule outline edges for the full trapezoid (inner edge, slant legs, outer chord p2–p3).
 * Fill uses `moleculeFillPolygon`; strokes use the uncut quad corners.
 */
export function moleculeOutlineSegments(
  molecule: [Point2, Point2, Point2, Point2],
  _minorLength: number = 0,
  _apex: Point2 = moleculeApex(molecule),
): [Point2, Point2][] {
  const [innerL, innerR, p2, p3] = molecule;
  return [
    [innerL, innerR],
    [innerR, p2],
    [innerL, p3],
    [p2, p3],
  ];
}

export interface CornerCutFoldSegments {
  valleyFold: { start: Point2; end: Point2 };
  /** One cut from each outer top-edge vertex (p2, p3) toward the valley fold. */
  minorCuts: { start: Point2; end: Point2 }[];
}

/**
 * Valley crease (outer-chord midpoint → inner-chord midpoint) and two minor cuts from
 * the outer top-edge vertices (p2, p3) inward toward that fold segment (never outward
 * from the fan apex or along the outer top chord).
 * `minorLength` is typically `computeMinorCutLength(γ, w, T)` (mm).
 */
export function cornerCutFoldSegments(
  molecule: [Point2, Point2, Point2, Point2],
  minorLength: number,
  apex: Point2 = moleculeApex(molecule),
): CornerCutFoldSegments {
  if (MINOR_CUT_FORMULA === "strip-removal") {
    return stripRemovalCuts(molecule, minorLength, apex);
  }
  const { p2, p3 } = moleculeSlantOuterVertices(molecule, apex);
  const topMid = moleculeTopEdgeMidpoint(molecule, apex);
  const [innerL, innerR] = moleculeInnerVertices(molecule, apex);
  const innerMid = lerp(innerL, innerR, 0.5);
  const valleyFold = { start: topMid, end: innerMid };
  const outerTop: [Point2, Point2] = [p2, p3];
  const topEdge = sub(p2, p3);

  const minorCuts: { start: Point2; end: Point2 }[] = [];
  for (const start of outerTop) {
    if (minorLength <= 0) {
      minorCuts.push({ start, end: start });
      continue;
    }

    const end = minorCutEndpointOnValleyFold(
      start,
      topMid,
      innerMid,
      apex,
      topEdge,
      minorLength,
    );
    if (!end || dist(start, end) <= 1e-9) {
      const foot = nearestInwardPointOnValleyFold(start, topMid, innerMid, apex);
      if (foot && dist(start, foot) > 1e-9) {
        minorCuts.push({ start, end: foot });
      } else {
        minorCuts.push({ start, end: start });
      }
      continue;
    }

    minorCuts.push({ start, end });
  }

  return { valleyFold, minorCuts };
}

/**
 * Endpoint of a minor cut on the valley fold segment (topMid → innerMid).
 * Ray from `start` toward the fan apex intersects the fold; otherwise the nearest
 * inward point on the fold. Length is capped by `minorLength` and radial limit
 * (endpoint not farther from apex than `start`).
 */
export function minorCutEndpointOnValleyFold(
  start: Point2,
  topMid: Point2,
  innerMid: Point2,
  apex: Point2,
  topEdge: Point2,
  minorLength: number,
): Point2 | null {
  if (minorLength <= 0) {
    return null;
  }

  const towardCenter = sub(apex, start);
  const rStart = dist(start, apex);
  const candidates: Point2[] = [];

  const pathPoint = valleyFoldPointAtPathLength(
    start,
    topMid,
    innerMid,
    minorLength,
  );
  if (pathPoint) {
    candidates.push(pathPoint);
  }

  for (const p of circleSegmentIntersections(start, minorLength, topMid, innerMid)) {
    candidates.push(p);
  }

  for (const p of circleSegmentIntersections(apex, rStart, topMid, innerMid)) {
    candidates.push(p);
  }

  const nearestInward = nearestInwardPointOnValleyFold(
    start,
    topMid,
    innerMid,
    apex,
  );
  if (nearestInward) {
    candidates.push(nearestInward);
  }

  let best: Point2 | null = null;
  let bestLen = -1;
  for (const p of candidates) {
    if (!pointOnClosedSegment(p, topMid, innerMid)) {
      continue;
    }
    const cutLen = dist(start, p);
    if (cutLen > minorLength + 1e-9) {
      continue;
    }
    if (dot(sub(p, start), towardCenter) <= 0) {
      continue;
    }
    if (dist(p, apex) > rStart + 1e-9) {
      continue;
    }
    if (cutLen > bestLen) {
      bestLen = cutLen;
      best = p;
    }
  }

  if (best) {
    return best;
  }

  // w·tan((π−γ)/2) can be shorter than the perpendicular distance to topMid (w/2)
  // for large N / shallow pyramids. The geometric foot is then topMid, but topMid is
  // the midpoint of the molecule's outer chord — a straight cut start→topMid lies on
  // that chord and is hidden under the molecule outline and outer-boundary strokes.
  // Aim instead along start→innerMid by minorLength so the cut enters the molecule
  // interior, preserving the dihedral-derived length and remaining visible.
  const foot = nearestInwardPointOnValleyFold(start, topMid, innerMid, apex);
  if (
    foot &&
    dist(start, foot) > 1e-9 &&
    dot(sub(foot, start), towardCenter) > 0 &&
    dist(foot, apex) <= rStart + 1e-9 &&
    pointOnClosedSegment(foot, topMid, innerMid)
  ) {
    if (pointsEqual(foot, topMid, 1e-6)) {
      const toward = sub(innerMid, start);
      const total = Math.hypot(toward.x, toward.y);
      if (total > 1e-9) {
        const t = Math.min(1, minorLength / total);
        return { x: start.x + toward.x * t, y: start.y + toward.y * t };
      }
    }
    return foot;
  }

  return longestFeasiblePointOnValleyFold(
    start,
    topMid,
    innerMid,
    apex,
    minorLength,
  );
}

/** Longest cut endpoint on topMid→innerMid satisfying inward + radial caps. */
function longestFeasiblePointOnValleyFold(
  start: Point2,
  topMid: Point2,
  innerMid: Point2,
  apex: Point2,
  minorLength: number,
): Point2 | null {
  const towardCenter = sub(apex, start);
  const rStart = dist(start, apex);
  let best: Point2 | null = null;
  let bestLen = 0;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const p = lerp(topMid, innerMid, i / steps);
    const cutLen = dist(start, p);
    if (cutLen <= 1e-9) {
      continue;
    }
    if (cutLen > minorLength + 1e-9) {
      continue;
    }
    if (dot(sub(p, start), towardCenter) <= 0) {
      continue;
    }
    if (dist(p, apex) > rStart + 1e-9) {
      continue;
    }
    if (cutLen > bestLen) {
      bestLen = cutLen;
      best = p;
    }
  }
  return best;
}

/**
 * Strip-removal mode: emit the three inner edges of the trapezoidal overlap
 * strip (right slant-leg portion p2→p2', strip bottom p2'→p3', left slant-leg
 * portion p3'→p3) as cut segments. The outer-chord side of the strip is the
 * pattern's outer boundary and is not emitted again. The valley fold is
 * shortened to run from the new top-mid (midpoint of p2'p3') to the inner
 * mid, since the original outer portion of the crease is inside the removed
 * strip. `depth` is `T/sin(γ/2)` from computeMinorCutLength.
 */
function stripRemovalCuts(
  molecule: [Point2, Point2, Point2, Point2],
  depth: number,
  apex: Point2,
): CornerCutFoldSegments {
  const { p2, p3 } = moleculeSlantOuterVertices(molecule, apex);
  const [innerL, innerR] = moleculeInnerVertices(molecule, apex);
  const innerMid = lerp(innerL, innerR, 0.5);
  const outerMid = lerp(p3, p2, 0.5);

  if (depth <= 0) {
    return {
      valleyFold: { start: outerMid, end: innerMid },
      minorCuts: [],
    };
  }

  const towardInner = sub(innerMid, outerMid);
  const towardInnerLen = Math.hypot(towardInner.x, towardInner.y);
  if (towardInnerLen < 1e-12) {
    return {
      valleyFold: { start: outerMid, end: innerMid },
      minorCuts: [],
    };
  }
  const perpDir = {
    x: towardInner.x / towardInnerLen,
    y: towardInner.y / towardInnerLen,
  };

  // p2_prime: on right slant (p2→innerR) at perpendicular depth `depth` from outer chord.
  const slantR = sub(innerR, p2);
  const depthPerUnitR = dot(slantR, perpDir);
  if (depthPerUnitR <= 1e-9) {
    return {
      valleyFold: { start: outerMid, end: innerMid },
      minorCuts: [],
    };
  }
  const tR = Math.min(1, depth / depthPerUnitR);
  const p2_prime = {
    x: p2.x + tR * slantR.x,
    y: p2.y + tR * slantR.y,
  };

  // p3_prime: on left slant (p3→innerL) similarly.
  const slantL = sub(innerL, p3);
  const depthPerUnitL = dot(slantL, perpDir);
  if (depthPerUnitL <= 1e-9) {
    return {
      valleyFold: { start: outerMid, end: innerMid },
      minorCuts: [],
    };
  }
  const tL = Math.min(1, depth / depthPerUnitL);
  const p3_prime = {
    x: p3.x + tL * slantL.x,
    y: p3.y + tL * slantL.y,
  };

  const newTopMid = lerp(p3_prime, p2_prime, 0.5);
  return {
    valleyFold: { start: newTopMid, end: innerMid },
    minorCuts: [
      { start: p2, end: p2_prime },
      { start: p2_prime, end: p3_prime },
      { start: p3_prime, end: p3 },
    ],
  };
}

/** Fan apex at intersection of the two molecule leg rays (innerL–outerL and innerR–outerR). */
export function moleculeApex(
  molecule: [Point2, Point2, Point2, Point2],
): Point2 {
  return lineIntersection(molecule[0], molecule[3], molecule[1], molecule[2]);
}

/**
 * Point on the valley fold (topMid → innerMid) reached by traveling from an outer
 * vertex toward topMid, then along the fold, for a total path length `pathLength`.
 * Returns null if the path ends before topMid (no point on the fold segment yet).
 */
export function valleyFoldPointAtPathLength(
  start: Point2,
  topMid: Point2,
  innerMid: Point2,
  pathLength: number,
): Point2 | null {
  const legToTop = dist(start, topMid);
  if (legToTop < 1e-12) {
    return topMid;
  }
  if (pathLength + 1e-9 < legToTop) {
    return null;
  }
  const alongFold = pathLength - legToTop;
  const foldLen = dist(topMid, innerMid);
  if (foldLen < 1e-12) {
    return topMid;
  }
  const t = Math.min(1, alongFold / foldLen);
  return lerp(topMid, innerMid, t);
}

/** Nearest point on the valley fold segment that lies inward from `start` toward `apex`. */
export function nearestInwardPointOnValleyFold(
  start: Point2,
  topMid: Point2,
  innerMid: Point2,
  apex: Point2,
): Point2 | null {
  const towardCenter = sub(apex, start);
  const rayHit = raySegmentIntersection(start, towardCenter, topMid, innerMid);
  if (rayHit) {
    return rayHit;
  }
  const nearest = nearestPointOnSegment(start, topMid, innerMid);
  if (dot(sub(nearest, start), towardCenter) > 0) {
    return nearest;
  }
  return null;
}

/** @deprecated Use nearestInwardPointOnValleyFold — kept for tests referencing inward path. */
export function inwardFoldTarget(
  start: Point2,
  topMid: Point2,
  innerMid: Point2,
  apex: Point2,
  _topEdge: Point2,
): Point2 {
  return (
    nearestInwardPointOnValleyFold(start, topMid, innerMid, apex) ?? innerMid
  );
}

/**
 * Convert an OLD-trapezoid molecule path [innerL, innerR, ..., p3] (CW) into the
 * inner-2N-gon-clipped HEXAGON path by inserting `polyTipR` after innerR and
 * `polyTipL` after p3 (= end of array). Result CW order:
 *   [innerL, innerR, polyTipR, ..., p3, polyTipL]
 * For the bare outline (4-vertex trapezoid) this yields the 6-vertex hexagon
 * [innerL, innerR, polyTipR, p2, p3, polyTipL].
 * For a fill path with intermediate fold-end vertices, the intermediates between
 * innerR and p3 are preserved (positions shift right by 1).
 */
export function injectPolyTipsCW(
  trapPath: Point2[],
  polyTipL: Point2,
  polyTipR: Point2,
): Point2[] {
  const result: Point2[] = [];
  for (let i = 0; i < trapPath.length; i++) {
    result.push(trapPath[i]);
    if (i === 1) result.push(polyTipR); // After innerR
  }
  result.push(polyTipL); // After p3 (last element)
  return result;
}

function lerp(a: Point2, b: Point2, t: number): Point2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function pointsEqual(a: Point2, b: Point2, tol = 1e-9): boolean {
  return dist(a, b) <= tol;
}

function dedupeConsecutivePoints(verts: Point2[], tol = 1e-9): Point2[] {
  if (verts.length === 0) {
    return verts;
  }
  const out: Point2[] = [verts[0]];
  for (let i = 1; i < verts.length; i++) {
    if (!pointsEqual(verts[i], out[out.length - 1], tol)) {
      out.push(verts[i]);
    }
  }
  if (out.length > 2 && pointsEqual(out[0], out[out.length - 1], tol)) {
    out.pop();
  }
  return out;
}

function sub(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unitVector(v: Point2): Point2 {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.y * b.y;
}

function cross2(a: Point2, b: Point2): number {
  return a.x * b.y - a.y * b.x;
}

/** Intersection of lines a0–a1 and b0–b1; falls back to a0 if parallel. */
function lineIntersection(a0: Point2, a1: Point2, b0: Point2, b1: Point2): Point2 {
  const dax = a1.x - a0.x;
  const day = a1.y - a0.y;
  const dbx = b1.x - b0.x;
  const dby = b1.y - b0.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-12) {
    return a0;
  }
  const t = ((b0.x - a0.x) * dby - (b0.y - a0.y) * dbx) / denom;
  return { x: a0.x + dax * t, y: a0.y + day * t };
}

/** Ray p + t·r (t ≥ 0) ∩ segment a–b, or null. */
function raySegmentIntersection(
  p: Point2,
  r: Point2,
  a: Point2,
  b: Point2,
): Point2 | null {
  const rx = r.x;
  const ry = r.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = cross2(r, { x: sx, y: sy });
  if (Math.abs(denom) < 1e-12) {
    return null;
  }
  const ap = sub(a, p);
  const t = cross2(ap, { x: sx, y: sy }) / denom;
  const u = cross2(ap, r) / denom;
  if (t < -1e-9 || u < -1e-9 || u > 1 + 1e-9) {
    return null;
  }
  return { x: p.x + rx * t, y: p.y + ry * t };
}

/** Points where |p - center| = radius on segment a–b (0, 1, or 2). */
function circleSegmentIntersections(
  center: Point2,
  radius: number,
  a: Point2,
  b: Point2,
): Point2[] {
  const ab = sub(b, a);
  const ac = sub(a, center);
  const A = dot(ab, ab);
  if (A < 1e-24) {
    return Math.abs(dist(a, center) - radius) <= 1e-9 ? [a] : [];
  }
  const B = 2 * dot(ac, ab);
  const C = dot(ac, ac) - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-12) {
    return [];
  }
  const out: Point2[] = [];
  const sqrtDisc = Math.sqrt(Math.max(0, disc));
  for (const t of [(-B - sqrtDisc) / (2 * A), (-B + sqrtDisc) / (2 * A)]) {
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      out.push({ x: a.x + ab.x * t, y: a.y + ab.y * t });
    }
  }
  return out;
}

function pointOnClosedSegment(p: Point2, a: Point2, b: Point2): boolean {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-24) {
    return dist(p, a) <= 1e-9;
  }
  const t = dot(sub(p, a), ab) / len2;
  if (t < -1e-9 || t > 1 + 1e-9) {
    return false;
  }
  const proj = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return dist(p, proj) <= 1e-9;
}

/** Closest point on segment a–b to point p (t clamped to [0, 1]). */
function nearestPointOnSegment(p: Point2, a: Point2, b: Point2): Point2 {
  const ab = sub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y;
  if (len2 < 1e-24) {
    return a;
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2),
  );
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function closedPolyline(verts: Point2[]): string {
  return verts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";
}

function openPolyline(verts: Point2[]): string {
  return verts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function computeBounds(points: Point2[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}
