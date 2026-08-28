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
  SWITCH_PITCH_MM,
  SWITCH_ROW_MM,
  TAPE_MM,
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

/**
 * How many decimal places of a millimetre a dimension read from the library is good to.
 *
 * Coordinates are stored on a 1e-6 inch grid, so one is off by at most 12.7nm and a dimension — the
 * difference of two of them — by at most 2.54e-5mm. Asserting to more places than that tests the grid,
 * not the geometry. Four is two orders inside the bound and still 2000x finer than the cutter places a
 * cut, so a real error has nowhere to hide.
 */
const GRID_DP = 4;

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
    //
    // `pad.h`, and it used to say `pad.w` — that was the bug, not drift. `before`/`after` are reserves
    // measured ALONG the rail, and `acrossPart.pad` is now normalised to the run (`parts.ts › padRunBox`),
    // so the along-run extent is `h`. On the SPDT that is 1.2mm against the 1.0mm this pinned, so the
    // assertion was under-reserving by a fifth of a pad and passing because the code agreed with it.
    expect(fit.before).toBe(SWITCH_GAP_MM / 2 + SPDT.pad.h);
    expect(fit.after).toBe(fit.before);
  });

  it("reads every other library part without being told anything about it", () => {
    // A 2010 resistor is wider than a 1206 and a push button wider still; each fit is that part's own
    // pads, so a new part in the library needs no new number here.
    // FabLib's own numbers. These moved when the library became the single source: its 1206 parts are
    // the reflow variants, not the hand-solder ones we had vendored, so a chip capacitor sits on 3mm
    // centres rather than 4mm. Nothing was recalibrated to make a test pass — the part changed.
    for (const [fp, gap] of [
      [LED_1206, 2], //   3.4mm centres, 1.4mm pads
      [C_1206, 1.8], //   3.0mm centres, 1.2mm pads
      [R_2010, 3.4], //   5.0mm centres, 1.6mm pads
      [SW_PUSH, 5.5], //  8.0mm centres, 2.5mm pads
    ] as [Footprint, number][]) {
      const fit = partFit(fp);
      expect(fit.rows).toBe(1);
      expect(fit.gap).toBeCloseTo(gap, GRID_DP);
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
    // A pad beyond the half-gap, as any part the rail steps across gets — and it is the pad's extent ALONG
    // the rail that matters, because that is the axis a reserve is measured in. These pads are 1mm across
    // and 2mm along, and the part is seated turned, so the reserve is 2. This pinned 1 — the across extent
    // — and passed because `partFit` read the same wrong axis. That was the bug, not drift.
    expect(fit.before).toBeCloseTo(fit.gap / 2 + 2, 12);
    expect(fit.after).toBe(fit.before);
    // One row of the same pads is the in-line case instead: no rows to step across.
    expect(partFit({ "1": rect(1, 2, -2, 0, 1), "2": rect(1, 2, 2, 0, 2) }).rows).toBe(1);
  });

  it("measures a part's gap along the part's own axis, not along x", () => {
    // A footprint whose pads run down y instead of across x. Ten of the library's forty-five placeable
    // parts are built this way — every pin header and socket — and every one of them was undroppable at
    // any run length, because the gap was measured between the two pads on x, where they are at the same
    // coordinate. `PinHeader_01x03_P2_54mm_Horizontal_SMD` came out at -2.500mm, and `breakRuns` refuses a
    // gap that is not positive, so the user got "that run is too short for the part" for a part no run
    // could ever hold.
    //
    // Two pads 5mm apart down y, each 1mm along that axis: 4mm of bare pattern between them.
    const downY: Footprint = { "1": rect(2, 1, 0, -2.5, 1), "2": rect(2, 1, 0, 2.5, 2) };
    const fit = partFit(downY);
    expect(fit.rows).toBe(1);
    expect(fit.gap).toBeCloseTo(4, GRID_DP);
    // The same part turned a quarter turn reads identically — the axis is read, not assumed.
    const acrossX: Footprint = { "1": rect(1, 2, -2.5, 0, 1), "2": rect(1, 2, 2.5, 0, 2) };
    expect(partFit(acrossX).gap).toBeCloseTo(fit.gap, 12);
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

  it("cuts no copper for a free part, and leaves the plan as if it were not there", () => {
    // A free part stands on the sheet: its pads are joined by nets or by hand-drawn copper, not by a rail
    // passing through it. Cutting a run for one would break copper somewhere the part is not.
    const { faces, gaps, base, mid } = fixture();
    const seated = planRoutes(faces, gaps, { ...base, parts: [{ component: "R_1206", x: mid.x, y: mid.y }] });
    const free = planRoutes(faces, gaps, {
      ...base,
      parts: [{ component: "R_1206", x: mid.x, y: mid.y, free: true }],
    });
    // Same point, same part -- the only difference is the flag, and it is the difference between a run
    // broken in two and a run left whole.
    expect(free.traces).toEqual(planRoutes(faces, gaps, base).traces);
    expect(free.traces).not.toEqual(seated.traces);
    expect(free.parts).toHaveLength(0);
  });

  it("counts a free part in the author's list when it numbers the parts it did seat", () => {
    // `PartPlacement.source` is an index into `circuit.parts` -- the author's list -- and the canvas matches
    // it against its own selection index. Skipping free parts by filtering the array before `byComponent`
    // would renumber every part after one, so clicking the second part would show the first one's span and
    // flip. Nothing crashes and nothing else in the suite notices, which is why this test exists.
    const { faces, gaps, base, mid } = fixture();
    const r = planRoutes(faces, gaps, {
      ...base,
      parts: [
        { component: "C_1206", x: mid.x, y: mid.y, free: true }, // index 0, seated for nothing
        { component: "R_1206", x: mid.x, y: mid.y },             // index 1, the one that gets a break
      ],
    });
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.source).toBe(1);
    expect(r.parts[0]!.component).toBe("R_1206");
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
    // Recorded from the router — every bundled pattern, at one LED and at three, run count and total
    // copper. The whole generic path hangs off `circuit.parts` being empty, so if any of these moves
    // without a reason, it leaked.
    //
    // Re-recorded once, deliberately, when LEDs became real footprints. These circuits have no PARTS but
    // they do have LEDs, and an LED's copper now reaches in over the tile gap to meet the chip's own legs
    // instead of stopping at the tile dent, so more copper is the point rather than a leak. What it cost,
    // stated plainly rather than hidden in the numbers:
    //
    //  - Copper is up on every pattern that routes at all: akde-decagon 68.11 -> 118.65mm at one LED,
    //    puffin 12.93 -> 17.61, house 0.70 -> 1.07. The pad coverage that buys went from 19-53% to
    //    96-100%, which is the difference between a chip that lights and one that does not.
    //  - Strips are up where a run had to split to reach two legs: house at three LEDs 3 -> 6 runs,
    //    church 4 -> 6, akde-decagon 3 -> 6. Each is one more piece to peel and lay by hand.
    //  - `akde-square-pyramid` LOSES its LED at one (2 runs -> 0) and half of them at three (4 -> 2).
    //    A real 1206's legs are 3.40mm apart and its hinges are too short to seat that. The router now
    //    refuses it rather than drawing copper the part cannot reach, which is the honest outcome, but it
    //    is a pattern that used to light and now does not.
    // Re-recorded a second time on 2026-08-28, when `TAPE_MM` fell from 3.25 to 1.5. Every keep-out in the
    // router is derived from the tape, so a narrower strip has more room and takes more direct routes.
    // What moved, stated plainly rather than hidden in the numbers:
    //
    //  - Copper is DOWN on nine of the twelve rows that route at all, which is the expected direction:
    //    church at three LEDs 9.86 -> 6.80mm (-31%), puffin at one 17.61 -> 13.00 (-26%), house at one
    //    1.07 -> 0.80 (-25%), akde-decagon at one 118.65 -> 75.47 (-36%). Three rows are up, all barely:
    //    akde-hex at one +0.4%, kirigami-flap +0.3%, puffin at three +1.9%.
    //  - Two patterns gained a run: akde-hex at three LEDs 5 -> 6 and puffin at three 5 -> 6. A sixth strip
    //    is one more piece to peel and lay, and it comes with puffin's 1.9% more copper.
    //  - No pattern gained or lost an LED. `akde-square-pyramid` still refuses its LED at one and seats two
    //    of three, and `bistable-star-tiling` still routes nothing — narrower tape does not rescue either,
    //    because what defeats them is hinge length against the 1206's 3.40mm legs, not strip width.
    const before: [string, number, number, number][] = [
      ["akde-decagon-pyramid", 1, 2, 75.47206013267432],
      ["akde-decagon-pyramid", 3, 6, 403.19751558200016],
      ["akde-hex", 1, 2, 105.15717799886949],
      ["akde-hex", 3, 6, 351.5438685461294],
      ["akde-square-pyramid", 1, 0, 0],
      ["akde-square-pyramid", 3, 2, 49.15677510965487],
      ["bistable-star-tiling", 1, 0, 0],
      ["bistable-star-tiling", 3, 0, 0],
      ["church", 1, 2, 0.5390219396942254],
      ["church", 3, 6, 6.804114837907989],
      ["house", 1, 2, 0.8038265682751792],
      ["house", 3, 6, 4.387003709496385],
      ["kirigami-flap", 1, 2, 68.50569501309963],
      ["kirigami-flap", 3, 2, 68.50569501309963],
      ["puffin", 1, 2, 12.996160368450141],
      ["puffin", 3, 6, 101.55074579073953],
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
  it("refuses a seat that would short the two nets through the part", { timeout: 20_000 }, () => {
    // A switch reaches a pitch plus half a pad off the centreline — 3.25mm on the SPDT, wider than the
    // tape it sits on — so on a crowded pattern a throw can land on the OTHER net's rail. That bridges
    // power to ground through the part, and it is invisible on screen because the terminal is drawn over
    // the copper it is shorting to. Measured before the veto existed: 9 of 44 placements did it.
    //
    // Choosing the better side cannot fix it, because when both sides are bad the better one still
    // shorts. So the part is refused instead, and reported as not fitting.
    const fold = JSON.parse(readFileSync(`${EXAMPLES}church.fkld`, "utf8"));
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    const seen = new Set<string>();
    const leds = [];
    for (const g of gaps) {
      const l = ledOf(g.faceA, g.faceB);
      const key = `${l.a}_${l.b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leds.push(l);
      if (leds.length >= 3) break;
    }
    const base: Circuit = { leds, battery: { face: 0 } };
    const tapeW = tapeWidthFor(faces);
    const pwr = planRoutes(faces, gaps, base).traces
      .filter((t) => t.net === "pwr")
      .sort((a, b) => b.pts.length - a.pts.length)[0]!;

    let placed = 0;
    for (let i = 0; i <= 8; i++) {
      const at = pwr.pts[Math.round((i / 8) * (pwr.pts.length - 1))]!;
      const r = planRoutes(faces, gaps, { ...base, parts: [{ component: "SW_SPDT", x: at.x, y: at.y }] });
      if (r.parts.length === 0) continue;      // refused, which is the allowed outcome
      placed++;
      const span = r.parts[0]!;
      const d = { x: span.b.x - span.a.x, y: span.b.y - span.a.y };
      const L = Math.hypot(d.x, d.y);
      const u = { x: d.x / L, y: d.y / L };
      const p = span.flip ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
      const pitch = (SWITCH_PITCH_MM * tapeW) / TAPE_MM;
      const rowSep = (SWITCH_ROW_MM * tapeW) / TAPE_MM;
      const row = { x: span.a.x + u.x * rowSep, y: span.a.y + u.y * rowSep };
      const terminalsAt = [
        span.a,
        { x: row.x + p.x * pitch, y: row.y + p.y * pitch },
        { x: row.x - p.x * pitch, y: row.y - p.y * pitch },
      ];
      for (const c of terminalsAt) {
        for (const t of r.traces.filter((x) => x.net !== span.net)) {
          for (let k = 1; k < t.pts.length; k++) {
            const a = t.pts[k - 1]!, b = t.pts[k]!;
            const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
            const s = l2 < 1e-18 ? 0
              : Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / l2));
            const dist = Math.hypot(c.x - (a.x + s * (b.x - a.x)), c.y - (a.y + s * (b.y - a.y)));
            expect(dist, `a terminal sits on the ${t.net} rail`).toBeGreaterThanOrEqual((t.width ?? tapeW) / 2);
          }
        }
      }
    }
    // The veto must not be a blanket refusal — most seats along a rail are still fine.
    expect(placed, "the veto refused every placement").toBeGreaterThan(3);
  });

});
