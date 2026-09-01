/**
 * Bands off against bands on, on this project's own patterns.
 *
 * Same router, same patterns, same LEDs; the only difference is whether `searchCorridor` minimises the worst
 * crease band before it minimises cost. Crossings are detected the way `crease-price.test.ts` detects them --
 * by watching which face each sampled point falls in and looking up the gap when it changes -- because
 * proximity to a gap's midpoint misses a trace that crosses the same crease further along it.
 *
 *   npx tsx scripts/bench-band.ts
 */
import { readFileSync } from "node:fs";
import { type Led, flatFaces, gapGraph, ledOf, pointInFace } from "../src/model/electronics.js";
import { patternDiag, planRoutes, totalLength } from "../src/model/electronics-routing.js";
import { DEFAULT_SHEET, STRAIN_BAND_CAP, foldStrain, strainBand } from "../src/model/fold-strain.js";
import { TAPE_MM, tapeWidthFor } from "../src/model/tape-width.js";

const EXAMPLES = new URL("../public/examples/", import.meta.url).pathname;
const PATTERNS = ["house.fkld", "church.fkld", "akde-hex.fkld", "akde-square-pyramid.fkld",
                  "akde-decagon-pyramid.fkld", "puffin.fkld"];
const LEDS = 12;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  return { faces, gaps: gapGraph(fold, faces).gaps };
}

function ledsOn(gaps: { faceA: number; faceB: number }[], max: number): Led[] {
  const out: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

function score(name: string, bandCap: number, sheet = DEFAULT_SHEET) {
  const { faces, gaps } = load(name);
  const leds = ledsOn(gaps, LEDS);
  const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } },
                       undefined, sheet, undefined, bandCap);
  const gapFor = new Map<string, (typeof gaps)[number]>();
  for (const g of gaps) gapFor.set(`${Math.min(g.faceA, g.faceB)}_${Math.max(g.faceA, g.faceB)}`, g);
  const tapeW = tapeWidthFor(faces);
  const mmPerUnit = tapeW > 0 ? TAPE_MM / tapeW : 0;
  const step = patternDiag(faces) / 3000;

  let tension = 0, fatiguing = 0, worst = 0;
  for (const t of r.traces) {
    let last = -1;
    for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1]!, b = t.pts[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 0; k <= n; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
        const f = pointInFace(faces, p);
        if (f < 0) continue;
        if (last >= 0 && f !== last) {
          const g = gapFor.get(`${Math.min(f, last)}_${Math.max(f, last)}`);
          if (g) {
            const isTension = g.dihedral != null ? g.dihedral > 0 : g.assignment === "M";
            if (isTension) {
              tension++;
              const hingeMm = Math.hypot(g.legB.x - g.legA.x, g.legB.y - g.legA.y) * mmPerUnit;
              const deg = g.dihedral ?? 180;
              if (foldStrain(hingeMm, deg, sheet) > sheet.fatigueStrain) fatiguing++;
              worst = Math.max(worst, strainBand(hingeMm, deg, sheet, undefined, 99));
            }
          }
        }
        last = f;
      }
    }
  }
  return { tension, fatiguing, worst, len: +totalLength(r.traces).toFixed(2) };
}

/** The shipped stack, and a thin film. On 0.4mm the copper passes its fatigue strain at about 7 degrees of
 *  fold, so every crossing is already lost and the bands collapse to one; at 0.05mm the limit moves to about
 *  19 degrees and shallow folds become genuinely survivable, which is the only regime where minimising the
 *  worst crossing has anything to choose between. */
const SHEETS: [string, typeof DEFAULT_SHEET][] = [
  ["shipped 0.40mm", DEFAULT_SHEET],
  ["film    0.05mm", { ...DEFAULT_SHEET, substrateMm: 0.05 }],
];

for (const [label, sheet] of SHEETS) {
console.log(`\n=== ${label} ===`);
console.log("pattern                    |      bands off       |       bands on       | delta");
console.log("                           | tens fatig wrst copper| tens fatig wrst copper|");
for (const p of PATTERNS) {
  try {
    const off = score(p, 0, sheet);
    const on = score(p, STRAIN_BAND_CAP, sheet);
    const dt = off.tension ? Math.round(100 * (on.tension / off.tension - 1)) : 0;
    const dl = off.len ? Math.round(100 * (on.len / off.len - 1)) : 0;
    const f = (n: number, w: number) => String(n).padStart(w);
    console.log(
      `${p.padEnd(26)} |${f(off.tension, 5)}${f(off.fatiguing, 6)}${f(off.worst, 5)}${f(off.len, 7)} |` +
      `${f(on.tension, 5)}${f(on.fatiguing, 6)}${f(on.worst, 5)}${f(on.len, 7)} | ` +
      `tension ${dt >= 0 ? "+" : ""}${dt}%  copper ${dl >= 0 ? "+" : ""}${dl}%`);
  } catch (e) {
    console.log(`${p.padEnd(26)} | failed: ${(e as Error).message.slice(0, 50)}`);
  }
}
}
