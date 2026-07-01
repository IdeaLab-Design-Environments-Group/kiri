# Pipeline Unfolding And Placement

This subsystem turns the planned cut graph into one flat sheet, removes vent
slivers for negative curvature, and classifies the placed pattern edges.

## Files

| File | Responsibility |
| --- | --- |
| `src/pipeline/unfold.ts` | Splits the target mesh along cuts, applies vents, unfolds patches, and runs relief refinement. |
| `src/pipeline/route-seams.ts` | Places the single sheet in a paper rectangle and classifies edges. |
| `src/pipeline/mesh.ts` | Supplies wedge, topology, face-angle, and edge-key helpers. |
| `src/pipeline/types.ts` | Defines `CutMesh`, `UnfoldResult`, `VentRecord`, `LipPair`, and `Sheet`. |

## Cut Mesh Construction

`cutAlongEdges(mesh, topo, cutEdges, ventAngles)` produces a fresh cut mesh.
It never mutates the source mesh.

Important outputs:

| Output | Meaning |
| --- | --- |
| `mesh` | The split 3D sheet mesh. |
| `origVertex` | Cut vertex to source vertex provenance; synthesized vent vertices use `-1`. |
| `goalPos` | Folded target position for each cut vertex. |
| `lips` | Pairs of boundary copies that came from one source cut edge. |
| `vents` | Removed sliver records used for cut subtype classification. |

The split is based on vertex fan wedges. Cut edges become separators between
copies; original boundary edges are already boundary and are not split again.

## Vent Semantics

Negative curvature is handled by a slit plus a removed sliver. The removed
material is represented as vent boundary geometry, not as a disconnected patch.

Vent handling must preserve:

| Invariant | Reason |
| --- | --- |
| Live sheet connectivity is not worsened. | Proper kirigami requires one physical sheet. |
| `goalPos` remains aligned with generated vertices. | The simulator uses the folded goal frame. |
| `origVertex` uses `-1` for synthesized split vertices. | Metadata and defect arrays must not index source defects for generated vertices. |
| Vent boundary edges are recorded. | `route-seams.ts` maps them to `cutType: "vent"`. |

## Flat Development

Unfolding places adjacent triangles by preserving 3D rest lengths in 2D. The
layout is therefore isometric by construction for each developable patch.

The core placement rule is:

| Item | Behavior |
| --- | --- |
| Shared edge | Already-placed edge anchors the next triangle. |
| Third vertex | Computed from triangle side lengths. |
| Side choice | Chosen opposite the already-placed neighboring face. |
| Audit | Edge-length error is checked against a relative tolerance. |

## Relief Refinement

The unfolding stage includes a bounded refinement loop. When overlap or
connectivity checks fail, extra relief cuts can be introduced and the unfold is
retried up to `RELIEF_MAX`.

This loop belongs in `unfold.ts` because it is the first stage that can see
whether the cut graph actually embeds as one flat sheet.

## Placement And Classification

`placeSheet(unfold, ctx, marginMm)` translates the flat pattern into the
positive quadrant and creates a sheet rectangle with margin.

Edge classification:

| Edge Case | `edges_assignment` | `cutType` |
| --- | --- | --- |
| Original boundary | `B` | `null` |
| Vent boundary | `C` | `vent` |
| Lip edge touching positive defect | `C` | `dart` |
| Other lip edge | `C` | `seam` |
| Interior positive dihedral | `M` | `null` |
| Interior negative dihedral | `V` | `null` |
| Interior flat edge | `F` | `null` |

Fold targets are measured on the goal-pose mesh, not guessed from source edge
ids. This keeps synthesized vent vertices and split sub-edges consistent.

## Failure Modes

| Failure | Meaning |
| --- | --- |
| More than one placed patch | The proper-kirigami connected-sheet invariant failed. |
| Non-developable or inconsistent patch | Edge-length audit or placement cannot satisfy rest lengths. |
| Relief limit reached | The mesh/cut plan cannot be embedded by current refinement rules. |

