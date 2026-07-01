# Subsystem: Printed Tile STL Export

Printed tile STL export turns the currently displayed FOLD/FKLD flat pattern
into the **printed-kirigami tiles** — the same pinched hexagons the 3D Sim shows
(rotating units). It is the mechanical counterpart to SVG cut/score export.

## Purpose

The export path produces an ASCII STL whose tiles match the 3D-Sim render exactly.
Each triangular face becomes a hexagonal tile `[A, mAB, B, mBC, C, mCA]` extruded
to a closed prism. The three **corners stay full** — neighbouring tiles meet there
(the pinpoint pivots). Every edge that is **not an outer boundary** (interior
fold/facet edges *and* `C` cuts) has its midpoint **pinched inward** by
`gap·inradius·2`, opening the diamond between tiles; boundary edges stay straight.

The tile geometry lives in `src/model/printed-joinery.ts` (`buildFoldableJoinery`),
matched to the sim's `updatePrintedTiles`, so the rule holds:

```text
what you see as printed tiles is what you export as STL
```

## Files

| File | Role |
| --- | --- |
| `src/model/stl-export.ts` | Pure FOLD/FKLD to ASCII-STL tile export. |
| `src/model/printed-joinery.ts` | Connected-joinery tile geometry, shared with the sim render + generator. |
| `src/model/tile-subdiv.ts` | Shared tile-gap constant (`TILE_INSET_FRAC`); subdivision unused by the export. |
| `src/model/stl-ascii.ts` | Shared low-level ASCII-STL box/triangle helpers. |
| `src/services/stl-export-service.ts` | Resolves the export target. |
| `src/view/export-modal.ts` | Tile-height/detail controls and STL download UI. |
| `src/view/sim-modal.ts` | Owns the live printed-tile detail state. |
| `src/view/sim-canvas.ts` | Uses the same tile subdivision/inset values for rendering. |

## Export Policy

STL export targets:

```text
viewerShown first, otherwise loaded fold model
```

This matches 3D Sim and SVG export: export the pattern currently shown in the
viewer when it differs from the file sitting in the convert panel.

## Edge Classification

`buildStlExport` reads `edges_assignment` and counts how many faces share each
edge, then classifies every face edge (`edgeRole` in `printed-joinery.ts`):

1. assignment `C` → **cut** (midpoint pinched → the diamond opening);
2. else shared by one face → **boundary** (incl. `B` — midpoint stays straight);
3. else (`M`/`V`/`F`, shared by two faces) → **merge** (interior — also pinched).

So every non-boundary edge pinches (interior folds *and* cuts), exactly as the
sim. There is no adaptive subdivision; the `Detail` control is inert
(`maxSubdiv = 0`).

## Geometry Contract

- Input coordinates are flat `vertices_coords`; z is read if present but the
  normal case is z = 0, extruded +height.
- N-gon faces fan-triangulate; the inner fan edges are interior → pinched.
- Each face becomes a hexagonal prism `[A, mAB, B, mBC, C, mCA]`; corners full.
- Non-boundary edge midpoints pinch inward by `gap·inradius·2` (the sim formula).
- Each tile is a closed prism; adjacent tiles share full corners (pivots), so the
  mesh is non-manifold only at those pivots — the rotating-units nature.
- The export is ASCII STL. Returns `null` when the fold has no faces/coords.

## Controls

| Control | Meaning |
| --- | --- |
| Tile height | Extrusion height in model units. Null or <= 0 uses a bbox-relative default. |
| Detail | Inert for the connected joinery (no subdivision); kept for API compatibility. |
| Gap/inset | Pinch depth — each non-boundary edge midpoint pulls in by `gap·inradius·2`, shared with the printed sim. |

## Failure Modes

| Failure | Cause | Fix |
| --- | --- | --- |
| STL export disabled | No viewer-shown or loaded fold model. | Load/show a FOLD/FKLD pattern first. |
| Export returns null | Pattern lacks faces or vertices. | Validate the source FKLD/FOLD. |
| Cuts do not open / no gaps | Source FKLD has no `C` edges (or missing `edges_assignment`). | Kirigamize so cut edges are assigned `C`. |
| Export does not match sim | Sim and export used a different Gap. | Use the same Gap slider value; both read `simTileGap`. |
