# Subsystem: Scene Routing

Scene routing decides which model should be simulated or exported. It keeps
"what you see is what gets simulated/cut" consistent across viewer-driven and
shell-driven loads.

## Files

| File | Role |
| --- | --- |
| `src/services/sim-scene-service.ts` | Resolve 3D simulation scene. |
| `src/services/svg-export-service.ts` | Resolve SVG export payload. |
| `src/services/stl-export-service.ts` | Resolve printed-tile STL export payload. |
| `src/view/viewer-frame.ts` | Tracks `current()` displayed viewer model. |
| `src/model/app-store.ts` | Stores loaded model and `viewerShown`. |
| `src/controller/app-controller.ts` | Wires providers and enablement. |

## Policy

3D Sim, SVG export, and printed-tile STL export use:

```text
viewerShown first, otherwise loaded fold model
```

Reason: the iframe viewer can load examples/files independently from the shell.
The user expects downstream actions to target the visible pattern.

## Simulation Routing

```text
resolveSimScene(model, viewerShown, material)
  -> choose source
  -> buildScene(source.object, material)
  -> { scene, title } or null
```

The title includes:

- source name;
- sim backend class (`guided`/`free` context from scene builder);
- mode label.

## Export Routing

```text
resolveSvgExport(model, viewerShown)
  -> choose source
  -> buildFkldSvgExport(source.object, baseName)
  -> SvgExportPayload or null

resolveStlExport(model, viewerShown, heightUnits, maxSubdiv, inset)
  -> choose source
  -> buildStlExport(source.object, baseName, heightUnits, maxSubdiv, inset)
  -> StlExport or null
```

## Enablement

In `AppController.render`:

- Sim is enabled only if selected source can simulate.
- Export is enabled if selected source is any fold pattern.

## Failure Modes

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Sim disabled while viewer shows a pattern | `viewerShown` not updated or `canSimulate` false. | Viewer messages and `canSimulate`. |
| Sim folds previous model | `ViewerFrame.current()` stale. | `kirigamizer:viewer-loaded`. |
| Export disabled | No fold source or export payload returns null. | `resolveSvgExport`, `resolveStlExport`. |
| Export wrong name | `baseName` stripping or viewer name missing. | `svg-export-service`. |

## Extension Rules

- Add new downstream consumers as services with the same source-selection
  policy unless there is a documented reason to differ.
- Do not duplicate source-selection logic in modals.
- Keep providers pure: read state, call service, return payload.
