# Subsystem: Origami/FOLD Import to Simulation

`src/sim/origami-import.ts` converts a FOLD/FKLD pattern into the bar-and-hinge
model that the solver runs. This is the normal simulation path for arbitrary
origami and kirigami patterns after preprocessing.

## Files

| File | Role |
| --- | --- |
| `src/sim/fold-ops.ts` | Preprocesses FOLD/FKLD: split cuts, triangulate faces, extract crease records. |
| `src/sim/origami-import.ts` | Builds the solver model and applies free/guided target policy. |
| `src/sim/model.ts` | Struct-of-arrays model definitions and default solver constants. |
| `src/sim/solver.ts` | Fold solver and dihedral measurement. |
| `src/sim/build.ts` | AKDE guided scene builder and material type. |
| `src/sim/scene.ts` | High-level scene routing for guided/free modes. |
| `src/services/sim-scene-service.ts` | App-facing service that resolves the current sim source. |

## Input Contract

A fold is simulatable when it has:

- `vertices_coords` with at least three vertices;
- `faces_vertices` with at least one face;
- `edges_vertices` with at least one edge.

`edges_assignment` controls crease/cut behavior. Unknown or unassigned edges
map to boundary behavior for simulation.

## Preprocess Flow

```text
FOLD/FKLD
  -> processFold(...)
       -> splitCuts(...)
       -> triangulatePolys(...)
       -> getFacesAndVerticesForEdges(...)
  -> assembleModel(...)
  -> FoldSolver
```

Cut edges (`"C"`) are split open before simulation, so the two lips of a cut can
move independently. Quads and n-gons are triangulated because the solver uses
triangular faces and per-triangle interior-angle springs.

## Model Assembly

`assembleModel` builds the same broad structure as Origami Simulator:

- one node per processed vertex;
- one axial beam per processed edge;
- one torsional crease per mountain, valley, or facet crease;
- one face record per triangle;
- nominal interior angles from the rest shape;
- centered and normalized coordinates with bounding-sphere radius `1`.

The normalized coordinate system is what lets the same stiffness constants work
across files with different physical units.

## Fold Angle Policy

Target fold angles are resolved in this order:

1. `edges_foldAngles` in radians;
2. `edges_foldAngle` in degrees;
3. assignment defaults:
   - mountain `M` -> `-PI`;
   - valley `V` -> `PI`;
   - facet `F` -> `0`;
   - boundary/cut/unassigned -> no crease target.

Keep this priority when adding importer features. Explicit file data must win
over assignment defaults.

## Materials

The simulation supports two material modes:

| Material | Params | Meaning |
| --- | --- | --- |
| `vinyl` | `ORIGAMI_PARAMS` | Thin flexible sheet, paper/vinyl behavior. |
| `printed` | `PRINTED_PARAMS` | Rigid printed tiles connected by soft hinge gaps. |

Printed mode also uses fabrication parameters:

- tile thickness: `DEFAULT_PRINTED.thicknessMm`;
- hinge gap: `DEFAULT_PRINTED.gapMm`;
- max closure angle: `printedThetaMax(...) = 2 * atan(gap / thickness)`.

The sim canvas and STL export share tile gap/detail through app state so the
rendered printed-tile behavior and exported mesh stay aligned.

## Guided vs Free

Free mode is the default: the fold moves according to crease targets and solver
forces.

Guided mode is used when the file declares enough target information for a
designed 3D state, such as:

- a folded-form frame;
- `fkld:vertices_driven`;
- legacy AKDE pyramid metadata recoverable from `frame_title`.

Guided mode drives selected nodes toward declared goals while the rest of the
bar-and-hinge model relaxes. This is required for floppy kirigami examples that
do not have a unique free equilibrium.

## Coordinate Convention

Kirigamizer embeds the flat sheet in the x-y plane and lets folds lift along
`+z`. This differs from some Origami Simulator conventions but matches the
Three.js viewer and FKLD examples used in this repo.

## Failure Modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Sim button disabled | Missing required FOLD arrays. | `isFoldable`, `canSimulate`, loaded/viewer source. |
| Cut does not open | Edge was not assigned `"C"` before `splitCuts`. | `edges_assignment`, processed vertex count. |
| Mountain/valley folds backward | Bad assignment or explicit fold-angle sign. | `targetFoldAngles`, crease winding tests. |
| Model explodes numerically | Bad scale, degenerate edges, or stiffness mismatch. | `computeDt`, min edge length, material params. |
| Free kirigami splays | Pattern needs a declared guided target. | `foldedForm`, `fkld:vertices_driven`, `scene.ts` route. |

## Tests

Relevant coverage lives in:

- `tests/current/sim/fold-adapter.test.ts`
- `tests/current/sim/foldnet.test.ts`
- `tests/current/sim/solver.test.ts`
- `tests/current/sim/scene.test.ts`
- `tests/current/sim/origami-exact.test.ts`
- `tests/current/kzr-sim.test.ts`

