import { describe, expect, it } from "vitest";
import { EMPTY_ROUTE, type RoutedCircuit } from "../../../src/model/electronics-routing.js";
import { withoutLed, withoutPart } from "../../../src/view/stale-copper.js";

const P = (x: number, y: number) => ({ x, y });

function plan(over: Partial<RoutedCircuit>): RoutedCircuit {
  return { ...EMPTY_ROUTE, ...over };
}

describe("view/stale-copper", () => {
  it("takes out the runs that reach a deleted LED's pads, and only those", () => {
    const routed = plan({
      pads: [{ pwr: P(0, 0.5), gnd: P(0, -0.5) }, { pwr: P(10, 0.5), gnd: P(10, -0.5) }],
      traces: [
        { net: "pwr", pts: [P(5, 5), P(0, 0.5)] },   // ends on LED 0's PWR pad
        { net: "gnd", pts: [P(0, -0.52), P(5, -5)] }, // within reach of its GND pad
        { net: "pwr", pts: [P(5, 5), P(10, 0.5)] },  // LED 1's
      ],
    });
    const out = withoutLed(routed, 0, 0.1);
    expect(out.traces).toEqual([routed.traces[2]]);
    expect(out.pads).toEqual([routed.pads[1]]);
    expect(routed.traces, "the input plan was changed").toHaveLength(3);
  });

  it("renumbers the unreachable and unseated LEDs after the deleted one", () => {
    const routed = plan({
      pads: [{ pwr: P(0, 0), gnd: P(0, 0) }, { pwr: P(1, 0), gnd: P(2, 0) }, { pwr: P(0, 0), gnd: P(0, 0) }],
      unreachable: [0, 2],
      unseated: [2],
    });
    const out = withoutLed(routed, 0, 0.1);
    expect(out.unreachable).toEqual([1]);
    expect(out.unseated).toEqual([1]);
    expect(out.pads).toHaveLength(2);
  });

  it("does not treat a zeroed pad pair as copper at the origin", () => {
    const routed = plan({
      pads: [{ pwr: P(0, 0), gnd: P(0, 0) }],
      unreachable: [0],
      traces: [{ net: "pwr", pts: [P(0, 0), P(3, 3)] }],
    });
    expect(withoutLed(routed, 0, 1).traces).toHaveLength(1);
  });

  it("drops a deleted part's span and moves the later parts' sources down one", () => {
    const span = (source: number) => ({ component: "R_1206", a: P(source, 0), b: P(source, 1), net: "pwr", source });
    const routed = plan({ parts: [span(0), span(1), span(2)] });
    const out = withoutPart(routed, "part", 1);
    expect(out.parts.map((s) => s.source)).toEqual([0, 1]);
    expect(out.parts[1]!.a).toEqual(P(2, 0));
  });

  it("leaves the other kinds of part alone", () => {
    const routed = plan({ resistors: [{ a: P(0, 0), b: P(1, 0), net: "pwr", source: 0 }] });
    expect(withoutPart(routed, "switch", 0).resistors).toEqual(routed.resistors);
    expect(withoutPart(routed, "resistor", 0).resistors).toEqual([]);
  });
});
