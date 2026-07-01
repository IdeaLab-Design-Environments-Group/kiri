# Pipeline FKLD Emission

This subsystem serializes the classified sheet into a FOLD/FKLD file that the
viewer, simulator, metadata panels, and SVG exporter can consume.

## Files

| File | Responsibility |
| --- | --- |
| `src/pipeline/emit.ts` | Builds the final FKLD object and validates FKLD extension arrays. |
| `src/model/fold-file.ts` | Defines the application-side FOLD/FKLD shape. |
| `src/fkld/spec.coffee` | Provides extension key names through the `KEYS` registry. |
| `src/fkld/cut-types.coffee` | Validates cut subtype arrays. |
| `src/fkld/molecule.coffee` | Validates molecule/tuck arrays. |
| `src/sim/fold-adapter.ts` | Consumes the emitted guided-fold frame and driven flags. |

## Emission Inputs

`emitFkld(sheet, opts)` requires the placed `Sheet` plus target mesh context.
The function does not inspect DOM state and does not call the controller.

Key inputs:

| Input | Purpose |
| --- | --- |
| `sheet.vertices` | Flat 2D coordinates for `vertices_coords`. |
| `sheet.edges` | FOLD `edges_vertices`. |
| `sheet.assignment` | FOLD `edges_assignment`. |
| `sheet.foldAngle` | Fold targets, exported in degrees for FOLD compatibility. |
| `sheet.cutType` | FKLD cut subtype extension. |
| `sheet.origVertex` | Provenance for curvature and strategy metadata. |
| `sheet.goalPos` | Folded 3D goal frame for simulation. |
| `opts.defects` | Per-source-vertex curvature metadata. |
| `opts.actions` | Per-source-vertex relief strategy metadata. |

## Output Structure

The emitted file includes:

| Field | Meaning |
| --- | --- |
| Standard FOLD arrays | `vertices_coords`, `edges_vertices`, `edges_assignment`, `edges_foldAngle`, `faces_vertices`. |
| Cut extension | `fkld:edges_cutType` via `KEYS.edges.cutType`. |
| Dihedral extension | FKLD dihedral target array for solver/viewer metadata. |
| Vertex curvature extensions | Angle defect, curvature class, relief strategy. |
| Architecture metadata | Scale, source, strategy, lambda, and paper rectangle. |
| Guided frame | `file_frames[0]` with `frame_classes: ["foldedForm"]`. |
| Driven flags | `fkld:vertices_driven` array consumed by the simulator adapter. |

## Guided-Fold Contract

The simulator uses the emitted folded-form frame as a target pose. Boundary
vertices on cut lips and sheet boundary are marked driven so they can be guided
to their target positions during simulation.

This is a deliberate simulation contract:

| Contract | Consumer |
| --- | --- |
| `file_frames[].frame_classes` contains `foldedForm`. | `src/sim/fold-adapter.ts`. |
| Goal coordinates are 3D and in millimeters. | Simulator build/adaptation. |
| `fkld:vertices_driven[i]` is `1` for driven boundary vertices. | Guided fold application. |
| Interior vertices may remain free. | Verification checks strain and crease residuals. |

## Molecule/Tuck Metadata

Positive defects tagged as tucks receive molecule metadata on incident crease
edges. The current pipeline annotates molecule parameters; it does not generate
a full Origamizer tuck-crease construction.

Do not treat molecule metadata as physical geometry. Geometry-changing tuck
generation would belong before placement and would require new topology docs.

## Validation

`emitFkld` validates before returning:

| Validator | Protects |
| --- | --- |
| `validateEdgeCutTypes` | Cut subtype arrays match edge assignments. |
| `validateMoleculeArrays` | Molecule theta/width arrays match edge topology. |

Validation failure is raised as `PipelineError("emit", ...)`.

## Extension Rules

Add new FKLD fields through the `KEYS` registry where possible. Do not hardcode
extension strings in multiple pipeline files. If a downstream subsystem consumes
a new emitted field, document the consumer in this page and add tests at the
emission boundary.

