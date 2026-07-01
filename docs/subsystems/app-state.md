# Subsystem: App State

The app state subsystem stores only UI coordination state: the loaded object,
status line, viewer source, and sim/export material settings.

## Files

| File | Role |
| --- | --- |
| `src/model/app-store.ts` | Observable store and state types. |
| `src/model/fold-file.ts` | Loaded model union types. |
| `src/model/derive-facts.ts` | View-ready facts derived from loaded model. |
| `src/controller/app-controller.ts` | Mutates store and subscribes to render state. |

## State Shape

```ts
interface AppState {
  model: LoadedModel | null;
  status: Status;
  viewerShown: { object: FoldFile; name: string } | null;
  simMaterial: "vinyl" | "printed";
  simDetail: number;
  simTileGap: number;
}
```

`LoadedModel` is either:

- `{ kind: "fold"; name; object }` for FOLD/FKLD/JSON;
- `{ kind: "mesh"; name; ext; text }` for OBJ/STL source text.

`Status` is:

- `msg`: user-facing message;
- `kind`: `"" | "ok" | "bad"`.

`viewerShown` is the model currently displayed by the FKLD viewer iframe. The
controller uses it before `model` for simulation and export so the active viewer
contents drive downstream workflows.

`simMaterial`, `simDetail`, and `simTileGap` mirror controls in the 3D Sim. STL
export reads the same values so printed-tile downloads match the preview.

## Store Contract

`AppStore` exposes:

- `getState()`;
- `model` getter;
- `update(partial)`;
- `setStatus(msg, kind)`;
- `subscribe(listener)`.

Subscriptions fire immediately with current state. This keeps view initialization
deterministic.

## Mutation Rules

- Only controllers should mutate `AppStore`.
- Views should not import `AppStore`.
- Presenters should accept data as arguments, not read the store.
- Simulation and pipeline code should never depend on app state.

## Render Derivation

`AppController.render(state)` is the only render path:

```text
AppState
  -> deriveFacts(...)
  -> summarizeFkldForDisplay(...)
  -> canSimulate(viewerShown ?? model)
  -> export enablement from viewerShown ?? model
  -> view render methods
```

The model layer prepares display data; views only write it to DOM.

## Adding State

Before adding state, check whether it can be derived from:

- `LoadedModel`;
- `ViewerFrame.current()`;
- existing FKLD metadata;
- pipeline result objects.

If durable state is necessary:

1. Add it to `AppState`.
2. Update initial state.
3. Update controller mutations.
4. Update render derivation.
5. Add tests for initial state, update behavior, and subscription behavior.

## Avoid

- Storing duplicate metadata summaries.
- Storing DOM nodes.
- Storing simulation model instances in `AppStore`.
- Storing SVG/STL export payloads; providers should build those on demand.
- Storing generated `dist/` paths.
