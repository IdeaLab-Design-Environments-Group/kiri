# Subsystem: SVG Export

SVG export produces cutter-friendly SVGs from the currently displayed FOLD/FKLD
flat pattern.

For the separate 3D-printable tile mesh export, see `stl-export.md`. For the
reverse path that imports Origami Simulator-style SVG crease patterns into
FOLD/FKLD, see `svg-import.md`.

## Files

| File | Role |
| --- | --- |
| `src/model/fkld-svg-export.ts` | Pure FKLD/FOLD to SVG/ZIP payload builder. |
| `src/services/svg-export-service.ts` | Resolves the target pattern. |
| `src/view/export-modal.ts` | Shared export modal UI, SVG previews, and SVG/STL downloads. |
| `src/controller/app-controller.ts` | Wires provider and enabled state. |
| `@kirigami/model/zip.js` | Dependency-free ZIP writer reused for bundled SVGs. |

## Export Policy

SVG export targets:

```text
viewerShown first, otherwise loaded fold model
```

This matches 3D Sim policy and keeps "what you see is what you cut".

## Layer Semantics

Cut layer:

- boundary `B`;
- cut `C`;
- black `#000000`.

Score layer:

- mountain `M`;
- valley `V`;
- blue `#0000ff`.

Ignored:

- facet `F` internal triangulation edges.

## Payload

`buildFkldSvgExport` returns:

- preview SVGs for cut, score, both;
- separate registered cut/score SVG files;
- combined color-coded SVG;
- ZIP archive containing the registered files.

Returns `null` when there is no cuttable/exportable geometry.

## Geometry Rules

- Reads flat `vertices_coords` as millimetres.
- Ignores z for SVG output.
- Flips Y for SVG coordinate space.
- Adds a margin around the viewBox.
- Uses non-scaling strokes for previews.
- Insets score lines from endpoints to avoid score/cut welds.

## Modal Behavior

`ExportModal`:

- lazy-pulls a fresh payload when opened;
- shows cut/score/both previews;
- downloads a ZIP for two-layer workflows;
- downloads a combined SVG for single-import workflows;
- disables downloads when no payload exists.

## Troubleshooting

If export is disabled:

1. Check that `viewerShown` or loaded model is a fold pattern.
2. Check `resolveSvgExport`.
3. Check `buildFkldSvgExport` did not return null.

If cut and score do not align:

1. Confirm both SVG files share the same viewBox.
2. Confirm the ZIP contains both files from the same payload.
3. Confirm the cutter app preserves SVG physical size in mm.

If boundary cuts look open:

1. Check boundary edges are 2-regular for loop assembly.
2. If not, export falls back to stroked cut paths.
3. Validate `edges_assignment` and `edges_vertices`.
