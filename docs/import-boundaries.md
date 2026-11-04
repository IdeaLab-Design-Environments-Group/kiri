# Import boundaries

The layering described in the [Architecture overview](architecture/overview.md) is executable. Two test files under `tests/current/architecture/` read every `src/**/*.ts` file, extract its import specifiers with regular expressions, and fail on any violation. Run them with `npm run test:architecture`; they take seconds.

!!! note "This page is the document the test names"
    `import-boundaries.test.ts` describes itself as "the executable version of docs/import-boundaries.md" and asks that any loosening of a rule come with a conscious update to this page in the same change. If you change a rule, change it here too.

## Direction rules (`import-boundaries.test.ts`)

| Rule | Statement |
|---|---|
| R1 | `three` is imported only by `src/view/**` and `src/sim/gpu/**` |
| R2 | `kirigami/` is reached only through the `@kirigami` alias, never by a relative path |
| R3 | Outside `src/sim/`, sim is imported only via `sim/index.js` or `sim/gpu/index.js` |
| R4 | `src/core/**` imports nothing from another layer, and never `three`, `@kirigami` or `@fkld` |
| R5 | `model/types.ts` and `model/geometry.ts` (former duplicates of `@kirigami/model`) must not reappear |
| R6 | Services never import `view/` or `controller/` |
| R7 | Views never import `services/` or `controller/`; intents flow up through callbacks |
| R8 | Full matrix: no layer imports a layer above it |
| R9 | The transitive closure of `sim/index.ts` and `pipeline/index.ts` never reaches `three` |
| R10 | `view/electronics-modal.ts` never assigns `this.circuit` except through `editCircuit` |

R8 is the general rule; the others are the cases that went wrong first. Its table lists, for each layer, the prefixes it may never import:

```ts title="tests/current/architecture/import-boundaries.test.ts › R8"
// Allowed direction: main → controller → services → {model, pipeline, sim, core}.
// FORBIDDEN[layer] = src prefixes that layer must never resolve an import into.
const FORBIDDEN: Record<string, string[]> = {
  "model/": ["view/", "controller/", "services/", "pipeline/", "sim/"],
  "pipeline/": ["view/", "controller/", "services/", "model/app-store"],
  "sim/": ["view/", "controller/", "services/", "pipeline/"],
  "view/": ["controller/", "services/", "pipeline/"],
  "services/": ["view/", "controller/"],
  "core/": ["view/", "controller/", "services/", "model/", "pipeline/", "sim/"],
};
```

The model may not import the sim. So when the store needs the sim's material type, it inlines a structurally identical union rather than importing it:

```ts title="src/model/app-store.ts › SimMaterial"
/**
 * Mirrors `SimMaterial` from sim/index — inlined (structurally identical union) so the model layer
 * never imports the sim layer (architecture rule R8). Stays in lock-step with the sim definition.
 */
export type SimMaterial = "vinyl" | "printed";
```

## Shape rules (`module-health.test.ts`)

The second file has nothing to say about direction; it checks the shape of the module graph:

| Rule | Statement |
|---|---|
| R11 | No runtime import cycles in `src/model` (type-only imports are erased and do not count) |
| R12 | No source file over 1200 lines, apart from generated files and a budgeted list of existing offenders |
| R13 | `*.generated.ts` footprint modules are imported only through their facades (`model/library.ts`, `model/footprint.ts`) |
| R14 | No iCloud conflict duplicates (`foo 2.ts`) tracked under `src/` or `tests/` |

!!! note "Why the allowlists only shrink"
    From the file's header: every rule carries an allowlist of what was already broken, with its current value recorded as the budget. A rule with no allowlist would have to be either false or switched off. Entries are debts: they may shrink or be deleted, but never added or raised. "If a change makes an entry wrong in the loosening direction, the change is the problem."

The 1200-line limit is explained in the same file. It is roughly the point past which nobody reads a file whole before editing it, and each budgeted file had already produced a bug for that reason. The cycle allowlist `ALLOWED_CYCLES` is empty. The cycles in `src/model` were broken when shared geometry moved into leaf modules (`trace-geometry`, `trace-types`, `tape-width`, `pad-landing`, `corridor`, `part-fit`); see [Electronics overview](electronics/overview.md).

R11 skips type-only imports on purpose. Two files that name each other's types do not form a runtime cycle, and counting them would leave the rule permanently red or permanently allowlisted.

## When a rule fails

Fix the import, not the rule. The usual fixes:

- Move the shared code down a layer, into `core/` or a leaf model module.
- Pass a value or callback in from the controller rather than importing upward.
- For a view that needs a computed value, add a pure presenter in `model/` or `view/electronics-presenters.ts` and have the controller hand it the inputs.
