# Subsystem: Pattern Editor

The pattern editor is a secondary design path for hand-authoring crease and cut
patterns on a square lattice. It does not run mesh import or the M1-M5 pipeline.

## Purpose

The editor gives a quick way to sketch FOLD/FKLD patterns directly in the app:
paint edge assignments on a grid, preview/download the resulting FKLD, or commit
it to the viewer and 3D Sim.

It is useful for small experiments, regression fixtures, and fold-engine tests
where a full mesh-to-pattern conversion is unnecessary.

## Files

| File | Role |
| --- | --- |
| `src/model/pattern-grid.ts` | Pure grid model, assignment painting, presets, and `gridToFold`. |
| `src/view/pattern-editor-modal.ts` | Modal UI, SVG grid render, brush/preset controls, use/download callbacks. |
| `src/services/pattern-service.ts` | `fkldFromPatternGrid` and `serializePatternGrid` wrappers. |
| `src/controller/app-controller.ts` | Wires editor use/download callbacks. |
| `tests/current/pattern-grid.test.ts` | Grid model coverage. |
| `tests/current/view/pattern-editor-modal.test.ts` | View/modal behavior coverage, if present. |

## Data Flow

```text
PatternEditorModal owns PatternGrid
  -> user paints assignments or applies preset
  -> onUse(grid)
  -> pattern-service.fkldFromPatternGrid(grid)
  -> AppController.showPattern(...)
  -> ViewerFrame + 3D Sim
```

Downloads use:

```text
PatternEditorModal serializer
  -> pattern-service.serializePatternGrid(grid)
  -> .fkld JSON payload
```

## Grid Contract

`PatternGrid` stores assignments over:

- horizontal edges;
- vertical edges;
- both diagonals per cell.

`gridToFold` converts the lattice into:

- `vertices_coords`;
- `edges_vertices`;
- `edges_assignment`;
- triangulated `faces_vertices`;
- cut subtype data for cut edges.

The service layer stamps FKLD metadata such as `fkld:meta_architecture`; the
grid model stays independent of FKLD extension keys.

## Presets

Presets live in `src/model/pattern-grid.ts` and are exposed by the modal. They
are intentionally small and deterministic so they can double as fixtures.

When adding a preset:

1. keep it pure and grid-size aware;
2. test assignment counts and face generation;
3. avoid modal-specific logic in the model;
4. let the service produce FKLD metadata.

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| Viewer shows no faces | Grid produced no valid cell triangulation. | Check `gridToFold` and grid dimensions. |
| Sim folds differently than expected | M/V defaults use standard FOLD assignment behavior. | Emit explicit `edges_foldAngle` in the service if a preset needs non-default angles. |
| Download differs from committed pattern | Serializer path diverged from `fkldFromPatternGrid`. | Keep both wrappers using `patternDraftToFkld`. |
