import { describe, expect, it } from "vitest";
import { computeState } from "@kirigami/model/index.js";
import { computeMinorCutLength } from "@kirigami/model/index.js";
import {
  buildPatternNet,
  cornerCutFoldSegments,
  cornerMoleculeTrapezoid,
  injectPolyTipsCW,
  moleculeApex,
  moleculeFillInteriorPoint,
  moleculeFillPolygon,
  moleculeInnerVertices,
  moleculeMinorCutEndpoints,
  moleculeSlantOuterVertices,
  moleculeTopEdgeMidpoint,
  moleculeTrapezoidFromOutlinePath,
} from "@kirigami/model/pattern.js";

function parsePathPoints(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

function dist(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpPt(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function eqPt(
  a: { x: number; y: number },
  b: { x: number; y: number },
  tol = 1e-4,
): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tol;
}

function pointOnSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  tol = 1e-3,
): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) {
    return eqPt(p, a, tol);
  }
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  if (t < -1e-6 || t > 1 + 1e-6) {
    return false;
  }
  const px = a.x + abx * t;
  const py = a.y + aby * t;
  return Math.hypot(p.x - px, p.y - py) <= tol;
}

function dot(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return a.x * b.x + a.y * b.y;
}

/** Ray-casting point-in-polygon (simple polygon, consistent winding). */
function pointInPolygon(
  p: { x: number; y: number },
  verts: { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x;
    const yi = verts[i].y;
    const xj = verts[j].x;
    const yj = verts[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 0) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function trapezoidFromPath(pts: { x: number; y: number }[]) {
  return moleculeTrapezoidFromOutlinePath(pts);
}

describe("buildPatternNet (Figure 2 apex-centered fan)", () => {
  const state = computeState({
    edgeCount: 4,
    edgeLength: 100,
    totalCurvature: 100 / Math.SQRT2,
    materialThickness: 1,
  });

  it("produces N polygons + N molecules + N folds + major cut + V-notched boundary", () => {
    const net = buildPatternNet(state);
    const polygons = net.segments.filter((s) => s.role === "polygon");
    const molecules = net.segments.filter((s) => s.role === "molecule");
    const folds = net.segments.filter((s) => s.role === "fold");
    const cuts = net.segments.filter((s) => s.role === "cut");
    const boundaries = net.segments.filter((s) => s.role === "boundary");
    const N = 4;

    expect(polygons.length).toBe(N);
    expect(molecules.length).toBe(N);
    expect(folds.length).toBe(N);
    expect(cuts.length).toBe(1); // the single major (apex-hole) cut
    expect(boundaries.length).toBe(1); // one V-notched outline (wedges removed)
    expect(net.viewBox[2]).toBeGreaterThan(0);
    expect(net.viewBox[3]).toBeGreaterThan(0);
  });

  it("polygons are triangles with tip on the major-cut boundary; outer base has length L", () => {
    const net = buildPatternNet(state);
    const polygons = net.segments.filter((s) => s.role === "polygon");
    const tips: { x: number; y: number }[] = [];
    for (const poly of polygons) {
      const pts = parsePathPoints(poly.d);
      expect(pts.length).toBe(3);
      tips.push(pts[0]);
      const outerBaseLen = dist(pts[1], pts[2]);
      expect(outerBaseLen).toBeCloseTo(100, 3);
    }
    const centroid = {
      x: tips.reduce((a, p) => a + p.x, 0) / tips.length,
      y: tips.reduce((a, p) => a + p.y, 0) / tips.length,
    };
    const r0 = dist(centroid, tips[0]);
    for (const tip of tips) {
      expect(dist(centroid, tip)).toBeCloseTo(r0, 4);
    }
  });

  it("molecule outer-chord length equals state.w", () => {
    const net = buildPatternNet(state);
    const molecules = net.segments.filter((s) => s.role === "molecule");
    for (const mol of molecules) {
      const pts = parsePathPoints(mol.d);
      const [_, __, p2, p3] = trapezoidFromPath(pts);
      const outerChord = dist(p2, p3);
      expect(outerChord).toBeCloseTo(state.w, 3);
    }
  });

  it("outerEdgeLength sets each polygon's outer-base length (default L unchanged)", () => {
    const base = buildPatternNet(state).segments.filter((x) => x.role === "polygon");
    for (const poly of base) {
      const pts = parsePathPoints(poly.d);
      expect(dist(pts[1], pts[2])).toBeCloseTo(100, 3); // default L_o = L = 100
    }

    const wide = computeState({
      edgeCount: 4,
      edgeLength: 100,
      outerEdgeLength: 60,
      totalCurvature: 100 / Math.SQRT2,
      materialThickness: 1,
    });
    const net = buildPatternNet(wide);
    for (const poly of net.segments.filter((x) => x.role === "polygon")) {
      const pts = parsePathPoints(poly.d);
      expect(dist(pts[1], pts[2])).toBeCloseTo(60, 3);
    }
    // Outer 2N-gon still closes: molecule chords absorb the difference and grow past w.
    const molecules = net.segments.filter((x) => x.role === "molecule");
    for (const mol of molecules) {
      const [, , p2, p3] = trapezoidFromPath(parsePathPoints(mol.d));
      expect(dist(p2, p3)).toBeGreaterThan(wide.w);
    }
  });

  it("molecule outer corners coincide with adjacent polygons' outer base vertices", () => {
    const net = buildPatternNet(state);
    const polygons = net.segments.filter((s) => s.role === "polygon");
    const molecules = net.segments.filter((s) => s.role === "molecule");
    const N = polygons.length;
    const polyOuterR = polygons.map((p) => parsePathPoints(p.d)[2]);
    const polyOuterL = polygons.map((p) => parsePathPoints(p.d)[1]);

    for (let k = 0; k < N; k++) {
      const molPts = parsePathPoints(molecules[k].d);
      const [_, __, p2, p3] = trapezoidFromPath(molPts);
      expect(eqPt(p2, polyOuterL[(k + 1) % N], 1e-6)).toBe(true);
      expect(eqPt(p3, polyOuterR[k], 1e-6)).toBe(true);
    }
  });

  it("boundary is a V-notched 3N-gon: polygon base (L) then V to foldPt then next polygon", () => {
    const net = buildPatternNet(state);
    const boundary = net.segments.find((s) => s.role === "boundary");
    expect(boundary).toBeDefined();
    const pts = parsePathPoints(boundary!.d);
    const N = 4;
    expect(pts.length).toBe(3 * N); // polygon-left, polygon-right, foldPt, repeating

    for (let k = 0; k < N; k++) {
      const polyL = pts[3 * k];
      const polyR = pts[3 * k + 1];
      const foldPt = pts[3 * k + 2];
      const nextPolyL = pts[(3 * k + 3) % (3 * N)];
      // each polygon's outer base edge has length L
      expect(dist(polyL, polyR)).toBeCloseTo(100, 2);
      // the V-notch tip (foldPt) sits inside the original outer chord (closer to centre than
      // the chord midpoint between polyR and nextPolyL) — the wedge is removed
      const chordMid = { x: (polyR.x + nextPolyL.x) / 2, y: (polyR.y + nextPolyL.y) / 2 };
      const centre = { x: state.s + 24, y: state.s + 24 }; // approx — net is shifted by `margin`
      expect(dist(foldPt, centre)).toBeLessThan(dist(chordMid, centre));
    }
  });

  it("folds run from each molecule's wedge-vertex (foldPt) to its inner-chord midpoint", () => {
    const net = buildPatternNet(state);
    const molecules = net.segments.filter((s) => s.role === "molecule");
    const folds = net.segments.filter((s) => s.role === "fold");

    expect(folds.length).toBe(molecules.length);
    for (let k = 0; k < folds.length; k++) {
      const foldPts = parsePathPoints(folds[k].d);
      expect(foldPts.length).toBe(2);
      // one endpoint is the inner-chord midpoint; the other (foldPt) sits inside the wedge
      // region, strictly between the outer-chord midpoint and the inner-chord midpoint
      const molPts = trapezoidFromPath(parsePathPoints(molecules[k].d));
      const outerMid = moleculeTopEdgeMidpoint(molPts);
      const innerMid = {
        x: (molPts[0].x + molPts[1].x) / 2,
        y: (molPts[0].y + molPts[1].y) / 2,
      };
      const inner = foldPts.find((p) => eqPt(p, innerMid, 1e-3));
      const foldPt = foldPts.find((p) => !eqPt(p, innerMid, 1e-3));
      expect(inner).toBeDefined();
      expect(foldPt).toBeDefined();
      // foldPt is strictly between innerMid and outerMid (the wedge has positive depth)
      expect(dist(foldPt!, innerMid)).toBeGreaterThan(1);
      expect(dist(foldPt!, outerMid)).toBeGreaterThan(0);
      expect(dist(foldPt!, innerMid)).toBeLessThan(dist(outerMid, innerMid) - 1e-6);
    }
  });

  it("works for N=3 and N=6", () => {
    for (const N of [3, 6]) {
      const s = computeState({
        edgeCount: N,
        edgeLength: 100,
        totalCurvature: 100,
        materialThickness: 1,
      });
      const net = buildPatternNet(s);
      expect(net.segments.filter((x) => x.role === "polygon").length).toBe(N);
      expect(net.segments.filter((x) => x.role === "molecule").length).toBe(N);
      expect(net.segments.filter((x) => x.role === "fold").length).toBe(N);
      expect(net.segments.filter((x) => x.role === "cut").length).toBe(1);
      expect(net.segments.filter((x) => x.role === "boundary").length).toBe(1);
    }
  });

  it("minor cuts and clipped fill for N=3..8 with valid L,H", () => {
    const L = 100;
    const T = 1;

    function polygonArea(verts: { x: number; y: number }[]) {
      let a = 0;
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        a += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
      }
      return Math.abs(a) / 2;
    }

    for (const N of [3, 4, 5, 6, 7, 8]) {
      const H = L / Math.SQRT2;
      const s = computeState({
        edgeCount: N,
        edgeLength: L,
        totalCurvature: H,
        materialThickness: T,
      });
      const minorLen = computeMinorCutLength(s.gamma, s.w, s.inputs.materialThickness, s.theta, s.rApex);
      const net = buildPatternNet(s);
      const molecules = net.segments.filter((x) => x.role === "molecule");
      const fills = net.segments.filter((x) => x.role === "molecule-fill");

      expect(molecules.length).toBe(N);

      for (let k = 0; k < N; k++) {
        const mol = trapezoidFromPath(parsePathPoints(molecules[k].d));
        const apex = moleculeApex(mol);
        const topMid = moleculeTopEdgeMidpoint(mol, apex);
        const [innerL, innerR] = moleculeInnerVertices(mol, apex);
        const innerMid = lerpPt(innerL, innerR, 0.5);
        // cornerCutFoldSegments still gives the underlying slit endpoints (the wedge corners);
        // they are now consumed by the boundary's V-notch rather than exported as their own paths
        const { minorCuts } = cornerCutFoldSegments(mol, minorLen, apex);
        expect(minorCuts.length).toBe(2);
        for (const minorCut of minorCuts) {
          const cutLen = dist(minorCut.start, minorCut.end);
          expect(cutLen).toBeGreaterThan(0.5);
          expect(cutLen).toBeLessThanOrEqual(minorLen + 1e-6);
          const onFold = pointOnSegment(minorCut.end, topMid, innerMid, 1e-4);
          const onAimLine = pointOnSegment(minorCut.end, minorCut.start, innerMid, 1e-4);
          expect(onFold || onAimLine).toBe(true);
        }

        const fillVerts = parsePathPoints(fills[k].d);
        const bodyPt = moleculeFillInteriorPoint(mol, minorLen, apex);

        expect(polygonArea(fillVerts)).toBeGreaterThan(1);
        expect(pointInPolygon(bodyPt, fillVerts)).toBe(true);
      }
    }
  });

  it("relief wedges are removed by the V-notched boundary (no separate interior minor cuts)", () => {
    const net = buildPatternNet(state);
    const molecules = net.segments.filter((s) => s.role === "molecule");
    const boundary = net.segments.find((s) => s.role === "boundary")!;
    const expectedLen = computeMinorCutLength(state.gamma, state.w, state.inputs.materialThickness, state.theta, state.rApex);
    const N = molecules.length;
    expect(expectedLen).toBeGreaterThan(0);

    // Boundary V-notches inward at each molecule — exactly N inward vertices (foldPts).
    const bpts = parsePathPoints(boundary.d);
    expect(bpts.length).toBe(3 * N);

    // For each molecule, the boundary point at index 3k+2 (the foldPt / V-notch tip) sits
    // strictly inside the chord between the two adjacent polygon corners (wedge removed).
    for (let k = 0; k < N; k++) {
      const polyR = bpts[3 * k + 1];
      const foldPt = bpts[3 * k + 2];
      const nextPolyL = bpts[(3 * k + 3) % (3 * N)];
      const chordMid = { x: (polyR.x + nextPolyL.x) / 2, y: (polyR.y + nextPolyL.y) / 2 };
      // foldPt is offset inward from the chord midpoint (the wedge has positive depth)
      expect(dist(foldPt, chordMid)).toBeGreaterThan(0.1);
    }
  });

  it("cornerCutFoldSegments: two minor cuts from p2/p3 move inward without exceeding the cap", () => {
    const net = buildPatternNet(state);
    const molecules = net.segments.filter((s) => s.role === "molecule");
    const minorLen = computeMinorCutLength(state.gamma, state.w, state.inputs.materialThickness, state.theta, state.rApex);

    for (let k = 0; k < molecules.length; k++) {
      const mol = trapezoidFromPath(parsePathPoints(molecules[k].d));
      const apex = moleculeApex(mol);
      const { p2, p3 } = moleculeSlantOuterVertices(mol, apex);
      const { minorCuts, valleyFold } = cornerCutFoldSegments(mol, minorLen, apex);
      const topMid = moleculeTopEdgeMidpoint(mol, apex);
      const [innerL, innerR] = moleculeInnerVertices(mol, apex);
      const innerMid = lerpPt(innerL, innerR, 0.5);

      expect(eqPt(valleyFold.start, topMid, 1e-9)).toBe(true);
      expect(eqPt(valleyFold.end, innerMid, 1e-6)).toBe(true);
      expect(minorCuts.length).toBe(2);

      const starts = minorCuts.map((c) => c.start);
      expect(starts.some((s) => eqPt(s, p2, 1e-9))).toBe(true);
      expect(starts.some((s) => eqPt(s, p3, 1e-9))).toBe(true);
      for (const minorCut of minorCuts) {
        const cutLen = dist(minorCut.start, minorCut.end);
        expect(cutLen).toBeGreaterThan(0);
        expect(cutLen).toBeLessThanOrEqual(minorLen + 1e-6);
        const inward = {
          x: minorCut.end.x - minorCut.start.x,
          y: minorCut.end.y - minorCut.start.y,
        };
        const toCenter = {
          x: apex.x - minorCut.start.x,
          y: apex.y - minorCut.start.y,
        };
        expect(dot(inward, toCenter)).toBeGreaterThan(0);
        expect(dist(minorCut.end, apex)).toBeLessThanOrEqual(
          dist(minorCut.start, apex) + 1e-6,
        );
        expect(pointOnSegment(minorCut.end, p3, p2, 1e-4)).toBe(false);
      }
    }
  });

  it("the V-notch tip on the boundary stays in the outer molecule region (N=3,5,6,7)", () => {
    for (const N of [3, 5, 6, 7]) {
      const s = computeState({
        edgeCount: N,
        edgeLength: 100,
        totalCurvature: 100 / Math.SQRT2,
        materialThickness: 1,
      });
      const net = buildPatternNet(s);
      const molecules = net.segments.filter((x) => x.role === "molecule");
      const boundary = net.segments.find((x) => x.role === "boundary")!;
      const bpts = parsePathPoints(boundary.d);
      expect(bpts.length).toBe(3 * N);

      for (let k = 0; k < N; k++) {
        const mol = trapezoidFromPath(parsePathPoints(molecules[k].d));
        const apex = moleculeApex(mol);
        const [innerL, innerR] = moleculeInnerVertices(mol, apex);
        const innerMid = lerpPt(innerL, innerR, 0.5);
        const dInner = dist(innerMid, apex);

        // the foldPt (V-notch tip on the boundary) is farther from the fan apex than the inner chord
        const foldPt = bpts[3 * k + 2];
        expect(dist(foldPt, apex)).toBeGreaterThan(dInner + 1e-6);

        const { p2, p3 } = moleculeSlantOuterVertices(mol, apex);
        expect(dist(p2, apex)).toBeGreaterThan(dInner + 1e-6);
        expect(dist(p3, apex)).toBeGreaterThan(dInner + 1e-6);
      }
    }
  });

  it("molecule fill excludes wedge between top chord and minor cuts", () => {
    const net = buildPatternNet(state);
    const outlines = net.segments.filter((s) => s.role === "molecule");
    const fills = net.segments.filter((s) => s.role === "molecule-fill");
    const minorLen = computeMinorCutLength(state.gamma, state.w, state.inputs.materialThickness, state.theta, state.rApex);
    expect(minorLen).toBeGreaterThan(0);

    for (let k = 0; k < outlines.length; k++) {
      const mol = trapezoidFromPath(parsePathPoints(outlines[k].d));
      const fillVerts = parsePathPoints(fills[k].d);
      const apex = moleculeApex(mol);
      const { p2, p3 } = moleculeSlantOuterVertices(mol, apex);
      const { foldAtP2, foldAtP3 } = moleculeMinorCutEndpoints(mol, minorLen, apex);
      const wedgePt = {
        x: (p2.x + p3.x + foldAtP2.x + foldAtP3.x) / 4,
        y: (p2.y + p3.y + foldAtP2.y + foldAtP3.y) / 4,
      };
      const bodyPt = moleculeFillInteriorPoint(mol, minorLen, apex);

      expect(pointInPolygon(wedgePt, fillVerts)).toBe(false);
      expect(pointInPolygon(bodyPt, fillVerts)).toBe(true);

      const outlinePts = parsePathPoints(outlines[k].d);
      const polyTipR = outlinePts[2];
      const polyTipL = outlinePts[outlinePts.length - 1];
      const expected = injectPolyTipsCW(
        moleculeFillPolygon(mol, minorLen),
        polyTipL,
        polyTipR,
      );
      expect(fillVerts.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(eqPt(fillVerts[i], expected[i], 1e-6)).toBe(true);
      }
    }
  });

  it("molecule fill has positive area between major and minor cuts for N=3,4 at H=70.7", () => {
    function polygonArea(verts: { x: number; y: number }[]) {
      let a = 0;
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        a += verts[i].x * verts[j].y - verts[j].x * verts[i].y;
      }
      return Math.abs(a) / 2;
    }

    for (const N of [3, 4]) {
      const s = computeState({
        edgeCount: N,
        edgeLength: 100,
        totalCurvature: 70.7,
        materialThickness: 1,
      });
      const net = buildPatternNet(s);
      const outlines = net.segments.filter((x) => x.role === "molecule");
      const fills = net.segments.filter((x) => x.role === "molecule-fill");
      const minorLen = computeMinorCutLength(s.gamma, s.w, s.inputs.materialThickness, s.theta, s.rApex);

      for (let k = 0; k < N; k++) {
        const mol = trapezoidFromPath(parsePathPoints(outlines[k].d));
        const fillVerts = parsePathPoints(fills[k].d);
        const apex = moleculeApex(mol);
        const { p2, p3 } = moleculeSlantOuterVertices(mol, apex);
        const { foldAtP2, foldAtP3 } = moleculeMinorCutEndpoints(
          mol,
          minorLen,
          apex,
        );
        const wedgePt = {
          x: (p2.x + p3.x + foldAtP2.x + foldAtP3.x) / 4,
          y: (p2.y + p3.y + foldAtP2.y + foldAtP3.y) / 4,
        };

        expect(polygonArea(fillVerts)).toBeGreaterThan(1);
        expect(pointInPolygon(wedgePt, fillVerts)).toBe(false);
        if (dist(foldAtP2, foldAtP3) > 1e-6) {
          expect(
            pointInPolygon(
              moleculeFillInteriorPoint(mol, minorLen, apex),
              fillVerts,
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("paint order: polygons, then molecules, then creases (fold/cut), then boundary", () => {
    const net = buildPatternNet(state);
    const roles = net.segments.map((s) => s.role);
    const firstMolecule = roles.indexOf("molecule");
    const lastPolygon = roles.lastIndexOf("polygon");
    const firstFoldOrCut = roles.findIndex((r) => r === "fold" || r === "cut");
    const boundary = roles.indexOf("boundary");

    expect(firstMolecule).toBeGreaterThan(lastPolygon);
    expect(firstFoldOrCut).toBeGreaterThan(firstMolecule);
    expect(boundary).toBeGreaterThan(firstFoldOrCut);
  });
});

function nearestOnFold(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-24) {
    return a;
  }
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2),
  );
  return { x: a.x + abx * t, y: a.y + aby * t };
}

describe("cornerMoleculeTrapezoid", () => {
  it("places all vertices on the two slants from b; outer corners coincide with the provided outer endpoints", () => {
    const b = { x: 0, y: 0 };
    const outerLeft = { x: -100, y: 150 };
    const outerRight = { x: 100, y: 150 };
    const [innerL, innerR, oR, oL] = cornerMoleculeTrapezoid(b, outerLeft, outerRight, 0.2);

    expect(eqPt(oL, outerLeft)).toBe(true);
    expect(eqPt(oR, outerRight)).toBe(true);
    expect(pointOnSegment(innerL, b, outerLeft)).toBe(true);
    expect(pointOnSegment(innerR, b, outerRight)).toBe(true);
    expect(dist(b, innerL)).toBeLessThan(dist(b, oL));
    expect(dist(b, innerR)).toBeLessThan(dist(b, oR));
  });

  it("inner-corner distance scales with innerFraction", () => {
    const b = { x: 0, y: 0 };
    const outerLeft = { x: -100, y: 150 };
    const outerRight = { x: 100, y: 150 };
    const slantLen = dist(b, outerLeft);
    const [innerL] = cornerMoleculeTrapezoid(b, outerLeft, outerRight, 0.3);
    expect(dist(b, innerL)).toBeCloseTo(0.3 * slantLen, 3);
  });
});
