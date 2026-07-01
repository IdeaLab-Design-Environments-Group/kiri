# Architecture

Kirigamizer is organized as **MVC + Core + Services** with two separate
domains (simulation, conversion pipeline). The goal is to keep DOM/WebGL
code, app state, use-case logic, and geometry/simulation logic independently
testable — and to keep the boundaries mechanically enforced
(`tests/current/architecture/import-boundaries.test.ts`).

Related structure docs:

- `docs/repository-structure.md` maps the top-level repository.
- `docs/source-structure.md` maps every active source file by responsibility.
- `docs/import-boundaries.md` gives allowed/forbidden dependency rules
  (executable as the architecture test).

## Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| Composition root | `src/main.ts` | Construct model, views, controller, and mount them. No app behavior. |
| Controller | `src/controller/` | Thin mediator: wire view intents to services + store, own the single `render(state)` path. |
| Services | `src/services/` | Stateless use-case logic: model loading/parsing (`model-loader`), pattern creation over both pipelines (`pattern-service`), sim-scene resolution (`sim-scene-service`). New features land here. |
| Model | `src/model/` | Application state (`AppStore`, incl. `viewerShown`), FOLD/FKLD data types, and pure presenters. No DOM. Kirigami geometry/types live in `@kirigami/model` (single source of truth). |
| View | `src/view/` | DOM/WebGL rendering and event emission. No parsing or durable app state. |
| Core | `src/core/` | Dependency-free shared code: `vec3` math, `AppError` vocabulary. Imports nothing. |
| Simulation domain | `src/sim/` | Bar-and-hinge topology, physics, solvers, and scene builders. No DOM. Node-safe via `sim/index.ts`; browser-only GPU path via `sim/gpu/index.ts`. |
| Conversion pipeline | `src/pipeline/` | Pure mesh-to-kirigami conversion stages and DTO contracts. No DOM/app state. |

## Data Flow

```text
User event
  -> View emits intent
  -> AppController routes it to a service
  -> Service does the work (parse / pipeline / scene build), returns data or throws AppError
  -> AppStore updates state
  -> Controller render subscription derives view data
  -> Views render new state
```

Example: loading a file.

```text
ConvertPanel.onFileChosen(file)
  -> AppController.loadFromFile(file)
  -> services/model-loader.readModelFile(file, onLoaded, onError)
       onLoaded: AppStore.update({ model, status: loadedStatus(model) })
       onError(AppError): "parse" clears the model; "io" updates status only
  -> render(state)
  -> ConvertPanel.renderFacts(...)
  -> MetadataPanel.render(...)
  -> HeaderActions.setKirigamizeEnabled(...)
  -> SimModal.setEnabled(...)   // derived from state.viewerShown ?? fold model
```

## State of Truth

`AppStore` is the single source of truth, including **`viewerShown`** — the
model the FKLD viewer iframe currently displays (fed by `ViewerFrame.onLoaded`
from both host pushes and the viewer's own load paths). The 3D Sim provider
and its enablement derive from `viewerShown ?? model`, so "what you see is
what gets simulated" survives re-renders.

## Errors

All surfaced failures are `AppError`s (`src/core/errors.ts`) with a `domain`
(`parse | pipeline | sim | io | create`); `PipelineError` specializes it with
a stage tag. `statusFromError` is the single bridge into the status line.

## Boundary Rules

See `docs/import-boundaries.md` — enforced by
`npx vitest run tests/current/architecture` (rules R1–R9, including the
Node-safety walk that keeps `sim/index.ts` and `pipeline/index.ts` free of
`three` in their transitive import closure).

- `src/view/*` may import types from `src/model/*` and sim APIs via the
  barrels only; it must not mutate `AppStore` or import services/controller.
- `src/model/*` must not import from view/controller/services or the DOM.
- `src/controller/*` is the only layer that knows both model and view; logic
  beyond wiring belongs in `src/services/`.
- `src/services/*` never imports view/ or controller/.
- `src/sim/*` and `src/pipeline/*` never import view/controller/services.
- `src/core/*` imports nothing from other layers.
- `src/main.ts` should stay boring: instantiate and wire objects only.

## File Ownership

Model files:

- `src/model/app-store.ts` stores observable UI state.
- `src/model/fold-file.ts` defines FOLD/FKLD shell types.
- `src/model/derive-facts.ts` maps loaded models to "Derived" rows.
- `src/model/fkld-metadata.ts` maps FKLD/FOLD objects to metadata sections.
- `kirigami/model/geometry.ts` and `kirigami/model/types.ts` hold the
  transferred AKDE kirigami math and types exposed through `@kirigami/model`.

View files:

- `src/view/convert-panel.ts` owns the file dropzone and derived facts DOM.
- `src/view/metadata-panel.ts` owns the metadata DOM.
- `src/view/viewer-frame.ts` owns the embedded FKLD viewer iframe bridge.
- `src/view/header-actions.ts` owns header buttons.
- `src/view/sim-modal.ts` owns the simulation modal shell.
- `src/view/sim-canvas.ts` owns Three.js/WebGL rendering for simulation scenes.

Controller files:

- `src/controller/app-controller.ts` is the app orchestration point.

Simulation files:

- `src/sim/model.ts`, `forces.ts`, `solver.ts`, and `gpu/` implement the
  Ghassaei/Demaine/Gershenfeld bar-and-hinge simulator.
- `src/sim/foldnet.ts`, `build.ts`, `fold-adapter.ts`, and `scene.ts` build
  simulation scenes from kirigami state or FOLD/FKLD data.

Pipeline files:

- `src/pipeline/bst/` implements the bistable star tiling route.
- `src/pipeline/types.ts` defines cross-stage DTOs and `PipelineError`.
- `src/pipeline/import.ts` parses OBJ and ASCII STL text into `TriMesh`.
- `src/pipeline/conditioning.ts` repairs and gates imported meshes.
- `src/pipeline/mesh.ts` derives topology and one-ring fans.
- `src/pipeline/curvature.ts` computes defects and target dihedrals.
- `src/pipeline/plan-cuts.ts` routes cut forests over the mesh graph.
