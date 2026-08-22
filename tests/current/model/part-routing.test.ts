/**
 * Placing ANY library part on a rail.
 *
 * The router used to know about two parts by name. It now reads how a part meets the rail off the part's
 * own footprint — one row of terminals and the rail runs along them, two rows and it steps across — so the
 * two it knew are no longer special. These tests are that claim, stated three ways: the generic reading
 * reproduces `RESISTOR` and `SPDT` exactly; a part the router has never heard of routes anyway; and a
 * circuit with no parts routes byte for byte as it did before any of this existed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import {
  RESISTOR_MM,
  SWITCH_GAP_MM,
  SWITCH_NECK_MM,
  SWITCH_ROW_MM,
  breakRuns,
  partFit,
  planRoutes,
  tapeWidthFor,
  totalLength,
} from "../../../src/model/electronics-routing.js";
import { printScale } from "../../../src/model/print-scale.js";
import { MM_PER_INCH, type Footprint } from "../../../src/model/footprint.js";
import { RESISTOR, SPDT } from "../../../src/model/parts.js";
import {
  C_1206,
  LED_1206,
  R_1206,
  R_2010,
  SW_PUSH,
  SW_SPDT,
} from "../../../src/model/footprints.generated.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house, and the midpoint of its PWR run — the fixture `resistor.test.ts` uses, for the same reasons. */
function fixture(leds = 1) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const seen = new Set<string>();
  const chosen = [];
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const key = `${l.a}_${l.b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(l);
    if (chosen.length >= leds) break;
  }
  const base: Circuit = { leds: chosen, battery: { face: 0 } };
  const plain = planRoutes(faces, gaps, base);
  const pwr = plain.traces.find((t) => t.net === "pwr")!;
  const mid = pwr.pts[Math.floor(pwr.pts.length / 2)]!;
  return { fold, faces, gaps, base, plain, mid, tapeW: tapeWidthFor(faces), k: printScale(fold) };
}

/** The midpoint of the longest run of a net — the roomiest spot a part can be dropped. */
function longestMid(traces: { net: string; pts: Vec2[] }[], net: "pwr" | "gnd" = "pwr"): Vec2 {
  const runLength = (t: { pts: Vec2[] }): number => {
    let s = 0;
    for (let i = 1; i < t.pts.length; i++) {
      s += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
    }
    return s;
  };
  const run = traces.filter((t) => t.net === net).sort((a, b) => runLength(b) - runLength(a))[0]!;
  return { x: (run.pts[0]!.x + run.pts.at(-1)!.x) / 2, y: (run.pts[0]!.y + run.pts.at(-1)!.y) / 2 };
}

/** A rectangular pad `w` x `h` millimetres, for footprints made up to test a shape the library lacks. */
function rect(w: number, h: number, x: number, y: number, index: number, hole = false) {
  const [hw, hh] = [w / 2 / MM_PER_INCH, h / 2 / MM_PER_INCH];
  return {
    shape: `M ${-hw} ${hh} L ${hw} ${hh} L ${hw} ${-hh} L ${-hw} ${-hh} L ${-hw} ${hh}`,
    pos: [x / MM_PER_INCH, y / MM_PER_INCH] as [number, number],
    layers: hole ? ["outline", "Thru.Hole"] : ["F.Cu", "F.Paste", "F.Mask"],
    index,
    ...(hole ? { drill: { diameter: 0.03, start: "F.Cu", end: "B.Cu", plated: true } } : {}),
  };
}

describe("model/part-routing", () => {
  it("reads the 1206 resistor's own fit off its footprint — the same numbers `RESISTOR` has", () => {
    // The proof that the generic path has not merely approximated the special case it replaces: not
    // "close to", but the identical float, because it is the identical arithmetic on the identical pads.
    const fit = partFit(R_1206);
    expect(fit.rows).toBe(1);
    expect(fit.gap).toBe(RESISTOR.gap);
    expect(fit.gap).toBe(RESISTOR_MM);
    // In line with the rail, a part straddles its gap evenly and needs no more copper than the gap
    // either side of the break's centre — which is exactly what `breakRuns` defaults to.
    expect(fit.before).toBe(fit.gap);
    expect(fit.after).toBe(fit.gap);
  });

  it("reads the SPDT switch as two rows, with the switch's own gap", () => {
    // Three terminals in one row on the footprint, but the common is reflected to the far edge so the
    // rail runs straight through — see `parts.ts`. So the fit has to come out as two rows, and the gap
    // as the row separation plus the neck that keeps the idle throw in clear pattern.
    const fit = partFit(SW_SPDT);
    expect(fit.rows).toBe(2);
    expect(fit.gap).toBe(SWITCH_GAP_MM);
    expect(fit.gap).toBe(SWITCH_ROW_MM + SWITCH_NECK_MM);
    // Its terminals run on past the break, so unlike a resistor it wants a pad beyond its own half-gap.
    expect(fit.before).toBe(SWITCH_GAP_MM / 2 + SPDT.pad.w);
    expect(fit.after).toBe(fit.before);
  });

  it("reads every other library part without being told anything about it", () => {
    // A 2010 resistor is wider than a 1206 and a push button wider still; each fit is that part's own
    // pads, so a new part in the library needs no new number here.
    for (const [fp, gap] of [
      [LED_1206, 2], // 1206 pads: 4mm centres, 2mm wide
      [C_1206, 2],
      [R_2010, 3.4], // 2010: 5mm centres, 1.6mm pads
      [SW_PUSH, 5.5], // PTS636: 8mm centres, 2.5mm wide
    ] as [Footprint, number][]) {
      const fit = partFit(fp);
      expect(fit.rows).toBe(1);
      expect(fit.gap).toBeCloseTo(gap, 6);
    }
    // Distinct parts get distinct fits — a reading, not one number reused.
    expect(partFit(R_2010).gap).toBeGreaterThan(partFit(R_1206).gap);
  });

  it("reads a part whose terminals really are in two rows", () => {
    // No library part is built this way yet — the switch gets there by reflection — so the direct case
    // is tested on a footprint made for it: one terminal on the near edge, two on the far one.
    const twoRow: Footprint = {
      "1": rect(1, 2, 0, -3, 1),
      "2": rect(1, 2, -2, 3, 2),
      "3": rect(1, 2, 2, 3, 3),
    };
    const fit = partFit(twoRow);
    expect(fit.rows).toBe(2);
    // Six millimetres between the rows, plus the neck the pitch and pad ask for.
    expect(fit.gap).toBeGreaterThan(6);
    // A pad beyond the half-gap, as any part the rail steps across gets. The pad is 1mm across.
    expect(fit.before).toBeCloseTo(fit.gap / 2 + 1, 12);
    expect(fit.after).toBe(fit.before);
    // One row of the same pads is the in-line case instead: no rows to step across.
    expect(partFit({ "1": rect(1, 2, -2, 0, 1), "2": rect(1, 2, 2, 0, 2) }).rows).toBe(1);
  });

  it("places a 1206 resistor from the library exactly as the resistor tool does", () => {
    // The strongest form of "no special cases left": routed as a library part and routed as the built-in
    // resistor, the copper is the same copper.
    const { faces, gaps, base, mid } = fixture();
    const viaTool = planRoutes(faces, gaps, { ...base, resistors: [mid] });
    const viaLibrary = planRoutes(faces, gaps, {
      ...base,
      parts: [{ component: "R_1206", x: mid.x, y: mid.y }],
    });
    expect(viaLibrary.traces).toEqual(viaTool.traces);
    expect(viaLibrary.parts).toHaveLength(1);
    expect(viaLibrary.parts[0]!.component).toBe("R_1206");
    expect(viaLibrary.parts[0]!.a).toEqual(viaTool.resistors[0]!.a);
    expect(viaLibrary.parts[0]!.b).toEqual(viaTool.resistors[0]!.b);
    expect(viaLibrary.parts[0]!.net).toBe(viaTool.resistors[0]!.net);
  });

  it("places an SPDT from the library exactly as the switch tool does, lands and all", () => {
    // Two rows, so the rail steps across: a land under the common, a land across to the live throw, and
    // the same choice of which side the idle throw is stranded on.
    const { faces, gaps, base, plain } = fixture(3);
    const at = longestMid(plain.traces);
    const viaTool = planRoutes(faces, gaps, { ...base, switches: [at] });
    const viaLibrary = planRoutes(faces, gaps, {
      ...base,
      parts: [{ component: "SW_SPDT", x: at.x, y: at.y }],
    });
    expect(viaTool.switches).toHaveLength(1);
    expect(viaLibrary.parts).toHaveLength(1);
    expect(viaLibrary.traces).toEqual(viaTool.traces);
    // Including the two land stubs, which are the runs carrying an explicit width.
    expect(viaLibrary.traces.filter((t) => t.width !== undefined)).toHaveLength(2);
    expect(viaLibrary.parts[0]!.flip).toBe(viaTool.switches[0]!.flip);
    expect(viaLibrary.parts[0]!.a).toEqual(viaTool.switches[0]!.a);
    expect(viaLibrary.parts[0]!.b).toEqual(viaTool.switches[0]!.b);
  });

  it("takes out each part's own length of copper, whatever the part", () => {
    // The gap is in millimetres and the router works in flat pattern units; `printScale` is the way back.
    // Getting that conversion wrong is the standing bug in this code, so it is measured per part.
    const { faces, gaps, base, plain, k } = fixture(3);
    const at = longestMid(plain.traces);
    for (const id of ["R_1206", "C_1206", "R_2010", "SW_PUSH"]) {
      const r = planRoutes(faces, gaps, { ...base, parts: [{ component: id, x: at.x, y: at.y }] });
      expect(r.parts, id).toHaveLength(1);
      const removed = (totalLength(plain.traces) - totalLength(r.traces)) * k;
      const fp = { R_1206, C_1206, R_2010, SW_PUSH }[id as "R_1206"]!;
      expect(removed, id).toBeCloseTo(partFit(fp).gap, 6);
      // And the run it sat on really is in two pieces now.
      expect(r.traces.length, id).toBe(plain.traces.length + 1);
    }
  });

  it("places two different components on one circuit, each to its own fit", () => {
    const { faces, gaps, base, plain, k } = fixture(3);
    const pwr = longestMid(plain.traces, "pwr");
    const gnd = longestMid(plain.traces, "gnd");
    const r = planRoutes(faces, gaps, {
      ...base,
      parts: [
        { component: "R_1206", x: pwr.x, y: pwr.y },
        { component: "R_2010", x: gnd.x, y: gnd.y },
      ],
    });
    expect(r.parts.map((p) => p.component).sort()).toEqual(["R_1206", "R_2010"]);
    const removed = (totalLength(plain.traces) - totalLength(r.traces)) * k;
    expect(removed).toBeCloseTo(partFit(R_1206).gap + partFit(R_2010).gap, 6);
  });

  it("leaves out a part that will not fit, and one the library no longer has", () => {
    // A part that cannot be seated is reported by omission — `parts` lists what was placed — which is
    // what the status line counts to say so. An id the library has dropped is treated the same way
    // rather than guessed at.
    const { faces, gaps, base, mid } = fixture();
    // house's one-LED runs are under a millimetre; a 20mm coin cell has nowhere to go.
    const big = planRoutes(faces, gaps, {
      ...base,
      parts: [{ component: "BAT_COIN_20", x: mid.x, y: mid.y }],
    });
    expect(big.parts).toEqual([]);
    const unknown = planRoutes(faces, gaps, {
      ...base,
      parts: [{ component: "NOT_IN_THE_LIBRARY", x: mid.x, y: mid.y }],
    });
    expect(unknown.parts).toEqual([]);
    // Neither disturbed the copper.
    const plain = planRoutes(faces, gaps, base);
    expect(big.traces).toEqual(plain.traces);
    expect(unknown.traces).toEqual(plain.traces);
    // The mechanism, on a run whose length is known: four times the run is too wide to seat.
    const run = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    expect(breakRuns([run], [{ x: 0.5, y: 0 }], 4).placed).toEqual([]);
  });

  it("routes a circuit with no parts exactly as it did before parts existed", () => {
    // Recorded from the router as it stood before this change — every bundled pattern, at one LED and at
    // three, run count and total copper. The whole generic path hangs off `circuit.parts` being empty, so
    // if any of these moved, it leaked.
    const before: [string, number, number, number][] = [
      ["akde-decagon-pyramid", 1, 2, 68.11195868628627],
      ["akde-decagon-pyramid", 3, 3, 372.6076617278911],
      ["akde-hex", 1, 2, 96.29369589946293],
      ["akde-hex", 3, 3, 322.9897264838064],
      ["akde-square-pyramid", 1, 2, 36.874058422683746],
      ["akde-square-pyramid", 3, 4, 142.67336194263746],
      ["bistable-star-tiling", 1, 0, 0],
      ["bistable-star-tiling", 3, 0, 0],
      ["church", 1, 2, 0.465791970607236],
      ["church", 3, 4, 8.739131867153544],
      ["house", 1, 2, 0.6968144071905864],
      ["house", 3, 3, 3.9713582398958804],
      ["kirigami-flap", 1, 2, 68.17575053727609],
      ["kirigami-flap", 3, 2, 68.17575053727609],
      ["puffin", 1, 2, 12.93370909112397],
      ["puffin", 3, 3, 95.58639962767194],
    ];
    for (const [name, leds, runs, copper] of before) {
      const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}.fkld`, "utf8"));
      const faces = flatFaces(fold);
      const gaps = gapGraph(fold, faces).gaps;
      const seen = new Set<string>();
      const chosen = [];
      for (const g of gaps) {
        const l = ledOf(g.faceA, g.faceB);
        const key = `${l.a}_${l.b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chosen.push(l);
        if (chosen.length >= leds) break;
      }
      const r = planRoutes(faces, gaps, { leds: chosen, battery: { face: 0 } });
      expect(r.traces.length, `${name}/${leds} runs`).toBe(runs);
      expect(totalLength(r.traces), `${name}/${leds} copper`).toBeCloseTo(copper, 12);
      // And the field is an array whether or not the circuit has any.
      expect(r.parts).toEqual([]);
    }
  });

  it("gives `parts` as an array however the circuit was saved", () => {
    // Circuits predate the field, so it is optional on the way in — but never optional on the way out,
    // or every caller has to guard it.
    const { faces, gaps, base } = fixture();
    expect(planRoutes(faces, gaps, base).parts).toEqual([]);
    expect(planRoutes(faces, gaps, { ...base, parts: [] }).parts).toEqual([]);
    // No battery: nothing is routed at all, and the field still comes back.
    expect(planRoutes(faces, gaps, { leds: [], battery: null }).parts).toEqual([]);
  });
});
