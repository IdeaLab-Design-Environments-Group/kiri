# Development

This repo is a Vite/TypeScript app with several active generation paths: the
general mesh Kirigamizer pipeline, AKDE pyramid creation, bistable star
tiling, pattern editing, and simulation.

For placement decisions, read these first:

- `docs/source-structure.md` for file ownership.
- `docs/import-boundaries.md` for dependency rules.
- `docs/subsystems/index.md` for subsystem-specific rules.
- `docs/pipeline.md` for mesh conversion stages.

## Commands

```sh
npm install
npm run dev
npm run build
npm run preview
```

`npm run build` runs `tsc --noEmit` and then `vite build`. Use it after changes
to imports, architecture, or simulation code.

## Node Version Note

The current machine may print an npm warning when run under Node 18.15.0:

```text
npm v11.2.0 does not support Node.js v18.15.0
```

The project still builds, but a Node version matching npm's supported range is
preferred for regular development.

## Adding Features

Use the MVC boundary when adding code:

- Add state or pure calculations under `src/model/`.
- Add DOM/WebGL UI under `src/view/`.
- Add app orchestration under `src/controller/`.
- Add mesh-to-kirigami conversion stages under `src/pipeline/`.
- Add standalone generation routes that do not consume the full M1-M5 chain
  under `src/pipeline/`, but document them as sibling routes. Current example:
  `src/pipeline/bst/`.
- Add folding physics or scene construction under `src/sim/`.
- Keep `src/main.ts` as a composition root.

Examples:

- New metadata row: update `src/model/fkld-metadata.ts`, then render through
  `MetadataPanel`.
- New file-derived fact: update `src/model/derive-facts.ts`.
- New button: add it to a view, expose an `on...` handler, and wire it in
  `AppController`.
- New simulation path: add a scene builder in `src/sim/`, then choose it from
  `src/sim/scene.ts`.
- New mesh conversion stage: define or extend DTOs in `src/pipeline/types.ts`,
  implement a pure stage under `src/pipeline/`, then wire it from the controller
  after tests exist.

## Testing Expectations

At minimum, run:

```sh
npm run build
```

For simulation changes, also test a small hinge or simple crease pattern before
testing complex FKLD files. The most useful first check is whether positive and
negative target fold angles settle to positive and negative measured theta.

For pipeline changes, test each stage with small meshes:

- one triangle;
- two triangles sharing one edge;
- an open disk with a boundary loop;
- a non-manifold edge that should fail;
- a negative-defect vertex that exercises the wedge rule.

## Generated Files

`dist/` is Vite output. Do not edit it by hand. Rebuild it with:

```sh
npm run build
```

`public/examples/` contains source examples served by Vite. Add examples there,
then rebuild if `dist/` needs to include them.
