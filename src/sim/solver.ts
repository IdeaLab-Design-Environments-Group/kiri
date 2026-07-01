import type { BarHingeModel } from "./model.js";
import {
  accumulateForces,
  computeDt,
  computeFaceNormals,
  computeThetas,
  integrate,
} from "./forces.js";
import { accumulateCollisionForces, buildCollisionState, DEFAULT_COLLISION, type CollisionParams } from "./collision.js";
import {
  dampVelocity,
  guardFinite,
  kineticDamp,
  removeRigidBodyMotion,
  totalKineticEnergy,
} from "./stabilize.js";

/** Options for {@link FoldSolver.solveUntilSettled}. */
export interface SettleOptions {
  /** Fold fraction to ease toward (default 1 = fully folded). */
  target?: number;
  /** Hard cap on iterations. */
  maxIters: number;
  /** Quasi-static ease rate per step (default 0.004, matching `solve`). */
  easeRate?: number;
  /** Converged once total kinetic energy drops below this (model's normalized units²). */
  keEps: number;
  /** Minimum steps held at `target` before the KE test arms (avoids stopping mid-transient). */
  minSettleIters?: number;
  /** Optional flat per-step velocity damping factor (e.g. 0.9 for a free mesh). */
  damp?: number;
  /** Optional Otter kinetic-energy quench per step (good for driven/guided folds). */
  quench?: boolean;
  /** Optional rigid-body-motion removal per step (free meshes that would otherwise drift). */
  removeRigidBody?: boolean;
  /** Optional divergence guard per step (catches NaN/runaway, reports non-convergence). */
  guard?: boolean;
  /** Speed cap for the divergence guard (default: no cap, finiteness only). */
  maxSpeed?: number;
}

/** Result of {@link FoldSolver.solveUntilSettled}. */
export interface SettleResult {
  /** True iff the fold reached `target`, stayed finite, and settled below `keEps`. */
  converged: boolean;
  /** Iterations actually run. */
  iters: number;
  /** Final total kinetic energy. */
  ke: number;
}

/**
 * CPU reference solver — the unit-testable twin of the GPU path (`gpu/gpu-solver.ts`). It runs
 * Gershenfeld's explicit bar-and-hinge integration: per step it computes face normals, crease
 * fold angles, accumulates axial/crease/face/damping forces, then does one forward-Euler update.
 *
 * `foldPercent` (0→1) scales every crease's design target angle, so ramping it animates the
 * flat net folding up into the pyramid; holding it at 1 and iterating relaxes to the folded
 * static state.
 */
export class FoldSolver {
  /** Stable explicit timestep; recomputed by {@link enableCollision} since contact adds stiffness. */
  dt: number;
  /** Persistent per-crease fold angle, unwrapped across steps. */
  readonly theta: Float32Array;
  foldPercent = 0;

  constructor(readonly model: BarHingeModel) {
    this.dt = computeDt(model);
    this.theta = new Float32Array(model.creases.count);
  }

  /**
   * Turn on penalty self-collision so folded layers can't pass through each other. Builds the
   * model's collision state and refreshes `dt` (the contact stiffness enters the stability bound).
   * No-op equivalent if never called: the bare Gershenfeld model has no collisions.
   */
  enableCollision(params: CollisionParams = DEFAULT_COLLISION): void {
    this.model.collide = buildCollisionState(this.model, params);
    this.dt = computeDt(this.model);
  }

  /** Advance one explicit step at the current `foldPercent`. */
  step(): void {
    this.driveBoundary();
    computeFaceNormals(this.model);
    computeThetas(this.model, this.theta);
    accumulateForces(this.model, this.theta, this.foldPercent);
    if (this.model.collide) accumulateCollisionForces(this.model, this.model.collide);
    integrate(this.model, this.dt);
  }

  /**
   * Forward process (DETC §3.2): move each driven boundary node along rest→goal by foldPercent,
   * so the structure is guided to the designed goal mesh M0 while the interior relaxes. Driven
   * nodes are also `fixed`, so the force passes leave them where this puts them.
   */
  private driveBoundary(): void {
    const m = this.model;
    // 3D-printed soft-driven mode: driven nodes are moved by the goal-spring force (forces.ts),
    // not hard-placed here, so thick-hinge barriers can relax an over-closed goal pose.
    if (m.softDriven) return;
    const fp = this.foldPercent;
    for (let i = 0; i < m.numNodes; i++) {
      if (!m.driven[i]) continue;
      for (let d = 0; d < 3; d++) {
        m.position[3 * i + d] = m.rest[3 * i + d] + (m.goal[3 * i + d] - m.rest[3 * i + d]) * fp;
      }
    }
  }

  /**
   * Run `iters` steps, easing foldPercent toward `targetFold` **quasi-statically** (a gradual
   * exponential approach, not a linear slam) so the structure stays near equilibrium throughout
   * and settles to low strain — a fast ramp injects energy the explicit integrator can't
   * dissipate. The remaining steps after the ease relax the fold.
   */
  solve(iters: number, targetFold = this.foldPercent): void {
    for (let i = 0; i < iters; i++) {
      this.foldPercent += (targetFold - this.foldPercent) * 0.004;
      this.step();
    }
    this.foldPercent = targetFold;
  }

  /**
   * Robust headless fold for any caller that needs a *settled* pose and a convergence signal —
   * the bundled `solve()` only eases and stops at a fixed iteration count, leaving residual jitter
   * on a frustrated/free mesh. This eases `foldPercent` → `target`, then applies the requested
   * stabilization passes (kinetic quench / viscous damp / rigid-body-motion removal, all from
   * `stabilize.ts`) each step and iterates until total kinetic energy < `keEps` (armed only once
   * `foldPercent === target` and at least `minSettleIters` steps have run there) or `maxIters`.
   * With `guard` on, a NaN/runaway blow-up is caught and reported as non-convergence instead of
   * returning silent NaNs — the signal the Stage-5 verify loop and the stability tests rely on.
   *
   * Recommended presets: free mesh → `{ damp: 0.9, removeRigidBody: true, guard: true }`;
   * guided/driven mesh → `{ quench: true, guard: true }`. The existing `step()`/`solve()` and the
   * guided pyramid path are untouched, so AKDE fidelity is preserved.
   */
  solveUntilSettled(opts: SettleOptions): SettleResult {
    const {
      target = 1,
      maxIters,
      easeRate = 0.004,
      keEps,
      minSettleIters = 0,
      damp,
      quench = false,
      removeRigidBody = false,
      guard = false,
      maxSpeed,
    } = opts;

    let prevKE = Infinity;
    let atTarget = 0;
    let diverged = false;
    let ke = Infinity;
    let i = 0;

    for (; i < maxIters; i++) {
      this.foldPercent += (target - this.foldPercent) * easeRate;
      if (Math.abs(target - this.foldPercent) < 1e-6) this.foldPercent = target;

      this.step();

      if (guard && !guardFinite(this.model, maxSpeed)) diverged = true;
      if (quench) prevKE = kineticDamp(this.model, prevKE);
      if (damp !== undefined) dampVelocity(this.model, damp);
      if (removeRigidBody) removeRigidBodyMotion(this.model);

      ke = totalKineticEnergy(this.model);

      if (this.foldPercent === target) {
        if (++atTarget >= minSettleIters && ke < keEps) {
          i++;
          break;
        }
      } else {
        atTarget = 0;
      }
    }

    this.foldPercent = target;
    const finite = guardFinite(this.model);
    return { converged: !diverged && finite && ke < keEps, iters: i, ke };
  }

  /** Current measured fold angle θ of crease `i` (signed; dihedral γ = π − θ). */
  thetaOf(i: number): number {
    return this.theta[i];
  }

  /** Copy current node positions out as an [x,y,z][] (e.g. for assertions). */
  positions(): [number, number, number][] {
    const out: [number, number, number][] = [];
    const p = this.model.position;
    for (let i = 0; i < this.model.numNodes; i++) {
      out.push([p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    }
    return out;
  }
}

/** Measure the dihedral fold angle θ across two faces sharing edge (e0,e1). Test helper. */
export function measureTheta(
  model: BarHingeModel,
  face1: number,
  face2: number,
  e0: number,
  e1: number,
): number {
  computeFaceNormals(model);
  const N = model.faces.normal;
  const n1 = { x: N[3 * face1], y: N[3 * face1 + 1], z: N[3 * face1 + 2] };
  const n2 = { x: N[3 * face2], y: N[3 * face2 + 1], z: N[3 * face2 + 2] };
  const p = model.position;
  const e = {
    x: p[3 * e1] - p[3 * e0],
    y: p[3 * e1 + 1] - p[3 * e0 + 1],
    z: p[3 * e1 + 2] - p[3 * e0 + 2],
  };
  const el = Math.hypot(e.x, e.y, e.z) || 1;
  const eh = { x: e.x / el, y: e.y / el, z: e.z / el };
  const x = Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y + n1.z * n2.z));
  const cr = {
    x: n1.y * eh.z - n1.z * eh.y,
    y: n1.z * eh.x - n1.x * eh.z,
    z: n1.x * eh.y - n1.y * eh.x,
  };
  const y = cr.x * n2.x + cr.y * n2.y + cr.z * n2.z;
  return Math.atan2(y, x);
}
