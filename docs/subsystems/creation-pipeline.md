# Subsystem: Transferred AKDE Creation Pipeline

The creation pipeline generates known AKDE-style pyramid FKLD patterns inside
the Kirigamizer shell. It is separate from the general mesh-to-kirigami
pipeline.

## Files

| File | Role |
| --- | --- |
| `src/controller/app-controller.ts` | Calls the creation pipeline from `createPyramid`. |
| `kirigami/model/geometry.ts` | `defaultInputs`, `computeState`. |
| `kirigami/model/fkld-export.ts` | `buildFkldFile`. |
| `src/sim/scene.ts` | Recognizes generated pyramid FKLDs and selects guided sim. |

## Purpose

This subsystem exists to keep a reliable known-good pattern path while the
general pipeline matures.

It produces:

- an FKLD crease/cut pattern;
- metadata that encodes `N`, `L`, `H`, `T` in `frame_title`;
- assignments/cut types compatible with the viewer;
- a file that can be simulated through guided mode.

## Data Flow

```text
HeaderActions.onCreatePyramid
  -> AppController.createPyramid()
  -> defaultInputs()
  -> computeState(inputs)
  -> buildFkldFile(state)
  -> applyFold(fkld, "akde-pyramid.fkld")
  -> ViewerFrame.show(...)
  -> SimModal can build guided scene
```

## Relationship to General Pipeline

| Creation pipeline | General pipeline |
| --- | --- |
| Starts from parametric AKDE inputs. | Starts from OBJ/STL target mesh. |
| Uses known uniform molecule construction. | Plans cuts from curvature/topology. |
| Emits known pyramid FKLD. | Emits arbitrary target-derived FKLD. |
| Guided sim reconstructs state from metadata. | Guided sim uses emitted goal frame. |

Do not merge the two without preserving this distinction. The creation pipeline
is a stable reference path.

## Extension Rules

- Add new parametric examples in `kirigami/model` or a dedicated creation
  module, not in `AppController`.
- Keep `AppController.createPyramid` as a thin orchestrator.
- Ensure generated FKLD remains valid for `ViewerFrame` and `SimModal`.
- If frame-title parsing changes, update `src/sim/scene.ts` and tests.

## Failure Modes

| Failure | Likely cause |
| --- | --- |
| `createPyramid` returns null | FKLD export failed or invalid state. |
| Viewer shows pattern but 3D Sim disabled | `canSimulate` cannot recognize metadata. |
| Guided sim folds wrong dimensions | `frame_title` parsing or units mismatch. |
| Metadata panel lacks fields | FKLD export missing extension arrays. |
