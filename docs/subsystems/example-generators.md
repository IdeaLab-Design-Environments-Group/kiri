# Subsystem: Example Generators

Example generators create reproducible public assets under
`public/examples/`. They are source code for examples, not runtime app code.
Keep generated assets deterministic so tests, screenshots, and documentation can
refer to stable names.

## Files

| File | Output | Purpose |
| --- | --- | --- |
| `scripts/gen-sample-stl.mjs` | `sample-cube.stl`, `sample-tetrahedron.stl`, `sample-octahedron.stl`, `sample-hex-pyramid.stl`, `dome-quarter.stl` | Small ASCII STL fixtures for mesh import and general kirigamize tests. |
| `scripts/gen-lamp-dome.mjs` | `lamp-dome.stl` | Antiprism-style lamp dome mesh example. |
| `scripts/gen-bistable-star-tiling.mjs` | `bistable-star-tiling.fkld` | Bistable star tiling FKLD example. |
| `scripts/gen-res-tower.ts` | `res-square-tower.fkld`, `res-square-tower-erect.fkld` | Converts Miyamoto RES Tower SVG into FOLD/FKLD examples. |
| `scripts/probe-house-door.ts` | Console report only. | Probe script for `house-door.stl` pipeline behavior. |

## Execution

There are no package scripts for these generators. Run them directly when their
outputs need to be refreshed:

```sh
node scripts/gen-sample-stl.mjs
node scripts/gen-lamp-dome.mjs
node scripts/gen-bistable-star-tiling.mjs
npx tsx scripts/gen-res-tower.ts
npx tsx scripts/probe-house-door.ts
```

The TypeScript scripts require a TS runner such as `tsx`; the repo does not
declare that as a dependency. If a runner is not installed, either add a project
script/dependency deliberately or run through the existing local environment.

## Output Policy

- Edit generator parameters in `scripts/`, not the generated example by hand.
- Write generated public assets to `public/examples/`.
- `scripts/gen-sample-stl.mjs` also tries to mirror outputs into
  `dist/examples/` when `dist/` exists; treat that as a convenience only.
- `dist/` is still generated output. The durable source of truth is
  `public/examples/` plus the generator script.

## Mesh Generator Rules

For STL-producing scripts:

- emit ASCII STL, not binary STL;
- keep face winding consistent enough for `parseMesh(..., "stl")`;
- keep examples small enough for pipeline and sim tests;
- name solids and output files consistently;
- document any non-obvious shape parameter in the script.

`gen-sample-stl.mjs` currently covers closed manifold targets (cube,
tetrahedron, octahedron, hex pyramid) plus an open quarter dome shell. The
closed meshes are canonical stress cases for curvature/cut planning; the dome
is a smoother shell example.

## FKLD Generator Rules

For FKLD-producing scripts:

- include `file_creator` and source/provenance metadata where possible;
- keep `vertices_coords`, `edges_vertices`, `faces_vertices`, and
  `edges_assignment` length-compatible;
- include FKLD extension arrays only when their lengths match `edges_vertices`
  or `vertices_coords` as appropriate;
- include `foldedForm` frames and `fkld:vertices_driven` when guided simulation
  depends on a declared 3D target.

`gen-res-tower.ts` validates its outputs by building a sim scene and checking
basic flat/erect behavior. Keep that validation close to the generator so the
example does not silently drift away from the simulator.

## Adding a New Generator

1. Put the script under `scripts/`.
2. Make output filenames deterministic.
3. Add or update tests if the asset exercises a new pipeline behavior.
4. Document the script in this file and in `static-assets-and-examples.md`.
5. Regenerate only the intended files.
6. Run `git diff --check -- scripts public docs` before committing.

## Failure Modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Mesh import fails | Binary STL, malformed facets, or inconsistent face data. | Re-emit ASCII STL and check facet/vertex records. |
| Pipeline result changes unexpectedly | Generator parameters changed without documentation. | Record the parameter change and update affected tests/docs. |
| RES Tower no longer erects | SVG import cleanup or driven flags changed. | Re-run `gen-res-tower.ts` validation and inspect `svg-import.md`. |
| Public and dist examples differ | Generator mirrored into `dist/` but build was not rerun. | Treat `public/examples/` as source and rebuild when needed. |

