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
import type { ResistorShape } from "../../../src/model/copper-svg-export.js";

/** Two breaks: one slanted, one straight up the page, so a rotation bug cannot hide in either. */
const A: Vec2 = { x: 10, y: 20 };
const B: Vec2 = { x: 34, y: 27 };
const C: Vec2 = { x: 5, y: -3 };
const D: Vec2 = { x: 5, y: 9 };

/**
 * The geometry `partShape` produces for a 1206 resistor and an SPDT, frozen as literals.
 *
 * Originally these were what the hand-written `resistorShape` and `switchShape` returned before
 * `partShape` replaced them, and matching them byte for byte is what proved that refactor inert. That
 * proof has been served and now lives in the history: these numbers were RE-RECORDED when the component
 * library moved wholesale to the KiCad FabLib, because FabLib's 1206 parts are the reflow variants and
 * the hand-solder ones we had vendored were a different part — 3mm centres against 4mm, so the body
 * spans 25.6mm where it used to span 26. The values changed because the part did, not because the code
 * drifted; every other test was green across that change.
 *
 * They are still worth freezing. As a lock they catch any future change to placement, which is the one
 * thing every rewrite of this drawing code has had to leave alone. Written as literals rather than
 * compared against the old functions because the old functions are gone — they are thin calls to
 * `partShape` now, so comparing them to it would compare it to itself and pass whatever it did.
 */
const BEFORE = {
  RES_AB: {"leads":[{"a":{"x":9.648000704000001,"y":19.064001872},"b":{"x":9.2000016,"y":20.5999988},"width":1.1999975999999999},{"a":{"x":34.7999984,"y":26.4000012},"b":{"x":34.351999295999995,"y":27.935998128},"width":1.1999975999999999}],"body":{"x":9.2000006,"y":22.82000136,"w":25.5999988,"h":1.35999728,"angle":16.26020470831196,"cx":22,"cy":23.5}},
  RES_CD: {"leads":[{"a":{"x":5.7999984,"y":-3.5999988},"b":{"x":4.2000016,"y":-3.5999988},"width":1.1999975999999999},{"a":{"x":5.7999984,"y":9.5999988},"b":{"x":4.2000016,"y":9.5999988},"width":1.1999975999999999}],"body":{"x":-1.2999994,"y":2.32000136,"w":12.5999988,"h":1.35999728,"angle":90,"cx":5,"cy":3}},
  SW_AB: {"leads":[{"a":{"x":15.115989768,"y":18.888002224},"b":{"x":16.267987464,"y":19.224001552},"width":0.999998},{"a":{"x":9.424001152,"y":19.832000336},"b":{"x":10.575998848,"y":20.167999664},"width":0.999998},{"a":{"x":13.715992567999999,"y":23.687992624},"b":{"x":14.867990263999998,"y":24.023991952},"width":0.999998}],"body":{"x":9.996000008,"y":18.128003744,"w":4.9999899999999995,"h":5.199989599999999,"angle":106.26020470831196,"cx":12.495995008,"cy":20.727998544000002},"holes":[{"c":{"x":11.055997888,"y":20.307999384000002},"r":0.4250055},{"c":{"x":13.935992127999999,"y":21.147997704},"r":0.4250055}]},
  SW_AB_FLIP: {"leads":[{"a":{"x":13.715992567999999,"y":23.687992624},"b":{"x":14.867990263999998,"y":24.023991952},"width":0.999998},{"a":{"x":9.424001152,"y":19.832000336},"b":{"x":10.575998848,"y":20.167999664},"width":0.999998},{"a":{"x":15.115989768,"y":18.888002224},"b":{"x":16.267987464,"y":19.224001552},"width":0.999998}],"body":{"x":9.996000008,"y":18.128003744,"w":4.9999899999999995,"h":5.199989599999999,"angle":-73.73979529168804,"cx":12.495995008,"cy":20.727998544000002},"holes":[{"c":{"x":11.055997888,"y":20.307999384000002},"r":0.4250055},{"c":{"x":13.935992127999999,"y":21.147997704},"r":0.4250055}]},
  SW_CD: {"leads":[{"a":{"x":7.499995,"y":1.5999907999999996},"b":{"x":7.499995,"y":2.7999883999999993},"width":0.999998},{"a":{"x":5,"y":-3.5999988},"b":{"x":5,"y":-2.4000012},"width":0.999998},{"a":{"x":2.5000050000000003,"y":1.5999907999999996},"b":{"x":2.5000050000000003,"y":2.7999883999999993},"width":0.999998}],"body":{"x":2.5000050000000003,"y":-3,"w":4.9999899999999995,"h":5.199989599999999,"angle":180,"cx":5,"cy":-0.4000052000000003},"holes":[{"c":{"x":5,"y":-1.9000022000000003},"r":0.4250055},{"c":{"x":5,"y":1.0999917999999997},"r":0.4250055}]},
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

/**
 * The shape with its pad NAMES dropped, for comparison against the recorded geometry.
 *
 * The baseline below was taken before a lead carried the name of the terminal it belongs to. That name
 * is a label, not a position, so it must not be allowed to make the geometry check pass or fail —
 * stripping it keeps the recorded numbers doing the job they were recorded for.
 */
function geometry(sh: ResistorShape | null): unknown {
  if (!sh) return null;
  return { ...sh, leads: sh.leads.map(({ name: _name, ...rest }) => rest) };
}

describe("model/part-shape", () => {
  it("draws a 1206 resistor exactly as the hand-written resistorShape did", () => {
    expect(geometry(partShape(R_1206, A, B))).toEqual(BEFORE.RES_AB);
    expect(geometry(partShape(R_1206, C, D))).toEqual(BEFORE.RES_CD);
  });

  it("draws an SPDT exactly as the hand-written switchShape did, either way round", () => {
    expect(geometry(partShape(SW_SPDT, A, B))).toEqual(BEFORE.SW_AB);
    expect(geometry(partShape(SW_SPDT, A, B, true))).toEqual(BEFORE.SW_AB_FLIP);
    expect(geometry(partShape(SW_SPDT, C, D, false))).toEqual(BEFORE.SW_CD);
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
