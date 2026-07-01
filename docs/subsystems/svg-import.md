# Subsystem: Origami Simulator SVG Import

The SVG importer is a 1:1 TypeScript port of the Origami Simulator
`pattern.js` SVG crease-pattern loader. It converts Origami Simulator-style SVG
crease patterns into FOLD/FKLD objects that the existing fold engine can
simulate.

## Purpose

This importer is the front half of the Origami Simulator compatibility path.
It lets the repo ingest crease-pattern SVGs using the same conventions as
Amanda Ghassaei's Origami Simulator assets, then hand the generated FOLD graph
to the normal `splitCuts` / triangulation / model assembly path.

The worked example is Miyamoto's RES Square Tower:

```text
public/examples/miyamotoTower.svg
  -> scripts/gen-res-tower.ts
  -> public/examples/res-square-tower.fkld
```

## Files

| File | Role |
| --- | --- |
| `src/sim/svg-import.ts` | DOM-free SVG parser and FOLD graph cleanup/topology port. |
| `scripts/gen-res-tower.ts` | Headless generator for the bundled RES Square Tower FKLD. |
| `scripts/check-lines-only.ts` | Diagnostic importer path for line-only comparison. |
| `public/examples/miyamotoTower.svg` | Source SVG asset. |
| `public/examples/res-square-tower.fkld` | Generated FOLD/FKLD example. |
| `tests/current/sim/svg-import.test.ts` | Importer behavior coverage. |
| `tests/current/sim/res-tower.test.ts` | RES Square Tower generated-example coverage. |

## SVG Conventions

Stroke color maps to assignment:

| Stroke | Assignment |
| --- | --- |
| black | `B` border |
| red | `M` mountain |
| blue | `V` valley |
| green | `C` cut |
| yellow | `F` triangulation |
| magenta | `U` hinge/unknown |

Stroke opacity maps to target fold angle for M/V edges:

```text
mountain theta = -opacity * pi
valley theta   =  opacity * pi
```

So opacity 0.5 means +/-90 degrees and opacity 1 means +/-180 degrees.

## Cleanup Pipeline

The importer follows the original Origami Simulator cleanup sequence:

1. collapse nearby vertices with `DEFAULT_VERT_TOL = 3`;
2. remove loop and duplicate edges;
3. find intersections;
4. repeat cleanup;
5. build vertex adjacency;
6. remove stray and redundant vertices;
7. sort adjacency counterclockwise;
8. derive faces;
9. remove border faces;
10. reverse face order.

## Supported SVG Elements

- `line`
- `rect`
- `polygon`
- `polyline`
- `path`

Path support is intentionally limited to crease-pattern primitives. Curves are
not real crease segments; endpoint fallback preserves graph connectivity when a
curve appears in source art.

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| Missing faces | Broken adjacency or border cleanup. | Compare against line-only import and check intersections. |
| Wrong fold direction | Stroke color/opacity mismatch. | Inspect normalized stroke and opacity in source SVG. |
| Too many duplicate vertices | Vertex tolerance too low for source coordinates. | Adjust import tolerance only with regression tests. |
| Generated FKLD changes unexpectedly | Importer or source SVG changed. | Regenerate through `scripts/gen-res-tower.ts` and update tests together. |
