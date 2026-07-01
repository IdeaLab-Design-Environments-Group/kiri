# Simulation

The 3D Sim is a **1:1 TypeScript port of Amanda Ghassaei's Origami Simulator**
(Ghassaei, Demaine & Gershenfeld, *Fast, Interactive Origami Simulation using
GPU Computation*, 7OSME 2018, MIT-licensed). One uniform engine folds **any
origami or kirigami**; the mode is **inferred from the file**, not hardcoded.

## Pipeline

```
FOLD/FKLD ──▶ fold-ops.ts ──▶ origami-import.ts ──▶ FoldSolver ──▶ sim-canvas.ts
            (preprocess)      (assemble + infer)    (step)        (render)
```

For the file-level import contract, fold-angle priority, and material-mode
details, see `subsystems/origami-import.md`.

### 1. Preprocess — `src/sim/fold-ops.ts`

A faithful port of `js/pattern.js` from the original simulator:

- **`splitCuts`** — the kirigami mechanism. Every `"C"` (cut) edge is duplicated
  into two boundary edges and the shared vertices around each cut discontinuity
  are duplicated, so the two lips of a cut become **independent nodes that open
  into a gap** as the sheet folds. All FKLD cut subtypes (major / minor / seam /
  dart / eyelet) are encoded as `"C"` in `edges_assignment`, so this handles
  them uniformly. Vertex provenance (`originOf`) is tracked through the split so
  a declared folded-form can be mapped back onto the split mesh.
- **`triangulatePolys`** — triangles pass through; quads split on the shorter
  diagonal (OS-exact); n-gons fan. New diagonals become facet (`"F"`) creases.
- **`getFacesAndVerticesForEdges`** — extracts, per M/V/F crease, its two
  incident faces and their opposite "wing" vertices in a **winding-consistent
  order** (the reorder at `pattern.js:797`). This is what makes the measured
  dihedral sign reliable, so a plain forward fold folds the right way.

### 2. Assemble + infer mode — `src/sim/origami-import.ts`

Builds the struct-of-arrays `BarHingeModel` exactly as `js/model.js` `sync` +
`js/dynamicSolver.js` do: a Node per vertex (unit mass), a Beam per edge
(`k = EA/l₀`), a Crease per M/V/F edge (`k = creaseStiffness·l₀`,
`targetTheta = fold angle`, type 0 = facet driven flat), an interior-angle
spring per triangle. Geometry is centred and scaled to bounding-sphere radius 1.

**Target fold angles**: explicit `edges_foldAngles` (radians) → `edges_foldAngle`
(degrees) → assignment default (mountain −π, valley +π, facet 0). Mountains fold
to negative θ, valleys to positive (paper §2.3).

**Adaptive fold-mode inference** (`applyDeclaredGoal`):

- If the FKLD declares a **folded-form footprint** — a `foldedForm` frame +
  `fkld:vertices_driven` (the generator's statement of "this is the 3D shape I
  lift into and these boundary nodes hold it") — that minimal boundary is
  **driven** to its designed positions so the forward fold lands the intended
  shape. This is how a floppy kirigami (e.g. the AKDE pyramid, whose cone is
  *not* a free equilibrium) cones instead of splaying. It is **not**
  pyramid-specific: any kirigami that declares a footprint is guided to it.
- Otherwise the model is **free** and folds by crease targets alone — the
  paper's uniform method (origami, honeycomb kirigami, anything self-supporting).

Goal alignment is translation-only (matching driven-node centroids). Crease
targets are measured from the goal only where it is trustworthy (globally
isometric, or all four crease nodes driven), because a declared goal can be a
chimera (real positions for driven vertices, flat coords for the rest).

### 3. Solve — `src/sim/forces.ts` + `solver.ts`

`forces.ts` is the paper's force math verbatim (axial Eq 1; crease Eqs 2–6 via
the cotangent projection weights; face §2.4; explicit Euler Eqs 7–8; per-edge
viscous damping `c = 2ζ√(k·m)`). `FoldSolver.foldPercent` (0→1) scales every
crease's target dihedral — the standard fold-percent slider. `dt = 0.9/(2π·ω_max)`,
`ω_max = max √(k_axial/m_min)`. `src/sim/gpu/` packs the same model into textures
for the WebGL path.

### Constants (`js/globals.js`)

`EA = 20`, `k_fold = 0.7`, `k_facet = 0.7`, `k_face = EA/100 = 0.2`,
`ζ (percentDamping) = 0.85`, beam damping uploaded as `getD()·0.5`. These apply
**uniformly** to origami and kirigami (the bespoke AKDE overdamping is retired).

## Routing — `src/sim/scene.ts`

| File | Mode |
| --- | --- |
| Declares a folded-form footprint (hex, decagon presets) | **guided** (faithful split mesh driven to it) |
| Foldable FKLD pyramid preset, no footprint (legacy square export) | **guided** via `buildFoldScene` recompute fallback |
| Any other foldable origami / kirigami | **free** |
| Non-foldable but recoverable pyramid spec (`frame_title` only) | **guided** via `buildFoldScene` |

## Coordinate convention

The original embeds the flat sheet in the x-z plane (`[x,0,y]`). We embed it in
the **x-y plane (`[x,y,0]`)** so the fold lifts along **+z** — a pure axis
relabel (physically identical) that matches the z-up Three.js viewer and the
z-up authored `foldedForm` frames, keeping the translation-only goal alignment
valid.

## Practical debugging

- A fold goes the wrong way → check `edges_assignment` (M ⇒ negative target θ);
  the winding-consistent crease extraction makes the sign reliable.
- A kirigami won't open → confirm cut edges are `"C"` and `splitCuts` ran
  (model has more nodes than the flat pattern's vertex count).
- A kirigami splays instead of forming its 3D shape → it is floppy and needs a
  declared `foldedForm` + `fkld:vertices_driven` footprint; without one it
  free-folds to whatever stable state it finds.
- Blank / missing faces (holes showing the background) → preprocessing dropped
  faces. `removeRedundantVertices` must not merge **face-corner** vertices (only
  edge-splitting artifacts); a guard preserves thin molecule-dart slivers. Check
  `model.faces.count` equals the FKLD's triangular `faces_vertices.length`.
- Jitter → the free path uses rigid-body-motion removal + a kinetic-energy
  quench (`stabilize.ts`); the timestep must come from `computeDt`.
