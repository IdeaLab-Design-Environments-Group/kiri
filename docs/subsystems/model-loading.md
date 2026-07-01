# Subsystem: Model Loading

Model loading turns files, samples, and raw text into `LoadedModel` values.

## Files

| File | Role |
| --- | --- |
| `src/services/model-loader.ts` | Parsing, FileReader wrapper, sample fetching, status text. |
| `src/model/fold-file.ts` | `FoldFile`, `LoadedModel`, `isFkld`. |
| `src/view/convert-panel.ts` | Emits chosen/dropped files. |
| `src/controller/app-controller.ts` | Applies loaded model to the store. |

## Supported Inputs

| Extension | Loaded model kind | Notes |
| --- | --- | --- |
| `.fold` | `fold` | JSON parsed as `FoldFile`. |
| `.fkld` | `fold` | JSON parsed as `FoldFile`; FKLD is FOLD plus extensions. |
| `.json` | `fold` | JSON parsed as `FoldFile`. |
| `.obj` | `mesh` | Raw text stored for pipeline conversion. |
| `.stl` | `mesh` | Raw text stored for pipeline conversion; ASCII expected downstream. |
| `.svg` | unsupported by app loader | SVG crease-pattern import currently exists as a headless/sim utility, not as a convert-panel input. See `svg-import.md`. |

Unsupported extensions produce `AppError("io", ...)`.

## Flow

```text
ConvertPanel file event
  -> AppController.loadFromFile(file)
  -> readModelFile(file, onLoaded, onError)
  -> parseLoaded(text, name)
  -> LoadedModel
  -> AppController.apply(model)
  -> AppStore.update({ model, status: loadedStatus(model) })
```

## Callback FileReader

`readModelFile` intentionally uses callback style rather than returning a
Promise. The tests and UI status sequencing rely on the callbacks firing in
the same event ordering as `FileReader` events.

Do not convert this to Promise style without updating controller tests and
documenting the sequencing change.

## Loaded Status

`loadedStatus(model)` is the single source for successful load messages:

- FOLD/FKLD: includes format and 3D Sim readiness.
- OBJ/STL: prompts user to press Kirigamize.

## Sample Loading

`fetchSample(url, name)` fetches a bundled sample and returns a fold model.
Network/fetch failures become `AppError("io", ...)`.

## Failure Policy

| Failure | Domain | Controller behavior |
| --- | --- | --- |
| Invalid JSON | `parse` | Clear model, bad status. |
| Unsupported extension | `io` | Keep model, bad status. |
| FileReader error | `io` | Keep model, bad status. |
| Sample fetch error | `io` | Keep model, neutral status in `loadSample`. |
