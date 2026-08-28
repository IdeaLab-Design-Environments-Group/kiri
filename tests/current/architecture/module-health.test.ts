/**
 * Architecture test — the ratchet that stops the codebase re-acquiring the problems a day of
 * untangling just removed. Its companion, import-boundaries.test.ts, says *which* layer may import
 * *which*; this file says nothing about direction and everything about shape: no import cycles, no
 * files that have grown past the point where anyone reads them whole, no reaching around the
 * facades, no iCloud duplicates.
 *
 * Every rule here carries an allowlist of what is already broken, with the current value recorded
 * as the budget. That is deliberate: a rule with no allowlist would have to be either false or
 * off. Entries are debts. They may shrink and they may be deleted; they may never be added or
 * raised. If a change makes an entry wrong in the loosening direction, the change is the problem.
 *
 *   R11 no runtime import cycles in src/model
 *   R12 no src file over 1200 lines
 *   R13 *.generated.ts is reached through its facade, not directly
 *   R14 no iCloud conflict duplicates ("foo 2.ts") tracked under src/ or tests/
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve, dirname, sep } from "node:path";

const SRC = resolve(__dirname, "../../../src");
const REPO = resolve(__dirname, "../../..");

/** All .ts files under src/, absolute paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A src-relative key with posix slashes and a .ts extension — the node id used everywhere here. */
function srcKey(abs: string): string {
  return relative(SRC, abs).split(sep).join("/");
}

/**
 * Relative import specifiers that survive to runtime, as src-relative .ts keys.
 *
 * The type-only filtering is the whole point of this function. A type import is erased before the
 * module graph exists, so a "cycle" made of type edges is not a cycle at all — it is two files
 * naming each other's shapes, which is fine and common here. Counting them would make R11 either
 * permanently red or permanently allowlisted, and a ratchet that is always red ratchets nothing.
 * Both spellings are erased and both are dropped:
 *
 *   import type { A } from "./x.js";          // whole clause is type-only
 *   import { type A, type B } from "./x.js";  // every specifier is type-only
 *
 * A clause with even one runtime specifier (`import { type A, b }`) is a runtime edge and stays.
 */
function runtimeImports(abs: string, source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*import\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith(".")) continue;
    if (/^type\b/.test(clause)) continue;
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      const before = clause.slice(0, clause.indexOf("{")).replace(/,\s*$/, "").trim();
      const named = braces[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // No default/namespace binding, and every named specifier is `type X` → nothing at runtime.
      if (before === "" && named.length > 0 && named.every((n) => /^type\s/.test(n))) continue;
    }
    const target = resolve(dirname(abs), spec);
    out.push(srcKey(target).replace(/\.js$/, ".ts"));
  }
  return out;
}

/** file → runtime imports, restricted to edges that land on a file that actually exists. */
function runtimeGraph(): Map<string, string[]> {
  const files = walk(SRC);
  const known = new Set(files.map(srcKey));
  const graph = new Map<string, string[]>();
  for (const abs of files) {
    const deps = runtimeImports(abs, readFileSync(abs, "utf8")).filter((d) => known.has(d));
    graph.set(srcKey(abs), deps);
  }
  return graph;
}

/**
 * Every simple cycle, each reported once.
 *
 * A plain DFS finds *a* cycle but silently skips cycles through already-visited nodes, which would
 * let a second cycle hide behind the first while it is being fixed. So: one DFS per start node,
 * restricted to nodes that sort at or after the start, which pins each cycle to its
 * lexicographically smallest member and enumerates it exactly once. src is ~120 modules and the
 * graph is nearly acyclic, so the cost is nil.
 */
function findCycles(graph: Map<string, string[]>): string[][] {
  const nodes = [...graph.keys()].sort();
  const cycles: string[][] = [];
  for (const start of nodes) {
    const path: string[] = [];
    const onPath = new Set<string>();
    const visit = (node: string): void => {
      path.push(node);
      onPath.add(node);
      for (const next of graph.get(node) ?? []) {
        if (next === start) cycles.push([...path]);
        else if (next > start && !onPath.has(next)) visit(next);
      }
      path.pop();
      onPath.delete(node);
    };
    visit(start);
  }
  return cycles;
}

/** Rotation-independent identity for a cycle: its member set, sorted. A -> B -> A === B -> A -> B. */
function cycleKey(cycle: string[]): string {
  return [...new Set(cycle)].sort().join(" + ");
}

/**
 * The three runtime cycles src/model has today, all of them in the electronics stack and all of
 * them being taken apart right now. They are here so the rule can be on while the work lands.
 *
 * DELETE ONLY. When a cycle is broken its entry goes; nothing is ever appended to this list. A new
 * cycle failing this test is the test doing its job — untangle the import, do not record it here.
 */
/**
 * Empty, and meant to stay that way.
 *
 * This held three cycles when the rule was written — electronics-routing knotted with netlist,
 * electronics-parts and net-routing. All three were the same shape: the router owned the shared
 * geometry, so anything that needed a width or a landing imported the router, and the router imported
 * it back. They came apart when that geometry moved to leaf modules (trace-geometry, trace-types,
 * tape-width, pad-landing, corridor, part-fit), and the knot went with it.
 *
 * Each was "safe" only because every imported name happened to be a function declaration read inside a
 * function body rather than at module-evaluation time. That is not a property a call site can see, and
 * it is one edit away from being false. Break a new cycle; do not add an entry here.
 */
const ALLOWED_CYCLES: string[] = [];

/**
 * Files already over the 1200-line limit, each budgeted at the length it had when this rule was
 * written. A listed file may not grow past its budget; everything else must stay under 1200.
 *
 * 1200 is not a style preference. It is roughly the point past which nobody reads the file before
 * editing it, and every one of these four has already produced a bug from exactly that.
 *
 * SHRINK AND DELETE. A number here may only ever go down, and the entry goes when the file drops
 * under 1200. Raising one to make a commit pass is the failure mode this rule exists to catch.
 */
const SIZE_BUDGETS: Record<string, number> = {
  "view/electronics-modal.ts": 2958,
  // 3,636 -> 1,692 as the geometry, scoring, widths, landings, corridor and part
  // fitting moved out. What is left is planRoutes and the bus it lays; getting under
  // the limit means splitting that function, not moving more helpers.
  "model/electronics-routing.ts": 1692,
    "model/copper-svg-export.ts": 1862,
  "pipeline/unfold.ts": 1252,
};

const LINE_LIMIT = 1200;

/** wc -l semantics: a trailing newline does not open a new line. */
function lineCount(source: string): number {
  return source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

describe("architecture: module health", () => {
  it("R11: src/model has no runtime import cycles beyond the ones being removed", () => {
    const cycles = findCycles(runtimeGraph()).filter((c) =>
      c.some((f) => f.startsWith("model/")),
    );
    const unexpected = cycles
      .filter((c) => !ALLOWED_CYCLES.includes(cycleKey(c)))
      .map((c) => `${c.join(" → ")} → ${c[0]}`);
    expect(
      unexpected,
      `new runtime import cycle(s) — break the cycle, do not add to ALLOWED_CYCLES:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("R12: no src file exceeds 1200 lines (generated files and budgeted offenders aside)", () => {
    const bad: string[] = [];
    const shrunk: string[] = [];
    for (const abs of walk(SRC)) {
      const file = srcKey(abs);
      // Generated modules are machine output — nobody reads them, and their length is the
      // generator's business (footprints.rest.generated.ts is 8800 lines of pad tables).
      if (/\.generated\.ts$/.test(file)) continue;
      const lines = lineCount(readFileSync(abs, "utf8"));
      const budget = SIZE_BUDGETS[file];
      if (budget === undefined) {
        if (lines > LINE_LIMIT) bad.push(`${file}: ${lines} lines > ${LINE_LIMIT}`);
      } else if (lines > budget) {
        bad.push(`${file}: ${lines} lines > recorded budget ${budget} — split it, do not raise it`);
      } else if (lines <= LINE_LIMIT) {
        shrunk.push(`${file}: now ${lines} lines — delete its SIZE_BUDGETS entry`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(shrunk, shrunk.join("\n")).toEqual([]);
  });

  it("R13: generated footprint modules are reached through their facades, not directly", () => {
    // src/model/footprint.ts re-exports the Component/Footprint/Pad types and src/model/library.ts
    // joins both generated halves into LIBRARY + componentById/footprintById. Importing
    // footprints.generated.js from outside model/ skips that join, which is how the app used to
    // offer parts from the half the router could not resolve. Callers outside the model take the
    // facades; only model/ may touch the raw generated data.
    //
    // Empty, and meant to stay that way. Two view files used to pull part constants straight out of
    // the generated module; they now take `Component` from model/footprint.js and the named parts
    // from model/library.js, which re-exports them for exactly this reason. Reroute a new offender
    // through the facade; never add an entry here.
    const DIRECT_GENERATED_IMPORTS: string[] = [];
    const bad: string[] = [];
    for (const abs of walk(SRC)) {
      const file = srcKey(abs);
      if (file.startsWith("model/")) continue;
      if (DIRECT_GENERATED_IMPORTS.includes(file)) continue;
      const source = readFileSync(abs, "utf8");
      const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
      for (let m = re.exec(source); m; m = re.exec(source)) {
        const spec = m[1] ?? m[2];
        if (/\.generated\.js$/.test(spec)) bad.push(`${file} → ${spec}`);
      }
    }
    expect(
      bad,
      `import through model/library.js or model/footprint.js instead:\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  it("R14: no iCloud conflict duplicates are tracked under src/ or tests/", () => {
    // This repo lives in an iCloud-synced ~/Documents, and iCloud resolves a sync collision by
    // writing "foo 2.ts" beside "foo.ts". Such copies have been committed before: stale, imported
    // by nothing, their tests never run, and indistinguishable from real code in a grep. Ask git
    // rather than walking the disk — an untracked local conflict file is iCloud's noise, but a
    // tracked one has shipped.
    const tracked = execFileSync("git", ["ls-files", "src", "tests"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const duplicates = tracked.filter((f) => / \d+\.tsx?$/.test(f));
    expect(duplicates, `iCloud conflict copies committed:\n${duplicates.join("\n")}`).toEqual([]);
  });
});
