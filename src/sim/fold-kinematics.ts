import type { BarHingeModel } from "./model.js";

/**
 * **The fold every panel agrees on.**
 *
 * A guide that pulls each vertex down the straight line `rest + (goal − rest)·s` is not asking for a
 * fold. Measured on house.fkld at `s = 0.5`, that target pose has every vertex sitting at its chord
 * midpoint: bars foreshortened by up to **100%**, and its own crease angles reading **0% folded**.
 * The crease springs meanwhile ask for a half-folded box. The sheet settles between two masters that
 * disagree, which is what the panels flying off in different directions, the squash-and-re-expand,
 * and the snap at the end all were. Four attempts to fix the *pace* of that fold failed because they
 * each left the disagreement in place.
 *
 * For most of these patterns the honest target is closed-form. The Kirigamizer flattens a closed
 * shape by cutting it open to a disk, and what comes out has no interior vertex and — measured — no
 * loop in its panel graph at all: house is 16 panels over 15 hinges, church 19 over 18, puffin 96
 * over 95. A tree. So there is no loop-closure constraint anywhere, and the pose at fold fraction `s`
 * follows from the crease angles alone: hold one panel still and rotate every subtree about its hinge
 * by `s·θ`. Panels stay rigid, so the pose is exactly isometric; every crease is exactly at `s` of
 * its target, so no panel runs ahead of another. At `s = 1` it *is* the declared form, because that
 * is where the targets were measured. Guide, crease springs and bars then want the same thing at
 * every `s`, and there is nothing left for the sheet to fight.
 *
 * Not every net is a tree. kirigami-flap and the three AKDE cones each carry one loop, where the
 * angles alone no longer determine the pose and closing the loop is its own problem (Tachi 2009).
 * Those fall back to the chord guide — `buildCreaseTree` reports the loops it found and
 * `origami-import.ts` gates on them.
 *
 * Seam hinges are deliberately not tree edges. They are the taped lips of the cuts the unfolding
 * made — precisely the loop closures it removed — so folding along them would put the loops back.
 */

/** The panel tree a fold is driven along, and whatever hinges did not fit in it. */
export interface CreaseTree {
  /** Face held still; everything else swings from it. */
  root: number;
  /** Faces in parent-before-child order, root first — walk it once to place every panel. */
  order: Int32Array;
  /** Per face: the crease joining it to its parent, or −1 for the root. */
  parentCrease: Int32Array;
  /** Per face: its parent, or −1 for the root. */
  parentFace: Int32Array;
  /** Per face: `true` when the face is the crease's `face1` (which way the hinge turns). */
  parentIsFace1: Uint8Array;
  /** Scored creases that closed a loop instead of joining a new panel. Empty ⇒ the net is a tree. */
  loops: number[];
  /** Per node: a face that owns it. On a tree every owner agrees; on a loop net they do not. */
  faceOfNode: Int32Array;
}

/**
 * Find the panel tree: which hinge swings which panel, from a root that stays put.
 *
 * Only the **scored** creases are candidates — `creases[i]` for `i < count − seamCreases`, skipping
 * any that carries a seam peer. The root is the panel the folded form puts lowest, so the fold rises
 * from it rather than hanging off it; ties go to the largest panel, which makes it stable to pin.
 */
export function buildCreaseTree(m: BarHingeModel): CreaseTree {
  const c = m.creases;
  const scored = c.count - (m.seamCreases ?? 0);
  const nFaces = m.faces.count;

  // adjacency over scored creases only
  const head = new Int32Array(nFaces).fill(-1);
  const next: number[] = [];
  const toFace: number[] = [];
  const viaCrease: number[] = [];
  const link = (from: number, to: number, crease: number): void => {
    next.push(head[from]);
    toFace.push(to);
    viaCrease.push(crease);
    head[from] = next.length - 1;
  };
  const candidate: boolean[] = [];
  for (let i = 0; i < scored; i++) {
    const isSeam = (c.seamPeer3?.[i] ?? -1) >= 0;
    candidate.push(!isSeam);
    if (isSeam) continue;
    link(c.face1[i], c.face2[i], i);
    link(c.face2[i], c.face1[i], i);
  }

  const root = pickRoot(m);
  const order = new Int32Array(nFaces);
  const parentCrease = new Int32Array(nFaces).fill(-1);
  const parentFace = new Int32Array(nFaces).fill(-1);
  const parentIsFace1 = new Uint8Array(nFaces);
  const seen = new Uint8Array(nFaces);
  const usedCrease = new Uint8Array(scored);

  let write = 0;
  order[write++] = root;
  seen[root] = 1;
  for (let read = 0; read < write; read++) {
    const face = order[read];
    for (let e = head[face]; e >= 0; e = next[e]) {
      const other = toFace[e];
      if (seen[other]) continue;
      seen[other] = 1;
      usedCrease[viaCrease[e]] = 1;
      parentCrease[other] = viaCrease[e];
      parentFace[other] = face;
      parentIsFace1[other] = c.face1[viaCrease[e]] === other ? 1 : 0;
      order[write++] = other;
    }
  }

  // Any candidate crease the walk did not need joined two panels already connected: a loop.
  const loops: number[] = [];
  for (let i = 0; i < scored; i++) if (candidate[i] && !usedCrease[i]) loops.push(i);

  // A face left unreached is its own island (the free-fold tilings have no creases at all); it keeps
  // its rest pose, which is what an unhinged panel should do.
  for (let f = 0; f < nFaces; f++) if (!seen[f]) order[write++] = f;

  const faceOfNode = new Int32Array(m.numNodes).fill(-1);
  for (let f = 0; f < nFaces; f++) {
    for (const n of [m.faces.a[f], m.faces.b[f], m.faces.c[f]]) {
      if (faceOfNode[n] < 0) faceOfNode[n] = f;
    }
  }

  return { root, order, parentCrease, parentFace, parentIsFace1, loops, faceOfNode };
}

/** The panel the folded form puts lowest; ties to the biggest, which is the steadier thing to pin. */
function pickRoot(m: BarHingeModel): number {
  let best = 0;
  let bestZ = Infinity;
  let bestArea = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 3 * m.numNodes; i++) {
    if (m.goal[i] < lo) lo = m.goal[i];
    if (m.goal[i] > hi) hi = m.goal[i];
  }
  const tie = 1e-3 * Math.max(hi - lo, 1e-9);
  for (let f = 0; f < m.faces.count; f++) {
    const a = m.faces.a[f], b = m.faces.b[f], d = m.faces.c[f];
    const z = (m.goal[3 * a + 2] + m.goal[3 * b + 2] + m.goal[3 * d + 2]) / 3;
    const area = triArea(m.rest, a, b, d);
    if (z < bestZ - tie || (z < bestZ + tie && area > bestArea)) {
      if (z < bestZ) bestZ = z;
      bestArea = area;
      best = f;
    }
  }
  return best;
}

function triArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
  const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Pick `k` nodes spread across a pose, by farthest-point sampling from the one furthest out.
 *
 * For comparing two poses through distances-to-anchors, how far apart the anchors sit IS the
 * resolution of the comparison: a node's displacement registers only along the directions from it to
 * each anchor, so anchors that huddle read a sideways swing at the sine of the angle they subtend.
 * Taking the extremes of the form instead keeps every direction well represented, and four of them
 * are not coplanar, which pins a point with no reflection ambiguity left over.
 */
export function spreadAnchors(p: Float32Array, numNodes: number, k: number): number[] {
  const n = Math.min(k, numNodes);
  if (n <= 0) return [];
  const dist = (a: number, b: number): number =>
    Math.hypot(p[3 * a] - p[3 * b], p[3 * a + 1] - p[3 * b + 1], p[3 * a + 2] - p[3 * b + 2]);

  // Seed with the node furthest from the centroid — an extreme of the form, not an arbitrary index,
  // so the choice does not depend on how the mesh happens to be numbered.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < numNodes; i++) { cx += p[3 * i]; cy += p[3 * i + 1]; cz += p[3 * i + 2]; }
  cx /= numNodes; cy /= numNodes; cz /= numNodes;
  let seed = 0, seedD = -1;
  for (let i = 0; i < numNodes; i++) {
    const d = Math.hypot(p[3 * i] - cx, p[3 * i + 1] - cy, p[3 * i + 2] - cz);
    if (d > seedD) { seedD = d; seed = i; }
  }

  const picked = [seed];
  const near = new Float64Array(numNodes);
  for (let i = 0; i < numNodes; i++) near[i] = dist(i, seed);
  while (picked.length < n) {
    let best = -1, bestD = -1;
    for (let i = 0; i < numNodes; i++) if (near[i] > bestD) { bestD = near[i]; best = i; }
    if (best < 0 || bestD <= 0) break; // every node already coincides with an anchor
    picked.push(best);
    for (let i = 0; i < numNodes; i++) { const d = dist(i, best); if (d < near[i]) near[i] = d; }
  }
  return picked;
}

/**
 * Place every node for fold fraction `s` by walking the tree: the root panel stays exactly where the
 * flat sheet puts it, and each child is its parent's placement composed with a turn of `s·θ` about
 * its own hinge — taken in REST coordinates, since the parent transform is what carries the rest
 * frame into the world.
 *
 * `s = 0` returns the flat sheet exactly and `s = 1` the declared form, both by construction.
 */
export function kinematicPose(
  m: BarHingeModel,
  tree: CreaseTree,
  s: number,
  out: Float32Array,
): Float32Array {
  const c = m.creases;
  const nFaces = m.faces.count;
  // Per face: rotation (row-major 3×3) then translation, mapping rest coordinates to the fold.
  const R = new Float64Array(9 * nFaces);
  const T = new Float64Array(3 * nFaces);
  for (let f = 0; f < nFaces; f++) {
    R[9 * f] = R[9 * f + 4] = R[9 * f + 8] = 1;
  }

  for (let i = 0; i < tree.order.length; i++) {
    const face = tree.order[i];
    const crease = tree.parentCrease[face];
    if (crease < 0) continue; // the root, or an unhinged island: identity, i.e. it stays flat
    const parent = tree.parentFace[face];

    const n3 = c.n3[crease], n4 = c.n4[crease];
    let ax = m.rest[3 * n4] - m.rest[3 * n3];
    let ay = m.rest[3 * n4 + 1] - m.rest[3 * n3 + 1];
    let az = m.rest[3 * n4 + 2] - m.rest[3 * n3 + 2];
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;

    // Which way the hinge turns depends on which side of it the child sits, because `measureTheta`
    // reads the two faces in a fixed order: it is `atan2((n̂₁ × ê)·n̂₂, n̂₁·n̂₂)` with `ê = p(n4) −
    // p(n3)`, so turning FACE 2 by `α` about `ê` reads as `θ = −α` (from flat, both normals at `+ẑ`,
    // Rodrigues gives `n̂₂ = ẑ cos α + (ê × ẑ) sin α`, hence `x = cos α` and `y = −sin α`), while
    // turning face 1 reads as `+α`. Verified end to end rather than trusted — `fold-kinematics.test.ts`
    // measures every crease of the `s = 1` pose back through `measureTheta`, and the wrong sign here
    // misses by twice the fold angle (190° on house) with the panels still perfectly rigid.
    const angle = s * c.targetTheta[crease] * (tree.parentIsFace1[face] ? 1 : -1);
    const co = Math.cos(angle), si = Math.sin(angle), ic = 1 - co;

    // Rodrigues, row-major.
    const r = [
      co + ax * ax * ic, ax * ay * ic - az * si, ax * az * ic + ay * si,
      ay * ax * ic + az * si, co + ay * ay * ic, ay * az * ic - ax * si,
      az * ax * ic - ay * si, az * ay * ic + ax * si, co + az * az * ic,
    ];
    // About the hinge point rather than the origin: t = p − R·p, with p the rest position of n3.
    const px = m.rest[3 * n3], py = m.rest[3 * n3 + 1], pz = m.rest[3 * n3 + 2];
    const t = [
      px - (r[0] * px + r[1] * py + r[2] * pz),
      py - (r[3] * px + r[4] * py + r[5] * pz),
      pz - (r[6] * px + r[7] * py + r[8] * pz),
    ];

    // Compose under the parent: R_child = R_parent·R, t_child = R_parent·t + t_parent.
    const p9 = 9 * parent, f9 = 9 * face;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        R[f9 + 3 * row + col] =
          R[p9 + 3 * row] * r[col] + R[p9 + 3 * row + 1] * r[3 + col] + R[p9 + 3 * row + 2] * r[6 + col];
      }
      T[3 * face + row] =
        R[p9 + 3 * row] * t[0] + R[p9 + 3 * row + 1] * t[1] + R[p9 + 3 * row + 2] * t[2] + T[3 * parent + row];
    }
  }

  for (let n = 0; n < m.numNodes; n++) {
    const f = tree.faceOfNode[n];
    if (f < 0) {
      out[3 * n] = m.rest[3 * n];
      out[3 * n + 1] = m.rest[3 * n + 1];
      out[3 * n + 2] = m.rest[3 * n + 2];
      continue;
    }
    const f9 = 9 * f;
    const x = m.rest[3 * n], y = m.rest[3 * n + 1], z = m.rest[3 * n + 2];
    out[3 * n] = R[f9] * x + R[f9 + 1] * y + R[f9 + 2] * z + T[3 * f];
    out[3 * n + 1] = R[f9 + 3] * x + R[f9 + 4] * y + R[f9 + 5] * z + T[3 * f + 1];
    out[3 * n + 2] = R[f9 + 6] * x + R[f9 + 7] * y + R[f9 + 8] * z + T[3 * f + 2];
  }
  return out;
}

/**
 * The guide's target pose for `foldPercent`, rebuilt only when that changes — the quasi-static ramp
 * holds it fixed across a whole frame's worth of solver steps.
 */
export function guideTarget(m: BarHingeModel, foldPercent: number): Float32Array | null {
  const tree = m.creaseTree;
  if (!tree) return null;
  if (!m.guideScratch || m.guideScratch.length !== 3 * m.numNodes) {
    m.guideScratch = new Float32Array(3 * m.numNodes);
    m.guideScratchFold = NaN;
  }
  if (m.guideScratchFold !== foldPercent) {
    kinematicPose(m, tree, foldPercent, m.guideScratch);
    m.guideScratchFold = foldPercent;
  }
  return m.guideScratch;
}
