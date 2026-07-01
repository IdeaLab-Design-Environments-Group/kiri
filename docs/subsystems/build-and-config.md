# Build And Configuration

This subsystem describes the project-level tooling that makes the app, tests,
CoffeeScript bridge modules, and path aliases resolve consistently.

## Files

| File | Responsibility |
| --- | --- |
| `vite.config.ts` | Browser build/dev server config. |
| `vitest.config.ts` | Test runner config. |
| `scripts/vite-plugin-coffee.ts` | Minimal CoffeeScript transform plugin for Vite and Vitest. |
| `tsconfig.json` | TypeScript project settings. |
| `package.json` | Scripts and dependency versions. |

## Vite Runtime Config

The app build uses:

| Setting | Purpose |
| --- | --- |
| `base: process.env.VITE_BASE ?? "./"` | Allows relative static deployment by default. |
| `server.open: true` | Opens the dev server in local workflows. |
| `build.outDir: "dist"` | Writes production artifacts to `dist/`. |
| `@kirigami` alias | Resolves app source imports from `src/`. |
| `@fkld` alias | Resolves FKLD CoffeeScript modules from `src/fkld/`. |
| Coffee plugin | Allows `.coffee` modules to participate in the TS/Vite graph. |

## Vitest Config

Vitest mirrors the runtime aliases and CoffeeScript transform so tests exercise
the same module graph as the app.

Test discovery is scoped to `tests/current/**/*.test.ts`. New tests should be
placed under `tests/current/` unless the suite is intentionally reorganized.

## CoffeeScript Bridge

`scripts/vite-plugin-coffee.ts` compiles `.coffee` files on demand. This keeps
legacy FKLD modules usable without converting all CoffeeScript at once.

Rules for this bridge:

| Rule | Reason |
| --- | --- |
| Keep CoffeeScript transform in both Vite and Vitest. | Runtime and tests must resolve the same modules. |
| Prefer small CoffeeScript interop surfaces. | Most new pipeline logic should remain TypeScript. |
| Do not duplicate FKLD constants in TypeScript. | `KEYS` remains the extension-key source of truth. |

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start local Vite dev server. |
| `npm run build` | Type-check and build production assets. |
| `npm test` or configured Vitest script | Run the current test suite if present in `package.json`. |

Use the exact scripts in `package.json`; this page documents intent, not a
replacement command source.

## Configuration Change Checklist

When changing aliases, transforms, or module extensions:

| Check | Why |
| --- | --- |
| Update `vite.config.ts`. | App runtime must resolve the new path. |
| Update `vitest.config.ts`. | Tests must resolve the same path. |
| Check TypeScript config. | Editor and type-checker need matching module resolution. |
| Run build/tests. | Alias mistakes often only appear in one environment. |
| Update docs. | Future subsystem work depends on import-boundary clarity. |

