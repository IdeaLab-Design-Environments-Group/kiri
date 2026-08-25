import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led, type Vec2 } from "../../../src/model/electronics.js";
import { planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { stripOutline } from "../../../src/model/copper-svg-export.js";
import { printScale } from "../../../src/model/print-scale.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const PATTERNS = [
  "akde-decagon-pyramid.fkld", "akde-hex.fkld", "akde-square-pyramid.fkld",
  "bistable-star-tiling.fkld", "church.fkld", "house.fkld", "kirigami-flap.fkld", "puffin.fkld",
];

function ledsOn(gaps: any[], max: number): Led[] {
  const leds: Led[] = []; const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB); const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue; seen.add(k); leds.push(l);
    if (leds.length >= max) break;
  }
  return leds;
}

function nets(name: string, n: number) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const circuit: Circuit = { leds: ledsOn(gaps, n), battery: { face: 0 } };
  const r = planRoutes(faces, gaps, circuit);
  const tapeW = tapeWidthFor(faces);
  const k = printScale(fold);
  const rings = (net: "pwr" | "gnd", pads = r.pads) =>
    r.traces.filter((t) => t.net === net)
      .map((t) => stripOutline(t, tapeW, pads).map((p) => ({ x: p.x * k, y: p.y * k })))
      .filter((ring) => ring.length >= 3);
  return { rings, leds: circuit.leds.length, pads: r.pads, tapeMm: tapeW * k };
}

function ptSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = b.x - a.x, ay = b.y - a.y, l2 = ax * ax + ay * ay;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / l2));
  return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t));
}
function segsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function segSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function inRing(p: Vec2, ring: Vec2[]): boolean {
  let w = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
  }
  return w;
}
function minDist(ps: Vec2[][], qs: Vec2[][]): number {
  let m = Infinity;
  for (const A of ps) for (const B of qs) {
    if (A.some((p) => inRing(p, B)) || B.some((p) => inRing(p, A))) return 0;
    for (let i = 0; i < A.length; i++) {
      const a = A[i]!, b = A[(i + 1) % A.length]!;
      for (let j = 0; j < B.length; j++) {
        m = Math.min(m, segSeg(a, b, B[j]!, B[(j + 1) % B.length]!));
        if (m === 0) return 0;
      }
    }
  }
  return m;
}

describe("probe", () => {
  it("diagnoses", () => {
    for (const n of [6]) {
      const rows: string[] = [];
      for (const name of PATTERNS) {
        try {
          const { rings, leds, pads, tapeMm } = nets(name, n);
          const A = rings("pwr"), B = rings("gnd");
          let why = "clear", where = "";
          outer: for (const a of A) for (const b of B) {
            if (a.some((p) => inRing(p, b))) { why = "pwr vertex inside gnd"; where = JSON.stringify(a.find((p)=>inRing(p,b))); break outer; }
            if (b.some((p) => inRing(p, a))) { why = "gnd vertex inside pwr"; where = JSON.stringify(b.find((p)=>inRing(p,a))); break outer; }
            for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
              if (segsCross(a[i]!, a[(i+1)%a.length]!, b[j]!, b[(j+1)%b.length]!)) { why = "edges cross"; where = JSON.stringify(a[i]); break outer; }
            }
          }
          const withPads = minDist(A, B);
          rows.push(`${name.padEnd(30)} leds=${leds} clear=${withPads.toFixed(4)} ${why} ${where} nPairs=${A.flatMap(a=>B.map(b=>minDist([a],[b]))).filter(d=>d===0).length}/${A.length*B.length} toPad=${where?Math.min(...pads.flatMap(q=>[Math.hypot(JSON.parse(where).x-q.pwr.x*printScale(JSON.parse(readFileSync(`${EXAMPLES}${name}`,"utf8"))),JSON.parse(where).y-q.pwr.y*printScale(JSON.parse(readFileSync(`${EXAMPLES}${name}`,"utf8")))),Math.hypot(JSON.parse(where).x-q.gnd.x*printScale(JSON.parse(readFileSync(`${EXAMPLES}${name}`,"utf8"))),JSON.parse(where).y-q.gnd.y*printScale(JSON.parse(readFileSync(`${EXAMPLES}${name}`,"utf8"))))])).toFixed(2):"-"}`);
        } catch (e) { rows.push(`${name} ERR ${e}`); }
      }
      console.log(`\n=== n=${n} ===\n` + rows.join("\n"));
    }
  }, 120000);
});
