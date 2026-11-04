# Design decisions

The decisions that shape the whole system, each with the alternative it was chosen over and where the reasoning is recorded. Each subsystem page has its own, more detailed "Design choices" section; this page collects the ones a newcomer needs first.

Every reason given here is sourced from a code comment, a commit or a test, which is cited. Where the source records no reason, the page says so.

## Representation

!!! note "One coordinate frame for form and circuit"
    The flat pattern's `vertices_coords` are the only geometry the electronics layer reads. Routed copper therefore lands in the same SVG frame as the cut and score layers, with nothing to convert and no second record of where anything sits. This is the paper's central claim, and the reason both halves of the app share one `FoldFile`. See [Electronics overview](../electronics/overview.md) and [FKLD](../kirigami/fkld.md).

| Decision | Alternative | Reason (source) |
|---|---|---|
| FKLD, a superset of FOLD, as the one interchange format | A custom format | Standard FOLD keys stay readable by other tools; extensions live under `fkld:` keys from the package's `KEYS` registry, "the single source of truth for every extension key" (`emit.ts`). [FKLD](../kirigami/fkld.md) |
| Take a fold's sign from `M`/`V`, its magnitude from the file | Trust the stored sign | Writers "do not agree on a sign convention, and M/V is unambiguous" (`electronics.ts › GapEdge.dihedral`). [Electronics overview](../electronics/overview.md) |
| A pattern smaller than the print sheet is scaled up, never down | Treat file units as millimetres | Several bundled patterns are a few units across yet claim `"mm"`. `printScale` decides the physical size for every export so the layers register (`print-scale.ts`). [FKLD](../kirigami/fkld.md), [Export](../electronics/export.md) |

## Architecture

| Decision | Alternative | Reason (source) |
|---|---|---|
| MVC plus a services layer, with layering enforced by tests | Layering by convention | The rules are in `import-boundaries.test.ts` and `module-health.test.ts`. A comment warning was shown not to stop repeats. [Import boundaries](../import-boundaries.md) |
| Allowlists that only shrink | Rules that are on or off | A rule with no allowlist "would have to be either false or off" (`module-health.test.ts` header) |
| `three` only in views and the GPU solver | three.js math throughout | Geometry, routing and the sim stay runnable and testable in plain Node (`core/vec3.ts` header, rule R9) |
| Services pure over their inputs, all with the "what the viewer shows" policy | Each feature reading the store | The sim, cut file, STL and circuit all target the pattern on screen (`sim-scene-service.ts`, `svg-export-service.ts` headers). [Architecture overview](overview.md) |
| Hash routes inside one document | Separate pages, or `pushState` | Editors are fed live from the store, and the app must run from `file://` (`view/route.ts` header) |
| Split `electronics-routing.ts` behind a re-exporting facade | Move every call site at once | Callers kept working during the split. A symbol found in the facade is usually defined elsewhere. [Electronics overview](../electronics/overview.md) |

## Kirigami

| Decision | Alternative | Reason (source) |
|---|---|---|
| Cut handles up front | Reject genus > 0 meshes | "Kirigami already *is* cutting, so the natural fix is to cut the handle loops up front" (`handle-cut.ts`). [Pipeline](../kirigami/pipeline.md) |
| One connected sheet, or a hard error | Multi-patch packing | Patch packing was removed; see [Pipeline](../kirigami/pipeline.md) for the current reasoning |
| The pipeline driver returns every intermediate stage | Return only the pattern | It returns every stage "so tests and the UI can introspect without re-running" (`kirigamize.ts`); `pattern-service.ts` narrows the result to `PatternOutcome` for the app. [Pipeline](../kirigami/pipeline.md) |
| Declared folded form as a soft guide that is released | Pin driven nodes hard | Pinning turns the fold into a straight-line blend: bars stretch, layers pass through each other (`origami-import.ts › applyDeclaredGoal`). [Simulation](../kirigami/simulation.md) |
| CPU solver on the live path | `GpuFoldSolver` | The GPU solver lacks the guide, seams, slack rule and collision (`gpu-solver.ts`). [Simulation](../kirigami/simulation.md) |
| Fold cadence owned by `FoldRunner`, not the view | Loop inside the canvas | A fast-ramp regression shipped because the tests ran a different loop from the viewer's (`fold-run.ts` header) |

## Circuit

| Decision | Alternative | Reason (source) |
|---|---|---|
| Price a crease by strain from its angle and measured hinge width | Price by `M`/`V`/`C` letter | The letter "could not answer … *how far* does this crease fold, and *how thick is the sheet*" (`fold-strain.ts` header). [Fold strain](../electronics/fold-strain.md) |
| Charge tension, not compression (except near closure) | Charge by \|ε\| | Mountains fracture while valleys plateau (Nakaya et al., cited in `fold-strain.ts`) |
| Routing threshold derived from ductility at the service life | A chosen 1% | 1% corresponded to about 2×10⁴ folds, about 200× stricter than needed (`thresholdStrainFor`, commit `b25c490`) |
| Route on a corridor of edge crossing points (¼, ¾) joined by chords | Through face centres and hinge midpoints | Through one centre point both nets solve the same problem and get the same answer, and the midpoint is where a chip sits (`corridor.ts › buildCorridor`, `EDGE_CROSSINGS`). [Routing](../electronics/routing.md) |
| Two-rail bus for power, a separate net router for declared nets | One general router | Banks assume exactly two nets; named nets are routed independently with a clearance gate (`net-routing.ts` header). [Netlist](../electronics/netlist.md) |
| Lexicographic plan objective (`PlanKey`, `lexLess`) | Weighted sum | See [Routing › Design choices](../electronics/routing.md#design-choices) |
| Report unroutable parts as faults | Draw copper anyway, or drop the part | "Reported rather than drawn wrong" (`RoutedCircuit.unreachable`); dropping is the silent stranding faults exist to end (`resolveNetlist`) |
| Footprints generated offline from KiCad FabLib, output committed | Hand-written pad tables, or OCaml in the browser | Hand values were wrong twice (`footprints.ml` header). Running the generator at runtime via js_of_ocaml was slower than TypeScript (commit `806fa8b`, original message). Why OCaml rather than a Node script is not documented. [Parts](../electronics/parts.md) |
| A placement is a 2×2 matrix and never a reflection | `{rot, flip}` | The matrix makes a reflection detectable; most two-row parts had been seated inside out (`electronics-parts.ts`). [Parts](../electronics/parts.md) |
| Every editor edit is a named pure command | Mutations in gesture handlers | Keeps field preservation and terminal renumbering small and testable (`circuit-commands.ts` header, rule R10). [Editor](../electronics/editor.md) |
| Manual routing by default | Re-plan on every edit | A plan costs most of a second, and a board re-routing itself mid-thought was disruptive (`electronics-modal.ts` header) |
| Copper exported as closed, filled outlines from one `stripOutline` | Stroked centrelines; each file drawing its own | A cutter follows the path, so a centreline cuts down the middle of the strip. A carrier drawn separately once shorted LEDs that the strips file kept apart (`copper-svg-export.ts`). [Export](../electronics/export.md) |

## Known gaps

These are open at the time of writing. Each is described on the linked page:

- Hand-drawn wires are obstacles to the net router only. The bus is laid without them; bus copper that runs into a wire of another net is reported as a `wire-short` fault, not routed around. [Netlist](../electronics/netlist.md)
- `PlanKey` has no crease term, and straightening ignores creases, so a shortcut can cross a hinge the corridor search avoided. [Routing](../electronics/routing.md)
- `src/pipeline/bst/` is reachable only from its tests and emits no bars in its current square-only form. [Bistable star tilings](../kirigami/bistable.md)
