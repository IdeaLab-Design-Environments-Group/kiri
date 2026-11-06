/**
 * Where the fold simulation's camera is framed when a scene loads. Pure, so it is tested without WebGL.
 *
 * A guided fold is framed on its folded goal alone. Simulate opens by folding the model, so the folded
 * shape is what the view is for; framing the union of the flat sheet and the goal sized the frame for
 * the sheet and left the folded house about a tenth of the canvas wide. The flat sheet overflows the
 * frame for the first moments of the fold, and the camera follow (`sim-camera-follow`) keeps the pose
 * centred as it moves. A free fold has no declared shape, so it is framed on the sheet.
 */
import type { Vec3 } from "./sim-camera-follow.js";

/** The parts of a `BarHingeModel` the framing reads. */
export interface FramedModel {
  numNodes: number;
  position: Float32Array;
  goal: Float32Array;
  driven: Uint8Array;
}

/** Axis-aligned box of the finite nodes: centre and largest extent (never 0), in model units. */
interface Box {
  centre: Vec3;
  span: number;
}

/**
 * The framed box, plus `reachSpan`: the largest extent of the sheet and the goal together, which is
 * what the frame used to be sized by. The viewer's freeze threshold is scaled by it and keeps it, so
 * reframing the camera does not also change when a settled fold stops being stepped.
 */
export function foldFrame(m: FramedModel): Box & { reachSpan: number } {
  let guided = false;
  for (let i = 0; i < m.driven.length && !guided; i++) guided = m.driven[i] === 1;
  const sheet = box(m.numNodes, m.position) ?? { centre: { x: 0, y: 0, z: 0 }, span: 1e-3 };
  const goal = guided ? box(m.numNodes, m.goal) : null;
  if (!goal) return { ...sheet, reachSpan: sheet.span };
  return { ...goal, reachSpan: box(m.numNodes, m.position, m.goal)!.span };
}

/** Box of the finite nodes of one or more poses, or null when there is none. */
function box(numNodes: number, ...poses: Float32Array[]): Box | null {
  let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
  for (const a of poses) {
    for (let i = 0; i < numNodes; i++) {
      const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < loX) loX = x; if (x > hiX) hiX = x;
      if (y < loY) loY = y; if (y > hiY) hiY = y;
      if (z < loZ) loZ = z; if (z > hiZ) hiZ = z;
    }
  }
  if (loX > hiX) return null;
  return {
    centre: { x: (loX + hiX) / 2, y: (loY + hiY) / 2, z: (loZ + hiZ) / 2 },
    span: Math.max(hiX - loX, hiY - loY, hiZ - loZ, 1e-3),
  };
}
