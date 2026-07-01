# Import Boundaries

This document is the practical rulebook for keeping the code separated.

**Enforcement:** the rules below are mechanically checked by
`tests/current/architecture/import-boundaries.test.ts` — run
`npx vitest run tests/current/architecture` (also part of `npm test`).
The test is the executable spec; loosening a rule requires updating both the
test and this document in the same change.

## Allowed Direction

```text
main
  -> controller
       -> services
            -> {model, pipeline, sim, @kirigami, @fkld, core}
  -> view  (model types + sim barrels only)
core -> nothing
```

The actual dependency shape is:

```text
src/main.ts
  imports model + view + controller (composition root only)

src/controller/
  imports model + view + services + core errors
  thin: wiring + the single render(state) path — use-case logic lives in services

src/services/
  stateless use-case logic (model-loader, pattern-service, sim-scene-service)
  imports model + pipeline + sim barrel + @kirigami + @fkld + core
  never imports view/ or controller/

src/view/
  imports model types/presenter result types
  imports sim APIs only via the barrels (sim/index.js, sim/gpu/index.js)
  never imports services/ or controller/ — intents flow up via callbacks

src/model/
  imports no view/controller/services/pipeline/sim
  may import shared types and core only

src/pipeline/
  imports model FoldFile type where FKLD emission/verification needs it
  imports sim ONLY via sim/index.js (verification boundary)
  imports core (vec3, errors); no view/controller/services

src/sim/
  imports @kirigami/model geometry/types for AKDE scene construction
  imports core (vec3); no view/controller/services/pipeline

src/core/
  imports nothing from other layers (vec3 math, AppError vocabulary)
```

## Explicitly Forbidden

Do not add these imports:

| From | Forbidden import | Reason |
| --- | --- | --- |
| `src/model/*` | `src/view/*` | Model must stay DOM-free. |
| `src/model/*` | `src/controller/*` | Model should not know orchestration. |
| `src/pipeline/*` | `src/view/*` | Pipeline must stay node-safe and testable. |
| `src/pipeline/*` | `src/controller/*` | Controller calls pipeline, not reverse. |
| `src/sim/*` | `src/view/*` | Rendering belongs in view. |
| `src/main.ts` | stage internals | Main should only compose. |

## Boundary Exceptions

Some dependencies are intentional:

- `src/view/sim-canvas.ts` imports simulation solvers **via the barrels only**:
  Node-safe APIs from `src/sim/index.ts`, the GPU solver from
  `src/sim/gpu/index.ts` (the one sanctioned browser-only entry point).
- `src/pipeline/emit.ts` imports FKLD spec/validators via the `@fkld` alias
  (never `../../fkld/` relative paths).
- `src/pipeline/verify.ts` imports `buildSceneFromFold`/`measureTheta` from
  `src/sim/index.ts` because verification uses the same adapter as the UI.
- `src/sim/{build,scene,foldnet}.ts` import `KirigamiState`/`computeState` etc.
  from `@kirigami/model` for guided AKDE scene construction. `@kirigami/model`
  is the **single source of truth** for this geometry — the former
  `src/model/types.ts` and `src/model/geometry.ts` byte-identical copies were
  deleted and must not reappear (enforced by rule R5 of the architecture test).
- Shared dependency-free math lives in `src/core/` (e.g. `core/vec3.ts`);
  `src/sim/vec3.ts` is a compatibility re-export of it. `core/` imports
  nothing from other layers.

Document any new exception in this file **and** in the architecture test.

## Quick Audit Commands

The audit is automated — run:

```sh
npx vitest run tests/current/architecture
```

Rules enforced (R1–R9): three.js containment; @kirigami/@fkld alias-only
access; sim barrel-only access; core isolation; no geometry re-duplication;
services/view layering; the full layering matrix; and a transitive
**Node-safety walk** (the import closure of `sim/index.ts` and
`pipeline/index.ts` must never reach `three` — that is what keeps them
importable under plain-Node vitest).

Sanctioned exceptions:

- `src/view/sim-canvas.ts` may import `src/sim/gpu/index.js` (the browser-only
  GPU barrel) — it is the rendering layer.
- `src/services/model-loader.ts` uses `FileReader` — it performs file IO on
  behalf of the controller (callback-style by design; tests stub FileReader).
- `src/view/*` naturally uses DOM types; `src/sim/gpu/*` uses Three.js/WebGL.

## Barrel Files

Use barrel files only when they preserve boundaries:

- `src/sim/index.ts` exports simulation domain APIs.
- `src/pipeline/index.ts` exports node-safe pipeline APIs.

Do not create a root `src/index.ts` that re-exports every layer. That makes
forbidden imports too easy.

## Adding a New File

Before creating a file, answer:

1. Does it render DOM/WebGL? Put it in `src/view/`.
2. Does it coordinate user intents/state/view updates? Put it in
   `src/controller/`.
3. Does it store app state or derive display data from state? Put it in
   `src/model/`.
4. Does it convert mesh data toward FKLD? Put it in `src/pipeline/`.
5. Does it simulate folding or build simulation meshes? Put it in `src/sim/`.
6. Is it global styling? Put it in `src/styles.css`.

If a file seems to need two layers, split it. For example, a "load mesh" feature
usually needs:

- a view change for the button/status;
- a controller handler for FileReader and status updates;
- a pipeline function for mesh conversion;
- model presenter updates for derived facts.

