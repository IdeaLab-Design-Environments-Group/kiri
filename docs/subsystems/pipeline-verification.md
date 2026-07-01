# Subsystem: Pipeline Verification

Pipeline verification checks whether an emitted FKLD pattern realizes the
source target mesh as a stable folded equilibrium.

## Files

| File | Role |
| --- | --- |
| `src/pipeline/verify.ts` | Verification metrics and solver orchestration. |
| `src/pipeline/kirigamize.ts` | Retry schedule using verification output. |
| `src/sim/fold-adapter.ts` | Loads emitted FKLD into a simulation scene. |
| `src/sim/solver.ts` | CPU reference solver used by verification. |

## Verification Mode

Verification is equilibrium-based:

1. Load emitted FKLD through `buildSceneFromFold`.
2. Put model at its guided goal pose.
3. Set `foldPercent = 1`.
4. Relax the solver.
5. Measure drift, strain, and crease residuals.

This is not full fold-path validation. Fold-path validation would need
collision handling or a constraint solver.

## Metrics

`VerifyReport` includes:

- `dH`: sampled symmetric Hausdorff distance;
- `dHRel`: relative Hausdorff distance;
- `epsilon`: absolute tolerance used;
- `meanStrain`;
- `maxStrain`;
- `iterations`;
- `attempts`;
- `converged`;
- `worstSourceVertex`.

## Sampled Hausdorff

Sampling includes:

- vertices;
- edge midpoints;
- face centroids.

This catches interior bulging that vertex-only checks miss.

## Retry Hook

If verification fails:

1. `kirigamize.ts` takes `worstSourceVertex`.
2. It re-runs planning with that vertex as an extra relief terminal.
3. It re-emits and verifies.
4. If still failing, it verifies with a larger iteration budget.

The final report keeps `converged = false` if the pattern still fails.

## Failure Modes

| Symptom | Likely cause |
| --- | --- |
| Large `dH` | Wrong goal mapping, bad unfold, or insufficient cuts. |
| High strain | Non-isometric layout or inconsistent packing. |
| High crease residual | Wrong assignment or fold-angle sign. |
| Non-finite solver output | Solver divergence or invalid geometry. |
| Worst vertex repeats | Planner needs a stronger refinement strategy. |

## Rules

- Verification uses CPU solver as reference.
- Do not use GPU path in headless verification.
- Do not hide non-convergence.
- Keep `origVertex` intact; verification depends on source mapping.

