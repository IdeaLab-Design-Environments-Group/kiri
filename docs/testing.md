# Testing and Troubleshooting

This project has two validation levels:

- Type/build validation with `npm run build`.
- Unit tests through Vitest when a test command is available or invoked
  directly.

## Build Check

Run:

```sh
npm run build
```

This runs TypeScript checking and a production Vite build. In this repo,
`tsconfig.json` includes `src/`, `kirigami/`, `fkld/`, `scripts/`, and `tests/`,
so TypeScript failures in tests can block the build even if runtime source
compiles.

## Node Warning

If npm reports:

```text
npm v11.2.0 does not support Node.js v18.15.0
```

the build can still pass, but use a supported Node version for regular
development to avoid package-manager edge cases.

## MVC Checks

Before finishing a change, verify:

- `src/main.ts` only constructs and wires objects.
- Views emit callbacks and render data; they do not parse files or mutate
  `AppStore`.
- `AppController` is the only place that connects views to the store.
- Model/presenter files have no DOM access.
- Simulation domain files do not import from `src/view/`.
- Pipeline files do not import DOM, controller, or view modules.

Useful checks:

```sh
rg "document|window|HTMLElement|FileReader" src/model src/pipeline src/sim
rg "../view|./view" src/model src/pipeline src/sim
```

Some simulation GPU files legitimately import Three.js infrastructure. DOM
imports should still stay out of `src/sim/`.

See `docs/import-boundaries.md` for the full dependency rulebook.

## Simulation Checks

For fold-direction bugs:

- Confirm `edges_assignment` signs at the file boundary.
- Confirm `edges_foldAngle` degrees are converted to radians.
- Confirm crease edge orientation follows face winding.
- Test a two-triangle hinge before a full mesh.

For instability:

- Confirm cut edges are not hinge creases.
- Confirm `computeDt` is used.
- Confirm fixed/driven nodes are intentional.
- Compare guided mode versus free mode; free patterns need more damping.

For GPU/CPU differences:

- Check whether the scene is guided. GPU is preferred for guided scenes.
- CPU is the reference path for logic debugging.
- If GPU output diverges, inspect packed texture data in `src/sim/gpu/pack.ts`
  before changing shader math.

## Pipeline Checks

For import failures:

- OBJ indices are 1-based; negative indices are relative.
- STL must be ASCII.
- STL imports require welding because STL is triangle soup.

For topology failures:

- Edge with more than two faces means non-manifold input.
- A duplicated directed edge usually means inconsistent winding.
- A vertex fan covering only part of incident faces means a bowtie vertex.

For curvature/cut planning failures:

- Boundary vertices intentionally report class `boundary`.
- Positive and negative defects are handled differently.
- Negative curvature requires the wedge rule; a single slit is often
  insufficient.
- Cut sets should stay forests unless the algorithm explicitly changes that
  invariant.

## Documentation Checks

When adding or moving major code:

- Update `README.md` if the top-level file map changes.
- Update `docs/architecture.md` if layer boundaries change.
- Update `docs/pipeline.md` for conversion-stage changes.
- Update `docs/simulation.md` for solver or scene-building changes.
- Update `docs/development.md` if commands or workflow expectations change.
