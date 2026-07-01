# Kirigamizer — build plan (general cut + fold for any surface)

**Status:** **M0–M5 complete; PROPER-KIRIGAMI rework (K1–K5) complete (2026-06-10).
Cut-placement improvements complete (2026-06-10): vis routing, hybrid strategy,
leaf pruning.**
The general model→pattern pipeline lives under `src/pipeline/` and is wired into
`AppController.kirigamize()`: OBJ/ASCII-STL → condition → angle defects → MST cut
forest (≤1 boundary attachment, no boundary transit) → seamed unfold with **vents**
(relief loop, single-sheet hard gate) → place + classify (sheetRect, vent/dart/seam
subtypes) → FKLD emit (goalPos frame + driven flags + sheet meta) →
**fold-from-flat verification**. M6 (fabrication export, STEP) remains deferred.

## Cut-placement improvements (2026-06-10)

Three improvements to `src/pipeline/plan-cuts.ts` (all backwards-compatible; λ=0
+ strategy="dart" + leafPruning=false reproduce original behaviour exactly):

- **vis(e) routing** (`PlanOptions.lambda`): edge weights are now
  `w(e) = len(e) + λ·vis(e)`, `vis(e) = 1 − |θ_e|/π`. With λ>0, cuts prefer
  high-dihedral (fold/ridge) edges. `cost.visibility` records the accumulated
  visibility component of the selected cut set.
- **Hybrid dart-vs-tuck** (`strategy: "hybrid"`): per-vertex cost comparison —
  `dartCost = boundarySol.dist[v]` (weighted path to boundary) vs.
  `tuckCost = tuckCostScale·δ(v)·r̄(v)` (molecule-size proxy). Chooses dart iff
  path is shorter than the tuck molecule. Closed meshes (no boundary) fall back
  to dart. Uses the pre-computed `boundarySol` (already needed for the MST step).
- **Leaf pruning** (`leafPruning: true`, `leafPruneDeltaMax`): post-MST pass
  iteratively demotes degree-1 dart leaves with δ < maxDelta to tuck, dropping
  their branch. Reduces total cut length on nearly-flat vertex-tips. Off by default
  (δ>0 tuck crease generation is still deferred in M6).

## Proper-kirigami semantics (K1–K5)

**The 2π invariant.** A flat sheet carries exactly 2π of material at every interior
point. The pattern is ONE connected piece (hard-gated in `seamedUnfold`); every
defect vertex gets a wedge **cutout** of angle |δ|:
- **δ>0 (dart):** the cutout lies BETWEEN Q-faces — the dart gap closes when folded;
  coverage is complete.
- **δ<0 (vent):** a sliver of Q-coverage is removed from a face adjacent to the slit
  (live-geometry walk, dynamic target = current excess over 2π, candidate placements
  with rollback + connectivity trial), so the slit is ZERO-WIDTH in the flat pattern
  and opens into a small uncovered hole when folded — the algorithm spec's
  "open slit / deliberate hole". Synthesized split vertices carry `origVertex = −1`
  and on-Q `goalPos`.

**Verification (K4).** Primary gate = **fold-from-flat**, two phases:
(A) kinematic transport — all vertices driven rest→goal under the fp ease, with a
**tensile path-strain audit** sampled at fp = 0.25/0.5/0.75 (a consistent pattern
never lengthens a bar along the linear path; chord shortening is geometric and
tolerated); (B) **release-and-settle** — non-boundary vertices freed at fp = 1,
the structure must hold (locked-in strain / drift / crease residual catch wrong
patterns). d_H is Kabsch-aligned (no reflection — mirror folds fail) and
**vent-aware**: declared coverage holes are excluded from the Q→folded direction
only. The equilibrium mode (start at goal, relax) is reported as a secondary
metric, never sufficient alone. Verification runs at a rescaled ~unit sim span:
the explicit Δt bound (paper Eqs 7–8) assumes k_axial ≫ k_crease, which large
normalization spans violate.

**Documented limitation (future work).** A fully FREE crease-driven fold (no
driving at all) is not traversable by the explicit bar-and-hinge integrator on
multi-crease patterns — it explodes at large scales, freezes under the kinetic
quench, and orbits under viscous damping — even though the folded state is a
perfect free equilibrium (verified: residual exactly 0). True free-path folding
needs collision handling / implicit integration.

**Authority:** `kirigamizer_algorithms.tex` (Emre Dayangac) — the algorithm
proposal; `origamizer_algorithms.tex` — the reused Origamizer stages. AKDE is the
v1 special case (uniform-molecule pyramid). Building blocks: Demaine & Tachi,
*Origamizer* (SoCG 2017); Ghassaei, Demaine, Gershenfeld, GPU origami simulation
(7OSME 2018); Liu, Chuang, Sang, Sabin, *Programmable Kirigami* (DETC2019-97557).

**Last updated:** 2026-06-09.

---

## 1. Goal and non-goal

**Goal.** Given a 3D target surface, emit a flat sheet with **cuts + folds** that
folds into it, fabrication-ready (FKLD + SVG/DXF), verified by the bar-and-hinge
simulator. The defining move: a fold preserves $2\pi$ at every interior point, so
origami can only *subtract* angle (tuck convex surplus) and fails at negative
curvature; a **cut** lifts that, realizing both curvature signs exactly and
locally. Origamizer is the special case $\mathcal{C}=\varnothing$; the AKDE
uniform pyramid is the special case "one positive-curvature apex, uniform
molecules."

**Non-goal (for now).** A general computational-origami research tool. Every
stage earns its place on the path target surface → cut plan → flat pattern →
simulation → fabrication.

---

## 2. What already exists in this repo

| Area | Where | State |
|------|-------|-------|
| **Shell (MVC)** | `src/model`, `src/view`, `src/controller`, `src/main.ts` | ✅ three-column UI: Convert · FKLD metadata · viewer; header actions |
| **Creation (uniform pyramid)** | `kirigami/model/` (`geometry`, `pattern`, `constraints`, `svg-export`, `zip`, `fkld-export`, `validation`) | ✅ transferred from AKDE; **167 AKDE tests pass here** |
| **FKLD format** | `fkld/` (`spec`, `bridge`, `io`, `molecule`, `cut-types` — CoffeeScript) + `src/model/fkld-metadata.ts` | ✅ FOLD 1.2 superset; read + write + validate |
| **Simulation** | `src/sim/` (CPU core = AKDE-exact) + `src/sim/gpu/` + `src/view/sim-canvas.ts` | ✅ **fixed**: guided pyramid folds AKDE-faithfully; generic FKLD free-fold via `cutRatio` |
| **Viewer** | `public/viewer/` (+ `postMessage` bridge in `src/view/viewer-frame.ts`) | ✅ renders any FOLD/FKLD |
| **Examples** | `public/examples/` (`akde-hex`, `akde-square-pyramid`, `akde-circular`, `fold-upstream/*`) | ✅ |
| **Create-pyramid action** | header → `AppController.createPyramid()` → `@kirigami` creation → viewer + sim | ✅ end-to-end demo of the creation half |
| **Model → kirigami conversion** | `AppController.kirigamize()` for `.obj`/`.stl` | ⛔ **stub** — this plan fills it |

The simulator fix is the precondition for everything downstream (Stage 5 verifies
every pattern): `src/sim/{model,forces,solver}.ts` are now byte-identical to AKDE,
and cut edges are made free flaps via AKDE's `cutRatio` API instead of the earlier
diverged crease-exclusion / sign-flip. See `tests/current/kzr-sim.test.ts`.

---

## 3. The pipeline (algorithm → modules to build)

From `kirigamizer_algorithms.tex`, the driver is
`Kirigamizer(M, ε, λ)` = ImportAndCondition → PlanCuts → SeamedUnfold →
RouteSeams → EmitPattern → SimulateVerifyOptimize. Target module layout
(new code under `src/pipeline/`, reusing `kirigami/` + `fkld/`):

| Stage | Algorithm | New module | Reuses |
|-------|-----------|-----------|--------|
| **0. Import & condition** | STEP/mesh → coarse manifold $Q$ (weld, repair, decimate, units, clean/tuck side) | `src/pipeline/import.ts`, `src/pipeline/conditioning.ts` | — |
| **1. Plan cuts** | $\delta(v)=2\pi-\sum\alpha_i$; necessity ($v\in\mathcal{C}\iff\delta\neq0$), connection (cut-tree to a developable disk + $2g$ handle loops), routing ($\min\sum \mathrm{len}+\lambda\,\mathrm{vis}$); dart-vs-tuck | `src/pipeline/curvature.ts`, `src/pipeline/plan-cuts.ts` | `fkld:vertices_angleDefect/curvatureClass/reliefStrategy` |
| **2. Seamed unfold** | cut into developable patches, flatten isometrically; relief cuts until each patch embeds | `src/pipeline/unfold.ts` | Origamizer vertex-unfolding |
| **3. Route seams & tabs** | pack patches (Tutte); seam (brook) for sealed cuts, gusset/tab strip (river) to deliver material to $\delta<0$ | `src/pipeline/route-seams.ts` | Origamizer streams |
| **4. Emit pattern** | write M/V/F creases + cut edges as **FKLD**; tuck the chosen $\delta>0$ vertices via local Origamizer molecules | `src/pipeline/emit.ts` | `kirigami/model/pattern`, `fkld/bridge`, `kirigami/model/molecule` |
| **5. Simulate · verify · optimize** | GPU-fold (cuts first-class), check $d_H(Q,f(P))\le ε$, refine $\lambda$/dart-vs-tuck/angles/scale | `src/pipeline/verify.ts` | `src/sim/*` (now AKDE-exact) |

Half-edge mesh + adjacency is the shared substrate: `src/pipeline/mesh.ts`
(vertices/edges/faces, one-ring traversal, boundary detection).

---

## 4. Phased build order

Each milestone is shippable and testable on its own. ✅ = done, ▶ = next, ☐ = later.

- **M0 — Foundation (✅).** Transfer AKDE creation + sim + FKLD; fix the sim to
  AKDE-exact; wire Create-pyramid; green build + tests.
- **M1 — Mesh substrate (✅).** `mesh.ts` ordered one-ring fan topology (half-edge
  rejected as overkill); OBJ/ASCII-STL import (`import.ts`, binary STL rejected);
  conditioning passes weld/orient/degenerate + genus-0 gate (`conditioning.ts`).
  *Tests:* cube/icosphere round-trip; $\Sigma\delta = 2\pi\chi$ within 1e-9.
- **M2 — Curvature & cut planning (✅).** `curvature.ts` ($\delta$, classes, signed
  dihedral M+); `plan-cuts.ts` necessity + MST-of-metric-closure connection
  (boundary as pseudo-terminal), forest pruning, **wedge rule** for $\delta<0$
  (cut-degree ≥ 2, every wedge < 2π); dart-vs-tuck strategy dial. *Tests:* saddle
  gets exactly the forced cuts; octahedron tuck-all reduces to $\mathcal{C}=\varnothing$.
- **M3 — Seamed unfold (✅).** `unfold.ts` wedge splitting (slit endpoints don't
  split), BFS law-of-cosines isometric layout, developability/isometry audits,
  shrink-SAT overlap predicate, bounded relief loop (RELIEF_MAX=64). Cutting may
  legitimately disconnect (saddle fan → 2 patches); result is globally indexed
  with per-face patch labels. *Tests:* cube net golden (1e-9 isometry), apex dart
  gap = $\delta$, icosphere relief termination.
- **M4 — Emit FKLD (✅).** `route-seams.ts` (shelf packing + M/V/F/B/C + cut
  subtypes minor/dart/seam) + `emit.ts` (builder over fkld KEYS registry; molecule
  tuck annotation θ=δ/N, w=2s̄·sin(θ/2); foldedForm goal frame +
  `fkld:vertices_driven`; self-validation). *Tests:* io round-trip, buildScene
  loadability, Σδ=4π through provenance.
- **M5 — Verify loop (✅).** `verify.ts` (sampled symmetric Hausdorff, bar strain,
  crease residual; **equilibrium verification** — see status note) + `kirigamize.ts`
  facade (3-attempt optimize schedule: re-plan with worst-vertex terminal, then 3×
  iterations) wired into `AppController.kirigamize()`. *Tests:* e2e cube / saddle
  roof / Enneper / tent (free-vertex relaxation) all converge; negative test proves
  the oracle rejects a tampered goal.
- **M6 — Fabrication & STEP (☐ deferred).** STEP/B-rep import (feature edges, units);
  SVG/DXF export with cut/score/engrave layers (reuse `kirigami/model/svg-export`);
  kerf, tabs, multi-sheet nesting. Also future: free-lip fold-path verification
  (needs collision handling), sealed gussets, Voronoi tuck crease generation.

---

## 5. Testing strategy

- Keep the transferred AKDE suite as the regression floor for creation + sim
  (geometry, pattern, constraints, svg-export, zip, fkld/*, sim). The repo's active
  tests live under `tests/current/`; `tests/*.test.ts` are the transferred AKDE
  originals (move into `tests/current/` as they're adopted).
- Every pipeline stage gets a unit test with a hand-checkable target (cube, saddle,
  Enneper patch). Stage 5 is the integration gate: folded $d_H \le ε$.
- The simulator is the oracle: a pattern is "correct" when it folds to the target in
  `src/sim`, not when it merely looks right on paper.

---

## 6. Honest scope (from the proposal)

- **Coarse flat-faceted input required** — curvature must live at vertices; a dense
  mesh would force cuts everywhere. Conditioning (M1) sets where curvature concentrates.
- **Open kirigami is fully general; sealed (watertight gusset) is not** — no general
  non-crossing layer-ordering proof; treat sealed seams heuristically and verify in sim.
- **Unfolding may add relief cuts** beyond the curvature minimum (immersion ≠ embedding).
- **No constructive flat-foldability guarantee** — M/V assignment + layer order are
  validated by the simulator, not proven.
- **Stage 5 is a search, not a solver** — terminates at $d_H\le ε$ or a budget.
- **Zero-thickness model** — material thickness, kerf, score depth, joining tabs are M6.

---

## 7. References

- `kirigamizer_algorithms.tex` — the algorithm proposal (driver, PlanCuts, stages, sim, FKLD, limits).
- `origamizer_algorithms.tex` — pseudocode for the reused Origamizer stages.
- `FKLD-SPEC.md` (AKDE) and `fkld/spec.coffee` — the file format.
- AKDE `theory/plan.md` (uniform-pyramid v1) and `theory/sim-ecs.md` (the bar-and-hinge sim).
