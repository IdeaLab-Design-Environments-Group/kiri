import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit } from "../../../src/model/electronics.js";
import {
  RESISTOR_MM,
  SWITCH_PITCH_MM,
  breakRuns,
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
    // Breaking a run shorter than the part would take all its copper and strand whatever it feeds. Better a
    // part whose leads need bending than a branch that quietly loses its supply. Tested on `breakRuns`
    // directly: with a 1206's 1.42mm gap no bundled run is short enough to show it.
    const run = { net: "pwr" as const, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
    const wide = breakRuns([run], [{ x: 0.5, y: 0 }], 4); // a part four times the run's length
    expect(wide.traces).toEqual([run]);
    expect(wide.placed).toEqual([]);

    // One that does fit still breaks it.
    const fits = breakRuns([run], [{ x: 0.5, y: 0 }], 0.4);
    expect(fits.traces).toHaveLength(2);
    expect(fits.placed).toHaveLength(1);
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
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const sides = sh.leads.map((l) => along({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }));
    // Two terminals behind the break, one past it.
    expect(sides.filter((d) => d <= 1e-9)).toHaveLength(2);
    expect(sides.filter((d) => d > 1e-9)).toHaveLength(1);
    void span;

    // And spaced at the part's own pitch, on a run that BENDS inside the break. Spacing them by the gap
    // they straddle put them 2.25mm apart against a 2.489mm pitch: the chord across a bend is shorter than
    // the copper taken out, and a rigid part's pins do not close up when the tape curves under them. A
    // straight test run hides this exactly, since there the two are equal.
    const ordered = [...sides].sort((x, y) => x - y);
    expect(ordered[1]! - ordered[0]!).toBeCloseTo(SWITCH_PITCH_MM, 6);
    expect(ordered[2]! - ordered[1]!).toBeCloseTo(SWITCH_PITCH_MM, 6);

    // All three on the copper's centreline, not off its edge.
    for (const l of sh.leads) {
      const c = { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 };
      const off = (c.x - a.x) * -uy + (c.y - a.y) * ux;
      expect(Math.abs(off)).toBeLessThan(1e-9);
    }

    // And it is drawn on the file, not cut into it.
    const out = buildCopperSvgExport(
      fold, r.traces, tapeW, "k", r.pads, undefined, undefined, r.resistors, undefined, r.switches,
    );
    expect(out.svg).toContain('id="parts"');
  });

  it("is the size the datasheet says", () => {
    // fab-modules pcb.py, class slide_switch (C&K AYZ0102AGRLC): pads .039 x .047in on .098in centres,
    // offset .1in from the origin, plus two .034in mounting holes at ±.059in. Real millimetres from the
    // library, not a size invented to look right.
    const { faces, gaps, base, mid, tapeW, k } = fixture();
    const r = planRoutes(faces, gaps, { ...base, switches: [mid] });
    const { a, b } = r.switches[0]!;

    // One pitch of copper comes out. Measured along the run, not across it: the run bends inside the break,
    // so the straight line between the cut ends is shorter than the copper removed and can only be shorter.
    const chord = Math.hypot(a.x - b.x, a.y - b.y) * k;
    expect(chord).toBeGreaterThan(0);
    expect(chord).toBeLessThanOrEqual(SWITCH_PITCH_MM + 1e-9);

    // Sheet coordinates are millimetres, so the part is measured directly.
    const sh = switchShape({ x: 0, y: 0 }, { x: SWITCH_PITCH_MM, y: 0 }, tapeW * k)!;
    // Pads .039 x .047in, from pcb.py's slide_switch.
    for (const l of sh.leads) {
      expect(l.width).toBeCloseTo(0.039 * 25.4, 4);
      expect(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y)).toBeCloseTo(0.047 * 25.4, 4);
    }
    // Two mounting holes, .034in across at ±.059in — the part's own.
    expect(sh.holes).toHaveLength(2);
    for (const h of sh.holes!) expect(h.r).toBeCloseTo((0.034 * 25.4) / 2, 4);
    expect(Math.hypot(sh.holes![1]!.c.x - sh.holes![0]!.c.x, sh.holes![1]!.c.y - sh.holes![0]!.c.y))
      .toBeCloseTo(0.118 * 25.4, 4);
    // The housing stands clear of the pad row by the pads' own .1in offset, rather than over the copper.
    expect(Math.hypot(sh.body.cy - 0, sh.body.cx - SWITCH_PITCH_MM / 2)).toBeGreaterThan(0.09 * 25.4);

    // Three terminals at one pitch, so 5,0 across all of them.
    const along = sh.leads.map((l) => (l.a.x + l.b.x) / 2).sort((x, y) => x - y);
    expect(along[1]! - along[0]!).toBeCloseTo(SWITCH_PITCH_MM, 6);
    expect(along[2]! - along[1]!).toBeCloseTo(SWITCH_PITCH_MM, 6);
    expect(along[2]! - along[0]!).toBeCloseTo(2 * SWITCH_PITCH_MM, 6);


  });

  it("places one dropped at the very end of a run", () => {
    // A part needs a half-body of copper either side. Dropped near an end there was not room, and it was
    // simply not placed: a click that did nothing, with nothing to say why. It slides inboard instead.
    const { faces, gaps, base, plain, k } = fixture();
    for (const net of ["pwr", "gnd"] as const) {
      const run = plain.traces.find((t) => t.net === net)!;
      for (const at of [run.pts[0]!, run.pts[run.pts.length - 1]!]) {
        const r = planRoutes(faces, gaps, { ...base, switches: [at] });
        expect(r.switches, `${net} at an end`).toHaveLength(1);
        expect(r.traces.filter((t) => t.net === net)).toHaveLength(
          plain.traces.filter((t) => t.net === net).length + 1,
        );
        expect((totalLength(plain.traces) - totalLength(r.traces)) * k).toBeCloseTo(SWITCH_PITCH_MM, 2);
      }
    }
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
