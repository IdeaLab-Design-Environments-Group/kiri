import { describe, expect, it } from "vitest";
import { pointTriangleDistance, sampledHausdorff, samplePoints } from "../../../src/pipeline/verify.js";
import { buildSceneFromFold } from "../../../src/sim/fold-adapter.js";
import { measureTheta } from "../../../src/sim/solver.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import type { Vec3 } from "../../../src/pipeline/types.js";
import { makeCube } from "./fixtures/targets.js";

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe("pointTriangleDistance", () => {
  const a = V(0, 0, 0);
  const b = V(2, 0, 0);
  const c = V(0, 2, 0);
  it("face region: perpendicular distance", () => {
    expect(pointTriangleDistance(V(0.5, 0.5, 3), a, b, c)).toBeCloseTo(3, 12);
  });
  it("vertex region: distance to the corner", () => {
    expect(pointTriangleDistance(V(-1, -1, 0), a, b, c)).toBeCloseTo(Math.SQRT2, 12);
  });
  it("edge region: distance to the closest edge point", () => {
    expect(pointTriangleDistance(V(1, -2, 0), a, b, c)).toBeCloseTo(2, 12);
    expect(pointTriangleDistance(V(2, 2, 0), a, b, c)).toBeCloseTo(Math.SQRT2, 12); // hypotenuse
  });
});

describe("sampledHausdorff", () => {
  const cube = makeCube();
  const mesh = { v: cube.vertices, f: cube.faces };
  it("identical meshes → 0", () => {
    expect(sampledHausdorff(mesh, mesh)).toBeCloseTo(0, 12);
  });
  it("known offset copy → exactly the offset", () => {
    const h = 7;
    const moved = { v: cube.vertices.map((p) => V(p.x, p.y, p.z + h)), f: cube.faces };
    expect(sampledHausdorff(mesh, moved)).toBeCloseTo(h, 9);
  });
  it("samples include vertices, edge midpoints, and centroids", () => {
    const tri = { v: [V(0, 0, 0), V(1, 0, 0), V(0, 1, 0)], f: [[0, 1, 2]] as [number, number, number][] };
    const samples = samplePoints(tri.v, tri.f);
    expect(samples.length).toBe(3 + 3 + 1);
  });
});

describe("the verification oracle bites (negative test)", () => {
  it("a non-isometric flat pattern fails verification", { timeout: 60_000 }, async () => {
    const { kirigamize } = await import("../../../src/pipeline/kirigamize.js");
    const { verifyFold } = await import("../../../src/pipeline/verify.js");
    const { makeTent } = await import("./fixtures/targets.js");
    const tent = makeTent();
    const result = kirigamize(tent, { verify: false });
    // Corrupt the PATTERN: stretch the flat sheet 50% in x. Bar rest lengths
    // derive from the flat net, so no pose matching the goal can be
    // unstrained — the folded state is not an equilibrium of this pattern.
    // Phase B (release-and-settle) catches it via locked-in strain.
    const coords = result.fkld.vertices_coords as number[][];
    for (const c of coords) c[0] *= 1.5;
    const report = verifyFold(result.fkld, tent);
    expect(report.converged).toBe(false);
    const fff = report.foldFromFlat;
    expect(
      fff.meanStrain > 0.01 || fff.dH > report.epsilon || fff.creaseResidual > 0.15 || (fff.pathStrain ?? 0) > 0.2,
    ).toBe(true);
  });
});

describe("kabsch rigid alignment", () => {
  it("recovers a known rotation + translation; never mirrors", async () => {
    const { kabsch, applyRigid } = await import("../../../src/pipeline/verify.js");
    // Deterministic point cloud.
    const pts: Vec3[] = [
      V(0, 0, 0), V(10, 0, 0), V(0, 10, 0), V(0, 0, 10), V(7, 5, 3), V(-4, 2, 8),
    ];
    // Known rotation: 40° about a skew axis, plus translation.
    const ang = (40 * Math.PI) / 180;
    const ax = { x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) };
    const rot = (p: Vec3): Vec3 => {
      // Rodrigues
      const c = Math.cos(ang), s = Math.sin(ang);
      const d = ax.x * p.x + ax.y * p.y + ax.z * p.z;
      return {
        x: p.x * c + (ax.y * p.z - ax.z * p.y) * s + ax.x * d * (1 - c) + 5,
        y: p.y * c + (ax.z * p.x - ax.x * p.z) * s + ax.y * d * (1 - c) - 3,
        z: p.z * c + (ax.x * p.y - ax.y * p.x) * s + ax.z * d * (1 - c) + 11,
      };
    };
    const moved = pts.map(rot);
    const { R, t } = kabsch(pts, moved);
    for (let i = 0; i < pts.length; i++) {
      const q = applyRigid(R, t, pts[i]);
      expect(q.x).toBeCloseTo(moved[i].x, 5);
      expect(q.y).toBeCloseTo(moved[i].y, 5);
      expect(q.z).toBeCloseTo(moved[i].z, 5);
    }
    // det(R) must be +1 (no reflection): a mirrored cloud cannot be aligned away.
    const det =
      R[0] * (R[4] * R[8] - R[5] * R[7]) -
      R[1] * (R[3] * R[8] - R[5] * R[6]) +
      R[2] * (R[3] * R[7] - R[4] * R[6]);
    expect(det).toBeCloseTo(1, 6);
    const mirrored = pts.map((p) => V(-p.x, p.y, p.z));
    const m = kabsch(pts, mirrored);
    // Best proper-rotation alignment of a mirror leaves residual error.
    let worst = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = applyRigid(m.R, m.t, pts[i]);
      worst = Math.max(worst, Math.hypot(q.x - mirrored[i].x, q.y - mirrored[i].y, q.z - mirrored[i].z));
    }
    expect(worst).toBeGreaterThan(1);
  });
});

describe("sign-convention pin (R7): edges_foldAngle M+ folds mountain end-to-end", () => {
  it("a single +90° M hinge develops positive measured θ in the solver", () => {
    // Two unit triangles hinged on edge (1,2); explicit +90° mountain target.
    const hinge: FoldFile = {
      file_spec: 1.2,
      frame_unit: "mm",
      vertices_coords: [
        [0, 0],
        [50, 0],
        [50, 50],
        [100, 50],
      ],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 0],
        [1, 3],
        [3, 2],
      ],
      edges_assignment: ["B", "B", "B", "B", "B"].map((a, i) => (i === 1 ? "M" : a)),
      edges_foldAngle: [null, 90, null, null, null] as unknown as number[],
      faces_vertices: [
        [0, 1, 2],
        [1, 3, 2],
      ],
    };
    const scene = buildSceneFromFold(hinge);
    scene.solver.solve(4000, 1);
    // find the crease and read its measured angle
    expect(scene.model.creases.count).toBe(1);
    const cr = scene.model.creases;
    const theta = measureTheta(scene.model, cr.face1[0], cr.face2[0], cr.n3[0], cr.n4[0]);
    expect(theta).toBeGreaterThan(0.5); // folded decisively in the mountain direction
  });
});
