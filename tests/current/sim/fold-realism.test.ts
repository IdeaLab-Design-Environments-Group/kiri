/**
 * The fold has to be a fold — not a shape-blend, and not a fold that walks through itself.
 *
 * Every FKLD that declares a folded form used to be simulated by pinning EVERY declared vertex and
 * writing `rest + (goal − rest)·foldPercent` into it each step. That is a straight-line blend
 * between two keyframes, so it looked right at 0% and 100% and was nonsense in between: on
 * house.fkld the bars were off their rest lengths by up to 100% (an edge collapsing to nothing) at
 * mid-fold, panels swept through each other, and the self-collision pass never ran at all because it
 * skips `fixed` nodes. Nothing in the suite objected, because nothing measured the path.
 *
 * These are the measurements that would have objected. They run the bundled presets through
 * `FoldRunner` — **the** fold loop, the one `sim-canvas` drives, not a copy of it — and check the
 * four things that make it a fold:
 *
 *   1. nothing is pinned — positions come out of the force passes, never into them;
 *   2. the material does not stretch, and interior edges do not crumple, ANYWHERE along the path;
 *   3. layers do not end up inside each other;
 *   4. and it still lands the shape the file declares, after the guide has been let go of.
 *
 * The tolerances are set from measured behaviour with headroom, not from theory; the comment on each
 * says what it is today, so a regression reads as a number moving rather than a mystery.
 *
 * Driving the real runner is not incidental. The first version of this file re-implemented the ramp
 * with its own quasi-static ease, and so it passed while the viewer — which had been put on the free
 * fold's ramp, 20× faster — overshot creases by up to 43° and drew a mangled house. A test that
 * re-implements the loop attests to nothing about the thing that runs.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "../../../src/sim/scene.js";
import { meanTensileStrain, maxTensileStrain } from "../../../src/sim/strain.js";
import { FoldRunner } from "../../../src/sim/fold-run.js";
import { kabsch, applyRigid } from "../../../src/pipeline/verify.js";
import type { BarHingeModel } from "../../../src/sim/model.js";
import type { FoldScene } from "../../../src/sim/build.js";
import type { Vec3 } from "../../../src/pipeline/types.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

const load = (name: string): FoldFile =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${name}`, import.meta.url)), "utf8"));

/** Every bundled preset that declares a folded form, so they all take the soft-guided path. */
const GUIDED = [
  "house.fkld",
  "church.fkld",
  "puffin.fkld",
  "akde-hex.fkld",
  "akde-decagon-pyramid.fkld",
  "bistable-star-tiling.fkld",
  "kirigami-flap.fkld",
];

/**
 * Files whose declared folded form is not an isometry of their own flat net, so no fold can reach it
 * without stretching (see the test at the bottom, and goalTensileDemand). Their stretch budget is
 * their own, not the solver's.
 */
const NON_ISOMETRIC = new Set(["akde-hex.fkld"]);

/**
 * Worst compressive strain on a MATERIAL interior bar — a real mountain or valley fold line, whose
 * length the sheet has to keep. Two kinds of bar are excluded because shortening is legitimate for
 * them: a free edge, which is allowed to go slack (`FREE_EDGE_SLACK` in forces.ts — paper ruffles
 * along a cut rather than shortening it), and an "F" facet diagonal, which is not material at all
 * but a triangulation chord across a polygon, so it shortens whenever the polygon bends, which for
 * vinyl it may.
 *
 * This is the measure that catches a straight-line blend. Interpolating a face rotation shortens
 * every chord, so the old blend crushed material fold lines by up to 100% while reading ≈ 0 on any
 * tension-only metric — stretch alone cannot see the bug at all.
 */
function maxInteriorCompression(m: BarHingeModel, facet: Set<number>): number {
  const pos = m.position;
  let worst = 0;
  for (let i = 0; i < m.beams.count; i++) {
    if (m.beams.free?.[i]) continue;
    if (facet.has(i)) continue;
    const a = m.beams.n0[i];
    const b = m.beams.n1[i];
    const l = Math.hypot(
      pos[3 * a] - pos[3 * b],
      pos[3 * a + 1] - pos[3 * b + 1],
      pos[3 * a + 2] - pos[3 * b + 2],
    );
    const e = 1 - l / m.beams.rest[i];
    if (e > worst) worst = e;
  }
  return worst;
}

/**
 * How much the DECLARED form itself asks the sheet to stretch: the worst tensile bar strain when the
 * mesh is placed at its goal. Zero for a form that is an isometry of its flat net — a pattern that
 * could actually be folded from paper — and non-zero for one that could not, which is a statement
 * about the file, not about the solver. Pinning every vertex used to impose such a form regardless
 * and show a clean result; a fold made of forces cannot, so the demand has to be accounted for when
 * judging what the fold achieves.
 */
function goalTensileDemand(m: BarHingeModel): number {
  const saved = m.position.slice();
  m.position.set(m.goal);
  const demand = maxTensileStrain(m);
  m.position.set(saved);
  return demand;
}

interface Ramp {
  /** Worst mean tensile strain seen at any sample along the path. */
  pathStretch: number;
  /** Worst single-bar tensile strain seen at any sample along the path. */
  pathStretchMax: number;
  /** Worst interior-bar compression seen at any sample along the path. */
  pathCrush: number;
  /** Mean per-vertex distance to the declared form after rigid alignment, as a fraction of span. */
  goalOff: number;
  span: number;
}

/**
 * Run the viewer's fold: ease to fully folded with the guide holding, LET GO (`guideWeight` → 0),
 * then settle. Sampled along the way, because the path is what was broken, not the endpoints.
 */
function ramp(scene: FoldScene): Ramp {
  const m = scene.model;
  const facet = new Set<number>();
  for (let i = 0; i < m.beams.count; i++) {
    const a = m.beams.n0[i], b = m.beams.n1[i];
    const e = scene.net.edges.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (e?.assignment === "F") facet.add(i);
  }
  scene.solver.enableCollision();
  let pathStretch = 0;
  let pathStretchMax = 0;
  let pathCrush = 0;
  const sample = (): void => {
    pathStretch = Math.max(pathStretch, meanTensileStrain(m));
    pathStretchMax = Math.max(pathStretchMax, maxTensileStrain(m));
    pathCrush = Math.max(pathCrush, maxInteriorCompression(m, facet));
  };

  // The viewer's own loop, frame by frame, all the way to fully folded and let go of.
  const runner = new FoldRunner(m, scene.solver);
  runner.setTarget(1);
  const marks = [0.25, 0.5, 0.75];
  let mi = 0;
  for (let frame = 0; frame < 2000 && !runner.settled(); frame++) {
    runner.frame();
    while (mi < marks.length && runner.foldPercent >= marks[mi]) {
      sample();
      mi++;
    }
  }
  // …then the settling the viewer allows before it freezes the pose.
  for (let frame = 0; frame < 240; frame++) runner.frame();
  sample();

  const P: Vec3[] = [];
  const G: Vec3[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < m.numNodes; i++) {
    P.push({ x: m.position[3 * i], y: m.position[3 * i + 1], z: m.position[3 * i + 2] });
    G.push({ x: m.goal[3 * i], y: m.goal[3 * i + 1], z: m.goal[3 * i + 2] });
    for (let d = 0; d < 3; d++) {
      lo = Math.min(lo, m.goal[3 * i + d]);
      hi = Math.max(hi, m.goal[3 * i + d]);
    }
  }
  const span = hi - lo;
  const { R, t } = kabsch(P, G);
  let dsum = 0;
  for (let i = 0; i < m.numNodes; i++) {
    const q = applyRigid(R, t, P[i]);
    dsum += Math.hypot(q.x - G[i].x, q.y - G[i].y, q.z - G[i].z);
  }
  return { pathStretch, pathStretchMax, pathCrush, goalOff: dsum / m.numNodes / span, span };
}

/**
 * Fold each preset ONCE and share the settled result. The fold is deterministic and the assertions
 * only read it, and folding puffin three times over cost more than a minute of wall clock.
 */
const folded = new Map<string, { scene: FoldScene; ramp: Ramp }>();
function settled(name: string): { scene: FoldScene; ramp: Ramp } {
  let got = folded.get(name);
  if (!got) {
    const scene = buildScene(load(name))!.scene;
    got = { scene, ramp: ramp(scene) };
    folded.set(name, got);
  }
  return got;
}

describe("a declared folded form is guided to, not blended into", () => {
  for (const name of GUIDED) {
    it(`${name}: no node is pinned, and the guide is a force that lets go`, () => {
      const built = buildScene(load(name));
      expect(built).not.toBeNull();
      const m = built!.scene.model;
      // The whole bug in one assertion: a pinned node is a position written into the model, and a
      // file may declare EVERY vertex driven, which pinned the entire mesh and left nothing to solve.
      expect(Array.from(m.fixed).some((f) => f === 1)).toBe(false);
      expect(Array.from(m.driven).some((d) => d === 1)).toBe(true);
      expect(m.softDriven).toBe(true);
      expect(m.guideWeight).toBe(1); // held at the start; the viewer takes it to 0 once folded
      // Seams: the joins the artifact makes, read off the declared form. Without them a cut pattern
      // folds perfectly and hangs open — see BarHingeModel.seams.
      expect(m.seams?.count ?? 0).toBeGreaterThan(0);
    });
  }
});

describe("the fold path is physical, not a blend between keyframes", () => {
  for (const name of GUIDED) {
    it(`${name}: sheet neither stretches nor crushes along the way`, { timeout: 120_000 }, () => {
      const r = settled(name).ramp;

      // Stretch. Most sit under 1%; akde-hex at ≈11%, because the hex's own declared
      // form is not an isometry of its flat net — 83 of its 113 bars have to change length to reach
      // it — so no fold can get there without stretching, and this reports honestly that it is
      // stretching rather than hiding it behind imposed positions the way the pinned path did.
      expect(r.pathStretch).toBeLessThan(NON_ISOMETRIC.has(name) ? 0.18 : 0.04);

      // Crush of a material fold line. Measured 11% (house), 14% (church), 5% (hex); it was 100% on
      // the straight-line blend this replaces.
      expect(r.pathCrush).toBeLessThan(0.25);

      // And no single bar stretched far past the mean — measured against what this file's own
      // declared form demands, since a fold cannot beat its target's own non-isometry (see
      // goalTensileDemand, and the test below that reports it).
      const demand = goalTensileDemand(settled(name).scene.model);
      expect(r.pathStretchMax).toBeLessThan(Math.max(0.25, 3 * demand));
    });

    it(`${name}: still lands its declared form after the guide lets go`, { timeout: 120_000 }, () => {
      const r = settled(name).ramp;
      // Measured 1.3–6.7% of a model span across the seven presets. The guide is zero by now, so
      // this is the pattern's own creases and seams holding the shape — a fold that sprang open, or
      // one ramped too fast to stay on its branch, lands far outside this (the free fold's ramp put
      // house at 14% and church at 27%).
      expect(r.goalOff).toBeLessThan(0.09);
    });
  }
});

describe("a folded form the sheet could not reach is reported, not hidden", () => {
  // Not a defect in the fold — a fact about these files that the pinned path made invisible by
  // imposing the positions anyway. house and church declare forms their flat nets can actually be
  // folded into; akde-hex does not (83 of its 113 bars have to change length to reach its cone),
  // which is why its fold stretches where the other two do not.
  it("house and church declare isometric forms; akde-hex does not", () => {
    expect(goalTensileDemand(buildScene(load("house.fkld"))!.scene.model)).toBeLessThan(0.02);
    expect(goalTensileDemand(buildScene(load("church.fkld"))!.scene.model)).toBeLessThan(0.02);
    expect(goalTensileDemand(buildScene(load("akde-hex.fkld"))!.scene.model)).toBeGreaterThan(0.2);
  });
});

describe("folded layers do not end up on the wrong side of each other", () => {
  /**
   * Pairs where a node sits on the OPPOSITE side of a far triangle from where the declared folded
   * form puts it — a layer that has passed through another instead of resting against it.
   *
   * Asking "how deep is it inside the contact shell?" instead was the wrong question, and a trap:
   * penalty contact is soft, so layers in a tightly folded model legitimately rest well inside the
   * shell where the contact force balances the fold, and a depth threshold only measures how hard
   * the contact was tuned. Which side of the sheet a layer is on is the property that means
   * something, and it needs no tuning to state.
   *
   * (Nothing asserted either before: the collision suite covered two parallel triangles and a NaN
   * check, and on the pinned path the pass never ran at all, every node being `fixed`.)
   */
  function wrongSidePairs(m: BarHingeModel): number {
    const ring: Set<number>[] = Array.from({ length: m.numNodes }, () => new Set<number>());
    for (let f = 0; f < m.faces.count; f++) {
      const a = m.faces.a[f], b = m.faces.b[f], c = m.faces.c[f];
      ring[a].add(b).add(c);
      ring[b].add(a).add(c);
      ring[c].add(a).add(b);
    }
    /** Signed distance of node `v` from triangle `f`'s plane, and whether its foot is on the face. */
    const side = (P: Float32Array, v: number, f: number): { s: number; inside: boolean } => {
      const a = m.faces.a[f], b = m.faces.b[f], c = m.faces.c[f];
      const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
      const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az;
      const wx = P[3 * c] - ax, wy = P[3 * c + 1] - ay, wz = P[3 * c + 2] - az;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const nl = Math.hypot(nx, ny, nz) || 1e-12;
      const rx = P[3 * v] - ax, ry = P[3 * v + 1] - ay, rz = P[3 * v + 2] - az;
      const d = (rx * nx + ry * ny + rz * nz) / nl;
      const d00 = ux * ux + uy * uy + uz * uz;
      const d01 = ux * wx + uy * wy + uz * wz;
      const d11 = wx * wx + wy * wy + wz * wz;
      const d20 = rx * ux + ry * uy + rz * uz;
      const d21 = rx * wx + ry * wy + rz * wz;
      const den = d00 * d11 - d01 * d01;
      if (Math.abs(den) < 1e-18) return { s: 0, inside: false };
      const t1 = (d11 * d20 - d01 * d21) / den;
      const t2 = (d00 * d21 - d01 * d20) / den;
      return { s: d, inside: t1 >= 0 && t2 >= 0 && t1 + t2 <= 1 };
    };
    let n = 0;
    for (let v = 0; v < m.numNodes; v++) {
      for (let f = 0; f < m.faces.count; f++) {
        const a = m.faces.a[f], b = m.faces.b[f], c = m.faces.c[f];
        if (a === v || b === v || c === v) continue;
        if (ring[v].has(a) || ring[v].has(b) || ring[v].has(c)) continue;
        const now = side(m.position, v, f);
        const want = side(m.goal, v, f);
        if (!now.inside || !want.inside) continue;
        if (Math.abs(want.s) < 1e-3 || Math.abs(now.s) < 1e-3) continue; // grazing: no side to speak of
        if (Math.sign(now.s) !== Math.sign(want.s)) n++;
      }
    }
    return n;
  }

  for (const name of GUIDED) {
    it(`${name}: layers rest against each other, not through`, { timeout: 120_000 }, () => {
      // Six of the seven presets are exactly zero. puffin is the exception, and the flips are local
      // to the same region where it also leaves creases off target (19 of 49) — it is the densest
      // model here, and the contact is proximity-only: vertex-vs-triangle, no edge-edge, no
      // continuous detection, so a face that sweeps past another between two steps is not caught.
      expect(wrongSidePairs(settled(name).scene.model)).toBeLessThanOrEqual(name === "puffin.fkld" ? 8 : 0);
    });
  }
});
