# Subsystem: Error Handling

Error handling is centralized around domain-tagged errors so the controller can
decide how to update the UI without parsing message strings.

## Files

| File | Role |
| --- | --- |
| `src/core/errors.ts` | `AppError`, `toAppError`, `statusFromError`. |
| `src/pipeline/types.ts` | `PipelineError`, stage-tagged pipeline failures. |
| `src/services/model-loader.ts` | Throws parse/io `AppError`s. |
| `src/services/pattern-service.ts` | Throws/passes creation and pipeline errors. |
| `src/controller/app-controller.ts` | Converts errors into store status updates. |

## Error Domains

`AppError.domain` values:

| Domain | Meaning | Typical UI behavior |
| --- | --- | --- |
| `parse` | User file text could not be parsed. | Clear loaded model and show bad status. |
| `io` | Unsupported type, unreadable file, fetch failure. | Keep model, show bad/neutral status. |
| `pipeline` | Mesh-to-FKLD conversion failed. | Keep mesh, show stage-prefixed bad status. |
| `sim` | Simulation scene/solver failure. | Disable/stop sim or show modal status. |
| `create` | Parametric AKDE creation failed. | Show bad status. |

## Pipeline Stages

`PipelineError.stage` values identify where conversion failed:

- `import`
- `conditioning`
- `mesh`
- `curvature`
- `plan-cuts`
- `unfold`
- `route-seams`
- `emit`
- `verify`

The message format is:

```text
<stage>: <message>
```

## Controller Policy

`AppController` handles errors as follows:

- `readModelFile` parse error: `model: null`, bad status.
- `readModelFile` IO error: status only.
- `kirigamizeMesh` failure: bad status from `statusFromError`.
- `createAkdePyramid` failure: bad status from `statusFromError`.
- `loadSample` failure: neutral status because the viewer can still show its
  default content.

## Adding Errors

When adding a failure path:

1. Use `AppError` if it belongs to app/service/core logic.
2. Use `PipelineError` if it belongs to a pipeline stage.
3. Preserve the original error in `details` where useful.
4. Convert to status only at the controller boundary.
5. Add tests that assert domain/stage, not only string text.

## Avoid

- Throwing bare strings.
- Matching status behavior by substring.
- Creating view-specific error types.
- Catching and swallowing pipeline failures without surfacing the stage.

