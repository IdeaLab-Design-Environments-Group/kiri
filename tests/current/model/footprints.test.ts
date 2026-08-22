import { describe, expect, it } from "vitest";
import {
  COMPONENTS,
  LED_1206,
  R_1206,
  SW_SPDT,
} from "../../../src/model/footprints.generated.js";
import {
  holes,
  isTerminal,
  MM_PER_INCH,
  padAt,
  padNamed,
  padPoints,
  padSize,
  terminals,
} from "../../../src/model/footprint.js";
import { LED, RESISTOR, SPDT } from "../../../src/model/parts.js";

/**
 * The component library.
 *
 * These parts are not authored here — they are read out of the manufacturers' own KiCad footprints by
 * `ocaml/kicad.ml`, and the generated file is committed. So what is worth asserting is not "the resistor
 * is 4mm long" (that is the file's business) but that the pipeline between the file and the router keeps
 * its meaning: units, axis, which pads are terminals, and the one place we knowingly depart from the part.
 */
describe("model/footprints", () => {
  it("gives every part terminals, numbered from one", () => {
    expect(COMPONENTS.length).toBeGreaterThan(0);
    for (const c of COMPONENTS) {
      const t = terminals(c.footprint);
      expect(t.length, `${c.id} has no terminals`).toBeGreaterThan(0);
      // Pad numbers are the part's own, so they start at 1 and do not repeat.
      const indices = t.map(([, p]) => p.index);
      expect(new Set(indices).size).toBe(indices.length);
      expect(Math.min(...indices)).toBe(1);
      for (const [name, pad] of t) {
        expect(padPoints(pad).length, `${c.id}.${name} has no outline`).toBeGreaterThan(2);
        const { w, h } = padSize(pad);
        expect(w, `${c.id}.${name} is flat`).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
      }
    }
  });

  it("keeps millimetres out of the stored representation and inches out of the model", () => {
    // A 1206 pad is a couple of millimetres, which is a couple of hundredths of an inch. If the scale
    // were dropped the two would differ by 25x, and a pad would be the size of a fingernail.
    const pad = padNamed(R_1206, "1");
    expect(Math.abs(pad.pos[0])).toBeLessThan(0.5);        // inches, as stored
    expect(Math.abs(padAt(pad).x)).toBeGreaterThan(1);     // millimetres, as read
    expect(padAt(pad).x * (1 / MM_PER_INCH)).toBeCloseTo(pad.pos[0], 12);
  });

  it("tells a terminal from a mounting hole", () => {
    // The switch seats on two pegs. They are in the footprint because we cut them, but a rail must never
    // try to reach one — being off every copper layer is what says so.
    const pegs = holes(SW_SPDT);
    expect(pegs.length).toBe(2);
    for (const peg of pegs) {
      expect(isTerminal(peg)).toBe(false);
      expect(peg.drill!.diameter).toBeGreaterThan(0);
    }
    expect(terminals(SW_SPDT).map(([n]) => n)).toEqual(["1", "2", "3"]);
  });

  it("reads a two-terminal part as a gap the rail can be broken by", () => {
    for (const part of [LED, RESISTOR]) {
      expect(part.pitch).toBeGreaterThan(part.pad.w);
      // The gap is bare pattern between the pads — pitch less one pad, so each pad still lands on copper.
      expect(part.gap).toBeCloseTo(part.pitch - part.pad.w, 12);
      expect(part.gap).toBeGreaterThan(0);
    }
    // Both are 1206 packages, so they agree — which is also a check that the two came through the same way.
    expect(LED.pitch).toBeCloseTo(RESISTOR.pitch, 12);
  });

  it("moves only the switch's common, and moves it across", () => {
    // The part itself is single-row surface mount: all three terminals share an edge.
    const rows = new Set(terminals(SW_SPDT).map(([, p]) => p.pos[1]));
    expect(rows.size, "the stored footprint should be the manufacturer's, unmodified").toBe(1);

    // The model puts the common on the far side so a rail runs through rather than doubling back.
    expect(Math.sign(SPDT.common.y)).toBe(-Math.sign(SPDT.throwA.y));
    expect(SPDT.rowSep).toBeCloseTo(SPDT.throwA.y - SPDT.common.y, 12);
    expect(SPDT.rowSep).toBeGreaterThan(0);

    // The throws stay where the part put them: same row, a pitch either side of the common's column.
    expect(SPDT.throwA.y).toBeCloseTo(SPDT.throwB.y, 12);
    expect(SPDT.throwB.x - SPDT.common.x).toBeCloseTo(SPDT.pitch, 12);
    expect(SPDT.common.x - SPDT.throwA.x).toBeCloseTo(SPDT.pitch, 12);
  });

  it("takes the switch pitch from the file rather than from the package name", () => {
    // Twice this was wrong: 2.54mm assumed from "1x03", then 2.5mm read off a datasheet page. The
    // footprint says 2.5mm exactly, and now so do we.
    expect(SPDT.pitch).toBeCloseTo(2.5, 9);
  });

  it("keeps the LED's pads a pad-width apart, so a break leaves copper under both", () => {
    const [a, c] = [padNamed(LED_1206, "1"), padNamed(LED_1206, "2")];
    expect(padAt(a).y).toBeCloseTo(padAt(c).y, 12);
    expect(Math.abs(padAt(c).x - padAt(a).x)).toBeCloseTo(LED.pitch, 12);
    expect(padSize(a)).toEqual(padSize(c));
  });
});
