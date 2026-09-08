import { readFileSync } from "node:fs";
import { type Led, flatFaces, gapGraph, ledOf, pointInFace } from "../src/model/electronics.js";
import { patternDiag, planRoutes, totalLength } from "../src/model/electronics-routing.js";
import { DEFAULT_SHEET } from "../src/model/fold-strain.js";
const EX = new URL("../public/examples/", import.meta.url).pathname;
function load(n: string) { const f = JSON.parse(readFileSync(`${EX}${n}`, "utf8")); const faces = flatFaces(f); return { faces, gaps: gapGraph(f, faces).gaps }; }
function ledsOn(gaps: any[], max: number): Led[] { const o: Led[] = []; const s = new Set<string>(); for (const g of gaps) { const l = ledOf(g.faceA, g.faceB); const k = `${l.a}_${l.b}`; if (s.has(k)) continue; s.add(k); o.push(l); if (o.length >= max) break; } return o; }
function crossings(name: string, n: number, creaseFrac: number | undefined, bandCap: number) {
  const { faces, gaps } = load(name);
  const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, n), battery: { face: 0 } }, undefined, DEFAULT_SHEET, creaseFrac, bandCap);
  const gapFor = new Map<string, any>(); for (const g of gaps) gapFor.set(`${Math.min(g.faceA, g.faceB)}_${Math.max(g.faceA, g.faceB)}`, g);
  const step = patternDiag(faces) / 3000; let tension = 0;
  for (const t of r.traces) { let last = -1;
    for (let i = 1; i < t.pts.length; i++) { const a = t.pts[i-1]!, b = t.pts[i]!;
      const m = Math.max(1, Math.ceil(Math.hypot(b.x-a.x, b.y-a.y)/step));
      for (let k = 0; k <= m; k++) { const p = { x: a.x+((b.x-a.x)*k)/m, y: a.y+((b.y-a.y)*k)/m };
        const f = pointInFace(faces, p); if (f < 0) continue;
        if (last >= 0 && f !== last) { const g = gapFor.get(`${Math.min(f,last)}_${Math.max(f,last)}`);
          if (g && (g.dihedral != null ? g.dihedral > 0 : g.assignment === "M")) tension++; }
        last = f; } } }
  return { tension, len: +totalLength(r.traces).toFixed(2) };
}
for (const [label, cf, bc] of [["length-only, bands off", 0, 0], ["length-only, bands ON", 0, 2],
                                ["priced, bands off", undefined, 0], ["priced, bands ON", undefined, 2]] as const) {
  const r = crossings("church.fkld", 12, cf as any, bc as number);
  console.log(`church 12 LEDs  ${String(label).padEnd(24)} tension=${r.tension}  copper=${r.len}`);
}
