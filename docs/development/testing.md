# Testing

Traceform is tested with Vitest in plain Node, with no browser: model and service code is tested directly, and view code runs against a small hand-written mock DOM. This page covers the layout, the scripts to run, the architecture tests that enforce the layering, and the rules the project has adopted after tests that passed while the code was wrong.

## Configuration

```ts title="vitest.config.ts"
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/current/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kirigami": resolve(__dirname, "kirigami"),
    },
  },
});
```

- `environment: "node"`: no jsdom or happy-dom. View tests install the project's own mock DOM (see [below](#view-tests-without-a-browser)).
- `globals: false`: every test file imports `describe`, `it` and `expect` from `vitest` explicitly.
- Only files matching `tests/current/**/*.test.ts` are collected. An iCloud conflict copy named `foo.test 2.ts` therefore never runs. `module-health.test.ts › R14` fails if such a copy is tracked by git.
- The `@kirigami` alias points at the vendored `kirigami/` directory, as in the app build.

!!! warning "A green suite is not a typecheck"
    Vitest compiles TypeScript with esbuild, which strips types without checking them. A test file can pass and still break `npm run build`, which runs `tsc --noEmit` over the whole `include`, test files among them. Run `npx tsc --noEmit` unfiltered as well as the tests. Narrowing its output to `^src/` hides every error in a test file.

## Layout

`tests/current/` mirrors `src/`. A test for `src/<area>/<file>.ts` lives at `tests/current/<area>/<file>.test.ts` and imports the module by relative path:

```ts title="tests/current/model/circuit-commands.test.ts (imports)"
import { describe, expect, it } from "vitest";
import { BATTERY_PART, type Circuit } from "../../../src/model/electronics.js";
import {
  appendPlacedPart,
  assignPad,
  cloneCircuit,
  // …
} from "../../../src/model/circuit-commands.js";
```

| Directory | Covers |
| --- | --- |
| `architecture/` | Whole-tree rules: import boundaries and module health |
| `bst/` | `src/pipeline/bst` and its sim scene (bistable tilings) |
| `controller/` | `src/controller/app-controller.ts` |
| `core/` | `src/core` |
| `fkld/` | The `@dayangac/fkld` package as the app uses it |
| `model/` | `src/model`: geometry, routing, strain, parts, exports |
| `pipeline/` | `src/pipeline`: mesh import, unfolding, cut planning; fixtures in `pipeline/fixtures` |
| `services/` | `src/services` |
| `sim/` | `src/sim` |
| `view/` | `src/view`, plus `mock-dom.ts` |

A few older test files sit directly in `tests/current/` instead of in an area folder. They are still collected by `npm test`, but no per-area script picks them up.

## Scripts

From `package.json`:

| Script | Runs |
| --- | --- |
| `npm test` | `vitest run`, the whole suite |
| `npm run test:watch` | `vitest` in watch mode |
| `npm run test:architecture` | `tests/current/architecture` |
| `npm run test:bst` | `tests/current/bst` |
| `npm run test:controller` | `tests/current/controller` |
| `npm run test:core` | `tests/current/core` |
| `npm run test:fkld` | `tests/current/fkld` |
| `npm run test:model` | `tests/current/model` |
| `npm run test:pipeline` | `tests/current/pipeline` |
| `npm run test:services` | `tests/current/services` |
| `npm run test:sim` | `tests/current/sim` |
| `npm run test:view` | `tests/current/view` |
| `npm run build` | `tsc --noEmit && vite build` (the typecheck) |

!!! note "The full suite takes more than ten minutes"
    Many model tests run the real router over bundled patterns and carry explicit per-test timeouts (`{ timeout: 30_000 }`, `{ timeout: 60000 }`). The normal loop is the per-area script for the code you touched, plus `npm run test:architecture`, which finishes in under a second. Run the full suite before you call a change done, and send its output to a file instead of piping it through `tail`, so a long run is not lost.

To run one file or one test: `npx vitest run tests/current/model/circuit-commands.test.ts`, or add `-t "<test name>"`.

## Architecture tests

The two files in `tests/current/architecture/` read the source tree as text and check its shape. They import no application code.

### `import-boundaries.test.ts`

It walks every `src/**/*.ts` file, extracts its `import`, `export … from` and dynamic `import()` specifiers, resolves relative ones to `src/`-relative paths, and checks them against these rules. Its header says to fix the import and not loosen the rule; loosening needs a matching change to [Import boundaries](../import-boundaries.md) in the same commit.

| Rule | Enforces |
| --- | --- |
| R1 | `three` is imported only from `src/view/**` and `src/sim/gpu/**`. |
| R2 | `kirigami/` and `fkld/` are reached only through their aliases, never by a relative path. |
| R3 | Outside `src/sim/`, sim code is imported only through `sim/index.js` or `sim/gpu/index.js`. |
| R4 | `src/core/**` imports nothing from other `src` layers, nor `three`, `@kirigami` or `@fkld`. |
| R5 | `model/types.ts` and `model/geometry.ts`, deleted duplicates of `@kirigami/model`, must not come back or be imported. |
| R6 | `services/` never imports `view/` or `controller/`. |
| R7 | `view/` never imports `services/` or `controller/`. Intents go up through callbacks. |
| R8 | The full layering matrix: `model/` imports none of `view/`, `controller/`, `services/`, `pipeline/`, `sim/`; `view/` imports none of `controller/`, `services/`, `pipeline/`; and so on. Allowed direction: main → controller → services → {model, pipeline, sim, core}. |
| R9 | The transitive imports of `sim/index.ts` and `pipeline/index.ts` never reach `three`, so both barrels load in plain Node. |
| R10 | `electronics-modal.ts` never assigns `this.circuit =` except through `editCircuit` (see [Editor](../electronics/editor.md#every-edit-is-a-named-pure-command)). |

R10 is a line-based regex check:

```ts title="tests/current/architecture/import-boundaries.test.ts › R10"
    const directWrites = source
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bthis\.circuit\s*=/.test(line) && !/editCircuit/.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);
    expect(directWrites, directWrites.join("\n")).toEqual([]);
```

### `module-health.test.ts`

It checks shape instead of direction. Its header calls each allowlist a debt: "They may shrink and they may be deleted; they may never be added or raised."

| Rule | Enforces |
| --- | --- |
| R11 | No runtime import cycles involving `src/model`. Type-only imports (`import type …`, or `import { type A, type B }`) are erased before runtime and are not counted. `ALLOWED_CYCLES` is empty and meant to stay that way. |
| R12 | No `src` file over 1200 lines, `*.generated.ts` excepted. Files already over the limit are listed in `SIZE_BUDGETS` at their recorded length and may not grow ("split it, do not raise it"). A listed file that drops under 1200 makes the test fail until its entry is deleted. |
| R13 | Outside `model/`, generated footprint modules (`*.generated.js`) are reached through `model/library.js` or `model/footprint.js`, never directly. |
| R14 | No iCloud conflict copies (`foo 2.ts`) are tracked by git under `src/` or `tests/`. It asks `git ls-files` instead of walking the disk, so an untracked local conflict file does not fail it. |

!!! note "Why R11 ignores type-only imports"
    From `runtimeImports`'s docblock: a cycle made of type edges is two files naming each other's shapes, and is not a cycle at runtime. Counting them would leave R11 either permanently red or permanently allowlisted, "and a ratchet that is always red ratchets nothing."

!!! note "Why 1200 lines"
    The `SIZE_BUDGETS` comment says 1200 is roughly the point past which nobody reads a file whole before editing it, and that every budgeted file had already produced a bug that way. A raise is allowed in one case only: the comment for `electronics-modal.ts` records 16 lines added when positional-argument calls became named-object calls through `ElectronicsDesignAdapter`, and asks that such a raise be argued for in the commit message every time.

## View tests without a browser

`tests/current/view/mock-dom.ts` is a minimal DOM. `installDom()` puts a `MockDocument` and a `MockWindow` on `globalThis`, and helpers find elements in the tree:

```ts title="tests/current/view/mock-dom.ts › installDom"
export function installDom(): { document: MockDocument; window: MockWindow } {
  const document = new MockDocument();
  const window = new MockWindow();
  (globalThis as any).document = document;
  (globalThis as any).window = window;
  return { document, window };
}
```

`MockElement` supports what the views actually use: `classList`, `dataset`, `innerHTML`, attributes, children, and listeners that tests fire with `dispatch(type, event)`. `MockDocument.querySelector` understands only `.class` and tag selectors. The helpers `childByClass`, `childrenByClass`, `childByData` and `childrenByTag` walk the tree.

A view test constructs the real view class and drives it with events. For example, `electronics-modal.test.ts` taps the canvas by converting a flat-pattern point through the modal's own transform and dispatching `pointerdown`/`pointerup` on its SVG element. Other tests press keys through `document.dispatch("keydown", …)`.

This works because views do no geometry of their own; anything they draw comes from model functions. It also limits what views may use. A DOM API the mock lacks passes `tsc` and fails at test time with `Cannot read properties of undefined`. Either add the API to the mock or avoid it. `electronics-modal.ts › isTyping` reads the target's `tagName` directly "rather than through `matches()` or `closest()`: those are DOM methods the headless DOM these tests run in does not implement". `route.ts` checks `addressable()` because the test DOM has no `location`.

Classes that depend on heavy model work take it as a constructor parameter with a real default, so a test can pass a stub: `ElectronicsModal(design = defaultElectronicsDesign)` and `AppController(…, electronicsPlanning = defaultElectronicsPlanning)`. Logic that can be lifted out of a view entirely goes into a DOM-free module tested without the mock (`electronics-presenters.test.ts`, `electronics-palette.test.ts`, `pcb-scene.test.ts`, `wire-tool.test.ts` against a fake `WireHost`).

## Golden-number tests

Some tests pin values recorded from the router over bundled patterns: run counts, total copper length, crease crossings, terminals reached. They catch any change in routing behaviour, intended or not. When a deliberate change moves them, the new values are recorded **with the delta and the reason written next to them**, never swapped silently:

```ts title="tests/current/model/crease-price.test.ts › buys tension crossings, and pays for them in copper"
    // Re-recorded on 2026-08-28 when `TAPE_MM` fell to 1.5 (from 16/14 crossings and 14.23/15.07 units).
    // Narrower tape gives the search more room, so it both crosses more creases when nothing stops it and
    // avoids more of them when the price does: the trade got wider at both ends, which is the direction it
    // should move, and the assertions below pin the SHAPE of it rather than only the four numbers.
    const priced = crossings("church.fkld", 12);
    const lengthOnly = crossings("church.fkld", 12, 0);
    expect(lengthOnly.tension).toBe(17);
    expect(priced.tension).toBe(11);
    // …
    expect(priced.tension).toBeLessThan(lengthOnly.tension);
    expect(priced.len).toBeGreaterThan(lengthOnly.len);
```

Two habits are visible here. The old values stay in the comment. And the shape of the result (fewer crossings, more copper) is asserted alongside the raw numbers, so a future re-record that breaks the relationship still fails. The table in `part-routing.test.ts` was re-recorded twice the same way, each time listing per pattern what moved and why, including one pattern that lost its LED. The vault records that writing the delta down has surfaced findings a silent swap would have buried.

Use `toBeCloseTo` for floating-point values, never exact equality.

## Lessons the suite encodes

These come from incidents recorded in the project's working notes and in comments in the tests themselves.

!!! warning "A guard must be tested against the thing it forbids"
    `net-routing.ts` twice enforced "no copper crosses another net" with a predicate that could not see a crossing. Its segment distance, in the router and in the test helper that checked the invariant, was a `min` over four endpoint projections, which reports a large positive number for two segments that actually cross. The whole corpus stayed green while copper crossed copper. The comment in `net-routing.test.ts › reaches most of the netlist` records the result: `church` had been recorded at 7 reached terminals, and "the 7 was not real". Feed a guard a case it must reject, and watch it reject that case. An assertion that only ever sees inputs it accepts tests nothing.

!!! warning "Expected values must not be read off the code under test"
    In one night, six tests were written to pin which footprint axis a pad dimension meant. Each took its expected value from the implementation, so each passed while the implementation was wrong. A seventh asserted that a placement kept its reflection, defending parts that were seated inside out. Derive expected values from the footprint, the drawing, or a measurement of the emitted geometry. Also, two halves that share a derivation will agree with each other whether or not they are correct, so a consistency test between them proves nothing.

!!! warning "Mutation-test a copy, not the shared file"
    Mutation testing (flip an operator, check that some test fails) is how several weak tests here were found. For example, the comment in `net-routing.test.ts` notes that relaxing the corridor search left every guarantee test green while it quietly stranded more terminals. Mutating the working file is still a write: a session once mutated another session's file and restored it from a snapshot, which risked shipping the mutant and overwrote edits made in the meantime. Mutate a copy at a scratch path, or have the file's owner run the mutants.

??? info "More rules from the same notes"
    - **A search that changes no outcome cannot be tested through outcomes.** A reordering search in the net router reached the same terminals either way, so the first test for it passed against a mutant that disabled it. The fix was to report the thing itself (`NetRouting.orders`). If a mutant survives, the test is describing something the code does not decide.
    - **A threshold that has never fired is an untested branch**, not a passing test.
    - **Measure from the plan, not a literal coordinate.** Fixtures that probed "the run at y = …" silently measured the wrong thing when a tape-width change moved the plan. Find the thing by position, by the router's own report, or in millimetres.
    - **Assert rules, not counts that rot.** The part library's size has changed several times; tests and comments that hard-code it go stale.
    - **A fixture field list is a guard.** `electronics-modal.test.ts › the round trip to the store` fills every optional `Circuit` field. Adding a field to `Circuit` means adding it to that fixture.

## Design choices

| Choice | Alternative considered | Reason (source) |
| --- | --- | --- |
| Node environment with a hand-written mock DOM | jsdom or a real browser | Views do no geometry, so a tiny DOM is enough. Its gaps are deliberate pressure on views to stay thin (`isTyping` comment, `mock-dom.ts`). |
| Architecture rules as tests over source text | Lint configuration | They run with the suite, report the offending `file → specifier`, and can express project-specific rules such as R10 and R12. |
| Allowlists that can only shrink | Rules that are either on or off | A rule with no allowlist "would have to be either false or off" (`module-health.test.ts` header). |
| Per-area npm scripts | Only `npm test` | The full suite takes 10+ minutes; per-area runs keep the edit loop short. |

See also: [Architecture overview](../architecture/overview.md), [Import boundaries](../import-boundaries.md), [Design decisions](../architecture/design-decisions.md), [History](history.md).
