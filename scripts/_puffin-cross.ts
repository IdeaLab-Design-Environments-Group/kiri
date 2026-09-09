/** Net crossings on puffin against the routing threshold — is the new crossing a knee or a knife-edge? */
import { readFileSync } from "node:fs";
import { flatFaces, gapGraph, ledOf, type Led } from "../src/model/electronics.js";
import { planRoutes, countNetCrossings } from "../src/model/electronics-routing.js";
import { DEFAULT_SHEET } from "../src/model/fold-strain.js";
import type { FoldFile } from "../src/model/fold-file.js";

const EX = new URL("../public/examples/", import.meta.url).pathname;
const fold = JSON.parse(readFileSync(`${EX}puffin.fkld`, "utf8")) as FoldFile;
const faces = flatFaces(fold);
const gaps = gapGraph(fold, faces).gaps;
const leds: Led[] = [];
const seen = new Set<string>();
for (const g of gaps) {
  const l = ledOf(g.faceA, g.faceB);
  const k = `${l.a}_${l.b}`;
  if (seen.has(k)) continue;
  seen.add(k); leds.push(l);
  if (leds.length >= 12) break;
}
for (const eps of [0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05]) {
  const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined,
    { ...DEFAULT_SHEET, routingThresholdStrain: eps });
  console.log(`eps_f=${eps.toFixed(4)}  net crossings=${countNetCrossings(r.traces)}  traces=${r.traces.length}`);
}
