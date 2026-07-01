/**
 * Stabilization passes for the explicit bar-and-hinge fold — the single source of truth for the
 * anti-jitter physics that used to live inlined in `src/view/sim-canvas.ts`. Pure functions over a
 * `BarHingeModel` (no Three.js, no DOM), so both the headless solver (`FoldSolver.solveUntilSettled`)
 * and the interactive canvas share identical math.
 *
 * Forward Euler on a frustrated, buckling mesh leaves residual motion that plain viscous damping
 * never fully drains (a limit-cycle "jitter"); these passes drain it deterministically:
 *  - `kineticDamp` — Otter's quenched dynamics (zero velocity whenever kinetic energy stops rising);
 *  - `dampVelocity` — a flat per-step velocity scale;
 *  - `removeRigidBodyMotion` — subtract the global translation/rotation that damping can't touch;
 *  - `guardFinite` — divergence guard: catch NaN/Inf or runaway speed and zero the offending node.
 */
import type { BarHingeModel } from "./model.js";

/** Total (unit-mass) kinetic energy Σ|v|² — the metric the kinetic-damping/settle tests use. */
export function totalKineticEnergy(m: Pick<BarHingeModel, "velocity">): number {
  const v = m.velocity;
  let ke = 0;
  for (let i = 0; i < v.length; i++) ke += v[i] * v[i];
  return ke;
}

/**
 * Otter's quenched dynamics: whenever total kinetic energy stops rising the system has just passed
 * an equilibrium, so zero all velocities. Pass the previous KE in and store the returned value for
 * next call. Drains a driven/frustrated fold to a dead-still pose, killing the limit-cycle jitter
 * plain viscous damping leaves behind, while momentum kept during each descent converges quickly.
 */
export function kineticDamp(m: Pick<BarHingeModel, "velocity">, prevKE: number): number {
  const v = m.velocity;
  let ke = 0;
  for (let i = 0; i < v.length; i++) ke += v[i] * v[i];
  if (ke < prevKE) {
    v.fill(0);
    return 0;
  }
  return ke;
}

/** Scale every velocity component by `factor` (0<factor<1) — flat viscous bleed. */
export function dampVelocity(m: Pick<BarHingeModel, "velocity">, factor: number): void {
  const v = m.velocity;
  for (let i = 0; i < v.length; i++) v[i] *= factor;
}

/**
 * Remove the global rigid-body component (mean linear velocity + rigid rotation about the centroid)
 * that viscous damping can't dissipate, so a free mesh settles in place instead of drifting/spinning
 * off-camera. Fixed nodes are held at zero velocity. Operates on `velocity` in place.
 */
export function removeRigidBodyMotion(
  m: Pick<BarHingeModel, "velocity" | "position" | "numNodes" | "fixed">,
): void {
  const v = m.velocity;
  const p = m.position;
  const n = m.numNodes;
  if (n === 0) return;

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p[3 * i]; cy += p[3 * i + 1]; cz += p[3 * i + 2]; }
  cx /= n; cy /= n; cz /= n;

  let mx = 0, my = 0, mz = 0, lx = 0, ly = 0, lz = 0, inertia = 0;
  for (let i = 0; i < n; i++) {
    const vx = v[3 * i], vy = v[3 * i + 1], vz = v[3 * i + 2];
    mx += vx; my += vy; mz += vz;
    const rx = p[3 * i] - cx, ry = p[3 * i + 1] - cy, rz = p[3 * i + 2] - cz;
    lx += ry * vz - rz * vy; ly += rz * vx - rx * vz; lz += rx * vy - ry * vx;
    inertia += rx * rx + ry * ry + rz * rz;
  }
  mx /= n; my /= n; mz /= n;
  const inv = inertia > 1e-9 ? 1 / inertia : 0;
  const wx = lx * inv, wy = ly * inv, wz = lz * inv;
  for (let i = 0; i < n; i++) {
    if (m.fixed[i]) { v[3 * i] = v[3 * i + 1] = v[3 * i + 2] = 0; continue; }
    const rx = p[3 * i] - cx, ry = p[3 * i + 1] - cy, rz = p[3 * i + 2] - cz;
    v[3 * i] -= mx + (wy * rz - wz * ry);
    v[3 * i + 1] -= my + (wz * rx - wx * rz);
    v[3 * i + 2] -= mz + (wx * ry - wy * rx);
  }
}

/**
 * Divergence guard. Scans every node for a non-finite position/velocity or a speed above `maxSpeed`,
 * and zeros that node's velocity to stop the energy injection from propagating. Returns `true` when
 * the model was clean (no intervention), `false` when a blow-up was caught — the signal a headless
 * solve uses to report non-convergence instead of returning silent NaNs.
 */
export function guardFinite(
  m: Pick<BarHingeModel, "velocity" | "position" | "numNodes">,
  maxSpeed = Infinity,
): boolean {
  const v = m.velocity;
  const p = m.position;
  const maxSq = maxSpeed === Infinity ? Infinity : maxSpeed * maxSpeed;
  let clean = true;
  for (let i = 0; i < m.numNodes; i++) {
    const vx = v[3 * i], vy = v[3 * i + 1], vz = v[3 * i + 2];
    const px = p[3 * i], py = p[3 * i + 1], pz = p[3 * i + 2];
    const badV = !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz);
    const badP = !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz);
    const fast = maxSq !== Infinity && vx * vx + vy * vy + vz * vz > maxSq;
    if (badV || badP || fast) {
      v[3 * i] = 0; v[3 * i + 1] = 0; v[3 * i + 2] = 0;
      clean = false;
    }
  }
  return clean;
}
