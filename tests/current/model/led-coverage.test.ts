import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Led, type Vec2 } from "../../../src/model/electronics.js";
import { ledSeat, planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { partShape, stripOutline, type LedPads } from "../../../src/model/copper-svg-export.js";
import { printScale } from "../../../src/model/print-scale.js";
import { COMPONENTS } from "../../../src/model/footprints.generated.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const BY_ID = new Map(COMPONENTS.map((c) => [c.id, c.footprint]));

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  return { fold, faces, gaps, tapeW: tapeWidthFor(faces), k: printScale(fold) };
}

function ledsOn(gaps: ReturnType<typeof load>["gaps"], max: number, component?: string): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const key = `${l.a}_${l.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    leds.push(component === undefined ? l : { ...l, component });
    if (leds.length >= max) break;
  }
  return leds;
}

const inRing = (p: Vec2, ring: Vec2[]): boolean => {
  let w = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
  }
  return w;
};

const N = 19;

function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const ps = (p: Vec2, u: Vec2, v: Vec2): number => {
    const l2 = (v.x - u.x) ** 2 + (v.y - u.y) ** 2;
    if (l2 < 1e-18) return Math.hypot(p.x - u.x, p.y - u.y);
    const t = Math.max(0, Math.min(1, ((p.x - u.x) * (v.x - u.x) + (p.y - u.y) * (v.y - u.y)) / l2));
    return Math.hypot(p.x - (u.x + t * (v.x - u.x)), p.y - (u.y + t * (v.y - u.y)));
  };
  return Math.min(ps(a, c, d), ps(b, c, d), ps(c, a, b), ps(d, a, b));
}

function nearChipClearance(mid: Vec2, R: number, pwr: Vec2[][], gnd: Vec2[][]): number {
  const edges = (rings: Vec2[][]) => {
    const out: [Vec2, Vec2][] = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!;
      if (Math.hypot(a.x - mid.x, a.y - mid.y) < R || Math.hypot(b.x - mid.x, b.y - mid.y) < R) out.push([a, b]);
    }
    return out;
  };
  const ea = edges(pwr), eb = edges(gnd);
  let m = Infinity;
  for (const [a, b] of ea) for (const [c, d] of eb) m = Math.min(m, segSegDist(a, b, c, d));
  return m;
}

function padRect(lead: { a: Vec2; b: Vec2; width: number }) {
  const dx = lead.b.x - lead.a.x, dy = lead.b.y - lead.a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  return {
    c: { x: (lead.a.x + lead.b.x) / 2, y: (lead.a.y + lead.b.y) / 2 },
    across: { x: ux, y: uy }, acrossHalf: len / 2,
    along: { x: -uy, y: ux }, alongHalf: lead.width / 2,
    w: lead.width, h: len,
  };
}

function coverage(r: ReturnType<typeof padRect>, rings: Vec2[][]): number {
  let on = 0, total = 0;
  for (let i = 0; i < N; i++) {
    const s = (2 * (i + 0.5)) / N - 1;
    for (let j = 0; j < N; j++) {
      const t = (2 * (j + 0.5)) / N - 1;
      const p = {
        x: r.c.x + r.across.x * s * r.acrossHalf + r.along.x * t * r.alongHalf,
        y: r.c.y + r.across.y * s * r.acrossHalf + r.along.y * t * r.alongHalf,
      };
      total++;
      if (rings.some((ring) => inRing(p, ring))) on++;
    }
  }
  return on / total;
}

function measure(name: string, component: string, n = 6) {
  const { faces, gaps, tapeW, k } = load(name);
  const leds = ledsOn(gaps, n, component);
  const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
  const ringsOf = (net: "pwr" | "gnd") =>
    r.traces.filter((t) => t.net === net).map((t) => stripOutline(t, tapeW, r.pads).map((q) => ({ x: q.x * k, y: q.y * k })));
  const rings = { pwr: ringsOf("pwr"), gnd: ringsOf("gnd") };
  const out: { i: number; pwr: number; gnd: number; padW: number; padH: number }[] = [];
  r.pads.forEach((pad: LedPads, i: number) => {
    if (pad.pwr.x === 0 && pad.pwr.y === 0) return;
    const fp = BY_ID.get(pad.component ?? component)!;
    const sh = partShape(fp, { x: pad.pwr.x * k, y: pad.pwr.y * k }, { x: pad.gnd.x * k, y: pad.gnd.y * k })!;
    const rp = padRect(sh.leads[0]!), rg = padRect(sh.leads[1]!);
    const mid = { x: ((pad.pwr.x + pad.gnd.x) / 2) * k, y: ((pad.pwr.y + pad.gnd.y) / 2) * k };
    out.push({ i, pwr: coverage(rp, rings.pwr), gnd: coverage(rg, rings.gnd), padW: rp.w, padH: rp.h,
      xpwr: coverage(rp, rings.gnd), xgnd: coverage(rg, rings.pwr),
      clear: nearChipClearance(mid, 6, rings.pwr, rings.gnd) } as any);
  });
  return { r, out, tapeW, k };
}

describe("scratch", () => {
  it("measures", { timeout: 120000 }, () => {
    for (const comp of ["LED_1206", "LED_0603"]) {
      const seat = ledSeat(comp);
      console.log(`\n## ${comp}  seat=${JSON.stringify(seat)}`);
      for (const name of ["house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld"]) {
        const { r, out, tapeW, k } = measure(name, comp);
        console.log(`${name} tapeW=${tapeW.toFixed(4)} k=${k.toFixed(4)} tapeMm=${(tapeW*k).toFixed(3)} unreachable=[${r.unreachable}] traces=${r.traces.length}`);
        for (const o of out) {
          const a = o as any;
          console.log(`   LED${o.i + 1} pwr ${(o.pwr * 100).toFixed(0)}%  gnd ${(o.gnd * 100).toFixed(0)}%  cross ${(a.xpwr*100).toFixed(0)}/${(a.xgnd*100).toFixed(0)}%  clear ${a.clear.toFixed(3)}mm  pad ${o.padW.toFixed(3)}x${o.padH.toFixed(3)}mm`);
        }
      }
    }
    expect(true).toBe(true);
  });
});
