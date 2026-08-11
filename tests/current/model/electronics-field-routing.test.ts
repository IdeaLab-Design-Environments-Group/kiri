import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planRoutesFreeform } from "../../../src/model/electronics-field-routing.js";
import { type Circuit, type Vec2, gapGraph, segsProperlyIntersect } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";

/** A 1×3 row of unit tiles: two hinges, so two LEDs and one shared bus. */
function row3(): FoldFile {
  return {
    vertices_coords: [[0, 0], [10, 0], [10, 10], [0, 10], [20, 0], [20, 10], [30, 0], [30, 10]],
    faces_vertices: [[0, 1, 2, 3], [1, 4, 5, 2], [4, 6, 7, 5]],
    edges_vertices: [[1, 2], [4, 5]],
    edges_assignment: ["M", "M"],
  };
}
/** A 2×2 block: four hinges meeting at the centre vertex — the hard case for crossings. */
function block2x2(): FoldFile {
  return {
    vertices_coords: [[0, 0], [10, 0], [20, 0], [0, 10], [10, 10], [20, 10], [0, 20], [10, 20], [20, 20]],
    faces_vertices: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]],
    edges_vertices: [[1, 4], [4, 5], [3, 4], [4, 7]],
    edges_assignment: ["M", "M", "M", "M"],
  };
}
const circuit = (over: Partial<Circuit>): Circuit => ({ leds: [], battery: null, ...over });

/** The bundled models are the only fixtures irregular enough to exercise the keep-outs — the toy grids
 *  below happen to satisfy them by construction, so they cannot tell a working keep-out from a missing
 *  one. Same loader the sim tests use. */
function loadExample(name: string): FoldFile {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/examples/${name}`, import.meta.url)), "utf8"));
}
const allLeds = (f: FoldFile) =>
  gapGraph(f).gaps.map((g) => ({ a: Math.min(g.faceA, g.faceB), b: Math.max(g.faceA, g.faceB) }));

/** Is every pad of `net` joined to that net's terminal through shared trace vertices? */
function netIsConnected(
  traces: { net: string; points: Vec2[] }[],
  terminal: Vec2,
  pads: Vec2[],
  net: string,
): boolean {
  const key = (p: Vec2) => `${p.x},${p.y}`;
  const adj = new Map<string, string[]>();
  const link = (a: Vec2, b: Vec2) => {
    const k = key(a);
    (adj.get(k) ?? adj.set(k, []).get(k)!).push(key(b));
  };
  for (const t of traces) {
    if (t.net !== net) continue;
    for (let i = 1; i < t.points.length; i++) { link(t.points[i - 1]!, t.points[i]!); link(t.points[i]!, t.points[i - 1]!); }
  }
  const seen = new Set([key(terminal)]);
  const stack = [key(terminal)];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  return pads.every((p) => seen.has(key(p)));
}

const crossings = (traces: { net: string; points: Vec2[] }[], a: string, b: string): number => {
  const seg = (net: string) => {
    const out: [Vec2, Vec2][] = [];
    for (const t of traces) {
      if (t.net !== net) continue;
      for (let i = 1; i < t.points.length; i++) out.push([t.points[i - 1]!, t.points[i]!]);
    }
    return out;
  };
  const A = seg(a), B = seg(b);
  let n = 0;
  for (const [p, q] of A) {
    for (const [r, s] of B) {
      if (a === b && p === r && q === s) continue;
      if (segsProperlyIntersect(p, q, r, s)) n++;
    }
  }
  return n;
};

describe("model/electronics-field-routing: unrestricted router", () => {
  it("connects every pad of a net to that net's terminal", () => {
    // The whole point of a net: the copper has to be electrically common. A Euclidean MST over
    // terminal + pads spans by construction, so this is a guard against the tree being built wrong.
    const fold = block2x2();
    const leds = allLeds(fold);
    const r = planRoutesFreeform(fold, circuit({ battery: { face: 1 }, leds }));
    expect(r.unreachable).toEqual([]);
    const live = r.ledPads.filter((_, i) => !r.unreachable.includes(i));
    expect(netIsConnected(r.traces, r.terminals!.pwr, live.map((p) => p.pwr), "pwr")).toBe(true);
    expect(netIsConnected(r.traces, r.terminals!.gnd, live.map((p) => p.gnd), "gnd")).toBe(true);
  });

  it("never lets a net cross itself", () => {
    // A Euclidean minimum spanning tree in the plane is planar. That is the property the paper gets from
    // integral curves of a tangent field — no two conductors of one layer may meet — obtained here from
    // the MST instead, because a net (unlike their independent drive lines) has to be connected.
    for (const fold of [row3(), block2x2()]) {
      const r = planRoutesFreeform(fold, circuit({ battery: { face: 0 }, leds: allLeds(fold) }));
      expect(crossings(r.traces, "pwr", "pwr")).toBe(0);
      expect(crossings(r.traces, "gnd", "gnd")).toBe(0);
    }
  });

  it("beats the fan construction on both crossings and copper", () => {
    // "fan" is the paper's construction taken literally on a planar domain: with a single sink at the
    // terminal, the integral curves of the field are straight radial lines. It keeps the no-self-crossing
    // property but every pad gets its own full-length run, and two fans from two different centres cross
    // each other constantly.
    const fold = block2x2();
    const leds = allLeds(fold);
    const mst = planRoutesFreeform(fold, circuit({ battery: { face: 1 }, leds }), { style: "mst" });
    const fan = planRoutesFreeform(fold, circuit({ battery: { face: 1 }, leds }), { style: "fan" });
    const len = (r: typeof mst) => r.traces.reduce((s, t) => {
      let l = 0;
      for (let i = 1; i < t.points.length; i++) l += Math.hypot(t.points[i]!.x - t.points[i - 1]!.x, t.points[i]!.y - t.points[i - 1]!.y);
      return s + l;
    }, 0);
    expect(crossings(mst.traces, "pwr", "gnd")).toBeLessThanOrEqual(crossings(fan.traces, "pwr", "gnd"));
    expect(len(mst)).toBeLessThan(len(fan));
  });

  it("reports pads that match the polarity it chose, and strands only gapless LEDs", () => {
    const fold = row3();
    // {0,2} share no edge, so there is no gap for it and no pads to land on.
    const r = planRoutesFreeform(fold, circuit({ battery: { face: 0 }, leds: [{ a: 0, b: 1 }, { a: 0, b: 2 }] }));
    expect(r.unreachable).toEqual([1]);
    const gap = gapGraph(fold).gaps.find((g) => g.faceA === 0 && g.faceB === 1)!;
    const pads = r.ledPads[0]!;
    const same = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9;
    const straddles = (same(pads.pwr, gap.legA) && same(pads.gnd, gap.legB)) ||
      (same(pads.pwr, gap.legB) && same(pads.gnd, gap.legA));
    expect(straddles).toBe(true);
  });

  it("never runs over an LED, on a model where that takes work", () => {
    // "Over the LED" means across the chip: the segment joining its two pads. Stated as a crossing rather
    // than a clearance radius on purpose — a radius wide enough to matter also forbids the stub that has
    // to *land* on a pad, since a pad cannot be reached without passing close to the chip beside it.
    //
    // Measured on puffin: 1 LED-body crossing with the keep-outs off, 0 with them on. The toy grids in this
    // file cannot show that — stepping each net off the pad line already clears the chips there.
    const fold = loadExample("puffin.fkld");
    const gaps = gapGraph(fold).gaps.slice(0, 12);
    const leds = gaps.map((g) => ({ a: Math.min(g.faceA, g.faceB), b: Math.max(g.faceA, g.faceB) }));
    const r = planRoutesFreeform(fold, circuit({ battery: { face: 0 }, leds }));
    let over = 0;
    for (const t of r.traces) {
      for (let i = 1; i < t.points.length; i++) {
        for (const g of gaps) {
          if (segsProperlyIntersect(t.points[i - 1]!, t.points[i]!, g.legA, g.legB)) over++;
        }
      }
    }
    expect(over).toBe(0);
  });

  it("never runs across a cut line or off the sheet", () => {
    // Not an aesthetic rule: the cutter severs tape laid over a `C` cut, and past the `B` silhouette there
    // is no sheet to stick to. Fold hinges are deliberately NOT protected — crossing those is the point of
    // this router, and costs durability rather than continuity.
    //
    // Measured on puffin: 16 cut crossings with the keep-outs off, 0 with them on.
    const fold = loadExample("puffin.fkld");
    const gaps = gapGraph(fold).gaps.slice(0, 12);
    const leds = gaps.map((g) => ({ a: Math.min(g.faceA, g.faceB), b: Math.max(g.faceA, g.faceB) }));
    const r = planRoutesFreeform(fold, circuit({ battery: { face: 0 }, leds }));

    const pts = (fold.vertices_coords ?? []).map((c) => ({ x: Number(c[0]) || 0, y: Number(c[1]) || 0 }));
    const roles = (fold.edges_assignment as string[] | undefined) ?? [];
    const cuts = (fold.edges_vertices ?? [])
      .map((e, i) => ({ e, role: roles[i] ?? "B" }))
      .filter((x) => x.role === "C" || x.role === "B")
      .map((x) => [pts[x.e[0]!]!, pts[x.e[1]!]!] as const)
      .filter(([a, b]) => a && b);

    let across = 0;
    for (const t of r.traces) {
      for (let i = 1; i < t.points.length; i++) {
        for (const [ca, cb] of cuts) {
          if (segsProperlyIntersect(t.points[i - 1]!, t.points[i]!, ca, cb)) across++;
        }
      }
    }
    expect(across).toBe(0);
  });

  it("emits each net as continuous strips, not one piece per tree edge", () => {
    // This is what made the tape read as a row of angular blocks. The bus turns at every pad, and
    // `tapeRibbon` can only bevel a bend *inside* one polyline — so a turn between two separate traces was
    // left as an unfilled notch, which looks exactly like a hard corner. Carrying the strip on through the
    // pad fills the joint and means fewer pieces to lay.
    //
    // On this fixture each net's tree is a simple path, so each net should be a single trace. Per-edge
    // emission gave three traces per net and four unbevelled joints.
    const fold = row3();
    const r = planRoutesFreeform(fold, circuit({ battery: { face: 0 }, leds: allLeds(fold) }));
    expect(r.traces.filter((t) => t.net === "pwr")).toHaveLength(1);
    expect(r.traces.filter((t) => t.net === "gnd")).toHaveLength(1);
    // And it really is a run through the pads, not a two-point hop.
    for (const t of r.traces) expect(t.points.length).toBeGreaterThanOrEqual(3);

    // No two trace ends may coincide: a shared end is a joint the ribbon cannot bevel.
    const ends = new Map<string, number>();
    for (const t of r.traces) {
      for (const p of [t.points[0]!, t.points[t.points.length - 1]!]) {
        const k = `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
        ends.set(k, (ends.get(k) ?? 0) + 1);
      }
    }
    expect([...ends.values()].filter((n) => n > 1)).toHaveLength(0);
  });

  it("is deterministic", () => {
    const fold = block2x2();
    const leds = allLeds(fold);
    const a = planRoutesFreeform(fold, circuit({ battery: { face: 1 }, leds }));
    const b = planRoutesFreeform(fold, circuit({ battery: { face: 1 }, leds }));
    expect(b.traces).toEqual(a.traces);
    expect(b.ledPads).toEqual(a.ledPads);
  });
});
