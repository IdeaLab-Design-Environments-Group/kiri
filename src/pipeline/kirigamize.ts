/**
 * The Kirigamizer driver (M5): mesh → cut+fold FKLD, verified in the sim.
 *
 * Pattern: facade/orchestrator returning ALL intermediates (AKDE
 * computeState-chain precedent) — every stage artifact is in the result so
 * tests and the UI can introspect without re-running.
 *
 * Stage order (kirigamizer_algorithms.tex driver):
 *   condition → topology/genus gate → angle defects → plan cuts →
 *   seamed unfold → pack & classify → emit FKLD → verify (fold + dH).
 *
 * Optimize schedule (budget = 3 attempts; "Stage 5 is a search, not a
 * solver"): (1) solve at `iterations`; if dH > ε → (2) add the worst source
 * vertex as an extra relief terminal and re-run plan→emit once; if still
 * failing → (3) re-solve at 3× iterations. Returns the best report with an
 * honest `converged` flag.
 */

import { condition, assertGenusZero } from "./conditioning.js";
import { cutHandles } from "./handle-cut.js";
import { angleDefects } from "./curvature.js";
import { emitFkld } from "./emit.js";
import { parseMesh } from "./import.js";
import { buildTopology } from "./mesh.js";
import { planCuts } from "./plan-cuts.js";
import { placeSheet } from "./route-seams.js";
import { seamedUnfold } from "./unfold.js";
import { DEFAULT_VERIFY, verifyFold, type VentHole } from "./verify.js";
import type { FoldFile } from "../model/fold-file.js";
import {
  PipelineError,
  type ConditionReport,
  type CutPlan,
  type DefectReport,
  type Sheet,
  type TriMesh,
  type UnfoldResult,
  type VerifyReport,
} from "./types.js";

export interface KirigamizeOptions {
  /**
   * Seam-visibility weight λ. w(e) = len(e) + λ·vis(e), vis(e) = 1−|θ_e|/π.
   * λ=0 (default): length-only routing. λ>0: cuts prefer high-dihedral edges.
   */
  lambda: number;
  /**
   * "dart"    — cut all δ>0 vertices.
   * "tuck-all"— tuck all δ>0 vertices (Origamizer reduction).
   * "hybrid"  — per-vertex cost comparison: dart iff path-to-boundary ≤
   *             tuckCostScale·δ(v)·r̄(v). Closed meshes fall back to dart.
   */
  strategy: "dart" | "tuck-all" | "hybrid";
  /** Scale for tuck cost in hybrid mode (default 1). */
  tuckCostScale: number;
  /**
   * Drop degree-1 dart leaves with δ < leafPruneDeltaMax from the cut forest,
   * promoting them to tucks. Default false.
   */
  leafPruning: boolean;
  /** Max δ (rad) for leaf pruning. Default π/4 ≈ 45°. */
  leafPruneDeltaMax: number;
  /**
   * After unfolding, drop relief cuts whose removal still flattens the patch
   * (one piece, no self-overlap). Planned curvature cuts are never touched.
   *
   * Default FALSE: measured headroom is small (the relief loop is already
   * near-minimal — relief edges are usually individually load-bearing, so
   * single-edge removal rarely succeeds) and each pruning trial is a full
   * re-cut+re-unfold, which is costly on the tangled saddle patches that carry
   * the most relief. Opt in (and rely on PRUNE_MAX_TRIALS) when minimizing
   * fabricated cut count matters more than solve time.
   */
  pruneRelief: boolean;
  /** ε as a fraction of Q's bbox diagonal. */
  epsilonRel: number;
  /** Run the simulator verification (M5). */
  verify: boolean;
  /** Solver iteration cap per attempt. */
  iterations: number;
}

export const DEFAULT_KIRIGAMIZE: KirigamizeOptions = {
  lambda: 0,
  strategy: "dart",
  tuckCostScale: 1.0,
  leafPruning: false,
  leafPruneDeltaMax: Math.PI / 4,
  pruneRelief: false,
  epsilonRel: DEFAULT_VERIFY.epsilonRel,
  verify: true,
  iterations: DEFAULT_VERIFY.iterations,
};

export interface KirigamizeResult {
  fkld: FoldFile;
  conditioning: ConditionReport[];
  defects: DefectReport;
  plan: CutPlan;
  unfold: UnfoldResult;
  sheet: Sheet;
  report: VerifyReport | null;
}

export function kirigamize(input: TriMesh, options: Partial<KirigamizeOptions> = {}): KirigamizeResult {
  const opts = { ...DEFAULT_KIRIGAMIZE, ...options };

  // Stage 0: condition → cut handles (genus>0 → genus 0) → genus gate.
  const conditioned = condition(input);
  const handle = cutHandles(conditioned.mesh); // no-op for a genus-0 surface
  const mesh = handle.mesh;
  const reports = [...conditioned.reports, handle.report];
  const topo = buildTopology(mesh);
  assertGenusZero(mesh, topo); // now passes: any handles have been slit open

  // Stage 1: curvature.
  const defects = angleDefects(mesh, topo);

  // Stages 2–4 as a re-runnable unit (the optimize schedule re-plans once).
  const runPipeline = (extraTerminals: number[]) => {
    const plan = planCuts(mesh, topo, defects, {
      lambda: opts.lambda,
      strategy: opts.strategy,
      tuckCostScale: opts.tuckCostScale,
      leafPruning: opts.leafPruning,
      leafPruneDeltaMax: opts.leafPruneDeltaMax,
      extraTerminals,
    });
    const tuckSet = plan.perVertexAction
      .map((a, v) => ({ a, v }))
      .filter((x) => x.a === "tuck")
      .map((x) => x.v);
    let unfold: UnfoldResult;
    try {
      unfold = seamedUnfold(mesh, topo, plan, defects, { pruneRelief: opts.pruneRelief });
    } catch (err) {
      if (err instanceof PipelineError && err.stage === "unfold" && tuckSet.length > 0) {
        // Honest scope: tucked δ>0 vertices stay interior, so the patch is not
        // developable — full Origamizer tuck crease generation is deferred.
        throw new PipelineError(
          "unfold",
          `tuck-all left ${tuckSet.length} positive-curvature vertices uncut and Origamizer tuck crease generation is deferred — use strategy "dart" for non-developable targets`,
          { tuckSet },
        );
      }
      throw err;
    }
    const sheet = placeSheet(unfold, { mesh, topo, defects });
    const fkld = emitFkld(sheet, {
      defects,
      target: mesh,
      topo,
      tuckSet,
      actions: plan.perVertexAction,
      lambda: opts.lambda,
      strategy: opts.strategy,
    });
    return { plan, unfold, sheet, fkld };
  };

  // Declared vent holes for the vent-aware d_H (open kirigami: coverage
  // holes at declared vents are not coverage errors). Center = the vent's
  // source vertex on Q; radius = max goal-space distance from that vertex to
  // its ventEdges' endpoints (the removed slivers are sub-triangles with
  // apex at the center and far vertices at those endpoints, so this ball
  // conservatively contains the whole hole).
  const ventHoles = (unfold: UnfoldResult): VentHole[] =>
    unfold.vents.map((vt) => {
      const center = mesh.vertices[vt.sourceVertex];
      let radiusMm = 0;
      for (const [a, b] of vt.ventEdges) {
        for (const v of [a, b]) {
          const g = unfold.goalPos[v];
          radiusMm = Math.max(radiusMm, Math.hypot(g.x - center.x, g.y - center.y, g.z - center.z));
        }
      }
      return { center, radiusMm };
    });

  let stages = runPipeline([]);
  if (!opts.verify) {
    return { ...stages, conditioning: reports, defects, report: null };
  }

  // Stage 5: fold-from-flat verification with the bounded optimize schedule
  // (K4): (1) two-phase fold; (2) same at 3× iterations; (3) re-plan with the
  // worst-fitting vertex as an extra terminal and fold again.
  let report = verifyFold(stages.fkld, mesh, {
    epsilonRel: opts.epsilonRel,
    iterations: opts.iterations,
    vents: ventHoles(stages.unfold),
  });
  let attempts = 1;

  if (!report.converged) {
    // Attempt 2: same pattern, triple the iteration budget.
    const longReport = verifyFold(stages.fkld, mesh, {
      epsilonRel: opts.epsilonRel,
      iterations: 3 * opts.iterations,
      vents: ventHoles(stages.unfold),
    });
    attempts = 2;
    if (longReport.foldFromFlat.dH <= report.foldFromFlat.dH) report = longReport;
  }

  if (!report.converged) {
    // Attempt 3: free the worst-fitting region with an extra relief terminal.
    const retried = runPipeline([report.worstSourceVertex]);
    const retriedReport = verifyFold(retried.fkld, mesh, {
      epsilonRel: opts.epsilonRel,
      iterations: opts.iterations,
      vents: ventHoles(retried.unfold),
    });
    attempts = 3;
    if (retriedReport.foldFromFlat.dH <= report.foldFromFlat.dH) {
      stages = retried;
      report = retriedReport;
    }
  }

  return {
    ...stages,
    conditioning: reports,
    defects,
    report: { ...report, attempts },
  };
}

/** Convenience wrapper for the controller: raw OBJ/STL text in, result out. */
export function kirigamizeText(
  text: string,
  ext: "obj" | "stl",
  options: Partial<KirigamizeOptions> = {},
): KirigamizeResult {
  return kirigamize(parseMesh(text, ext), options);
}
