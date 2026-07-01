# Subsystem: Test Suite

The test suite covers current app code, pipeline stages, simulation logic, FKLD
validators, and legacy AKDE utilities.

## Files

| Path | Role |
| --- | --- |
| `tests/current/model/` | Current model/store/presenter tests. |
| `tests/current/view/` | View component tests with DOM mocks. |
| `tests/current/controller/` | Controller intent and state-flow tests. |
| `tests/current/pipeline/` | Mesh-to-FKLD stage tests. |
| `tests/current/sim/` | CPU/GPU simulation tests. |
| `tests/current/fkld/` | FKLD bridge/spec/validator tests. |
| `tests/current/architecture/` | Import-boundary architecture tests. |
| top-level `tests/*.test.ts` | Legacy/current compatibility tests. |

## Build Interaction

`tsconfig.json` includes `tests/**/*`, so TypeScript errors in tests fail:

```sh
npm run build
```

This is intentional: tests are part of the typechecked codebase.

## View Test Pattern

View tests generally:

1. install a mock DOM;
2. instantiate the view;
3. call render/update methods;
4. trigger callbacks;
5. assert DOM state or callback calls.

Use typed `Array.from(element.children)` when indexing children; TypeScript
types `children` as `HTMLCollection`.

## Pipeline Test Pattern

Pipeline tests should use minimal meshes:

- one triangle;
- two triangles sharing one edge;
- open disk;
- closed tetrahedron;
- non-manifold edge;
- bowtie vertex;
- negative defect requiring wedge splitting.

Keep fixtures small enough to inspect by eye.

## Simulation Test Pattern

Simulation tests should first isolate:

- vector helpers;
- model assembly;
- force signs;
- solver stepping;
- stabilization;
- adapter scene construction;
- GPU packing/shader contracts.

Only then use larger guided examples.

## Architecture Tests

Architecture tests should enforce:

- model cannot import view/controller;
- pipeline cannot import view/controller;
- sim cannot import view;
- main remains a composition root.

If a boundary exception is legitimate, document it in
`docs/import-boundaries.md` before changing the test.

