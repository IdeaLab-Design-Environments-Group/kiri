import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The 3D subsystem's blast radius.
 *
 * three.js and the solver are a third of a megabyte, and they are fetched only when the simulation is opened.
 * That is what keeps the rest of the app working — and loading at all — when they cannot be fetched: the
 * editor, the router and the exports never touch them. The guarantee is easy to lose by accident, though. One
 * ordinary-looking `import` from a shared module drags three.js into the main bundle, and then a broken 3D
 * dependency stops being "the simulation is unavailable" and becomes a blank page.
 *
 * So the boundary is asserted rather than assumed.
 */
const SRC = new URL("../../../src/", import.meta.url).pathname;

/** Files allowed to import three.js: the 3D view itself and the GPU solver behind it. */
const THREE_D = ["view/sim-canvas.ts", "sim/gpu/"];

function sources(dir = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = dir + name;
    if (statSync(full).isDirectory()) sources(full + "/", out);
    else if (name.endsWith(".ts")) out.push(full.slice(SRC.length));
  }
  return out;
}

/** Only real imports — a mention of "three" in prose does not pull in a megabyte. */
function importsOf(rel: string): string[] {
  const text = readFileSync(SRC + rel, "utf8");
  return [...text.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm)]
    .filter((m) => !/^\s*import\s+type\s/.test(m[0])) // types are erased; they cost nothing at runtime
    .map((m) => m[1]!);
}

describe("view/sim boundary", () => {
  it("keeps three.js inside the 3D subsystem", () => {
    const leaks = sources()
      .filter((f) => !THREE_D.some((allowed) => f.startsWith(allowed)))
      .filter((f) => importsOf(f).some((i) => i === "three" || i.startsWith("three/")));
    expect(leaks, `these modules would pull three.js into the main bundle: ${leaks.join(", ")}`)
      .toEqual([]);
  });

  it("reaches the 3D view only through the interface, and only on demand", () => {
    // A static `import { SimCanvas }` anywhere would defeat the code split however careful the rest is:
    // the chunk would be in the main bundle, fetched on page load, whether or not the sim is ever opened.
    const statics = sources()
      .filter((f) => f !== "view/sim-canvas.ts")
      .filter((f) => importsOf(f).some((i) => i.includes("sim-canvas")));
    expect(statics, `these modules import the 3D view eagerly: ${statics.join(", ")}`).toEqual([]);

    // And the modal holds the interface, not the class.
    const modal = readFileSync(SRC + "view/sim-modal.ts", "utf8");
    expect(modal).toContain("import type { SimView }");
    // Fetched with a dynamic import — the form does not matter, only that it is not a static one.
    expect(modal).toMatch(/[^.\w]import\(\s*(\/\*[^*]*\*\/\s*)?[`"']\.\/sim-canvas/);
  });

  it("keeps the boundary itself free of 3D dependencies", () => {
    // `sim-view.ts` is imported by the app side, so anything it pulls in is loaded whether or not the
    // simulation is ever opened. It may only name types.
    const runtime = importsOf("view/sim-view.ts");
    expect(runtime).toEqual([]);
  });
});
