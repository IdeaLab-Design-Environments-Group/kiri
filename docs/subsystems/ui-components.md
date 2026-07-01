# Subsystem: UI Components

The UI component subsystem is the view layer: small classes that own DOM nodes,
render passed data, and emit callbacks.

## Files

| File | Component | Responsibility |
| --- | --- | --- |
| `src/view/dom.ts` | helpers | `el`, `heading`, `renderDefinitionList`. |
| `src/view/convert-panel.ts` | `ConvertPanel` | Dropzone, status, derived facts. |
| `src/view/header-actions.ts` | `HeaderActions` | Header buttons and callbacks. |
| `src/view/metadata-panel.ts` | `MetadataPanel` | FKLD metadata section rendering. |
| `src/view/viewer-frame.ts` | `ViewerFrame` | iframe bridge and current viewer model. |
| `src/view/pattern-editor-modal.ts` | `PatternEditorModal` | Interactive crease-grid editor, presets, use/download callbacks. |
| `src/view/sim-modal.ts` | `SimModal` | Modal shell, fold slider, lazy canvas loading. |
| `src/view/sim-canvas.ts` | `SimCanvas` | Three.js simulation scene rendering and printed-tile display. |

## View Rules

Views may:

- create and own DOM nodes;
- register DOM event listeners;
- expose callback registration methods;
- expose render/update methods;
- keep ephemeral UI-local state such as iframe readiness.

Views must not:

- parse files;
- call `FileReader`;
- mutate `AppStore`;
- directly call `kirigamizeText`;
- compute FKLD summaries;
- own domain objects longer than needed for rendering.

## Component Contracts

### ConvertPanel

Inputs:

- `renderFacts(rows)`;
- `setStatus(msg, kind)`.

Output intent:

- `onFileChosen(handler)`.

### HeaderActions

Output intents:

- `onCreatePyramid(handler)`;
- `onLoadSample(handler)`;
- `onKirigamize(handler)`.

State update:

- `setKirigamizeEnabled(enabled)`.

Button order:

```text
[3D Sim] [Create pyramid] [Load sample] [method] [Kirigamize ▶]
```

`3D Sim` is mounted by `SimModal`; the remaining buttons are appended by
`HeaderActions.appendActionButtons()`.

### MetadataPanel

Input:

- `render(sections)`.

`sections` must come from `src/model/fkld-metadata.ts`.

### ViewerFrame

Inputs:

- `show(object, name)`.

Output:

- `onLoaded(handler)`.

Read:

- `current()`.

### SimModal

Inputs:

- `setProvider(provider)`;
- `setEnabled(enabled)`.

Behavior:

- lazy-loads `SimCanvas`;
- rebuilds the scene on reset;
- forwards fold slider value.
- owns material/detail controls.

### SimCanvas

Inputs:

- `setScene(scene)`;
- `setFoldPercent(p)`;
- `start()`;
- `stop()`.

Behavior:

- chooses GPU/CPU where appropriate;
- renders faces and line overlays;
- owns orbit controls and Three.js resources.

## Testing

View tests should use DOM mocks and assert:

- elements are created in expected order;
- callbacks fire exactly once;
- disabled state changes;
- render methods replace prior contents;
- iframe messages update `ViewerFrame.current()`;
- modals stop the canvas on close.
