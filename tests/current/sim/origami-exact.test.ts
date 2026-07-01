/**
 * Plain FOLD files run the EXACT simulation of Ghassaei–Demaine–Gershenfeld,
 * "Fast, Interactive Origami Simulation using GPU Computation" (7OSME 2018).
 * The force core (forces.ts) is the paper's equations verbatim; these tests
 * pin the CONVENTION layer the adapter applies for plain FOLD (§2.3, §3):
 *
 *   - FOLD-spec sign: mountain foldAngle NEGATIVE folds the wings away from
 *     the face-normal side; valley POSITIVE folds toward it;
 *   - no explicit edges_foldAngle → full-fold defaults ±π;
 *   - k_crease: l₀·k_fold (M/V), l₀·k_facet (F), 0 for "B"/"U"/missing
 *     (undriven hinges swing free — not driven flat);
 *   - no MAX_FOLD clamp on file angles;
 *   - ζ = 0.45 (paper stable range), EA = 20, k_fold = k_facet = 0.7,
 *     k_face = 0.2 (paper Fig. 5).
 *
 * FKLD files keep the kirigami/AKDE conventions (covered by kzr-sim,
 * guided-examples, and the pipeline e2e suites).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSceneFromFold, ORIGAMI_PARAMS } from "../../../src/sim/fold-adapter.js";
import { buildScene } from "../../../src/sim/scene.js";
import { measureTheta } from "../../../src/sim/solver.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** Two CCW triangles (rest normals +z) hinged on edge (1,2); wings 0 and 3. */
function hinge(assign: string, foldAngleDeg: number | null): FoldFile {
  return {
    file_spec: 1.1,
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
    edges_assignment: ["B", assign, "B", "B", "B"],
    ...(foldAngleDeg === null ? {} : { edges_foldAngle: [0, foldAngleDeg, 0, 0, 0] }),
    faces_vertices: [
      [0, 1, 2],
      [1, 3, 2],
    ],
  };
}

/**
 * z of the wing nodes relative to the crease midpoint after folding. The two
 * crease nodes are fixed so the crease line pins the frame — a free fold has
 * rotational rigid-body freedom about its single anchor, which would make
 * absolute z comparisons meaningless.
 */
function foldHinge(fold: FoldFile, iters = 8000): { dz0: number; dz3: number; theta: number; scene: ReturnType<typeof buildSceneFromFold> } {
  const scene = buildSceneFromFold(fold);
  scene.model.fixed.fill(0); // drop the free-fold display anchor
  scene.model.fixed[1] = 1;
  scene.model.fixed[2] = 1;
  scene.solver.solve(iters, 1);
  const p = scene.model.position;
  const z = (i: number): number => p[3 * i + 2];
  const midZ = (z(1) + z(2)) / 2;
  const c = scene.model.creases;
  const theta = measureTheta(scene.model, c.face1[0], c.face2[0], c.n3[0], c.n4[0]);
  return { dz0: z(0) - midZ, dz3: z(3) - midZ, theta, scene };
}

describe("FOLD-spec sign convention (paper §2.3)", () => {
  it("mountain (foldAngle −90°): wings fold AWAY from the +z normal side", () => {
    // Thresholds are scale-relative: the adapter normalizes to a ~unit sim box,
    // so a 90° wing drop is ≈ 0.35 × span, not an absolute number of mm.
    const { dz0, dz3, theta } = foldHinge(hinge("M", -90));
    expect(dz0).toBeLessThan(-0.2);
    expect(dz3).toBeLessThan(-0.2);
    expect(Math.abs(Math.abs(theta) - Math.PI / 2)).toBeLessThan(0.15);
  });

  it("valley (foldAngle +90°): wings fold TOWARD the +z normal side", () => {
    const { dz0, dz3, theta } = foldHinge(hinge("V", 90));
    expect(dz0).toBeGreaterThan(0.2);
    expect(dz3).toBeGreaterThan(0.2);
    expect(Math.abs(Math.abs(theta) - Math.PI / 2)).toBeLessThan(0.15);
  });

  it("mountain and valley with the same |angle| are mirror folds", () => {
    const m = foldHinge(hinge("M", -120));
    const v = foldHinge(hinge("V", 120));
    expect(m.dz0).toBeCloseTo(-v.dz0, 2);
    expect(m.dz3).toBeCloseTo(-v.dz3, 2);
  });
});

describe("target defaults and stiffness rules (paper §2.3, §3)", () => {
  it("M/V with no edges_foldAngle default to full fold ±π (unclamped)", () => {
    const m = buildSceneFromFold(hinge("M", null));
    const v = buildSceneFromFold(hinge("V", null));
    expect(Math.abs(m.model.creases.targetTheta[0])).toBeCloseTo(Math.PI, 5);
    expect(Math.abs(v.model.creases.targetTheta[0])).toBeCloseTo(Math.PI, 5);
    expect(Math.sign(m.model.creases.targetTheta[0])).not.toBe(Math.sign(v.model.creases.targetTheta[0]));
  });

  it("edges_foldAngles (OrigamiSimulator): radians pass through unchanged", () => {
    const base = hinge("V", null);
    delete base.edges_foldAngle;
    const scene = buildSceneFromFold({
      ...base,
      edges_foldAngles: [0, Math.PI, 0, 0, 0],
    });
    expect(scene.model.creases.targetTheta[0]).toBeCloseTo(Math.PI, 5);
  });

  it("explicit angles are NOT clamped (−170° survives past the FKLD 2.7 rad clamp)", () => {
    const scene = buildSceneFromFold(hinge("M", -170));
    expect(Math.abs(scene.model.creases.targetTheta[0])).toBeCloseTo((170 * Math.PI) / 180, 5);
  });

  it('"U" and missing assignments produce NO crease (free hinge — beam only, paper §2.3)', () => {
    // The faithful port (OS getFacesAndVerticesForEdges) only makes creases for M/V/F edges; an
    // undriven hinge is just an axial beam with no torsional spring across it.
    const u = buildSceneFromFold(hinge("U", null));
    expect(u.model.creases.count).toBe(0);
    const none = hinge("M", null);
    delete none.edges_assignment;
    const free = buildSceneFromFold(none);
    expect(free.model.creases.count).toBe(0);
  });

  it('"F" facet creases are driven flat with k = l₀·k_facet', () => {
    const f = buildSceneFromFold(hinge("F", null));
    expect(f.model.creases.targetTheta[0]).toBe(0);
    const l0 = f.model.creases.k[0] / ORIGAMI_PARAMS.kFacet;
    expect(l0).toBeGreaterThan(0); // = rest length of the crease edge (sim units)
  });

  it("OrigamiSimulator constants apply UNIFORMLY: ζ = 0.85, beamDampingScale = 0.5 (origami and FKLD alike)", () => {
    expect(ORIGAMI_PARAMS.zeta).toBe(0.85);
    expect(ORIGAMI_PARAMS.beamDampingScale).toBe(0.5);
    expect(ORIGAMI_PARAMS.EA).toBe(20);
    expect(ORIGAMI_PARAMS.kFold).toBe(0.7);
    expect(ORIGAMI_PARAMS.kFacet).toBe(0.7);
    expect(ORIGAMI_PARAMS.kFace).toBe(0.2);
    const plain = buildSceneFromFold(hinge("M", -90));
    expect(plain.model.params.zeta).toBe(0.85);
    expect(plain.model.params.beamDampingScale).toBe(0.5);
    // The 1:1 port retires the bespoke AKDE overdamping: FKLD uses the SAME OrigamiSimulator params.
    const fkldHinge = { ...hinge("M", 90), "fkld:edges_cutType": [null, null, null, null, null] };
    const fkldScene = buildSceneFromFold(fkldHinge);
    expect(fkldScene.model.params.zeta).toBe(0.85);
    expect(fkldScene.model.params.beamDampingScale).toBe(0.5);
  });
});

describe("crease force ≡ paper Eqs 2–6 (finite-difference gradient proof)", () => {
  it("F_crease = −k(θ−θ_t)·∂θ/∂p matches numeric ∂θ/∂p on a bent hinge", async () => {
    const { computeFaceNormals, computeThetas, accumulateForces } = await import("../../../src/sim/forces.js");
    // Non-degenerate, already-bent hinge (deterministic "random" offsets).
    const fold: FoldFile = {
      vertices_coords: [
        [3, -41, 0],
        [55, 2, 0],
        [47, 58, 0],
        [104, 39, 0],
      ],
      edges_vertices: [[0, 1], [1, 2], [2, 0], [1, 3], [3, 2]],
      edges_assignment: ["B", "M", "B", "B", "B"],
      faces_vertices: [[0, 1, 2], [1, 3, 2]],
    };
    const scene = buildSceneFromFold(fold);
    const m = scene.model;
    // bend the wing out of plane so all partials are non-trivial
    m.position[3 * 3 + 2] += 27;
    m.position[3 * 0 + 2] -= 13;
    // isolate the crease force: no beams, no face springs, no damping (v = 0)
    m.beams.k.fill(0);
    m.params.kFace = 0;
    const theta = new Float32Array(m.creases.count);
    computeFaceNormals(m);
    computeThetas(m, theta);
    m.creases.k[0] = 1;
    m.creases.targetTheta[0] = theta[0] + 1; // angForce = k(θ_t − θ) = 1 ⇒ F = ∂θ/∂p
    m.fixed.fill(0);
    accumulateForces(m, theta, 1);
    const analytic = m.force.slice();

    // numeric ∂θ/∂p by central differences of the measured dihedral
    const h = 1e-3;
    const c = m.creases;
    for (let node = 0; node < 4; node++) {
      for (let axis = 0; axis < 3; axis++) {
        const idx = 3 * node + axis;
        const saved = m.position[idx];
        m.position[idx] = saved + h;
        const tPlus = measureTheta(m, c.face1[0], c.face2[0], c.n3[0], c.n4[0]);
        m.position[idx] = saved - h;
        const tMinus = measureTheta(m, c.face1[0], c.face2[0], c.n3[0], c.n4[0]);
        m.position[idx] = saved;
        const numeric = (tPlus - tMinus) / (2 * h);
        expect(Math.abs(analytic[idx] - numeric)).toBeLessThan(5e-4);
      }
    }
  });
});

describe("end-to-end: upstream Origami-Simulator file folds per spec", () => {
  it("diagonal-cp.fold (V +180°): valley flat-fold rises toward +z", { timeout: 60_000 }, () => {
    const fold = JSON.parse(readFileSync("public/examples/fold-upstream/diagonal-cp.fold", "utf8")) as FoldFile;
    const built = buildScene(fold)!;
    expect(built.sim).toBe("origami");
    expect(built.mode).toBe("free");
    const { model, solver } = built.scene;
    model.fixed.fill(0); // drop the free-fold display anchor (it may pin a wing)
    model.fixed[1] = 1; // pin the diagonal crease line — see foldHinge note
    model.fixed[3] = 1;
    solver.solve(16000, 1);
    const p = model.position;
    // wings (vertices 0 and 2) rise above the diagonal crease (vertices 1, 3)
    const midZ = (p[3 * 1 + 2] + p[3 * 3 + 2]) / 2;
    expect(p[3 * 0 + 2] - midZ).toBeGreaterThan(0.2); // scale-relative (unit sim box)
    expect(p[3 * 2 + 2] - midZ).toBeGreaterThan(0.2);
    // deep valley fold approached (target −π internal)
    const c = model.creases;
    const theta = measureTheta(model, c.face1[0], c.face2[0], c.n3[0], c.n4[0]);
    expect(Math.abs(theta)).toBeGreaterThan(2.2);
    for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true);
  });
});
