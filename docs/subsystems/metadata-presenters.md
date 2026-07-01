# Subsystem: Metadata and Presenters

Presenter modules turn model data into simple view-ready rows and sections.
They are pure and DOM-free.

## Files

| File | Role |
| --- | --- |
| `src/model/derive-facts.ts` | Loaded model to Convert panel Derived rows. |
| `src/model/fkld-metadata.ts` | FOLD/FKLD object to metadata sections. |
| `src/model/fold-file.ts` | Minimal FOLD/FKLD type and `isFkld`. |
| `src/view/convert-panel.ts` | Renders Derived rows. |
| `src/view/metadata-panel.ts` | Renders metadata sections. |

## Presenter Outputs

`deriveFacts(model)` returns:

```ts
[string, string][]
```

`summarizeFkldForDisplay(fkld)` returns:

```ts
SummarySection[]
```

Views should receive these already-shaped structures and only render them.

## Derived Facts

For FOLD/FKLD models:

- file name;
- format;
- vertex count;
- face count;
- edge count;
- unit.

For mesh models:

- file name;
- mesh type;
- line count.

## FKLD Metadata Sections

Current sections:

- file header;
- topology;
- `edges_assignment`;
- `fkld:edges_cutType`;
- molecules;
- `fkld:meta_architecture`.

## Adding Metadata

When adding a new FKLD extension:

1. Add or confirm the key in `fkld/spec.coffee`.
2. Add type-safe reading in `src/model/fkld-metadata.ts`.
3. Return a `SummarySection`.
4. Keep formatting helpers in the presenter, not the view.
5. Add tests for missing, malformed, and populated values.

## Boundary Rules

- Presenters may inspect arbitrary `fkld:*` keys.
- Presenters must not access DOM.
- Presenters must not call `postMessage`.
- Presenters must not mutate the input object.
- Views must not compute domain summaries directly.

## Failure Behavior

Presenter functions should degrade gracefully:

- missing arrays become zero counts or "Not present";
- missing scalar values become `—`;
- unsupported nested metadata is flattened or stringified;
- malformed optional extension arrays should not crash the app unless a stage
  requires validation.

