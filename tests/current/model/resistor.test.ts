import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit } from "../../../src/model/electronics.js";
import {
  RESISTOR_MM,
  SWITCH_PITCH_MM,
  planRoutes,
  tapeWidthFor,
  totalLength,
} from "../../../src/model/electronics-routing.js";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
  resistorShape,
  switchShape,
} from "../../../src/model/copper-svg-export.js";
import { printScale } from "../../../src/model/print-scale.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house, and the midpoint of its PWR run — somewhere a resistor can sit.
 *
 *  One LED by default. Three when both rails need a run longer than the resistor's body: with one, house's
 *  GND run is 5.7mm end to end and cannot take a 6.5mm part at all. */
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

describe("model/resistor", () => {
  it("breaks the copper it sits on, instead of narrowing it", () => {
    // Both a resistor's ends are on +. Tape running underneath therefore shorts it out and the LEDs see the
    // full battery — so unlike an LED, which straddles the two nets and only needs the strip pinched, this
    // has to be a real gap in the copper.
    const { faces, gaps, base, plain, mid, k } = fixture();
    const withRes = planRoutes(faces, gaps, { ...base, resistors: [mid] });

    const pwrBefore = plain.traces.filter((t) => t.net === "pwr").length;
    const pwrAfter = withRes.traces.filter((t) => t.net === "pwr").length;
    expect(pwrAfter).toBe(pwrBefore + 1); // one run became two

    const removed = (totalLength(plain.traces) - totalLength(withRes.traces)) * k;
    expect(removed).toBeCloseTo(RESISTOR_MM, 1); // exactly the body's length of copper
  });

  it("reports where the leads land, so the part can be drawn on the break", () => {
    const { faces, gaps, base, mid, tapeW, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });
    expect(r.resistors).toHaveLength(1);
    const { a, b } = r.resistors[0]!;
    // The two ends are the cut ends of the run: a body's length apart along it, so at most that in a line.
    const span = Math.hypot(a.x - b.x, a.y - b.y) * k;
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(RESISTOR_MM + 1e-6);
    // And they are on the copper's centreline, not somewhere off the run.
    const near = r.traces
      .filter((t) => t.net === "pwr")
      .some((t) => t.pts.some((p) => Math.hypot(p.x - a.x, p.y - a.y) < tapeW * 0.01));
    expect(near).toBe(true);
  });

  it("breaks whichever rail it is put on", () => {
    // In series is in series: a resistor limits the current the same on the way out as on the way back, so
    // either rail will take one.
    // Three LEDs: with one, house's GND run is too short to hold a resistor (see the test below).
    const { faces, gaps, base, plain, k } = fixture(3);
    const runLength = (t: { pts: { x: number; y: number }[] }): number => {
      let s = 0;
      for (let i = 1; i < t.pts.length; i++) s += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
      return s;
    };
    for (const net of ["pwr", "gnd"] as const) {
      // The longest run of this net — a run shorter than the body cannot take one, see below.
      const run = plain.traces
        .filter((t) => t.net === net)
        .sort((x, y) => runLength(y) - runLength(x))[0]!;
      const at = run.pts[Math.floor(run.pts.length / 2)]!;
      const r = planRoutes(faces, gaps, { ...base, resistors: [at] });
      const before = plain.traces.filter((t) => t.net === net).length;
      expect(r.traces.filter((t) => t.net === net), `${net} run split`).toHaveLength(before + 1);
      expect(r.resistors).toHaveLength(1);
      expect((totalLength(plain.traces) - totalLength(r.traces)) * k).toBeCloseTo(RESISTOR_MM, 1);
    }
  });

  it("leaves a run too short to hold one alone", () => {
    // Breaking a run shorter than the body would take all its copper and strand whatever it feeds. Better a
    // resistor whose leads need bending than a branch that quietly loses its supply.
    const { faces, gaps, base, plain, k } = fixture();
    const short = plain.traces
      .map((t) => {
        let len = 0;
        for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
        return { t, len: len * k };
      })
      .find((r) => r.len < RESISTOR_MM);
    expect(short, "the fixture needs a run shorter than the body").toBeTruthy();

    const at = short!.t.pts[Math.floor(short!.t.pts.length / 2)]!;
    const r = planRoutes(faces, gaps, { ...base, resistors: [at] });
    const before = plain.traces.filter((t) => t.net === short!.t.net).length;
    expect(r.traces.filter((t) => t.net === short!.t.net)).toHaveLength(before);
    expect(r.resistors).toHaveLength(0); // nothing drawn, because nothing was broken
  });

  it("lays its contacts across the tape, not along it", () => {
    // The join is a band of lead pressed over the full width of the copper. Drawn along the run it read as
    // a line down the middle of the tape, which is not where a lead touches.
    const { faces, gaps, base, mid, tapeW, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });
    const { a, b } = r.resistors[0]!;
    const sh = resistorShape(a, b, tapeW)!;
    expect(sh.leads).toHaveLength(2);
    // And the body reaches both of them: drawn shorter than the break, the part came out as three
    // disconnected pieces with bare pattern showing between the black and each grey contact.
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    expect(sh.body.w).toBeGreaterThanOrEqual(span);
    const run = { x: b.x - a.x, y: b.y - a.y };
    const runLen = Math.hypot(run.x, run.y);
    for (const l of sh.leads) {
      const across = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
      // Square to the run: the dot product of the two directions is nil.
      const dot = (across.x * run.x + across.y * run.y) / (Math.hypot(across.x, across.y) * runLen);
      expect(Math.abs(dot)).toBeLessThan(1e-9);
      // And a tape's width across, so it covers the copper it sits on.
      expect(Math.hypot(across.x, across.y) * k).toBeCloseTo(tapeW * k, 6);
    }
  });

  it("is drawn on both cut files, and cut on neither", () => {
    // The part is not copper. A cut along it would slice the tape it is bridging.
    const { fold, faces, gaps, base, mid, tapeW } = fixture();
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid] });

    const strips = buildCopperSvgExport(fold, r.traces, tapeW, "k", r.pads, undefined, undefined, r.resistors);
    expect(strips.svg).toContain('id="parts"');
    expect(strips.svg).toContain("#8b93a1"); // the leads, onto the copper
    expect(strips.svg).toContain("#111111"); // the body, over the gap

    const carrier = buildCopperCarrierExport(
      fold, r.traces, tapeW, "k", [], undefined, undefined, r.pads, r.resistors,
    );
    // The carrier group only: it is filled copper now, and the annotation that names the parts is drawn on
    // top of it — so slicing to the end of the file would sweep the annotation in and prove nothing.
    const from = carrier.svg.indexOf('<g id="carrier"');
    const cut = carrier.svg.slice(from, carrier.svg.indexOf("</g>", from));
    expect(cut).not.toContain("#8b93a1");
    expect(cut).not.toContain("#111111");
  });

  it("leaves the circuit alone when there are none", () => {
    const { faces, gaps, base, plain } = fixture();
    const same = planRoutes(faces, gaps, { ...base, resistors: [] });
    expect(same.traces).toEqual(plain.traces);
    expect(same.resistors).toEqual([]);
  });
});

describe("model/switch", () => {
  it("breaks the rail by one pin pitch, and puts two pins one side and one the other", () => {
    // A 1x03 header at 0.1in centres. The break falls between the second pin and the third, so pins 1 and 2
    // land on the copper behind it and pin 3 on the copper in front — which is what a header in a rail is.
    const { fold, faces, gaps, base, plain, mid, tapeW, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, switches: [mid] });

    expect(r.switches).toHaveLength(1);
    const removed = (totalLength(plain.traces) - totalLength(r.traces)) * k;
    expect(removed).toBeCloseTo(SWITCH_PITCH_MM, 1);

    const { a, b } = r.switches[0]!;
    const sh = switchShape(a, b, tapeW)!;
    expect(sh.leads).toHaveLength(3);

    // Two contacts behind the break, one in front — measured along the run.
    const ux = (b.x - a.x) / Math.hypot(b.x - a.x, b.y - a.y);
    const uy = (b.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y);
    const along = (p: { x: number; y: number }): number => (p.x - a.x) * ux + (p.y - a.y) * uy;
    const sides = sh.leads.map((l) => along({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }));
    expect(sides.filter((d) => d < 0)).toHaveLength(2);
    expect(sides.filter((d) => d > 0)).toHaveLength(1);

    // And it is drawn on the file, not cut into it.
    const out = buildCopperSvgExport(
      fold, r.traces, tapeW, "k", r.pads, undefined, undefined, r.resistors, undefined, r.switches,
    );
    expect(out.svg).toContain('id="parts"');
  });

  it("takes a switch and a resistor on the same circuit", () => {
    const { faces, gaps, base, plain, mid, k } = fixture(3);
    const pwr = plain.traces.filter((t) => t.net === "pwr");
    const other = pwr[pwr.length - 1]!;
    const at = other.pts[Math.floor(other.pts.length / 2)]!;
    const r = planRoutes(faces, gaps, { ...base, resistors: [mid], switches: [at] });
    expect(r.resistors).toHaveLength(1);
    expect(r.switches).toHaveLength(1);
    const removed = (totalLength(plain.traces) - totalLength(r.traces)) * k;
    expect(removed).toBeCloseTo(RESISTOR_MM + SWITCH_PITCH_MM, 1);
  });
});
