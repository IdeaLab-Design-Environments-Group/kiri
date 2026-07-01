# Source Structure

`src/` is the active application source. It is split by responsibility rather
than by file type.

For narrower subsystem docs, start at `docs/subsystems/index.md`.

## Tree

```text
src/
  main.ts
  styles.css
  controller/
    app-controller.ts
  core/
    errors.ts
    vec3.ts
  services/
    model-loader.ts
    pattern-service.ts
    sim-scene-service.ts
    stl-export-service.ts
    svg-export-service.ts
  model/
    app-store.ts
    derive-facts.ts
    fkld-metadata.ts
    fkld-svg-export.ts
    fold-file.ts
    pattern-grid.ts
    stl-ascii.ts
    stl-export.ts
    tile-subdiv.ts
  pipeline/
    bst/
      bistable-bar.ts
      emit-bst.ts
      index.ts
      mesh-project.ts
      relax.ts
      star-tiling.ts
      types.ts
    conditioning.ts
    curvature.ts
    emit.ts
    import.ts
    index.ts
    kirigamize.ts
    mesh.ts
    plan-cuts.ts
    route-seams.ts
    types.ts
    unfold.ts
    verify.ts
  sim/
    build.ts
    fold-adapter.ts
    foldnet.ts
    forces.ts
    gpu/
      gpu-solver.ts
      index.ts
      pack.ts
      shaders.ts
    index.ts
    model.ts
    origami-import.ts
    scene.ts
    solver.ts
    stabilize.ts
    svg-import.ts
    vec3.ts
  view/
    convert-panel.ts
    dom.ts
    export-modal.ts
    header-actions.ts
    metadata-panel.ts
    pattern-editor-modal.ts
    sim-canvas.ts
    sim-modal.ts
    viewer-frame.ts
```

## Composition Root

`src/main.ts`

- Imports CSS.
- Instantiates `AppStore`.
- Instantiates all views.
- Instantiates `AppController`.
- Loads the default sample.
- Should not contain business logic, parsing, geometry, solver code, or DOM
  update details beyond mounting views.

## Controller

`src/controller/app-controller.ts`

Responsibilities:

- Register view callbacks and route each intent to a **service**.
- Update `AppStore` with service results (or `AppError` statuses).
- Push derived render data into views when state changes (single `render`).
- Send FOLD/FKLD objects to `ViewerFrame`; record `viewerShown` from it.
- Provide simulation scenes to `SimModal` via `services/sim-scene-service`.

It is intentionally the only app layer that imports both model and view
classes. Use-case logic does NOT belong here — it lives in `src/services/`.

## Core

`src/core/` — dependency-free shared code (imports nothing from other layers).

| File | Responsibility |
| --- | --- |
| `vec3.ts` | Plain `{x,y,z}` vector math shared by sim/ and pipeline/ (`sim/vec3.ts` re-exports it). |
| `errors.ts` | `AppError` (domain-tagged) + `toAppError` + `statusFromError` — the app-wide error vocabulary. |

## Services

`src/services/` — stateless use-case logic between controller and domains.
New features land here, not in the controller.

| File | Responsibility |
| --- | --- |
| `model-loader.ts` | Text→`LoadedModel` parsing, FileReader IO (callback-style by design), sample fetching, loaded-status strings. |
| `pattern-service.ts` | Single facade over the creation paths — the M1–M5 pipeline (`kirigamizeMesh`), the AKDE creation pipeline (`createAkdePyramid`), and the **pattern editor** (`fkldFromPatternGrid` / `serializePatternGrid`) — each returning a narrow `PatternOutcome`. Owns the `fkld:` namespace stamping for the editor draft. |
| `sim-scene-service.ts` | `resolveSimScene(model, shown)` — pure policy for what the 3D Sim folds. |
| `stl-export-service.ts` | `resolveStlExport(model, shown, heightUnits, maxSubdiv)` — pure policy for printed-tile STL export source selection. |
| `svg-export-service.ts` | `resolveSvgExport(model, shown)` — pure policy for what SVG export targets. |

Rules:

- No view/ or controller/ imports.
- Stateless: services take inputs, return data or throw `AppError`.

## Model

`src/model/`

| File | Responsibility |
| --- | --- |
| `app-store.ts` | Observable UI state: loaded model, status, and `viewerShown` (what the viewer iframe displays). |
| `fold-file.ts` | Minimal FOLD/FKLD types and `isFkld`. |
| `derive-facts.ts` | Loaded model to Derived panel rows. |
| `fkld-metadata.ts` | FOLD/FKLD object to metadata panel sections. |
| `fkld-svg-export.ts` | FOLD/FKLD flat pattern to cut/score SVG payload. |
| `pattern-grid.ts` | Secondary design path: a paintable square lattice (Origami-Simulator crease vocabulary) compiled to a triangulated FOLD draft (`gridToFold`) + foldable presets. Pure; the service stamps the `fkld:` keys. |
| `stl-ascii.ts` | Shared ASCII-STL triangle/box helpers. |
| `stl-export.ts` | Printed tile STL export path. |
| `tile-subdiv.ts` | Shared printed-tile subdivision/inset constants used by sim rendering and STL export. |

Kirigami geometry/types (`KirigamiState`, `computeState`, …) live in
`@kirigami/model` — the single source of truth. The former `src/model/types.ts`
and `src/model/geometry.ts` duplicates were deleted (architecture-test rule R5
keeps them from reappearing).

Rules:

- No DOM.
- No controller imports.
- No view imports.
- Pure calculations should stay deterministic and testable.

## View

`src/view/`

| File | Responsibility |
| --- | --- |
| `dom.ts` | Tiny DOM helpers shared by views. |
| `convert-panel.ts` | File dropzone, status line, Derived rows. |
| `metadata-panel.ts` | FKLD metadata rendering. |
| `viewer-frame.ts` | Embedded FKLD viewer iframe and postMessage bridge. |
| `export-modal.ts` | Export modal for SVG cut/score and printed tile STL downloads. |
| `pattern-editor-modal.ts` | Interactive crease-pattern grid editor (secondary design path): tool palette, presets, paints a `PatternGrid`, emits `onUse(grid)` + a download serializer. |
| `header-actions.ts` | Header buttons and intent callbacks. |
| `sim-modal.ts` | 3D simulation modal shell and fold slider. |
| `sim-canvas.ts` | Three.js/WebGL simulation rendering, printed-tile display, and animation policy. |

Rules:

- Views emit intents via callbacks.
- Views render data they are given.
- Views do not parse files.
- Views do not mutate `AppStore`.
- `sim-canvas.ts` may call simulation solvers because it is the rendering
  adapter for live simulation scenes.

## Pipeline

`src/pipeline/`

| File | Stage | Responsibility |
| --- | --- | --- |
| `types.ts` | shared | DTOs, `PipelineError`, cross-stage contracts. |
| `import.ts` | M1 | Parse OBJ/ASCII STL text into `TriMesh`. |
| `conditioning.ts` | M1 | Weld, drop degenerates, orient, genus gate. |
| `mesh.ts` | M1 | Topology, edge keys, face angles, boundary loops, wedges. |
| `curvature.ts` | M2 | Angle defects and signed dihedral targets. |
| `plan-cuts.ts` | M2 | Cut terminals, shortest paths, wedge rule. |
| `unfold.ts` | M3 | Cut along edges, unfold patches, relief loop. |
| `route-seams.ts` | M4 | Pack patches and classify sheet edges/cuts. |
| `emit.ts` | M4 | Build FOLD/FKLD output and validate extension arrays. |
| `verify.ts` | M5 | Sim-based equilibrium verification metrics. |
| `kirigamize.ts` | driver | Full pipeline facade and retry schedule. |
| `index.ts` | barrel | Node-safe exports. |

`src/pipeline/bst/` is a sibling pipeline, not an M-stage file group. It owns
bistable star tiling generation, surface-fit relaxation, bistable bar placement,
and FKLD emission for the `Bistable star tiling` method selector path. See
`docs/subsystems/bst-pipeline.md`.

Rules:

- No DOM.
- No view/controller imports.
- Stage files should expose pure functions where possible.
- Throw `PipelineError` with stage names.
- Preserve `origVertex` provenance.

## Simulation

`src/sim/`

| File | Responsibility |
| --- | --- |
| `vec3.ts` | Compatibility re-export of `core/vec3.ts` (the shared math). |
| `foldnet.ts` | FoldNet topology from AKDE/generic meshes. |
| `model.ts` | `BarHingeModel` struct-of-arrays assembly. |
| `forces.ts` | CPU force math and timestep calculation. |
| `solver.ts` | CPU reference solver. |
| `stabilize.ts` | Solver stabilization/settling helpers. |
| `build.ts` | Guided AKDE scene builder. |
| `fold-adapter.ts` | FOLD/FKLD to simulation scene adapter. |
| `origami-import.ts` | FOLD/FKLD preprocessing result to bar-and-hinge model assembly, fold-angle policy, and material params. |
| `scene.ts` | Guided/free scene selection. |
| `svg-import.ts` | Origami Simulator SVG crease-pattern importer used by generated examples. |
| `gpu/pack.ts` | Pack model into GPU textures. |
| `gpu/shaders.ts` | GLSL force/integration shaders. |
| `gpu/gpu-solver.ts` | Three.js GPU computation wrapper. |
| `gpu/index.ts` | Browser-only GPU barrel — the only sanctioned GPU entry point. |
| `index.ts` | Public Node-safe simulation exports (never re-exports gpu/ or anything importing `three`). |

`src/sim/origami-import.ts` is the central arbitrary FOLD/FKLD simulation
import path. `src/sim/svg-import.ts` is a DOM-free compatibility importer for
Origami Simulator SVG crease patterns. It belongs in `sim/` because it
reproduces the upstream simulator's front-end pattern loader and feeds the same
fold engine. See `docs/subsystems/origami-import.md` and
`docs/subsystems/svg-import.md`.

Rules:

- Physics/math belongs here, not in views.
- Rendering belongs in `src/view/sim-canvas.ts`.
- CPU solver is the reference path.
- GPU solver is an acceleration path.
- Consumers outside `src/sim/` import only via `sim/index.js` (Node-safe) or
  `sim/gpu/index.js` (browser) — enforced by architecture-test rule R3.

## Styling

`src/styles.css`

- Global app layout.
- Panel styles.
- Header action styles.
- Viewer frame styles.
- 3D simulation modal styles.

Keep class names aligned with view components. Avoid adding layout-specific
styles inside TypeScript files.
