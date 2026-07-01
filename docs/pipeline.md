# Kirigamize Pipeline

`src/pipeline/` is the general mesh-to-kirigami conversion scaffold. It is
separate from the app MVC shell and from the origami simulator. The controller
calls this pipeline for `.obj` and `.stl` inputs when the header method selector
is set to the normal Kirigamizer route.

A sibling generation route also lives under `src/pipeline/`:

- `bst/` — bistable star tiling generation and mesh surface fitting.

It is documented separately in `docs/subsystems/bst-pipeline.md`; it does not run
through every M1-M5 stage.

## Scope

Pipeline code is a pure TypeScript functional core:

- No DOM access.
- No file picker or `FileReader` access.
- No Three.js rendering.
- No app store mutation.
- No Vite/browser assumptions.

Inputs and outputs are plain DTOs from `src/pipeline/types.ts`.

## Stage Map

| Stage | File | Purpose |
| --- | --- | --- |
| BST route | `src/pipeline/bst/` | Generate bistable star tiling FKLDs, optionally fit to a target mesh. |
| M1 import | `src/pipeline/import.ts` | Parse OBJ or ASCII STL text into `TriMesh`. |
| M1 conditioning | `src/pipeline/conditioning.ts` | Weld coincident vertices, drop degenerates, orient faces, reject unsupported genus. |
| M1 topology | `src/pipeline/mesh.ts` | Build edges, one-ring fans, boundary sets, Euler/boundary helpers. |
| M2 curvature | `src/pipeline/curvature.ts` | Compute angle defects and signed dihedral targets. |
| M2 cut planning | `src/pipeline/plan-cuts.ts` | Choose cut terminals/routes using greedy graph algorithms and wedge rules. |
| M3 seamed unfold | `src/pipeline/unfold.ts` | Split along cut forests, unfold developable patches, add relief cuts. |
| M4 route/pack | `src/pipeline/route-seams.ts` | Pack flat patches and classify sheet edges as M/V/F/B/C. |
| M4 emit | `src/pipeline/emit.ts` | Emit FKLD/FOLD arrays, FKLD extensions, goal frame, driven flags. |
| M5 verify | `src/pipeline/verify.ts` | Fold emitted FKLD and measure Hausdorff/strain/crease residuals. |
| Driver | `src/pipeline/kirigamize.ts` | Orchestrate all stages and bounded retry schedule. |

## DTO Contracts

The main cross-stage DTOs are:

- `TriMesh`: target triangle mesh in millimetres.
- `MeshTopology`: derived adjacency and boundary information.
- `DefectReport`: per-vertex angle defects and curvature classes.
- `CutPlan`: cut edge ids, per-vertex actions, and cost.
- `UnfoldResult`: flattened patches, cut lips, provenance, relief edges.
- `Sheet`: packed flat pattern with assignments, cut types, fold angles, lips.
- `VerifyReport`: simulator verification metrics and convergence status.

All lengths are millimetres. All angles are radians except at FOLD/FKLD emission
boundaries where `edges_foldAngle` is stored in degrees.

BST has its own DTOs (`BstParams`, `BstResult`) because its inputs are not
general conditioned meshes in the same shape as M1-M5 intermediates.

## Import Rules

OBJ support:

- Reads `v x y z` vertices.
- Reads `f` polygon faces.
- Accepts `v/vt/vn` face tokens.
- Accepts negative relative OBJ indices.
- Fan-triangulates n-gons.

STL support:

- ASCII STL only.
- Binary STL is rejected with a `PipelineError`.
- STL imports as triangle soup and must be conditioned/welded afterward.

## Conditioning Rules

`condition(mesh)` runs:

1. `weldVertices`: quantized vertex welding.
2. `dropDegenerates`: removes zero-area faces and unused vertices.
3. `orientFaces`: BFS face-winding consistency pass.

`assertGenusZero(mesh, topo)` enforces v1 scope. Handles are rejected because
handle-loop cutting is deferred.

## Curvature Rules

Angle defect:

```text
delta(v) = 2*pi - sum(interior angles around v)
```

Boundary vertices report zero defect and class `boundary`, because boundary
defect sign is not meaningful for the planner.

Signed dihedral targets use:

```text
theta = atan2((n1 x ehat) dot n2, n1 dot n2)
```

The pipeline currently documents the AKDE solver convention in
`curvature.ts`: mountain-positive at the target-mesh stage. The simulation
adapter converts FOLD/FKLD conventions at the boundary. Keep this distinction
explicit when wiring pipeline output into FKLD emission.

## Cut Planning Rules

`planCuts(mesh, topo, defects, opts)` follows three steps:

1. Necessity: non-flat curvature vertices become cut terminals unless tucked.
2. Connection: terminals are connected by shortest paths on the mesh graph,
   approximating the Steiner-tree problem with an MST over the metric closure.
3. Wedge rule: negative curvature vertices need enough separators so every
   wedge angle is below `2*pi`.

The cut set is pruned to a forest so genus-0 surfaces stay disk-like after
cutting.

## Unfold Rules

`seamedUnfold(mesh, topo, plan)` implements the M3 cut-and-flatten stage.

Important invariants:

- Planned cut edges become separators.
- Interior cut edges are split into lip pairs.
- Each source vertex becomes one copy per fan wedge.
- `origVertex` preserves provenance from flat/cut vertices back to source mesh
  vertices.
- Patch layout is isometric: every flat edge length must match the 3D source
  rest length within tolerance.

The layout process uses BFS over each patch's face dual. It places faces across
already-placed edges using triangle side lengths from the 3D target, so the
flat pattern preserves rest lengths by construction.

Overlap handling:

- `trianglesOverlap` is exported for isolated tests.
- The relief loop can add source edges as extra cuts when the flat layout
  overlaps.
- `RELIEF_MAX` bounds the iteration count.

## Route and Pack Rules

`packPatches(unfold, ctx)` turns flattened patches into one `Sheet`.

Responsibilities:

- Translate patches apart with deterministic shelf packing.
- Rebuild sheet topology from flat faces.
- Map boundary lip edges to assignment `C`.
- Map original source boundary edges to assignment `B`.
- Map uncut interior source edges to `M`, `V`, or `F` from source target
  dihedral.
- Assign deterministic cut subtypes:
  - negative endpoint defect wins as `minor`;
  - positive endpoint defect becomes `dart`;
  - otherwise connection/relief cuts become `seam`.

`major` and `tab` are not emitted by the general pipeline; they remain
AKDE-pyramid-specific or deferred.

## FKLD Emission Rules

`emitFkld(sheet, opts)` is the M4 file builder.

It emits standard FOLD arrays:

- `vertices_coords`
- `edges_vertices`
- `edges_assignment`
- `edges_foldAngle`
- `faces_vertices`

It also emits FKLD extensions:

- cut subtypes;
- dihedral targets;
- molecule annotations for tucked vertices;
- per-vertex angle defects;
- curvature classes;
- relief strategies;
- architecture metadata;
- driven vertex flags.

Guided-fold contract:

- The FKLD contains a `foldedForm` frame.
- `foldedForm.vertices_coords[i]` is the goal position from the source mesh
  through `origVertex`.
- `fkld:vertices_driven[i] = 1` marks sheet-boundary vertices.
- `src/sim/fold-adapter.ts` consumes this frame and drives those nodes.

Emission validates FKLD extension arrays before returning. Validation failures
are reported as `PipelineError("emit", ...)`.

## Verification Rules

`verifyFold(fkld, target, opts)` runs M5.

Verification is equilibrium-based:

- The emitted FKLD is loaded through the same fold adapter used by the UI.
- The solver starts at the goal pose with `foldPercent = 1`.
- The structure is relaxed.
- A correct pattern should remain a stable equilibrium.
- A wrong pattern drifts or accumulates strain/crease residuals.

Metrics:

- sampled symmetric Hausdorff distance;
- relative Hausdorff distance;
- mean/max bar strain;
- mean crease-angle residual;
- convergence flag;
- worst source vertex for retry/refinement.

The sampled Hausdorff set includes vertices, edge midpoints, and face centroids.
This catches interior bulge that vertex-only sampling would miss.

## Driver Rules

`kirigamize(input, options)` returns all intermediates, not just the FKLD:

- `conditioning`
- `defects`
- `plan`
- `unfold`
- `sheet`
- `fkld`
- `report`

The bounded retry schedule is:

1. Run the full pipeline and verify.
2. If verification fails, add the worst source vertex as an extra relief
   terminal and rerun plan-to-emit once.
3. If still failing, rerun verification with 3x iterations.

The result keeps an honest `converged` flag. The driver does not hide failed
verification.

## Error Handling

Pipeline stages throw `PipelineError`, not bare `Error`, so UI/controller code
can report:

```text
<stage>: <message>
```

Known stages are listed in `PipelineError["stage"]`. Add a new stage value
before adding a new stage file.

## Implementation Rules

- Rebuild topology after any stage that changes mesh connectivity.
- Do not mutate input DTOs unless a function documents that it does.
- Keep algorithm constants near the stage that owns them.
- Preserve provenance fields such as `origVertex`; later guided simulation and
  verification depend on source-target vertex mapping.
- Add tests for each stage before wiring it into the controller.
- Keep `kirigamize.ts` as a facade; stage-specific algorithms belong in their
  stage files.
- Keep sibling routes explicit. If a feature does not consume the M1-M5 DTO
  chain, document it as a sibling pipeline instead of forcing it into the stage
  table.
