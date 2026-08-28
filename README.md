# Kiri

*form and circuit together as one*

A TypeScript + Vite app that turns a 3D model into a cuttable kirigami pattern, then lets you lay
electronics on that pattern and route copper tape across it.

It is two halves sharing one artifact. The **kirigami half** takes a mesh and produces a cut-and-fold
pattern in FKLD (FOLD plus an `fkld:` namespace), verified by a bar-and-hinge folding simulation. The
**electronics half** treats that same flat pattern as a circuit board: place LEDs, a battery and library
parts on it, and copper tape is routed between them.

The two meet at exactly one place — the flat pattern's `vertices_coords`, in millimetres — so a routed
trace drops straight into the same SVG frame as the cut and score layers.

## Generation paths

- General mesh pipeline: `.obj` / ASCII `.stl` → condition → curvature and cut planning → unfold and
  pack → FKLD → sim verification
- AKDE pyramid creation
- Bistable star tiling surface programming
- A paintable pattern editor

FKLD/FOLD files flow straight into the viewer; mesh files are routed through the selected method.

## Running it

```sh
npm install
npm run dev       # Vite dev server
npm run build     # tsc --noEmit + vite build → dist/
npm run preview   # serve the production build
```

Drop a `.fold`/`.fkld` file (or click **Load sample**), then **Kirigamize ▶**. The electronics editor is
its own page at `#/electronics`.

Run `npx tsc --noEmit` unfiltered rather than narrowing it to `^src/` — the build typechecks tests too,
and a filtered run reports a clean typecheck and a broken build identically.

## Where things are

- `src/main.ts` — composition root
- `src/controller/` — the only layer that knows about both the store and the views
- `src/model/`, `src/pipeline/` — pure geometry and data; no DOM
- `src/view/` — DOM and SVG; owns no truth
- `src/sim/` — the bar-and-hinge folding solver, CPU and GPU paths
- `public/viewer/` — the dependency-free FKLD viewer, behind a `postMessage` bridge
- `public/examples/` — bundled `.fkld` / `.fold` samples
- `*_algorithms.tex` — the Origamizer / Kirigamizer algorithms the pipeline implements

Every source file names its layer on its first line, and
`tests/current/architecture/import-boundaries.test.ts` enforces the boundaries between them.

## Documentation

The project's knowledge base is an Obsidian vault at `~/Documents/ObsidianPT/traceform/wiki/`, entry
point `index.md`. Read the article for the area you are about to touch, then open only the files it
names; `working-agreements.md` records the traps that have already cost time here.
