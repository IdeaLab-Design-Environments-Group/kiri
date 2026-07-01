# Subsystem: Core

`src/core/` is the dependency-free shared layer. It imports nothing.

## Files

| File | Role |
| --- | --- |
| `src/core/errors.ts` | Unified app error vocabulary. |
| `src/core/vec3.ts` | Dependency-free 3D vector math. |

## Rules

Core code:

- must not import any project layer;
- must not import Three.js;
- must not access DOM;
- must be usable from Node tests;
- should expose small primitives, not app workflows.

## Errors

`AppError` carries:

- `domain`: `"parse" | "pipeline" | "sim" | "io" | "create"`;
- `message`;
- optional `details`.

Helpers:

- `toAppError(err, fallbackDomain, prefix?)`;
- `statusFromError(err, fallbackDomain, prefix?)`.

Controller code uses `statusFromError` to turn failures into store status
messages without parsing strings.

Pipeline errors should extend or behave like app errors so stage failures keep
their domain/stage metadata.

## Vec3

`vec3.ts` exposes plain-object vector helpers:

- `vec3`;
- `clone`;
- `add`;
- `sub`;
- `scale`;
- `dot`;
- `cross`;
- `length`;
- `distance`;
- `normalize`.

Use these helpers in pipeline/sim code when Three.js is not required. This
keeps algorithms portable and testable.

## Adding Core Code

Only add a core module if:

- it has no dependency on app state;
- it has no dependency on browser APIs;
- multiple subsystems need it;
- it is stable enough to be shared.

If a helper is only used by the pipeline, keep it in `src/pipeline/`. If it is
only used by simulation, keep it in `src/sim/`.

