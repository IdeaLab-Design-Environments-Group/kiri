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
import { acrossRun, planRoutes, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import {
  BAT_COIN_20,
  COMPONENTS,
  C_1206,
  R_1206,
  R_2010,
  SW_SPDT,
} from "../../../src/model/footprints.generated.js";
import { padNamed, padSize, terminals } from "../../../src/model/footprint.js";
import { LIBRARY } from "../../../src/model/library.js";
import { acrossPart, padAxis } from "../../../src/model/parts.js";
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

  it("draws one contact per terminal, for every part in the library", () => {
    // A part is drawn so someone can see where its legs land. A drawing with fewer contacts than the part
    // has legs is not a simplification -- it is a picture of a different part, and it goes onto the cut
    // file that a person solders to.
    //
    // `inlineShape` was fixed for this when a three-pin header lost its middle pin. `rowShape` was not, and
    // it is the path 87 of the 129 parts take: it is written for the SPDT slide switch and returns exactly
    // three contacts -- idle, common, live -- whatever the footprint actually has.
    const wrong: string[] = [];
    for (const c of LIBRARY) {
      const want = terminals(c.footprint).length;
      const sh = partShape(c.footprint, A, B, false);
      if (!sh) continue; // a part with fewer than two terminals is not drawn on a break at all
      if (sh.leads.length !== want) wrong.push(`${c.id}: ${want} terminals, ${sh.leads.length} drawn`);
    }
    // Two remain, and they are listed rather than tolerated by a `length <= 2` fudge, so that fixing the
    // cause fails this test and asks for it to be tightened. Both are five terminals in ONE row, where
    // `acrossPart` fabricates the second row by reflection (`parts.ts:184`). Drawing their pads where the
    // footprint really has them would contradict the routing, which breaks the rail across a separation the
    // part does not have. That is `acrossPart` conflating "is a switch" with "sits across the run", and it
    // belongs to the session that owns `parts.ts` — not to the drawing.
    expect(wrong).toEqual([
      "Conn_USB_microB_Socket_WurthElektronik_629105136821: 5 terminals, 3 drawn",
      "Conn_USB_miniB_Socket_CUIDevices_UJ2_MBH_1_SMT_TR: 5 terminals, 3 drawn",
    ]);
  });

  it("puts each contact where the footprint has that pad, and at that pad's own size", () => {
    // Counting contacts and naming them is not enough: a drawing with the right number of pads in the wrong
    // places is still a picture of a different part. This pins the mapping itself.
    //
    // `TO_252` is a three-terminal two-row part whose pads are wildly unequal -- 3.0x1.5 against 6.6x6.0 --
    // so a drawing that gave every contact the same size would be visibly wrong and is caught here.
    const c = LIBRARY.find((x) => x.id === "TO_252")!;
    const g = acrossPart(c.footprint)!;
    const sh = partShape(c.footprint, C, D, false)!;
    const mid = (l: { a: Vec2; b: Vec2 }): Vec2 => ({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 });
    const at = (name: string) => mid(sh.leads.find((l) => l.name === name)!);

    // C->D runs straight up the page, so the run axis is +y and across it is -x. The common pad anchors the
    // part: the router breaks the rail there, so it must land exactly on the break.
    expect(at(g.names.common).x).toBeCloseTo(C.x, 9);
    expect(at(g.names.common).y).toBeCloseTo(C.y, 9);
    // And the live throw sits one row separation ALONG the run and one pitch ACROSS it -- the two distances
    // `acrossPart` measured off this very footprint.
    //
    // Asserted SIGNED, in the run's own frame, not as `Math.abs`. The signs are the whole job the mapping
    // does: `TO_252`'s live pad is at NEGATIVE across and NEGATIVE along in footprint coordinates, and the
    // mapping's two sign factors are what put it on the far row on the side the router chose. Taking
    // magnitudes here passes just as happily with either sign dropped, which is a drawing with the part
    // reflected -- contacts on the wrong side of the break, off the copper cut for them.
    const u = { x: (D.x - C.x) / 12, y: (D.y - C.y) / 12 };  // C->D is 12 long, straight up the page
    const p = acrossRun(u, false);
    const live = at(g.names.live);
    const d = { x: live.x - C.x, y: live.y - C.y };
    expect(d.x * u.x + d.y * u.y).toBeCloseTo(g.rowSep, 9);
    expect(d.x * p.x + d.y * p.y).toBeCloseTo(g.pitch, 9);

    // Each contact is drawn at its OWN pad's size, not at the live pad's -- and at that size in the RUN's
    // axes, which is not the same as the footprint's.
    //
    // This line used to read `want!.w` and it was WRONG, not drift: `TO_252` is an `alongIsY` part, so its
    // pad's across-run extent is the footprint's y-extent, 1.5mm, while `.w` is the x-extent, 3.0mm. The
    // assertion passed because the drawing had the same transposition the test did -- both read the raw
    // `padSize` where the run's frame was meant. It held for the 44 library across-parts whose terminals
    // run along x and hid the bug on the 43 that run along y, `TO_252` among them. See
    // `parts.ts › padRunBox` and the sweep in `pad-axis-sweep.test.ts`.
    const alongIsY = padAxis(c.footprint).alongIsY;
    const byName = new Map(terminals(c.footprint).map(([n, p]) => [n, padSize(p)]));
    for (const l of sh.leads) {
      const want = l.name === undefined ? undefined : byName.get(l.name);
      expect(want, `lead ${l.name} names no terminal of this footprint`).toBeDefined();
      expect(l.width, `lead ${l.name} across-run width`)
        .toBeCloseTo(alongIsY ? want!.h : want!.w, 9);
    }
    expect(new Set(sh.leads.map((l) => l.width)).size).toBeGreaterThan(1);
  });

  it("names every contact it draws after the pad it is, so the cut file can label them", () => {
    // Two parts the switch path claims, neither of which is a switch: a 26-way USB-C socket and a two-way
    // pin socket. The socket is the sharper case -- it has TWO terminals and is currently drawn with THREE,
    // so the extra contact is not merely a missing pin but an invented one.
    for (const id of ["Conn_USB_C_Socket_Molex_2171790001", "PinSocket_01x02_P2_54mm_Vertical_SMD"]) {
      const c = LIBRARY.find((x) => x.id === id)!;
      const sh = partShape(c.footprint, A, B, false)!;
      const names = sh.leads.map((l) => l.name).sort();
      expect(names).toEqual(terminals(c.footprint).map(([n]) => n).sort());
    }
  });

  it("takes its one-row/two-row dispatch from acrossPart, the rule the router cuts by", () => {
    // The rule lives in parts.ts and nowhere else. This asserts the DRAWING follows it for every part in
    // the library, because the router breaks the copper by the same call: a part cut in line and drawn
    // with a housing across the rail is a cut file that disagrees with its own drawing.
    for (const c of COMPONENTS) {
      const sh = partShape(c.footprint, C, D);
      if (!sh) continue;
      const across = acrossPart(c.footprint);
      // BOTH forms draw every terminal. This used to read `across ? 3 : terminals(...).length`, which was
      // not a description of the rule but a record of a bug: the two-row form drew the switch's three
      // contacts whatever the part was, so a 26-way USB-C socket came out with three and a two-terminal pin
      // socket came out with three — one of them INVENTED, at a place the part has no metal.
      //
      // The exception is a part whose terminals all sit in ONE row, where `acrossPart` fabricates the row
      // separation by reflection: there is no second row to place a pad on. `SW_SPDT` is one of those, which
      // is why the switch is unaffected by any of this.
      const ax = padAxis(c.footprint);
      const oneRow = new Set(terminals(c.footprint).map(([, p]) => ax.across(p).toFixed(6))).size === 1;
      const drawn = across && oneRow ? 3 : terminals(c.footprint).length;
      expect([c.id, sh.leads.length]).toEqual([c.id, drawn]);
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
    // All three of its terminals are drawn, on one line along the rail. That it is in line rather than
    // across is `acrossPart` being null above; the lead count says how many pads it has, not which form
    // it takes, and reading the form off the count is what this test exists to stop.
    expect(partShape(BAT_COIN_20, C, D)!.leads).toHaveLength(3);
  });

  it("draws every pin of a three-pin header, not just the two the rail reaches", () => {
    // The bug this replaces: a pad the routing gave no role to had no lead, and no lead meant nothing
    // painted, so a 01x03 header came out as two pads with a hole in the middle of the part.
    const fp = COMPONENTS.find((c) => c.id === "PinHeader_01x03_P2_54mm_Horizontal_SMD")!.footprint;
    const sh = partShape(fp, C, D)!;
    expect(sh.leads.map((l) => l.name).sort()).toEqual(["1", "2", "3"]);
    // Outermost first, so the middle pin is the middle lead — and it lands midway, because the part's
    // three pins are evenly pitched and the drawing keeps their spacing.
    expect(sh.leads[1]!.name).toBe("2");
    const centre = (l: { a: Vec2; b: Vec2 }): Vec2 => ({
      x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2,
    });
    const [p1, p2, p3] = sh.leads.map(centre) as [Vec2, Vec2, Vec2];
    expect(p2.x).toBeCloseTo((p1.x + p3.x) / 2, 9);
    expect(p2.y).toBeCloseTo((p1.y + p3.y) / 2, 9);
  });

  it("keeps a pad the way round its own footprint has it", () => {
    // This header's pins run DOWN Y — a large minority of the library is that way round — so a pad's
    // y extent is what lies along the rail. Read as though every part ran along x, each pad came out a
    // quarter turn from the part it belongs to.
    const fp = COMPONENTS.find((c) => c.id === "PinHeader_01x03_P2_54mm_Horizontal_SMD")!.footprint;
    for (const l of partShape(fp, C, D)!.leads) {
      expect(l.swap).toBe(true);
      // `width` is the lead's extent along the rail, which for this part is the pad's own height.
      expect(l.width).toBeCloseTo(padSize(padNamed(fp, l.name!)).h, 9);
    }
    // A 1206 runs along x, so it is the other way round and says nothing.
    for (const l of partShape(R_1206, C, D)!.leads) {
      expect(l.swap).toBeUndefined();
      expect(l.width).toBeCloseTo(padSize(padNamed(R_1206, l.name!)).w, 9);
    }
  });

  it("adds no pad smaller than the two the drawing already had", () => {
    // A tripwire for the view, which does not own what it depends on here. `padMinOf` in
    // `electronics-modal.ts` takes the smallest extent of ANY lead to decide whether a pad has room for
    // its pin name, so drawing the terminals that used to be left out can only lower that minimum and
    // make labels appear later than they did.
    //
    // Today it cannot: every in-line part in the library with more than two terminals is evenly pitched
    // with identical pads, so the middle ones are never the smallest. That is a fact about the FabLib,
    // not a rule the code enforces — a part with a pinched middle pad would move the label threshold
    // silently, and this is what would say so instead.
    const smallest = (ls: { a: Vec2; b: Vec2; width: number }[]): number =>
      Math.min(...ls.map((l) => Math.min(l.width, Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y))));
    for (const c of COMPONENTS) {
      if (acrossPart(c.footprint)) continue;
      const sh = partShape(c.footprint, C, D);
      if (!sh || sh.leads.length <= 2) continue;
      const outer = smallest([sh.leads[0]!, sh.leads[sh.leads.length - 1]!]);
      expect(smallest(sh.leads), `${c.id} has a middle pad smaller than its outermost two`)
        .toBeCloseTo(outer, 9);
    }
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
