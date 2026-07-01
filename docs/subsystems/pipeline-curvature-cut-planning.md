# Pipeline Curvature And Cut Planning

This subsystem decides which target vertices need relief and how the cut graph
is routed while keeping the kirigami sheet connected.

## Files

| File | Responsibility |
| --- | --- |
| `src/pipeline/curvature.ts` | Computes angle defects and signed dihedral fold targets. |
| `src/pipeline/plan-cuts.ts` | Converts curvature defects into cut/tuck actions and a connected cut forest. |
| `src/pipeline/mesh.ts` | Provides edge lengths, topology, and boundary vertex sets. |
| `src/pipeline/types.ts` | Defines `DefectReport`, `CutPlan`, `PlanOptions`, and stage error types. |

## Curvature Data

`angleDefects(mesh, topo)` is the single source of truth for discrete
curvature. Later stages consume the returned `DefectReport`; they should not
recompute angle defect independently.

Classification:

| Class | Meaning |
| --- | --- |
| `positive` | Interior vertex has positive angle defect and may be darted or tucked. |
| `negative` | Interior vertex has missing angle and needs a slit plus vent handling. |
| `flat` | Interior vertex is within the flat tolerance. |
| `boundary` | Boundary defect sign is not meaningful for this pipeline. |

`targetFoldAngles(mesh, topo)` computes per-edge signed dihedral targets for
the final crease pattern. Boundary edges receive `null` targets.

## Cut Planning Flow

`planCuts(mesh, topo, defects, opts)` performs four decisions:

| Step | Behavior |
| --- | --- |
| Necessity | Non-flat interior defect vertices become terminals unless tucked. |
| Action tagging | Positive defects become `dart` or `tuck`; negative defects become `slit`. |
| Connection | Terminals are connected with an MST over shortest-path distances. |
| Forest pruning | Cycles are removed so the cut graph remains a forest. |

The planner approximates a Steiner-style routing problem. The current cost is
edge length plus a visibility term hook; visibility is zero in the current
implementation, but `lambda` is already carried through the public contract.

## Proper-Kirigami Connectivity

The key invariant is that the cut sheet must remain one connected piece.

Planner rules that protect this:

| Rule | Reason |
| --- | --- |
| Cut set is pruned to a forest. | A tree-like cut graph does not isolate a patch by itself. |
| Boundary is used as at most one pseudo-terminal. | Multiple boundary contacts can tear the sheet into pieces. |
| Interior paths cannot transit through boundary vertices. | Prevents hidden boundary-to-boundary cuts. |
| One closed-mesh terminal receives a dangling slit. | A single defect still needs to become boundary material. |

## Strategy Dial

`PlanOptions.strategy` controls positive curvature relief:

| Strategy | Positive defect behavior | Negative defect behavior |
| --- | --- | --- |
| `dart` | Terminal is cut with dart semantics. | Terminal is cut with slit semantics. |
| `tuck-all` | Vertex is tagged for molecule/tuck metadata instead of a cut terminal. | Still cut with slit semantics. |

Negative curvature is not tucked by this planner. The missing angle is handled
later by vent sliver removal during unfolding.

## Failure Modes

| Failure | Source |
| --- | --- |
| Disconnected mesh cannot connect terminals. | `PipelineError("plan-cuts", ...)`. |
| Topology or defect arrays are inconsistent. | Usually surfaces in tests before routing completes. |
| Cut graph disconnects after vent/unfold refinement. | Reported by the unfolding stage, not the planner. |

## Extension Points

Visibility-aware routing should be added by replacing the current zero
visibility edge weights in `plan-cuts.ts`, not by changing downstream
classification. New relief strategies should extend `perVertexAction` and
must document how they preserve one connected sheet.

