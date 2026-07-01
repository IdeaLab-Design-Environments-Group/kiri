# Subsystem: Bistable Star Tiling Pipeline

The BST subsystem generates bistable star-tiling kirigami patterns. It lives in
`src/pipeline/bst/` and is exposed through the `Bistable star tiling` method in
the header method selector.

## Purpose

BST is a second mesh-to-pattern route, separate from the default M1-M5
Kirigamizer pipeline. It implements the design direction from Toyooka and
Tachi's bistable star tiling kirigami work:

- build a contracted flat star tiling;
- compute or relax the expanded/deployed state;
- optionally fit the deployment to a target mesh;
- emit FKLD with a `foldedForm` frame and driven vertices so the 3D Sim deploys
  the pattern.

## Files

| File | Role |
| --- | --- |
| `src/pipeline/bst/types.ts` | BST DTOs and defaults (`BstParams`, `BstTiling`, `BstResult`). |
| `src/pipeline/bst/star-tiling.ts` | Planar tiling construction at a slit angle. |
| `src/pipeline/bst/mesh-project.ts` | Target footprint/domain projection helpers. |
| `src/pipeline/bst/relax.ts` | Projective dynamic relaxation against a target mesh. |
| `src/pipeline/bst/bistable-bar.ts` | Bistable connector/bar solve and placement. |
| `src/pipeline/bst/emit-bst.ts` | FKLD emission for contracted pattern plus deployed goal. |
| `src/pipeline/bst/index.ts` | Public orchestrators: `bstUniform`, `bstSurfaceFit`, `bstFromMesh`. |
| `src/services/pattern-service.ts` | `bstSurfaceProgram` service facade and user-facing summary. |
| `tests/current/bst/` | Unit and service-level tests. |

## Entry Points

`bstUniform(params)` creates a flat contracted crease pattern and a planar
expanded goal. It is useful for examples and basic deployment checks.

`bstSurfaceFit(mesh, params)` surface-programs a `TriMesh`. It fits the expanded
tiling to the mesh footprint, projects vertices onto the target, relaxes rigid
edges, computes bars, and emits FKLD.

`bstFromMesh(text, ext, params)` is the app-facing text importer. It parses
OBJ/STL, conditions the mesh, and delegates to `bstSurfaceFit`.

## Data Flow

```text
Header method = bst
  -> AppController.kirigamize()
  -> pattern-service.bstSurfaceProgram(...)
  -> bstFromMesh(text, ext)
  -> parseMesh + condition
  -> bstSurfaceFit
  -> emitBstFkld
  -> ViewerFrame.show + 3D Sim guided deployment
```

## Parameters

Defaults live in `DEFAULT_BST`:

| Parameter | Meaning |
| --- | --- |
| `alpha` | Contracted slit angle in radians. |
| `gamma` | Slit edge-length ratio. |
| `beta0` | Planar expanded slit angle. |
| `grid.nx`, `grid.ny` | Tiling dimensions. |
| `epsilon` | Bar strain target. |
| `relaxIters` | Relaxation iteration cap. |

Current defaults start with a square-safe case (`alpha = 0`, `gamma = 1`) so
the pipeline and tests run predictably. Concave star-regime bars require the
star tile profile work noted in `bistable-bar.ts`.

## FKLD Contract

BST emission writes:

- the contracted tiling as the flat crease pattern;
- the deployed result as a `foldedForm` frame;
- driven flags for kinematic deployment;
- auxetic/bistable metadata under `fkld:` keys;
- bar connector geometry when bars are kept.

The sim uses the same guided-frame mechanism as the general pipeline: the file
declares the target deployment, and the fold adapter drives vertices to that
target.

## Failure Modes

| Failure | Likely Cause | Fix |
| --- | --- | --- |
| Parse/conditioning error | Unsupported mesh text, binary STL, non-manifold input. | Use ASCII STL/OBJ and the normal mesh-conditioning checklist. |
| Poor fit residual | Tiling too coarse or target too curved for the current grid. | Increase grid density or simplify target curvature. |
| No bars emitted | Square-first geometry or skipped infeasible bars. | Use this as a valid deployment pattern; add star profile support before relying on bars. |
| Sim looks flat without guidance | Missing `foldedForm`/driven metadata. | Fix `emit-bst.ts`; BST depends on guided deployment. |
