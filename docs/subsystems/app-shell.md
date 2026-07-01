# Subsystem: App Shell and Controller

The app shell coordinates the MVC application. It owns user intent flow, not
geometry or rendering algorithms.

## Files

| File | Role |
| --- | --- |
| `src/main.ts` | Composition root. Instantiates store, views, controller. |
| `src/controller/app-controller.ts` | Thin orchestration controller. |
| `src/model/app-store.ts` | Observable state container consumed by the controller. |
| `src/services/*` | Use-case logic called by the controller. |
| `src/view/header-actions.ts` | Header buttons: 3D Sim slot, Create pyramid, Load sample, Kirigamize. |
| `src/view/convert-panel.ts` | File dropzone, status, derived facts list. |

## Responsibilities

The app shell:

- wires all view callbacks;
- delegates file reads/parsing to `model-loader`;
- updates `AppStore`;
- routes already-foldable objects directly to the viewer;
- delegates mesh conversion and AKDE creation to `pattern-service`;
- provides the currently displayed viewer model to the simulation modal.

It does not:

- compute geometry;
- parse OBJ/STL itself;
- render Three.js;
- mutate FKLD extension arrays directly;
- run solver force math directly.

## Intent Flow

```text
HeaderActions / ConvertPanel
  -> AppController intent handler
  -> AppStore.update(...)
  -> AppController.render(state)
  -> ConvertPanel / MetadataPanel / HeaderActions / SimModal
```

## Current User Intents

| Intent | Source view | Controller method | Outcome |
| --- | --- | --- | --- |
| Choose/drop file | `ConvertPanel` | `loadFromFile` | Parse/load model or mesh text. |
| Create pyramid | `HeaderActions` | `createPyramid` | Generate AKDE FKLD and show it. |
| Load sample | `HeaderActions` | `loadSample` | Fetch bundled FKLD sample and show it. |
| Kirigamize | `HeaderActions` | `kirigamize` | Pass through FOLD/FKLD or convert mesh. |
| Open 3D Sim | `SimModal` | provider callback | Build scene from viewer/current model. |
| Export SVG | `ExportModal` | provider callback | Export viewer/current model cut/score SVG. |

## State Model

`AppStore` stores:

- `model`: loaded fold object or mesh text;
- `status`: message and severity.

The viewer also tracks a displayed model internally. This is intentional:
viewer-side loads can happen through the iframe itself, so 3D Sim uses
`ViewerFrame.current()` first and falls back to `AppStore.model`.

## Extension Points

Add a new app action by:

1. Adding a button/callback in a view.
2. Registering that callback in `AppController`.
3. Updating `AppStore` or downstream views from the controller.
4. Adding derived presenter output if the new state needs display rows.

Do not put new app actions in `src/main.ts`; keep that file as construction
only.

## Failure Modes

| Failure | Where handled | User-facing behavior |
| --- | --- | --- |
| JSON parse failure | `loadFromFile` | Status: parse error. |
| Unsupported extension | `loadFromFile` | Status: unsupported file type. |
| File read failure | `FileReader.onerror` | Status: could not read file. |
| Pipeline failure | `kirigamize` catch | Status: `<stage>: <message>`. |
| Sample fetch failure | `loadSample` catch | Non-fatal status message. |
