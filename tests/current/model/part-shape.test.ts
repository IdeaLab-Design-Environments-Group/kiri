import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  partShape,
  resistorShape,
  switchShape,
} from "../../../src/model/copper-svg-export.js";
import { flatFaces, gapGraph, ledOf, type Circuit, type Vec2 } from "../../../src/model/electronics.js";
import { planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import {
  BAT_COIN_20,
  COMPONENTS,
  C_1206,
  R_1206,
  R_2010,
  SW_SPDT,
} from "../../../src/model/footprints.generated.js";
import { padNamed, padSize } from "../../../src/model/footprint.js";
import { acrossPart } from "../../../src/model/parts.js";

/** Two breaks: one slanted, one straight up the page, so a rotation bug cannot hide in either. */
const A: Vec2 = { x: 10, y: 20 };
const B: Vec2 = { x: 34, y: 27 };
const C: Vec2 = { x: 5, y: -3 };
const D: Vec2 = { x: 5, y: 9 };

/**
 * What `resistorShape` and `switchShape` returned BEFORE `partShape` existed, recorded by running them.
 *
 * These are the whole point of the refactor: the generic path has to reproduce the two hand-written
 * special cases exactly, not approximately. Written out as literals rather than compared against the old
 * functions because the old functions are gone — they are thin calls to `partShape` now, so comparing
 * them to it would compare it to itself and pass whatever it did.
 */
const BEFORE = {
  RES_AB: {
    leads: [
      { a: { x: 9.278, y: 18.904 }, b: { x: 8.802000000000001, y: 20.535999999999998 }, width: 1.9999999999999998 },
      { a: { x: 35.198, y: 26.464000000000002 }, b: { x: 34.722, y: 28.096 }, width: 1.9999999999999998 },
    ],
    body: { x: 9, y: 22.7775, w: 26, h: 1.4449999999999998, angle: 16.26020470831196, cx: 22, cy: 23.5 },
  },
  RES_CD: {
    leads: [
      { a: { x: 5.85, y: -4 }, b: { x: 4.15, y: -4 }, width: 1.9999999999999998 },
      { a: { x: 5.85, y: 10 }, b: { x: 4.15, y: 10 }, width: 1.9999999999999998 },
    ],
    body: { x: -1.5, y: 2.2775, w: 13, h: 1.4449999999999998, angle: 90, cx: 5, cy: 3 },
  },
  SW_AB: {
    leads: [
      { a: { x: 14.78, y: 18.79 }, b: { x: 17.18, y: 19.490000000000002 }, width: 1.5 },
      { a: { x: 8.8, y: 19.65 }, b: { x: 11.2, y: 20.35 }, width: 1.5 },
      { a: { x: 13.38, y: 23.589999999999996 }, b: { x: 15.78, y: 24.29 }, width: 1.5 },
    ],
    body: { x: 10.14, y: 18.02, w: 4.999999999999999, h: 5.5, angle: 106.26020470831196, cx: 12.64, cy: 20.77 },
    holes: [
      { c: { x: 14.08, y: 21.19 }, r: 0.42499999999999993 },
      { c: { x: 11.200000000000001, y: 20.349999999999998 }, r: 0.42499999999999993 },
    ],
  },
  SW_AB_FLIP: {
    leads: [
      { a: { x: 13.38, y: 23.589999999999996 }, b: { x: 15.78, y: 24.29 }, width: 1.5 },
      { a: { x: 8.8, y: 19.65 }, b: { x: 11.2, y: 20.35 }, width: 1.5 },
      { a: { x: 14.78, y: 18.79 }, b: { x: 17.18, y: 19.490000000000002 }, width: 1.5 },
    ],
    body: { x: 10.14, y: 18.02, w: 4.999999999999999, h: 5.5, angle: -73.73979529168804, cx: 12.64, cy: 20.77 },
    holes: [
      { c: { x: 14.08, y: 21.19 }, r: 0.42499999999999993 },
      { c: { x: 11.200000000000001, y: 20.349999999999998 }, r: 0.42499999999999993 },
    ],
  },
  SW_CD: {
    leads: [
      { a: { x: 7.5, y: 1.2500000000000002 }, b: { x: 7.5, y: 3.75 }, width: 1.5 },
      { a: { x: 5, y: -4.25 }, b: { x: 5, y: -1.7500000000000002 }, width: 1.5 },
      { a: { x: 2.5000000000000004, y: 1.2500000000000002 }, b: { x: 2.5000000000000004, y: 3.75 }, width: 1.5 },
    ],
    body: { x: 2.5000000000000004, y: -3, w: 4.999999999999999, h: 5.5, angle: 180, cx: 5, cy: -0.25 },
    holes: [
      { c: { x: 5, y: 1.25 }, r: 0.42499999999999993 },
      { c: { x: 5, y: -1.75 }, r: 0.42499999999999993 },
    ],
  },
};

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house with one LED, and the midpoint of its PWR run — the same fixture `resistor.test.ts` uses. */
function fixture() {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const g = gaps[0]!;
  const base: Circuit = { leds: [ledOf(g.faceA, g.faceB)], battery: { face: 0 } };
  const r = planRoutes(faces, gaps, base);
  const pwr = r.traces.find((t) => t.net === "pwr")!;
  const mid = pwr.pts[Math.floor(pwr.pts.length / 2)]!;
  return { fold, traces: r.traces, tapeW: tapeWidthFor(faces), mid };
}

describe("model/part-shape", () => {
  it("draws a 1206 resistor exactly as the hand-written resistorShape did", () => {
    expect(partShape(R_1206, A, B)).toEqual(BEFORE.RES_AB);
    expect(partShape(R_1206, C, D)).toEqual(BEFORE.RES_CD);
  });

  it("draws an SPDT exactly as the hand-written switchShape did, either way round", () => {
    expect(partShape(SW_SPDT, A, B)).toEqual(BEFORE.SW_AB);
    expect(partShape(SW_SPDT, A, B, true)).toEqual(BEFORE.SW_AB_FLIP);
    expect(partShape(SW_SPDT, C, D, false)).toEqual(BEFORE.SW_CD);
  });

  it("is the only implementation — resistorShape and switchShape now go through it", () => {
    expect(resistorShape(A, B)).toEqual(partShape(R_1206, A, B));
    expect(switchShape(A, B, true)).toEqual(partShape(SW_SPDT, A, B, true));
    expect(switchShape(C, D)).toEqual(partShape(SW_SPDT, C, D));
  });

  it("returns null for a break with no length, rather than a part of NaNs", () => {
    expect(partShape(R_1206, A, A)).toBeNull();
    expect(partShape(SW_SPDT, A, A, true)).toBeNull();
  });

  it("takes its dimensions from the part's own pads, not from the resistor's", () => {
    // R_2010 is a bigger chip than R_1206: wider across, shorter along. If the contact width or the body
    // depth still came from RESISTOR, both parts would be drawn the same size.
    const big = partShape(R_2010, C, D)!;
    const small = partShape(R_1206, C, D)!;
    const pad2010 = padSize(padNamed(R_2010, "1"));
    expect(big.leads[0]!.width).toBeCloseTo(pad2010.w, 9);
    expect(big.body.h).toBeCloseTo(pad2010.h * 0.85, 9);
    expect(big.leads[0]!.width).not.toBeCloseTo(small.leads[0]!.width, 3);
    expect(big.body.h).not.toBeCloseTo(small.body.h, 3);
    // A capacitor is a 1206 too, so it comes out the size of one — same footprint, same drawing.
    expect(partShape(C_1206, C, D)).toEqual(small);
  });

  it("takes its one-row/two-row dispatch from acrossPart, the rule the router cuts by", () => {
    // The rule lives in parts.ts and nowhere else. This asserts the DRAWING follows it for every part in
    // the library, because the router breaks the copper by the same call: a part cut in line and drawn
    // with a housing across the rail is a cut file that disagrees with its own drawing.
    for (const c of COMPONENTS) {
      const sh = partShape(c.footprint, C, D);
      if (!sh) continue;
      const across = acrossPart(c.footprint);
      expect([c.id, sh.leads.length]).toEqual([c.id, across ? 3 : 2]);
      if (across) {
        // The housing stands off the near row by half a row separation, beside the pads.
        expect(sh.body.h).toBeCloseTo(across.rowSep, 9);
        expect(sh.body.w).toBeCloseTo(2 * across.pitch, 9);
        expect(sh.body.cy).toBeCloseTo(C.y + across.rowSep / 2, 9);
      } else {
        // The in-line form sits ON the break, centred between the cut ends, and has no pegs to draw.
        expect(sh.holes).toBeUndefined();
        expect(sh.body.cx).toBeCloseTo(5, 9);
        expect(sh.body.cy).toBeCloseTo(3, 9);
      }
    }
    // The two parts the rule is named for, spelled out.
    expect(acrossPart(SW_SPDT)).not.toBeNull();
    expect(partShape(SW_SPDT, C, D)!.holes).toHaveLength(2);
    expect(acrossPart(R_1206)).toBeNull();
    // And the coin cell: three terminals but no mounting pegs, so there is no line to reflect a common
    // through. It is in line with the rail, and drawn that way.
    expect(acrossPart(BAT_COIN_20)).toBeNull();
    expect(partShape(BAT_COIN_20, C, D)!.leads).toHaveLength(2);
  });

  it("draws placed parts on both cut files without cutting them", () => {
    const { fold, traces, tapeW, mid } = fixture();
    const parts = [{ component: "R_2010", a: mid, b: { x: mid.x + 6, y: mid.y } }];

    const plainSvg = buildCopperSvgExport(fold, traces, tapeW);
    const withSvg = buildCopperSvgExport(fold, traces, tapeW, "kiri", [], undefined, undefined, [], [], parts);
    // A new parts layer appeared, and the copper that will actually be cut is untouched by it.
    expect(plainSvg.svg).not.toContain('<g id="parts">');
    expect(withSvg.svg).toContain('<g id="parts">');
    expect(withSvg.counts).toEqual(plainSvg.counts);
    // The copper layers themselves are byte-identical; the parts layer is purely additive.
    const copperOf = (svg: string): string => svg.split(/\n?  <g id="parts">|\n<\/svg>/)[0]!;
    expect(copperOf(withSvg.svg)).toBe(copperOf(plainSvg.svg));

    const plainCar = buildCopperCarrierExport(fold, traces, tapeW);
    const withCar = buildCopperCarrierExport(
      fold, traces, tapeW, "kiri", [], undefined, undefined, [], [], [], parts,
    );
    expect(plainCar.svg).not.toContain('<g id="annotation"');
    expect(withCar.svg).toContain('<g id="annotation"');
    expect(withCar.svg).toContain(plainCar.svg.replace(/\n<\/svg>\n$/, ""));
  });

  it("ignores a placed part whose component is not in the library", () => {
    const { fold, traces, tapeW, mid } = fixture();
    const parts = [{ component: "NOT_A_PART", a: mid, b: { x: mid.x + 6, y: mid.y } }];
    const out = buildCopperSvgExport(fold, traces, tapeW, "kiri", [], undefined, undefined, [], [], parts);
    expect(out.svg).toBe(buildCopperSvgExport(fold, traces, tapeW).svg);
  });
});
