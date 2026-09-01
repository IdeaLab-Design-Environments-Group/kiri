import type { BarHingeModel } from "./model.js";
import type { FoldSolver } from "./solver.js";
import { kineticDamp, removeRigidBodyMotion } from "./stabilize.js";

/**
 * **How a fold is driven over time** — the per-frame cadence, separated from the viewport that
 * displays it so it can be run, and therefore tested, without a browser.
 *
 * This is not an incidental extraction. The cadence is not a detail on top of the physics; it *is*
 * part of the physics of an explicit integrator, and getting it wrong looks exactly like getting the
 * forces wrong. Ramping the fold faster than the mesh can relax injects energy the integrator cannot
 * dissipate, and creases overshoot into the wrong branch: on house.fkld the free fold's per-step
 * ramp lands 4 of 9 creases up to 43° off target and the model 14% of a span from its declared
 * form, where the quasi-static per-frame ease lands every crease within 5° and the model within 3%.
 *
 * It lives here because a test that re-implements the loop attests to nothing. That is precisely how
 * the fast-ramp regression above shipped: the physics tests eased quasi-statically while the viewer
 * ramped 20× faster, so they passed and the viewer was visibly wrong. Anything checking how a fold
 * behaves over time drives it through this, the way `sim-canvas` does.
 *
 * Three properties of the scene decide the cadence, and they are independent:
 *
 *  - **toGoal** — the fold is being taken to a declared shape, pinned to it or guided softly toward
 *    it. Quasi-static ease, and the Otter kinetic quench once the target is reached.
 *  - **unpinned** — no node is fixed, so global drift has to be removed each step. A softly guided
 *    model is `toGoal` AND `unpinned`; conflating the two is what put it on the free ramp.
 *  - **guideHeld** — there is a soft guide to let go of at the end (`BarHingeModel.guideWeight`).
 */

/**
 * Guided cadence: fraction of the remaining fold applied per FRAME (not per step).
 *
 * **This is measured in frames, so it is coupled to `solver.dt`** — a frame advances
 * `dt · GUIDED_STEPS_PER_FRAME` of simulated time, and anything that shrinks `dt` therefore makes
 * the fold ramp *faster in physical time* at the same value here. `computeDt` shrinks with stiffness,
 * so raising a stiffness to fix one thing silently speeds the ramp and can break another: raising the
 * self-collision `k` from 220 to 600 takes house.fkld's dt from 9.7e-3 to 5.8e-3 and its settled pose
 * from 3% of a span off its declared form to 27%, with nothing about the contact itself at fault.
 *
 * Before changing any stiffness (`EA`, `kSeam`, `DEFAULT_COLLISION.k`), re-measure the fold, not just
 * the thing being tuned. Normalizing the ease by `dt · steps` would decouple them and is the right
 * fix if this bites again; it is not done here because it would also re-time every existing preset.
 */
const FOLD_EASE = 0.05;
/**
 * A frame stops early once some node has moved this fraction of the model's span, so fast motion is
 * DRAWN rather than skipped.
 *
 * Letting go of the guide is a snap-through: the pose the guide holds is not an equilibrium of the
 * pattern alone, so somewhere around half-released the mesh crosses a barrier and slides to the one
 * that is. That is real, and not a rate artifact — stretching the release from 1 second to 15 makes
 * no difference to it (36.2% of a span moved in a single frame either way). But at 80 steps a frame
 * the whole slide happens in about five rendered frames, so what reaches the screen is not a fold
 * settling, it is a flick. Under this cap the same slide is spread over fifty-odd frames and reads
 * as what it is.
 */
const FAST_MOTION = 0.01;
/** Steps between checks of how far the frame has got. Small enough to stop close to the budget. */
const CHUNK = 1;
/** Guided cadence: solver steps per frame, all at that frame's foldPercent. */
const GUIDED_STEPS_PER_FRAME = 80;
/** Free cadence: solver steps per frame. */
const STEPS_PER_FRAME = 40;
/** Free cadence: fraction of the remaining fold applied per STEP. */
const FREE_PER_STEP_EASE = 0.014;
/** How fast the soft guide lets go once the fold reaches its target (~1s at 60fps). */
const GUIDE_RELEASE_PER_FRAME = 1 / 60;
/** |targetFold − foldPercent| below this counts as "at the target fold". */
export const FOLD_REACHED_EPS = 1e-3;

/** Drives one fold scene's solver over time. Owns `foldPercent`; the view owns everything visual. */
export class FoldRunner {
  /** The fold actually applied right now — eased toward `target`. */
  foldPercent = 0;
  private target = 0;
  private prevKE = Infinity;
  /** Scratch copy of the pose at the start of a frame, for measuring how far it moved. */
  private before: Float32Array | null = null;
  /** The share of a full frame's stepping the last frame did; the guide fades by the same share. */
  private releaseShare = 1;
  /** Largest extent of the model, for reading node motion as a fraction of it. */
  private readonly span: number;
  /** Taken to a declared shape (pinned or softly guided) ⇒ quasi-static ease + quench at target. */
  readonly toGoal: boolean;
  /** Nothing pinned and nothing holding the placement ⇒ remove rigid-body motion each step. */
  readonly unpinned: boolean;
  /** There is a soft guide, so there is something to let go of at the end. */
  readonly guideHeld: boolean;

  constructor(
    private readonly model: BarHingeModel,
    private readonly solver: FoldSolver,
  ) {
    let pinned = false;
    for (let i = 0; i < model.fixed.length; i++) {
      if (model.fixed[i]) {
        pinned = true;
        break;
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 3 * model.numNodes; i++) {
      if (model.rest[i] < lo) lo = model.rest[i];
      if (model.rest[i] > hi) hi = model.rest[i];
    }
    this.span = hi > lo ? hi - lo : 1;
    this.guideHeld = model.softDriven === true && model.guideWeight !== undefined;
    this.toGoal = pinned || this.guideHeld;
    // Re-centring exists for a fold that nothing holds in place. A kinematic guide DOES hold it in
    // place — its target is a specific pose, not just a shape — so removing rigid-body motion there
    // does not stabilise the model, it drags it: the panel the artifact rests on wandered 11-15% of
    // a span through the fold with this on, against 0.9% with it off.
    this.unpinned = !pinned && model.foldDrive !== "kinematic";
    if (this.guideHeld) model.guideWeight = 1;
  }

  /** Aim at a new fold fraction (the slider). Restarts the guide, since the shape is moving again. */
  setTarget(p: number): void {
    this.target = Math.min(1, Math.max(0, p));
    this.prevKE = Infinity;
    if (this.guideHeld) this.model.guideWeight = 1;
  }

  getTarget(): number {
    return this.target;
  }

  /** True once `foldPercent` has arrived at the target (the guide may still be letting go). */
  atTarget(): boolean {
    return Math.abs(this.target - this.foldPercent) < FOLD_REACHED_EPS;
  }

  /** True once the guide has fully let go — or there was never one to let go of. */
  guideReleased(): boolean {
    return !this.guideHeld || (this.model.guideWeight ?? 0) <= 0;
  }

  /** The fold is finished when it has arrived AND the hands are off it. */
  settled(): boolean {
    return this.atTarget() && this.guideReleased();
  }

  /**
   * Advance one animation frame: ease the fold, step the solver, stabilize, and let go of the guide
   * a little once the target is reached.
   *
   * The quench runs only AT the target. During the ramp the guide keeps feeding the mesh, so
   * quenching then would repeatedly halt the lagging interior and leave a worse pose.
   */
  frame(): void {
    const m = this.model;
    if (this.toGoal) {
      // A frame is stepped in chunks and CUT SHORT once enough has visibly happened, so fast motion
      // is drawn rather than skipped. Everything measured per frame — the ease and the guide's
      // release — is scaled by the share of a frame that actually ran, so cutting a frame short
      // changes how much of the fold is DRAWN and never how fast the fold happens.
      const before = (this.before ??= new Float32Array(m.position.length));
      before.set(m.position);
      const budget = FAST_MOTION * this.span;
      let ran = 0;
      while (ran < GUIDED_STEPS_PER_FRAME) {
        const chunk = Math.min(CHUNK, GUIDED_STEPS_PER_FRAME - ran);
        const share = chunk / GUIDED_STEPS_PER_FRAME;
        this.foldPercent += (this.target - this.foldPercent) * FOLD_EASE * share;
        if (this.atTarget()) this.foldPercent = this.target;
        const at = this.foldPercent === this.target;
        this.solver.foldPercent = this.foldPercent;
        for (let i = 0; i < chunk; i++) {
          this.solver.step();
          if (this.unpinned) removeRigidBodyMotion(m);
          if (at) this.prevKE = kineticDamp(m, this.prevKE);
        }
        ran += chunk;
        if (this.maxNodeMove(before) > budget) break; // enough has happened to be worth drawing
      }
      this.releaseShare = ran / GUIDED_STEPS_PER_FRAME;
    } else {
      // Free fold (self-supporting origami/kirigami, e.g. the Miyamoto RES tower): drive crease
      // targets and let the OS-faithful under-damped dynamics settle — exactly as Origami Simulator
      // does. NO kinetic quench here: zeroing velocity at the first equilibrium traps an
      // underconstrained sheet flat before it can buckle UP into shape (the RES tower stalled at
      // h/w ≈ 0.2 with the quench versus ≈ 0.57 erected without it).
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        this.foldPercent += (this.target - this.foldPercent) * FREE_PER_STEP_EASE;
        this.solver.foldPercent = this.foldPercent;
        this.solver.step();
        removeRigidBodyMotion(m);
      }
      if (this.atTarget()) this.foldPercent = this.target;
    }
    this.releaseGuide();
  }

  /**
   * Let go. While the fold eases to its target the guide holds the mesh toward the declared form;
   * once it arrives, the guide relaxes to zero over ~a second, leaving the pose standing on the
   * pattern's own creases and seams. A fold that springs open here would spring open in paper.
   */
  private releaseGuide(): void {
    if (!this.guideHeld) return;
    if (!this.atTarget()) {
      this.model.guideWeight = 1; // still being folded, or the slider moved back — hold on
      return;
    }
    this.model.guideWeight = Math.max(0, (this.model.guideWeight ?? 1) - GUIDE_RELEASE_PER_FRAME * this.releaseShare);
  }

  /** How far the furthest node moved since `before`. */
  private maxNodeMove(before: Float32Array): number {
    const p = this.model.position;
    let worst = 0;
    for (let i = 0; i < this.model.numNodes; i++) {
      const d = Math.hypot(p[3 * i] - before[3 * i], p[3 * i + 1] - before[3 * i + 1], p[3 * i + 2] - before[3 * i + 2]);
      if (d > worst) worst = d;
    }
    return worst;
  }

  /**
   * Fast-forward to the target without drawing the frames — for opening a modal already scrolled to
   * a fold. Runs the same `frame()`, so it takes the same path the animation would.
   */
  warmToTarget(maxFrames = 2000): void {
    if (!this.toGoal || this.target < FOLD_REACHED_EPS) return; // a free fold has to be watched
    for (let i = 0; i < maxFrames && !this.settled(); i++) this.frame();
  }
}
