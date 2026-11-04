# Setup

How to run Traceform locally, build it, regenerate the footprint library and deploy the site. Everything runs in Node, except the footprint generator, which is OCaml.

## Requirements

- Node 20 (the version CI uses) and npm.
- Optional: an OCaml toolchain (`ocamlfind`/`ocamlopt`), only if you regenerate footprints. The generated TypeScript is committed, so normal development does not need OCaml.

## Commands

All commands are defined in `package.json`:

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload; opens the browser |
| `npm run build` | `tsc --noEmit && vite build` into `dist/`. A type error fails the build |
| `npm run preview` | Serve the built `dist/` |
| `npm test` | Full vitest run. Slow (10+ minutes); see [Testing](testing.md) |
| `npm run test:model`, `test:sim`, `test:pipeline`, … | One area of `tests/current/`, the usual inner loop |
| `npm run test:architecture` | Layering and module-health rules; fast, run it before every commit |
| `npm run footprints` | `sh ocaml/build.sh`, which compiles the OCaml generator and regenerates `src/model/footprints.generated.ts` and `footprints.rest.generated.ts` from `footprints/fab/*.kicad_mod` |
| `npm run examples -- <meshes>` | Kirigamize `.stl` files into `public/examples/<slug>.fkld` and draw their folded and flat preview SVGs into `public/examples/previews/` (`scripts/gen-example-previews.ts`) |

## Repository layout

```text
src/
  main.ts          composition root: builds store, views, controller
  core/            dependency-free primitives (errors, vec3); imports nothing
  model/           pure data + geometry: app store, electronics, routing, exports
  pipeline/        mesh → kirigami pattern (and bst/ for bistable star tilings)
  sim/             bar-and-hinge folding simulation (gpu/ holds the three.js solver)
  services/        use-case logic at the edges, pure over inputs
  controller/      AppController: the only module that sees store and views
  view/            DOM / SVG / three.js; renders state, emits intents
kirigami/          AKDE pyramid creation pipeline, reached via the @kirigami alias
ocaml/             KiCad footprint parser + TypeScript generator
footprints/fab/    KiCad FabLib .kicad_mod sources
public/            static assets: FKLD viewer, examples, tutorial videos
scripts/           one-off generators and debugging scripts (gen-*.mjs/ts, _*.ts)
tests/current/     vitest suite, mirroring src/
```

## Path aliases

`@kirigami/*` resolves to `kirigami/*`. It is declared three times, and the three must agree: in `tsconfig.json` (`paths`), in `vite.config.ts` and in `vitest.config.ts` (`resolve.alias`). The FKLD format library is the npm package `@dayangac/fkld`; it used to be vendored in the repo and no longer is (see the comment in `vite.config.ts`).

## Deployment

`.github/workflows/pages.yml` builds on every push to `main` and publishes `dist/` to GitHub Pages.

!!! note "Why the site is the build output, not the source tree"
    From the workflow's own header: `index.html` requests `/src/main.ts`, which is TypeScript. A static host answers with its 404 page, the browser receives `text/html` where it expected a module, and `X-Content-Type-Options: nosniff` makes it refuse to run. So the site must be the built `dist/`. `vite.config.ts` sets `base: "./"`, so the bundle works under a project path such as `/Kiri/` without knowing the repo name. Override it with `VITE_BASE`.

`dist/` and `node_modules/` are git-ignored. Both were tracked until commit `800107b`, which is how iCloud "`name 2.ext`" conflict copies got into the repository.

## Building these docs

```sh
pip install mkdocs-material
mkdocs serve        # live preview at http://127.0.0.1:8000
mkdocs build --strict
```
