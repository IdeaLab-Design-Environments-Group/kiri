import { type BarHingeModel, TILE_COLLIDE_SIGN } from "./model.js";

/**
 * Gershenfeld bar-and-hinge force math, written once as pure CPU functions over the SoA
 * `BarHingeModel`. These are the **reference** equations (paper §2.2–2.5); the GLSL passes in
 * `gpu/` are a per-texel transcription of exactly these. Keeping them in plain TS makes the
 * physics unit-testable in Node (vitest), where WebGL is unavailable.
 *
 * Per solver step the order matches the paper's 5 GPU passes:
 *   1. computeFaceNormals   (1 face/thread)
 *   2. computeThetas        (1 crease/thread) — dihedral fold angle
 *   3. accumulateForces     (1 node/thread)   — axial + crease + face + damping
 *   4. integrate            (1 node/thread)   — explicit Euler
 *
 * Dihedral note (DETC2019-97557 Eq 5 / screenshot): the crease fold angle θ and the geometric
 * dihedral γ between adjacent faces are the same quantity, θ = π − γ. We measure θ with the
 * branch-safe signed `atan2` form (paper §2.3) rather than the `sin γ` closed form, so it stays
 * valid through the full fold range and across ±π.
 */

interface V3 {
  x: number;
  y: number;
  z: number;
}
const get = (a: Float32Array, i: number): V3 => ({ x: a[3 * i], y: a[3 * i + 1], z: a[3 * i + 2] });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

/** Pass 1 — unit face normals from current positions: n = (b−a) × (c−a). */
export function computeFaceNormals(m: BarHingeModel): void {
  const pos = m.position;
  const normal = m.faces.normal;
  for (let f = 0; f < m.faces.count; f++) {
    const a = get(pos, m.faces.a[f]);
    const b = get(pos, m.faces.b[f]);
    const c = get(pos, m.faces.c[f]);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n) || 1;
    normal[3 * f] = n.x / l;
    normal[3 * f + 1] = n.y / l;
    normal[3 * f + 2] = n.z / l;
  }
}

const TWO_PI = 2 * Math.PI;

/**
 * Pass 2 — signed dihedral fold angle per crease, unwrapped against the previous value so it
 * tracks continuously across ±π (paper §2.3). `lastTheta` is read and overwritten in place.
 */
export function computeThetas(m: BarHingeModel, lastTheta: Float32Array): void {
  const N = m.faces.normal;
  for (let i = 0; i < m.creases.count; i++) {
    const f1 = m.creases.face1[i];
    const f2 = m.creases.face2[i];
    const n1: V3 = { x: N[3 * f1], y: N[3 * f1 + 1], z: N[3 * f1 + 2] };
    const n2: V3 = { x: N[3 * f2], y: N[3 * f2 + 1], z: N[3 * f2 + 2] };
    const p3 = get(m.position, m.creases.n3[i]);
    const p4 = get(m.position, m.creases.n4[i]);
    const e = sub(p4, p3);
    const el = len(e) || 1;
    const ehat = { x: e.x / el, y: e.y / el, z: e.z / el };

    let x = dot(n1, n2);
    x = Math.max(-1, Math.min(1, x));
    const y = dot(cross(n1, ehat), n2);
    let theta = Math.atan2(y, x);

    // Unwrap relative to the last value (avoid 2π jumps as the fold passes ±π).
    let diff = theta - lastTheta[i];
    if (diff < -5.0) diff += TWO_PI;
    else if (diff > 5.0) diff -= TWO_PI;
    theta = lastTheta[i] + diff;
    lastTheta[i] = theta;
  }
}

/**
 * Pass 3 — accumulate per-node forces into `m.force` (zeroed first):
 *   axial (Eq 1) + crease (Eqs 2–6) + face interior-angle (§2.4) + viscous damping.
 * `foldPercent` scales every crease's design target angle (paper's Fold-Percent slider).
 */
export function accumulateForces(m: BarHingeModel, lastTheta: Float32Array, foldPercent: number): void {
  const F = m.force;
  F.fill(0);
  const pos = m.position;
  const vel = m.velocity;
  const { zeta, kFace } = m.params;

  // --- Axial + viscous damping (per beam) ---------------------------------------------
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const k = m.beams.k[i];
    const l0 = m.beams.rest[i];
    const pa = get(pos, a);
    const pb = get(pos, b);
    const d = sub(pb, pa);
    const l = len(d) || 1e-9;
    const f = (k * (l - l0)) / l; // force magnitude / length → multiply by d
    // axial: pull both ends toward rest length
    F[3 * a] += f * d.x;
    F[3 * a + 1] += f * d.y;
    F[3 * a + 2] += f * d.z;
    F[3 * b] -= f * d.x;
    F[3 * b + 1] -= f * d.y;
    F[3 * b + 2] -= f * d.z;
    // viscous damping between neighbours: c·(v_neighbor − v), c = 2ζ√(k·m_min)
    const c = 2 * zeta * m.params.beamDampingScale * Math.sqrt(k * Math.min(m.mass[a], m.mass[b]));
    const va = get(vel, a);
    const vb = get(vel, b);
    F[3 * a] += c * (vb.x - va.x);
    F[3 * a + 1] += c * (vb.y - va.y);
    F[3 * a + 2] += c * (vb.z - va.z);
    F[3 * b] += c * (va.x - vb.x);
    F[3 * b + 1] += c * (va.y - vb.y);
    F[3 * b + 2] += c * (va.z - vb.z);
  }

  // --- Crease torsional springs (per crease, distributed to 4 nodes) ------------------
  const Nrm = m.faces.normal;
  for (let i = 0; i < m.creases.count; i++) {
    const n1i = m.creases.n1[i];
    const n2i = m.creases.n2[i];
    const n3i = m.creases.n3[i];
    const n4i = m.creases.n4[i];
    const f1 = m.creases.face1[i];
    const f2 = m.creases.face2[i];
    const normal1: V3 = { x: Nrm[3 * f1], y: Nrm[3 * f1 + 1], z: Nrm[3 * f1 + 2] };
    const normal2: V3 = { x: Nrm[3 * f2], y: Nrm[3 * f2 + 1], z: Nrm[3 * f2 + 2] };

    const p3 = get(pos, n3i);
    const p4 = get(pos, n4i);
    const e = sub(p4, p3);
    const el = len(e) || 1e-9;
    const ehat = { x: e.x / el, y: e.y / el, z: e.z / el };

    // moment arms h1,h2 = perpendicular distance from each wing vertex to the crease line
    const p1 = get(pos, n1i);
    const p2 = get(pos, n2i);
    const r1 = sub(p1, p3);
    const proj1 = dot(r1, ehat);
    const h1 = Math.max(Math.sqrt(Math.max(0, dot(r1, r1) - proj1 * proj1)), 1e-6);
    const coef1 = proj1 / el; // fraction along crease from n3 → n4
    const r2 = sub(p2, p3);
    const proj2 = dot(r2, ehat);
    const h2 = Math.max(Math.sqrt(Math.max(0, dot(r2, r2) - proj2 * proj2)), 1e-6);
    const coef2 = proj2 / el;

    const target = m.creases.targetTheta[i] * foldPercent;
    let angForce = m.creases.k[i] * (target - lastTheta[i]); // −k(θ − θ_target)
    // 3D-printed mode: ONE-SIDED barrier resisting closure past the thickness/gap limit θ_max only on
    // the tile side (the rigid tiles sit on the +normal face, TILE_COLLIDE_SIGN). Folding toward them
    // (s·θ > θ_max) is pushed back so the tiles stop short of colliding; the fabric-backing side folds
    // freely. Inactive in vinyl mode (thetaMax unset).
    const tmax = m.creases.thetaMax;
    if (tmax) {
      const s = TILE_COLLIDE_SIGN;
      const th = lastTheta[i];
      if (s * th > tmax[i]) angForce += (m.params.kBarrier ?? 0) * (s * tmax[i] - th);
    }

    // wing nodes
    F[3 * n1i] += (angForce / h1) * normal1.x;
    F[3 * n1i + 1] += (angForce / h1) * normal1.y;
    F[3 * n1i + 2] += (angForce / h1) * normal1.z;
    F[3 * n2i] += (angForce / h2) * normal2.x;
    F[3 * n2i + 1] += (angForce / h2) * normal2.y;
    F[3 * n2i + 2] += (angForce / h2) * normal2.z;
    // crease nodes (reactions) — conserve linear momentum
    const a3_1 = (-angForce * (1 - coef1)) / h1;
    const a3_2 = (-angForce * (1 - coef2)) / h2;
    F[3 * n3i] += a3_1 * normal1.x + a3_2 * normal2.x;
    F[3 * n3i + 1] += a3_1 * normal1.y + a3_2 * normal2.y;
    F[3 * n3i + 2] += a3_1 * normal1.z + a3_2 * normal2.z;
    const a4_1 = (-angForce * coef1) / h1;
    const a4_2 = (-angForce * coef2) / h2;
    F[3 * n4i] += a4_1 * normal1.x + a4_2 * normal2.x;
    F[3 * n4i + 1] += a4_1 * normal1.y + a4_2 * normal2.y;
    F[3 * n4i + 2] += a4_1 * normal1.z + a4_2 * normal2.z;
  }

  // --- Face interior-angle springs (per face, three nodes) — paper §2.4 ----------------
  for (let f = 0; f < m.faces.count; f++) {
    const ia = m.faces.a[f];
    const ib = m.faces.b[f];
    const ic = m.faces.c[f];
    const A = get(pos, ia);
    const B = get(pos, ib);
    const C = get(pos, ic);
    const ab = sub(B, A);
    const ac = sub(C, A);
    const bc = sub(C, B);
    const lAB = len(ab) || 1e-9;
    const lAC = len(ac) || 1e-9;
    const lBC = len(bc) || 1e-9;
    const abn = { x: ab.x / lAB, y: ab.y / lAB, z: ab.z / lAB };
    const acn = { x: ac.x / lAC, y: ac.y / lAC, z: ac.z / lAC };
    const bcn = { x: bc.x / lBC, y: bc.y / lBC, z: bc.z / lBC };
    const angA = Math.acos(Math.max(-1, Math.min(1, dot(abn, acn))));
    const angB = Math.acos(Math.max(-1, Math.min(1, -dot(abn, bcn))));
    const angC = Math.acos(Math.max(-1, Math.min(1, dot(acn, bcn))));
    const d0 = kFace * (m.faces.nominalAngles[3 * f] - angA);
    const d1 = kFace * (m.faces.nominalAngles[3 * f + 1] - angB);
    const d2 = kFace * (m.faces.nominalAngles[3 * f + 2] - angC);

    const n: V3 = { x: m.faces.normal[3 * f], y: m.faces.normal[3 * f + 1], z: m.faces.normal[3 * f + 2] };
    const ncAB = scaleV(cross(n, ab), 1 / (lAB * lAB)); // cross(n,ab)/|ab|
    const ncAC = scaleV(cross(n, ac), 1 / (lAC * lAC));
    const ncBC = scaleV(cross(n, bc), 1 / (lBC * lBC));

    // node a
    addScaled(F, ia, ncAC, -(d0) + d2);
    addScaled(F, ia, ncAB, d0 - d1);
    // node b
    addScaled(F, ib, ncAB, -d0 + d1);
    addScaled(F, ib, ncBC, d1 - d2);
    // node c
    addScaled(F, ic, ncAC, d0 - d2);
    addScaled(F, ic, ncBC, -d1 + d2);
  }

  // --- 3D-printed soft-driven goal spring -------------------------------------------
  // In printed mode driven boundary nodes are NOT hard-pinned (so hinge barriers can open an
  // over-closed goal); a stiff spring pulls each toward its kinematic target rest→goal·foldPercent.
  if (m.softDriven) {
    const kGoal = m.params.kGoal ?? 0;
    for (let i = 0; i < m.numNodes; i++) {
      if (!m.driven[i]) continue;
      for (let d = 0; d < 3; d++) {
        const tgt = m.rest[3 * i + d] + (m.goal[3 * i + d] - m.rest[3 * i + d]) * foldPercent;
        F[3 * i + d] += kGoal * (tgt - pos[3 * i + d]);
      }
    }
  }

  // zero out forces on fixed nodes so they never move
  for (let i = 0; i < m.numNodes; i++) {
    if (m.fixed[i]) {
      F[3 * i] = 0;
      F[3 * i + 1] = 0;
      F[3 * i + 2] = 0;
    }
  }
}

function scaleV(v: V3, k: number): V3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}
function addScaled(F: Float32Array, i: number, v: V3, k: number): void {
  F[3 * i] += v.x * k;
  F[3 * i + 1] += v.y * k;
  F[3 * i + 2] += v.z * k;
}

/** Pass 4 — explicit forward Euler: v += (F/m)·dt; p += v·dt (paper §2.5). */
export function integrate(m: BarHingeModel, dt: number): void {
  const F = m.force;
  for (let i = 0; i < m.numNodes; i++) {
    if (m.fixed[i]) continue;
    const invM = 1 / m.mass[i];
    m.velocity[3 * i] += (F[3 * i] * invM) * dt;
    m.velocity[3 * i + 1] += (F[3 * i + 1] * invM) * dt;
    m.velocity[3 * i + 2] += (F[3 * i + 2] * invM) * dt;
    m.position[3 * i] += m.velocity[3 * i] * dt;
    m.position[3 * i + 1] += m.velocity[3 * i + 1] * dt;
    m.position[3 * i + 2] += m.velocity[3 * i + 2] * dt;
  }
}

/** Stable timestep dt < 1/(2π·ω_max), ω_max = max√(k_axial/m_min); paper Eqs 7–8 (0.9 margin).
 *  When self-collision is on, its penalty stiffness is another spring on the lightest node, so it
 *  enters ω_max too — otherwise a stiff contact would blow up the explicit integrator. */
export function computeDt(m: BarHingeModel): number {
  let maxFreq = 0;
  for (let i = 0; i < m.beams.count; i++) {
    const mMin = Math.min(m.mass[m.beams.n0[i]], m.mass[m.beams.n1[i]]);
    const w = Math.sqrt(m.beams.k[i] / mMin);
    if (w > maxFreq) maxFreq = w;
  }
  if (m.collide) {
    let mMin = Infinity;
    for (let i = 0; i < m.numNodes; i++) if (m.mass[i] < mMin) mMin = m.mass[i];
    const w = Math.sqrt(m.collide.params.k / (mMin || 1));
    if (w > maxFreq) maxFreq = w;
  }
  if (maxFreq <= 0) return 1e-3;
  return (1 / (2 * Math.PI * maxFreq)) * 0.9;
}
