import type { BarHingeModel } from "./model.js";

/**
 * How far the bars are from their rest lengths — the sim's own honesty check.
 *
 * A bar-and-hinge fold is only physical while the material keeps its length: paper and vinyl bend,
 * they do not stretch. So bar strain is the one number that says whether what is on screen is a
 * fold or a shape-blend. Origami Simulator puts exactly this on screen at all times (a global
 * percentage next to the fold slider, plus a strain colour mode clipped at 5%), which is what makes
 * an unphysical pose announce itself instead of being read as a fold.
 *
 * Two measures, because they answer different questions:
 *
 *  - {@link meanTensileStrain} — mean of `max(0, l/l₀ − 1)`, i.e. **stretch only**. This is the one
 *    to compare against a tolerance along a fold path. Compression is excluded deliberately: a
 *    straight-line interpolation of a face rotation φ shortens chords by ≈ 1 − cos(φ/2) even on a
 *    perfect pattern, so an unsigned mean reads ~31% on a flawless cube and tells you nothing.
 *  - {@link maxTensileStrain} — the worst single bar's stretch. This catches a *local* degeneracy
 *    that a mean averages away: one bar stretched 100% while the rest are fine barely moves a mean
 *    over hundreds of bars.
 *
 * Both are tension-only for the same reason: compression is legitimate here. A free edge of the
 * sheet is deliberately allowed to go slack rather than strut (`FREE_EDGE_SLACK` in forces.ts —
 * paper ruffles along a cut instead of shortening it), so a correct fold routinely shows large
 * compression on those bars and it means nothing is wrong.
 *
 * Both are O(beams) and allocation-free, so they are cheap enough to run per rendered frame.
 */

/** Mean tensile (stretch-only) bar strain: mean of `max(0, l/l₀ − 1)` over all bars. */
export function meanTensileStrain(m: BarHingeModel): number {
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

/** Worst single bar's tensile strain — catches a local stretch that a mean averages away. */
export function maxTensileStrain(m: BarHingeModel): number {
  const pos = m.position;
  let worst = 0;
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const l = Math.hypot(
      pos[3 * a] - pos[3 * b],
      pos[3 * a + 1] - pos[3 * b + 1],
      pos[3 * a + 2] - pos[3 * b + 2],
    );
    const e = l / m.beams.rest[i] - 1;
    if (e > worst) worst = e;
  }
  return worst;
}
