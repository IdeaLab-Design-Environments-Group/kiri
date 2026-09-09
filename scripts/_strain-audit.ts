/**
 * What strain the model attributes to every crease in the bundled corpus, under each candidate for the
 * outer-fibre distance `c`, and how much of the corpus sits above the routing threshold. Read-only.
 *
 *   npx vite-node scripts/_strain-audit.ts
 *
 * Each arm is computed end to end from its own SheetSpec, tape width included: `tapeWidthFor` reads the
 * sheet, and the pattern's millimetre scale is TAPE_MM over that width, so changing the foil thickness
 * moves the hinge widths in mm as well as the fibre distance. Comparing arms that share one scale would
 * hide half of what the change did.
 */
import { readFileSync, readdirSync } from "node:fs";
import { flatFaces, gapGraph } from "../src/model/electronics.js";
import { tapeWidthFor, TAPE_MM } from "../src/model/electronics-routing.js";
import {
  DEFAULT_SHEET, outerFibreMm, thresholdStrainFor, DESIGN_FOLD_CYCLES, COFFIN_MANSON_C,
  type SheetSpec,
} from "../src/model/fold-strain.js";
import type { FoldFile } from "../src/model/fold-file.js";

const EXAMPLES = new URL("../public/examples/", import.meta.url).pathname;
const EPS_F = DEFAULT_SHEET.routingThresholdStrain;

/** Folds at which the fatigue branch reaches `eps` — the inverse of the curve, for reporting. */
const FOLDS_AT = (eps: number, c: number = COFFIN_MANSON_C): number =>
  8.0e4 * (eps / 0.00478) ** (1 / c);

/** The transformed-section neutral axis: copper and substrate bending as one, adhesive a dead spacer. */
function compositeFibreMm(spec: SheetSpec): number {
  const n = spec.foilGPa / spec.substrateGPa;
  const h = spec.substrateMm, a = spec.adhesiveMm, t = spec.foilMm;
  const yBar = (h * (h / 2) + n * t * (h + a + t / 2)) / (h + n * t);
  return h + a + t - yBar;
}

const PRE = { ...DEFAULT_SHEET, foilMm: 0.035, adhesiveMm: 0 };   // what shipped before the datasheet
const ARMS: { name: string; spec: SheetSpec; fibre: (s: SheetSpec) => number }[] = [
  { name: "pre-datasheet", spec: PRE, fibre: outerFibreMm },
  { name: "shipped", spec: DEFAULT_SHEET, fibre: outerFibreMm },
  { name: "composite", spec: DEFAULT_SHEET, fibre: compositeFibreMm },
];

const FILES = readdirSync(EXAMPLES).filter((f) => f.endsWith(".fkld")).sort();
const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1] : NaN;
};

console.log(`eps_f = ${EPS_F.toFixed(4)}  (thresholdStrainFor(${DESIGN_FOLD_CYCLES}) design folds)`);
console.log("the strain-life curve it comes off, and the exponent range around it:");
console.log("  folds      c=-0.5     c=-0.6     c=-0.7   (capped at the foil's elongation at break)");
for (const n of [1, 10, 100, 1e3, 1e4, 1e5]) {
  const cell = (c: number): string => (100 * thresholdStrainFor(n, c)).toFixed(2).padStart(8) + "%";
  console.log(`  ${String(n).padEnd(8)} ${cell(-0.5)}   ${cell(-0.6)}   ${cell(-0.7)}`);
}
console.log(`  (a 1% threshold, which is what this shipped until 2026-09-09, is ` +
  `${(FOLDS_AT(0.01, -0.7) / 1000).toFixed(1)}-${(FOLDS_AT(0.01, -0.5) / 1000).toFixed(1)}k folds)\n`);

console.log(`corpus: ${FILES.length} bundled patterns; eps_f = ${EPS_F.toFixed(4)}\n`);
console.log("arm             c (mm)   hinge w (mm)          median |th|   median eps   over eps_f   theta_sat");
for (const arm of ARMS) {
  const c = arm.fibre(arm.spec);
  const ws: number[] = [], degs: number[] = [], eps: number[] = [];
  for (const file of FILES) {
    const fold = JSON.parse(readFileSync(EXAMPLES + file, "utf8")) as FoldFile;
    let faces, gaps, tapeW;
    try {
      faces = flatFaces(fold);
      gaps = gapGraph(fold, faces).gaps;
      tapeW = tapeWidthFor(faces, undefined, arm.spec);
    } catch { continue; }
    if (!(tapeW > 0)) continue;
    const mmPerUnit = TAPE_MM / tapeW;
    for (const g of gaps as any[]) {
      if (g.dihedral == null) continue;
      const w = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
      if (!(w > 0)) continue;
      ws.push(w);
      degs.push(Math.abs(g.dihedral));
      if (g.dihedral > 0.01) eps.push((c * (g.dihedral * Math.PI)) / 180 / w);
    }
  }
  const over = eps.filter((e) => e > EPS_F).length;
  console.log(
    `${arm.name.padEnd(14)} ${c.toFixed(4).padStart(6)}   `
    + `${(Math.min(...ws).toFixed(2) + "-" + Math.max(...ws).toFixed(2)).padStart(12)} med ${med(ws).toFixed(2)}   `
    + `${med(degs).toFixed(1).padStart(9)}   ${(100 * med(eps)).toFixed(2).padStart(9)}%   `
    + `${((100 * over) / eps.length).toFixed(1).padStart(8)}%   `
    + `${(((EPS_F * med(ws)) / c) * (180 / Math.PI)).toFixed(1).padStart(6)} deg`,
  );
  if (arm === ARMS[0]) console.log(`                (${eps.length} tensile of ${ws.length} creases with a measured hinge)`);
}
