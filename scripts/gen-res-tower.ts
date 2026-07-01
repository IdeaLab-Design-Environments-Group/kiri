/**
 * Regenerate the bundled Miyamoto RES square-tower examples from Yoshinobu Miyamoto's crease
 * pattern, by running the 1:1 Origami Simulator SVG importer (`src/sim/svg-import.ts`) over the
 * original asset `public/examples/miyamotoTower.svg` (copied verbatim from
 * amandaghassaei/OrigamiSimulator `assets/Kirigami/miyamotoTower.svg`). Replaces the old offline
 * `svg2fold.py`: both examples now come from the same ported loadSVG logic the app uses.
 *
 * Two variants (see raw/kirigamizer-svg-import-2026-06.md):
 *   • res-square-tower.fkld        — FAITHFUL full import (paths in: 20 M / 56 V). The full RES
 *     crease set is flat-foldable, so it free-folds ISOMETRICALLY into a flat layer stack — exactly
 *     Origami Simulator's dynamic-solver behaviour. The tall tower is a guided rigid-kinematic branch.
 *   • res-square-tower-erect.fkld  — LINE-ONLY import (includePaths:false: 8 M / 24 V, like the old
 *     svg2fold.py). Over-constrained, so it free-ERECTS into a visible tower (h/w ≈ 0.52).
 *
 * Run headless:  npx vite-node scripts/gen-res-tower.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importOrigamiSimulatorSvg } from "../src/sim/svg-import.js";
import { buildScene } from "../src/sim/scene.js";
import type { FoldFile } from "../src/model/fold-file.js";

const root = resolve(import.meta.dirname, "..");
const svg = readFileSync(resolve(root, "public/examples/miyamotoTower.svg"), "utf8");

interface Variant {
  out: string;
  includePaths: boolean;
  title: string;
  expectErect: boolean;
}

const VARIANTS: Variant[] = [
  {
    out: "res-square-tower.fkld",
    includePaths: true,
    title: "RES Square Tower — Yoshinobu Miyamoto (kirigami, faithful OS import, free fold)",
    expectErect: false,
  },
  {
    out: "res-square-tower-erect.fkld",
    includePaths: false,
    title: "RES Square Tower — Yoshinobu Miyamoto (kirigami, line-only, free-erects)",
    expectErect: true,
  },
];

for (const v of VARIANTS) {
  const imported = importOrigamiSimulatorSvg(svg, {
    recenter: true,
    includePaths: v.includePaths,
    title: v.title,
    creator: "kirigamizer: Origami Simulator SVG → FOLD (svg-import.ts, 1:1 loadSVG port)",
    author: "Yoshinobu Miyamoto (pattern); imported from Origami Simulator SVG",
    description:
      "RES Square Tower kirigami crease pattern by Yoshinobu Miyamoto. Source SVG: " +
      "amandaghassaei/OrigamiSimulator assets/Kirigami/miyamotoTower.svg. Imported via the kirigamizer " +
      `1:1 port of Origami Simulator's loadSVG (${v.includePaths ? "faithful, <path> creases in" : "line-only, <path> creases dropped"}); ` +
      "stroke opacity 0.5 → M −90° / V +90°; free-fold.",
    unit: "mm",
  });

  const { stats, ...fold } = imported;
  (fold as Record<string, unknown>)["fkld:source"] = {
    origin: "amandaghassaei/OrigamiSimulator",
    asset: "assets/Kirigami/miyamotoTower.svg",
    importer: "src/sim/svg-import.ts (1:1 pattern.js loadSVG port)",
    variant: v.includePaths ? "faithful-full" : "line-only",
    foldMode: "free",
    angleEncoding: "stroke-opacity → ±opacity·π (0.5 ⇒ ±90°)",
  };

  writeFileSync(resolve(root, "public/examples", v.out), JSON.stringify(fold), "utf8");

  console.log(`\n${v.out}  (${v.includePaths ? "faithful" : "line-only"})`);
  console.log(`  vertices=${stats.vertices} faces=${stats.faces}  M=${stats.mountains} V=${stats.valleys} F=${stats.facets} C=${stats.cuts} B=${stats.borders}`);

  // Free-fold sanity check (no collision — fast; matches the headless tests).
  const built = buildScene(fold as FoldFile);
  if (!built) throw new Error(`buildScene returned null for ${v.out}`);
  const { model, solver } = built.scene;
  for (let k = 1; k <= 10; k++) solver.solve(6000, k / 10);
  solver.solve(20000, 1.0);

  let zLo = Infinity, zHi = -Infinity, xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity, strain = 0;
  for (let i = 0; i < model.numNodes; i++) {
    const x = model.position[3 * i], y = model.position[3 * i + 1], z = model.position[3 * i + 2];
    zLo = Math.min(zLo, z); zHi = Math.max(zHi, z); xLo = Math.min(xLo, x); xHi = Math.max(xHi, x); yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
  }
  for (let i = 0; i < model.beams.count; i++) {
    const a = model.beams.n0[i], b = model.beams.n1[i];
    const l = Math.hypot(model.position[3 * a] - model.position[3 * b], model.position[3 * a + 1] - model.position[3 * b + 1], model.position[3 * a + 2] - model.position[3 * b + 2]);
    strain += Math.abs(l / model.beams.rest[i] - 1);
  }
  strain /= Math.max(1, model.beams.count);
  const h = zHi - zLo, w = Math.max(xHi - xLo, yHi - yLo);
  let finite = true;
  for (let i = 0; i < model.position.length; i++) if (!Number.isFinite(model.position[i])) finite = false;
  const ok = finite && (v.expectErect ? h > 0.4 * w : strain < 0.05 && h < 0.3 * w);
  console.log(`  free fold: h/w=${(h / w).toFixed(3)}  barStrain=${(strain * 100).toFixed(2)}%  finite=${finite}`);
  console.log(`  ${ok ? "✓" : "✗"} ${v.expectErect ? "erects into a visible tower" : "folds isometrically (flat stack — faithful OS dynamic-solver behaviour)"}`);
}
