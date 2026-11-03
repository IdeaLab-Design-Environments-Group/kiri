/**
 * Camera follow for the fold simulation. While the sheet folds, its centre moves; the camera is framed once
 * on the union of the flat and folded poses, so the part drifts off-centre. This module eases the orbit
 * target and the camera position by the SAME delta towards the centre of the current pose: the user's orbit
 * angle and zoom are untouched and only the pan follows. The maths is pure so it can be unit tested without
 * WebGL; `SimCameraFollow` holds the on/off state.
 */

export interface Vec3 { x: number; y: number; z: number }

/** Fraction of the remaining gap closed per frame. */
export const FOLLOW_DAMPING = 0.12;

/** Gap (in model units) below which the camera snaps instead of creeping forever. */
export const FOLLOW_SNAP = 1e-4;

/** Centre of the axis-aligned bounding box of an xyz array (one O(N) pass); non-finite nodes are skipped. */
export function poseCentre(pos: ArrayLike<number>, numNodes: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
  for (let i = 0; i < numNodes; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < loX) loX = x; if (x > hiX) hiX = x;
    if (y < loY) loY = y; if (y > hiY) hiY = y;
    if (z < loZ) loZ = z; if (z > hiZ) hiZ = z;
  }
  if (loX > hiX) return out; // no finite node: leave the output as given
  out.x = (loX + hiX) / 2; out.y = (loY + hiY) / 2; out.z = (loZ + hiZ) / 2;
  return out;
}

/**
 * Delta to add to BOTH the target and the camera so the target moves `damping` of the way to `centre`.
 * Snaps the whole gap once it is below `FOLLOW_SNAP`. Pure.
 */
export function followDelta(centre: Vec3, target: Vec3, damping: number = FOLLOW_DAMPING, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const dx = centre.x - target.x, dy = centre.y - target.y, dz = centre.z - target.z;
  const k = Math.hypot(dx, dy, dz) < FOLLOW_SNAP ? 1 : Math.min(1, Math.max(0, damping));
  out.x = dx * k; out.y = dy * k; out.z = dz * k;
  return out;
}

export class SimCameraFollow {
  private on = true;
  private readonly centre: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly delta: Vec3 = { x: 0, y: 0, z: 0 };

  get following(): boolean { return this.on; }

  /** The user took the camera (pan / drag / wheel): stop following. */
  stop(): void { this.on = false; }

  /** Resume following (double-click). */
  resume(): void { this.on = true; }

  /**
   * One follow step. Moves `target` and `cameraPos` by the same delta. `snap` applies the whole gap.
   * Returns false (and does nothing, no O(N) pass) when not following.
   */
  step(pos: ArrayLike<number>, numNodes: number, target: Vec3, cameraPos: Vec3, snap = false): boolean {
    if (!this.on) return false;
    poseCentre(pos, numNodes, this.centre);
    followDelta(this.centre, target, snap ? 1 : FOLLOW_DAMPING, this.delta);
    target.x += this.delta.x; target.y += this.delta.y; target.z += this.delta.z;
    cameraPos.x += this.delta.x; cameraPos.y += this.delta.y; cameraPos.z += this.delta.z;
    return true;
  }
}
