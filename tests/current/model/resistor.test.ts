import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit } from "../../../src/model/electronics.js";
import {
  RESISTOR_MM,
  planRoutes,
  tapeWidthFor,
  totalLength,
} from "../../../src/model/electronics-routing.js";
import {
  buildCopperCarrierExport,
  buildCopperSvgExport,
} from "../../../src/model/copper-svg-export.js";
import { printScale } from "../../../src/model/print-scale.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

/** house with one LED, and the midpoint of its PWR run — somewhere a resistor can sit. */
function fixture() {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}house.fkld`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  const base: Circuit = { leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } };
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

  it("never sits on GND", () => {
    // Both ends on +. Breaking a GND run would open the return path and light nothing.
    const { faces, gaps, base, plain } = fixture();
    const gnd = plain.traces.find((t) => t.net === "gnd")!;
    const onGnd = gnd.pts[Math.floor(gnd.pts.length / 2)]!;
    const r = planRoutes(faces, gaps, { ...base, resistors: [onGnd] });
    const gndBefore = plain.traces.filter((t) => t.net === "gnd").length;
    expect(r.traces.filter((t) => t.net === "gnd")).toHaveLength(gndBefore);
    // It snapped to the nearest PWR run instead of being dropped.
    expect(r.resistors).toHaveLength(1);
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
    const cut = carrier.svg.slice(carrier.svg.indexOf('<g id="carrier"'));
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
