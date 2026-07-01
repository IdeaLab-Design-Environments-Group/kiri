/**
 * Simulator verification (M5): fold the emitted FKLD with the AKDE
 * bar-and-hinge solver and measure how close the folded sheet lands to Q.
 *
 * Pattern: imperative orchestrator around pure metric functions, with the
 * CPU solver as reference (tests run only the CPU `FoldSolver`; the GPU path
 * stays a UI accelerator). The simulator is the oracle: a pattern is correct
 * when it folds to the target, not when it merely looks right on paper.
 *
 * What "verified" means here: TWO-PHASE FOLD-FROM-FLAT (primary) plus an
 * EQUILIBRIUM check (secondary).
 *
 * Fold-from-flat, phase A — kinematic transport: EVERY vertex is driven
 * (model.goal is fully populated from the emitted goal frame) linearly
 * rest→goal as foldPercent eases 0→1. This demonstrates a continuous,
 * isometry-auditable motion from the flat sheet: by the triangle inequality
 * |(1−fp)·d₀ + fp·d₁| ≤ l₀ whenever |d₀| = |d₁| = l₀, so a CONSISTENT
 * pattern never lengthens a bar along the path — the mean TENSILE strain
 * sampled at fp = 0.25/0.5/0.75 (recorded as `pathStrain`, max of the three)
 * is ≈ 0 iff rest and goal lengths agree. (The unsigned mid-path strain is
 * NOT usable: linear interpolation of a face rotation φ shortens chords by
 * ≈ 1 − cos(φ/2) even on a perfect pattern — ~31% mean on the cube.)
 *
 * Fold-from-flat, phase B — release-and-settle: at fp = 1 the original
 * driven flags are restored (only sheet-boundary vertices stay pinned),
 * velocities are zeroed, and the solver relaxes until settled. The folded
 * state must HOLD under the pattern's own bars/creases — the real physics
 * gate. Metrics are measured after phase B. A wrong pattern (non-isometric
 * unfold, wrong lips/packing, M/V or angle errors) pushes itself away and
 * fails on d_H, strain, or crease residual.
 *
 * Why two phases instead of driving only the sheet boundary the whole way:
 * with the scaffold driven, the solver's momentum-conserving crease
 * reactions act on free crease nodes in the direction OPPOSITE their wings —
 * with wings pinned this actively pushes FREE interior fold-line vertices
 * (e.g. a tent ridge, intrinsically flat so never cut) toward the mirror
 * side, so the ridge never rises (verified empirically). Phase A transports
 * such vertices kinematically; phase B proves they are mechanically stable.
 *
 * d_H decision: sampled symmetric Hausdorff over vertices ∪ edge midpoints ∪
 * face centroids, brute-force min point–triangle distance (coarse meshes —
 * no BVH). Vertex-only sampling would miss interior bulge, the very failure
 * mode the sim must catch; exact Hausdorff is overkill.
 *
 * Open kirigami / vent-aware d_H: at δ<0 vertices a VENT removes a sliver of
 * Q-coverage, so the folded surface legitimately has a small HOLE there —
 * coverage holes at declared vents are NOT coverage errors. The folded→Q
 * directed distance stays full strength (the sheet must lie ON Q), but
 * Q→folded samples within `radiusMm` of a declared vent center (see
 * `VentHole`, computed by kirigamize.ts from the unfold's VentRecords) are
 * skipped. Patterns without vents keep the plain symmetric metric.
 *
 * Frames & scaling: verification always runs at ~unit span — both scenes are
 * rescaled (see rescaleScene) because the explicit solver's Δt bound covers
 * only the axial mode and assumes k_axial = EA/l₀ ≫ k_crease ∝ l₀, which the
 * adapter's display normalization (span ≈ 100) violates badly enough that
 * solves explode. Q's samples are mapped into the shared sim frame
 * deterministically: the rescaled scene's mm→sim scale plus the mean offset
 * between model.goal and the emitted foldedForm frame (no ICP — the
 * correspondence is known). ε_sim = ε_mm · scale. Before measuring d_H the
 * settled pose is rigidly aligned onto the goal by Kabsch/Horn (quaternion
 * method, NO reflection — see kabsch) over the known per-vertex
 * correspondence, so settling drift does not read as coverage error while a
 * mirror-folded sheet cannot be "aligned away" and shows up as large d_H.
 *
 * Future work — a fully FREE crease-driven fold from flat (no kinematic
 * transport; the creases alone do the work): without collision handling the
 * explicit solver explodes, freezes, or orbits in frustrated/mirror states
 * even though the folded target is a perfect free equilibrium (the secondary
 * check starts there and holds). Until then, fold-from-flat is transport +
 * release, and equilibrium stays a reported metric only.
 */

import { buildSceneFromFold, measureTheta, FoldSolver } from "../sim/index.js";
import type { FoldFile } from "../model/fold-file.js";
import type { TriMesh, Vec3, VerifyReport } from "./types.js";
import { PipelineError } from "./types.js";

/**
 * A declared coverage hole on Q (open kirigami): the region of Q left
 * uncovered by a vent sliver removed at a δ<0 vertex. Q→folded d_H samples
 * inside the ball (center, radiusMm) are skipped — see the module doc.
 */
export interface VentHole {
  /** Hole location on Q — the vent's source vertex position (mm, Q frame). */
  center: Vec3;
  /** Conservative hole radius: max goal-space distance from the vent vertex
   *  to its ventEdges' endpoints (mm). The removed slivers are sub-triangles
   *  with apex at the center and far vertices at those endpoints, so the
   *  whole hole lies within this ball. */
  radiusMm: number;
}

export interface VerifyOptions {
  /** ε as a fraction of Q's bbox diagonal. */
  epsilonRel: number;
  /** Iteration cap for the settled solve. */
  iterations: number;
  /** Max acceptable mean bar strain (isometry oracle). */
  strainTol: number;
  /** Max acceptable mean crease-angle residual (rad). */
  creaseTol: number;
  /**
   * Declared vent holes on Q (open kirigami) — Q→folded d_H samples inside
   * any of these balls are not coverage errors. Default: none (plain
   * symmetric d_H).
   */
  vents?: VentHole[];
}

export const DEFAULT_VERIFY: VerifyOptions = {
  epsilonRel: 0.05,
  iterations: 16000,
  strainTol: 0.1,
  creaseTol: 0.15,
};

/** Sample set: vertices ∪ edge midpoints ∪ face centroids. */
export function samplePoints(vertices: Vec3[], faces: [number, number, number][]): Vec3[] {
  const samples: Vec3[] = vertices.map((v) => ({ ...v }));
  const seen = new Set<string>();
  for (const [i, j, k] of faces) {
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        x: (vertices[a].x + vertices[b].x) / 2,
        y: (vertices[a].y + vertices[b].y) / 2,
        z: (vertices[a].z + vertices[b].z) / 2,
      });
    }
    samples.push({
      x: (vertices[i].x + vertices[j].x + vertices[k].x) / 3,
      y: (vertices[i].y + vertices[j].y + vertices[k].y) / 3,
      z: (vertices[i].z + vertices[j].z + vertices[k].z) / 3,
    });
  }
  return samples;
}

/** Euclidean distance from point p to triangle (a,b,c). */
export function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // Ericson, Real-Time Collision Detection §5.1.5 (closest point on triangle).
  const sub = (u: Vec3, v: Vec3): Vec3 => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u: Vec3, v: Vec3): number => u.x * v.x + u.y * v.y + u.z * v.z;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const dist = (q: Vec3): number => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  if (d1 <= 0 && d2 <= 0) return dist(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dist({ x: a.x + v * ab.x, y: a.y + v * ab.y, z: a.z + v * ab.z });
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dist({ x: a.x + w * ac.x, y: a.y + w * ac.y, z: a.z + w * ac.z });
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return dist({ x: b.x + w * (c.x - b.x), y: b.y + w * (c.y - b.y), z: b.z + w * (c.z - b.z) });
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return dist({
    x: a.x + ab.x * v + ac.x * w,
    y: a.y + ab.y * v + ac.y * w,
    z: a.z + ab.z * v + ac.z * w,
  });
}

interface SampledMesh {
  v: Vec3[];
  f: [number, number, number][];
}

function supDistance(
  from: SampledMesh,
  to: SampledMesh,
  skip?: (p: Vec3) => boolean,
): { d: number; worstSample: Vec3 } {
  let worst = 0;
  let worstSample = from.v[0];
  for (const p of samplePoints(from.v, from.f)) {
    if (skip?.(p)) continue;
    let best = Infinity;
    for (const [i, j, k] of to.f) {
      const d = pointTriangleDistance(p, to.v[i], to.v[j], to.v[k]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > worst) {
      worst = best;
      worstSample = p;
    }
  }
  return { d: worst, worstSample };
}

/** Sampled symmetric Hausdorff distance (max of both directed sups). */
export function sampledHausdorff(A: SampledMesh, B: SampledMesh): number {
  return Math.max(supDistance(A, B).d, supDistance(B, A).d);
}

/**
 * Optimal rigid alignment (Kabsch/Horn, NO reflection) of corresponding
 * point pairs: returns R (row-major 3×3) and t minimizing Σ|R·p + t − q|².
 * Quaternion (Horn) method with Gershgorin-shifted power iteration on the
 * symmetric 4×4 N matrix — deterministic, Math-only. Reflections are
 * impossible by construction (quaternions parameterize SO(3) only), so a
 * mirror-folded sheet shows up as large d_H instead of being "aligned away".
 */
export function kabsch(
  from: Vec3[],
  to: Vec3[],
): { R: number[]; t: Vec3 } {
  const n = Math.min(from.length, to.length);
  if (n < 3) throw new PipelineError("verify", "kabsch needs ≥3 point pairs");
  // Centroids.
  const cf = { x: 0, y: 0, z: 0 };
  const ct = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    cf.x += from[i].x; cf.y += from[i].y; cf.z += from[i].z;
    ct.x += to[i].x; ct.y += to[i].y; ct.z += to[i].z;
  }
  cf.x /= n; cf.y /= n; cf.z /= n;
  ct.x /= n; ct.y /= n; ct.z /= n;
  // Cross-covariance H = Σ (p−cf)(q−ct)ᵀ.
  const H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const px = from[i].x - cf.x, py = from[i].y - cf.y, pz = from[i].z - cf.z;
    const qx = to[i].x - ct.x, qy = to[i].y - ct.y, qz = to[i].z - ct.z;
    H[0] += px * qx; H[1] += px * qy; H[2] += px * qz;
    H[3] += py * qx; H[4] += py * qy; H[5] += py * qz;
    H[6] += pz * qx; H[7] += pz * qy; H[8] += pz * qz;
  }
  // Horn's symmetric 4×4 N matrix.
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = H;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Dominant eigenvector via power iteration on N + μI (Gershgorin shift).
  let mu = 0;
  for (let r = 0; r < 4; r++) {
    mu = Math.max(mu, Math.abs(N[r][0]) + Math.abs(N[r][1]) + Math.abs(N[r][2]) + Math.abs(N[r][3]));
  }
  let q = [1, 0.1, 0.2, 0.3]; // deterministic, not an eigenvector of typical N
  for (let iter = 0; iter < 200; iter++) {
    const next = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      next[r] = mu * q[r];
      for (let c = 0; c < 4; c++) next[r] += N[r][c] * q[c];
    }
    const l = Math.hypot(next[0], next[1], next[2], next[3]) || 1;
    q = next.map((x) => x / l);
  }
  const [w, x, y, z] = q;
  // Quaternion → rotation matrix (row-major).
  const R = [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
  const rot = (p: Vec3): Vec3 => ({
    x: R[0] * p.x + R[1] * p.y + R[2] * p.z,
    y: R[3] * p.x + R[4] * p.y + R[5] * p.z,
    z: R[6] * p.x + R[7] * p.y + R[8] * p.z,
  });
  const rc = rot(cf);
  const t = { x: ct.x - rc.x, y: ct.y - rc.y, z: ct.z - rc.z };
  return { R, t };
}

/** Apply a kabsch result to a point. */
export function applyRigid(R: number[], t: Vec3, p: Vec3): Vec3 {
  return {
    x: R[0] * p.x + R[1] * p.y + R[2] * p.z + t.x,
    y: R[3] * p.x + R[4] * p.y + R[5] * p.z + t.y,
    z: R[6] * p.x + R[7] * p.y + R[8] * p.z + t.z,
  };
}

interface SceneMetrics {
  metrics: import("./types.js").FoldMetrics;
  worstSample: Vec3;
}

/**
 * Rescale a built scene to span ≈ `targetSpan` sim units. The explicit
 * solver's Δt bound (paper Eqs 7–8) covers only the axial mode and assumes
 * k_axial = EA/l₀ ≫ k_crease = 0.7·l₀ — true at unit scale but violated at
 * large normalization spans (l₀ ≈ 25 ⇒ creases 20× stiffer than the bound
 * assumes ⇒ free folds explode). Verification therefore always runs in the
 * stable regime regardless of the adapter's display normalization.
 * Returns a fresh solver (Δt recomputed for the scaled stiffnesses).
 */
function rescaleScene(scene: ReturnType<typeof buildSceneFromFold>, targetSpan = 2): void {
  const net = scene.net;
  let span = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of net.vertices) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  const s = targetSpan / span;
  if (Math.abs(s - 1) < 1e-9) return;
  const m = scene.model;
  for (let i = 0; i < m.position.length; i++) {
    m.position[i] *= s;
    m.rest[i] *= s;
    m.goal[i] *= s;
  }
  for (const v of net.vertices) {
    v.x *= s; v.y *= s; v.z *= s;
  }
  for (let i = 0; i < m.beams.count; i++) {
    m.beams.rest[i] *= s;
    m.beams.k[i] /= s; // k_axial = EA/l₀
  }
  for (let i = 0; i < m.creases.count; i++) {
    m.creases.k[i] *= s; // k_crease = (1−cut)·k·l₀
  }
  net.meta.scale *= s; // sim-units-per-mm stays consistent for dH conversion
  // Fresh solver: Δt depends on the (now smaller) stiffness spectrum.
  scene.solver = new FoldSolver(m);
}

/** Strain + crease residual + aligned d_H of a settled scene vs targetSim.
 *  `ventSkip` excludes declared vent-hole samples from the Q→folded
 *  direction only (open kirigami — see the module doc). */
function measureScene(
  scene: ReturnType<typeof buildSceneFromFold>,
  targetSim: SampledMesh,
  scale: number,
  bboxDiag: number,
  iterations: number,
  settled: boolean,
  ventSkip?: (p: Vec3) => boolean,
): SceneMetrics {
  const m = scene.model;
  const pos = m.position;
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) {
      throw new PipelineError("verify", `solver produced non-finite position at component ${i}`);
    }
  }

  // strain over beams (isometry oracle)
  let meanStrain = 0;
  let maxStrain = 0;
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const l = Math.hypot(
      pos[3 * a] - pos[3 * b],
      pos[3 * a + 1] - pos[3 * b + 1],
      pos[3 * a + 2] - pos[3 * b + 2],
    );
    const strain = Math.abs(l / m.beams.rest[i] - 1);
    meanStrain += strain;
    maxStrain = Math.max(maxStrain, strain);
  }
  meanStrain /= Math.max(1, m.beams.count);

  // crease residual vs goal-derived targets (rotation-invariant)
  let creaseResidual = 0;
  for (let c = 0; c < m.creases.count; c++) {
    const meas = measureTheta(m, m.creases.face1[c], m.creases.face2[c], m.creases.n3[c], m.creases.n4[c]);
    creaseResidual += Math.abs(meas - m.creases.targetTheta[c]);
  }
  creaseResidual /= Math.max(1, m.creases.count);

  // Kabsch-align the folded pose onto the goal using the KNOWN per-vertex
  // correspondence (position[i] ↔ model.goal[i]) — a free fold ends in an
  // arbitrary rigid pose; alignment must not absorb a mirror (see kabsch).
  const foldedRaw: Vec3[] = [];
  const goalPts: Vec3[] = [];
  for (let i = 0; i < m.numNodes; i++) {
    foldedRaw.push({ x: pos[3 * i], y: pos[3 * i + 1], z: pos[3 * i + 2] });
    goalPts.push({ x: m.goal[3 * i], y: m.goal[3 * i + 1], z: m.goal[3 * i + 2] });
  }
  const { R, t } = kabsch(foldedRaw, goalPts);
  const folded: SampledMesh = { v: foldedRaw.map((p) => applyRigid(R, t, p)), f: scene.net.faces };

  const toTarget = supDistance(folded, targetSim); // sheet must lie ON Q — full strength
  const fromTarget = supDistance(targetSim, folded, ventSkip); // vent holes are not coverage errors
  const dH = Math.max(toTarget.d, fromTarget.d) / scale; // mm

  return {
    metrics: {
      dH,
      dHRel: bboxDiag > 0 ? dH / bboxDiag : 0,
      meanStrain,
      maxStrain,
      creaseResidual,
      iterations,
      settled,
    },
    worstSample: toTarget.worstSample,
  };
}

/** Mean tensile bar strain max(l/l₀ − 1, 0) at the model's CURRENT positions
 *  — the phase-A transport audit (consistent patterns never lengthen a bar
 *  along the linear rest→goal path; see the module doc). */
function meanTensileStrain(m: ReturnType<typeof buildSceneFromFold>["model"]): number {
  const pos = m.position;
  let sum = 0;
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const l = Math.hypot(
      pos[3 * a] - pos[3 * b],
      pos[3 * a + 1] - pos[3 * b + 1],
      pos[3 * a + 2] - pos[3 * b + 2],
    );
    sum += Math.max(0, l / m.beams.rest[i] - 1);
  }
  return sum / Math.max(1, m.beams.count);
}

/**
 * Verify the emitted FKLD against Q two ways (single-shot; the retry
 * schedule lives in kirigamize.ts):
 *
 * 1. FOLD-FROM-FLAT (primary gate), two-phase: (A) kinematic transport —
 *    EVERY vertex driven linearly rest→goal as foldPercent eases 0→1, with
 *    the mean tensile strain sampled at fp = 0.25/0.5/0.75 recorded as
 *    `pathStrain`; (B) release-and-settle — restore the original driven
 *    flags (sheet boundary only), zero velocities, relax until settled: the
 *    folded state must HOLD. Kabsch-aligned d_H + strain + crease residual,
 *    measured after phase B.
 * 2. EQUILIBRIUM (secondary, reported): start at the goal pose, relax, and
 *    measure drift — a cheap consistency check that can never pass alone.
 *
 * `opts.vents` declares open-kirigami coverage holes (see VentHole): the
 * Q→folded direction of d_H skips samples inside them.
 */
export function verifyFold(
  fkld: FoldFile,
  target: TriMesh,
  opts: Partial<VerifyOptions> = {},
): VerifyReport {
  const { epsilonRel, iterations, strainTol, creaseTol, vents = [] } = { ...DEFAULT_VERIFY, ...opts };

  // --- shared frame: build the rescaled flat scene FIRST and derive the
  // mm → sim map + targetSim from it (both scenes are rescaled identically,
  // so the frame is shared) ---------------------------------------------------
  const flatScene = buildSceneFromFold(fkld, undefined, { splitCuts: false });
  rescaleScene(flatScene);
  const scale = flatScene.net.meta.scale;
  const frames = fkld.file_frames as
    | { frame_classes?: string[]; vertices_coords?: number[][] }[]
    | undefined;
  const goalMm = frames?.find((fr) => (fr.frame_classes ?? []).includes("foldedForm"))?.vertices_coords;
  if (!goalMm || goalMm.length === 0) {
    throw new PipelineError("verify", "fkld lacks a foldedForm goal frame — emit must run first");
  }
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < goalMm.length; i++) {
    tx += flatScene.model.goal[3 * i] - (goalMm[i][0] ?? 0) * scale;
    ty += flatScene.model.goal[3 * i + 1] - (goalMm[i][1] ?? 0) * scale;
    tz += flatScene.model.goal[3 * i + 2] - (goalMm[i][2] ?? 0) * scale;
  }
  tx /= goalMm.length;
  ty /= goalMm.length;
  tz /= goalMm.length;
  const targetSim: SampledMesh = {
    v: target.vertices.map((p) => ({ x: p.x * scale + tx, y: p.y * scale + ty, z: p.z * scale + tz })),
    f: target.faces,
  };
  let qMin = { x: Infinity, y: Infinity, z: Infinity };
  let qMax = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of target.vertices) {
    qMin = { x: Math.min(qMin.x, p.x), y: Math.min(qMin.y, p.y), z: Math.min(qMin.z, p.z) };
    qMax = { x: Math.max(qMax.x, p.x), y: Math.max(qMax.y, p.y), z: Math.max(qMax.z, p.z) };
  }
  const bboxDiag = Math.hypot(qMax.x - qMin.x, qMax.y - qMin.y, qMax.z - qMin.z);
  const epsilon = epsilonRel * bboxDiag;

  // Vent holes mapped into the shared sim frame (open kirigami — the
  // Q→folded d_H direction skips samples inside them; see the module doc).
  const ventsSim = vents.map((vt) => ({
    c: { x: vt.center.x * scale + tx, y: vt.center.y * scale + ty, z: vt.center.z * scale + tz },
    r: vt.radiusMm * scale * (1 + 1e-9), // float slack; boundary samples lie ON the sheet anyway
  }));
  const ventSkip =
    ventsSim.length > 0
      ? (p: Vec3): boolean =>
          ventsSim.some((vt) => Math.hypot(p.x - vt.c.x, p.y - vt.c.y, p.z - vt.c.z) <= vt.r)
      : undefined;

  // free (non-driven) vertices in the guided model — diagnostic only
  let freeVertices = 0;
  for (let i = 0; i < flatScene.model.numNodes; i++) if (!flatScene.model.driven[i]) freeVertices++;

  // --- 1. fold-from-flat (primary), two-phase ---------------------------------
  // Phase A — kinematic transport: drive EVERY vertex (model.goal is fully
  // populated from the emitted goal frame) linearly rest→goal with the normal
  // quasi-static fp ease. The fold is purely kinematic here, so the only
  // honest signal is the transport audit: mean TENSILE strain sampled at
  // fp = 0.25/0.5/0.75, max recorded as pathStrain (≈ 0 iff the pattern is
  // isometrically consistent — see the module doc). This transports free
  // interior fold-line vertices (e.g. a tent ridge) that the driven-boundary
  // forward process structurally cannot raise (mirror-side crease reactions).
  const fm = flatScene.model;
  const savedDriven = fm.driven.slice();
  const savedFixed = fm.fixed.slice();
  fm.driven.fill(1);
  fm.fixed.fill(1);
  fm.velocity.fill(0);
  const sampleFps = [0.25, 0.5, 0.75];
  let sampleIdx = 0;
  let pathStrain = 0;
  const solver = flatScene.solver;
  solver.foldPercent = 0;
  let phaseAIters = 0;
  const easeRate = 0.004; // solveUntilSettled's default quasi-static ease
  while (solver.foldPercent < 1 && phaseAIters < iterations) {
    solver.foldPercent += (1 - solver.foldPercent) * easeRate;
    if (1 - solver.foldPercent < 1e-6) solver.foldPercent = 1;
    solver.step(); // all nodes driven+fixed ⇒ pure kinematic placement at fp
    phaseAIters++;
    while (sampleIdx < sampleFps.length && solver.foldPercent >= sampleFps[sampleIdx]) {
      pathStrain = Math.max(pathStrain, meanTensileStrain(fm));
      sampleIdx++;
    }
  }

  // Phase B — release-and-settle: restore the original driven flags (only
  // sheet-boundary vertices stay pinned at the goal), zero velocities, and
  // relax at fp = 1. The folded state must HOLD under the pattern's own
  // bars/creases — the real physics gate; metrics are measured here.
  fm.driven.set(savedDriven);
  fm.fixed.set(savedFixed);
  fm.velocity.fill(0);
  const flatSettle = solver.solveUntilSettled({
    target: 1,
    maxIters: iterations,
    keEps: 1e-2,
    minSettleIters: 500,
    quench: true,
    guard: true,
  });
  const flat = measureScene(
    flatScene,
    targetSim,
    scale,
    bboxDiag,
    phaseAIters + flatSettle.iters,
    flatSettle.converged,
    ventSkip,
  );
  flat.metrics.pathStrain = pathStrain;

  // --- 2. equilibrium (secondary) ---------------------------------------------
  const eqScene = buildSceneFromFold(fkld, undefined, { splitCuts: false });
  rescaleScene(eqScene);
  eqScene.model.position.set(eqScene.model.goal);
  eqScene.model.velocity.fill(0);
  eqScene.solver.foldPercent = 1;
  const eqSettle = eqScene.solver.solveUntilSettled({
    target: 1,
    maxIters: iterations,
    keEps: 1e-2,
    minSettleIters: 500,
    quench: true,
    guard: true,
  });
  const eq = measureScene(eqScene, targetSim, scale, bboxDiag, eqSettle.iters, eqSettle.converged, ventSkip);

  // worst source vertex: Q vertex nearest the worst fold-from-flat sample
  let worstSourceVertex = 0;
  let best = Infinity;
  for (let v = 0; v < targetSim.v.length; v++) {
    const q = targetSim.v[v];
    const d = Math.hypot(
      q.x - flat.worstSample.x,
      q.y - flat.worstSample.y,
      q.z - flat.worstSample.z,
    );
    if (d < best) {
      best = d;
      worstSourceVertex = v;
    }
  }

  return {
    foldFromFlat: flat.metrics,
    equilibrium: eq.metrics,
    epsilon,
    freeVertices,
    attempts: 1,
    converged:
      flat.metrics.settled &&
      flat.metrics.dH <= epsilon &&
      flat.metrics.meanStrain <= strainTol &&
      flat.metrics.creaseResidual <= creaseTol &&
      pathStrain <= 2 * strainTol,
    worstSourceVertex,
  };
}
