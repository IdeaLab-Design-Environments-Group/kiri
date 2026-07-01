# Repository Structure

This document explains the top-level folders and which ones are source,
generated output, legacy/reference code, tests, or documentation.

## Top-Level Map

```text
kirigamizer/
  README.md
  docs/
  src/
  public/
  fkld/
  kirigami/
  tests/
  theory/
  scripts/
  dist/
  node_modules/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  vitest.config.ts
```

## Ownership

| Path | Category | Edit? | Purpose |
| --- | --- | --- | --- |
| `README.md` | docs | yes | Entry point and short map. |
| `docs/` | docs | yes | Detailed architecture, pipeline, testing, and structure docs. |
| `src/` | active source | yes | Current Kirigamizer app, MVC shell, pipeline, simulator. |
| `public/` | served static assets | yes | Viewer iframe and example FOLD/FKLD files served by Vite. |
| `fkld/` | library/reference source | careful | CoffeeScript FKLD bridge/spec/validators reused by the TS app. |
| `kirigami/` | legacy/reference source | careful | AKDE-derived kirigami implementation and tests. |
| `tests/` | tests | yes | Vitest coverage for current, legacy, FKLD, and pipeline code. |
| `theory/` | notes/spec | yes | Algorithm plans and theoretical notes. |
| `scripts/` | build tooling | yes | Local Vite/CoffeeScript integration helpers. |
| `dist/` | generated | no manual edits | Production build output from `npm run build`. |
| `node_modules/` | generated dependency install | no | Installed npm packages. |
| `index.html` | app entry | yes | Vite HTML shell. |
| `package.json` | config | yes | npm scripts and dependencies. |
| `tsconfig.json` | config | yes | TypeScript project boundaries and aliases. |
| `vite.config.ts` | config | yes | Vite build/dev config. |
| `vitest.config.ts` | config | yes | Vitest config. |

## Active Source vs Reference Source

Active app code lives in `src/`.

Reference/compatibility code lives in:

- `fkld/`: FKLD bridge, spec keys, cut-type and molecule validators.
- `kirigami/`: older AKDE-style MVC and geometry/simulation implementation.

Do not casually move code from `fkld/` or `kirigami/` into `src/`. Prefer
small imports through stable public APIs, then document the dependency.

## Generated Files

Generated paths:

- `dist/`
- `node_modules/`
- `node_modules/.vite/`

Do not edit generated files by hand. Recreate them with:

```sh
npm install
npm run build
```

## Public Assets

`public/` is copied into `dist/` by Vite.

| Path | Purpose |
| --- | --- |
| `public/viewer/index.html` | iframe viewer shown by `ViewerFrame`. |
| `public/examples/*.fkld` | bundled sample files for Load Sample / local demos. |

If an example changes, edit `public/examples/`, not `dist/examples/`.

## Tests

`tsconfig.json` includes tests, so TypeScript errors under `tests/` can break
`npm run build`.

Main test areas:

- `tests/current/`: current app/pipeline/sim behavior.
- `tests/fkld/`: FKLD bridge/spec validators.
- top-level `tests/*.test.ts`: legacy/current geometry, sim, export coverage.

## Documentation Placement

Use separate docs rather than one large document:

- Repo/file layout: `docs/repository-structure.md`
- Source code layout: `docs/source-structure.md`
- Import rules: `docs/import-boundaries.md`
- MVC overview: `docs/architecture.md`
- Pipeline details: `docs/pipeline.md`
- Simulation details: `docs/simulation.md`
- Testing/troubleshooting: `docs/testing.md`
- Developer workflow: `docs/development.md`

