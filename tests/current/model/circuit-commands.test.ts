import { describe, expect, it } from "vitest";
import { BATTERY_PART, type Circuit } from "../../../src/model/electronics.js";
import {
  appendPlacedPart,
  assignPad,
  cloneCircuit,
  cycleLedFlip,
  editCircuit,
  removeSelectedPart,
  toggleBattery,
} from "../../../src/model/circuit-commands.js";

describe("circuit commands", () => {
  it("appends parts without dropping the existing circuit shape", () => {
    const circuit: Circuit = {
      leds: [],
      battery: null,
      nets: [{ id: "n1", name: "SIG", color: "#0ea5e9" }],
      terminals: [],
    };

    const next = editCircuit(circuit, appendPlacedPart({ component: "R_1206", x: 1, y: 2, free: true }));

    expect(next.parts).toEqual([{ component: "R_1206", x: 1, y: 2, free: true }]);
    expect(next.nets).toEqual(circuit.nets);
    expect(circuit.parts).toBeUndefined();
  });

  it("gives the battery its two terminals, on PWR and GND, and takes them away with it", () => {
    // The battery is the one part whose net membership is not a guess: its `+` IS the PWR rail. Storing
    // the pair is what puts it in the parts list with pads the author can read and re-point.
    const circuit: Circuit = {
      leds: [],
      battery: null,
      nets: [{ id: "pwr", name: "PWR", color: "#f00" }, { id: "gnd", name: "GND", color: "#000" }],
      terminals: [{ part: 0, pad: "1", net: "pwr" }],
    };

    const on = editCircuit(circuit, toggleBattery(2));
    expect(on.battery).toEqual({ face: 2 });
    expect(on.terminals).toEqual([
      { part: 0, pad: "1", net: "pwr" },
      { part: BATTERY_PART, pad: "+", net: "pwr" },
      { part: BATTERY_PART, pad: "−", net: "gnd" },
    ]);

    // Off again — the same face is what takes it off — and its terminals go with it, leaving the part's.
    const off = editCircuit(on, toggleBattery(2));
    expect(off.battery).toBeNull();
    expect(off.terminals).toEqual([{ part: 0, pad: "1", net: "pwr" }]);
  });

  it("seeds no battery terminals into a circuit that has not declared the rails", () => {
    // A file from before the netlist existed has no nets at all, and a terminal naming a net that is not
    // there is a fault rather than a wiring.
    const circuit: Circuit = { leds: [], battery: null };
    const on = editCircuit(circuit, toggleBattery(0));
    expect(on.battery).toEqual({ face: 0 });
    expect(on.terminals ?? []).toEqual([]);
  });

  it("leaves the battery's terminals alone when a part below them is removed", () => {
    // `reindexTerminals` shifts terminals ABOVE the deleted index. -1 is never above one, which is the
    // whole reason the battery is addressed with it.
    const circuit: Circuit = {
      leds: [],
      battery: { face: 0 },
      parts: [{ component: "R_1206", x: 0, y: 0 }, { component: "C_1206", x: 1, y: 1 }],
      terminals: [
        { part: BATTERY_PART, pad: "+", net: "pwr" },
        { part: 1, pad: "1", net: "n2" },
      ],
    };
    const next = editCircuit(circuit, removeSelectedPart({ kind: "part", index: 0 }));
    expect(next.terminals).toEqual([
      { part: BATTERY_PART, pad: "+", net: "pwr" },
      { part: 0, pad: "1", net: "n2" },
    ]);
  });

  it("reindexes terminals when a library part is removed", () => {
    const circuit: Circuit = {
      leds: [],
      battery: null,
      parts: [
        { component: "R_1206", x: 0, y: 0 },
        { component: "C_1206", x: 1, y: 1 },
        { component: "LED_1206", x: 2, y: 2, free: true },
      ],
      terminals: [
        { part: 0, pad: "1", net: "n1" },
        { part: 1, pad: "1", net: "n2" },
        { part: 2, pad: "2", net: "n3" },
      ],
    };

    const next = editCircuit(circuit, removeSelectedPart({ kind: "part", index: 1 }));

    expect(next.parts).toEqual([
      { component: "R_1206", x: 0, y: 0 },
      { component: "LED_1206", x: 2, y: 2, free: true },
    ]);
    expect(next.terminals).toEqual([
      { part: 0, pad: "1", net: "n1" },
      { part: 1, pad: "2", net: "n3" },
    ]);
  });

  it("cycles authored LED orientation back to router choice", () => {
    const circuit: Circuit = { leds: [{ a: 0, b: 1 }], battery: null };

    const fixed = editCircuit(circuit, cycleLedFlip(0, false));
    const released = editCircuit(fixed, cycleLedFlip(0, true));

    expect(fixed.leds[0]).toEqual({ a: 0, b: 1, flip: true });
    expect(released.leds[0]).toEqual({ a: 0, b: 1 });
  });

  it("assigns a pad to at most one net", () => {
    const circuit: Circuit = {
      leds: [],
      battery: null,
      terminals: [{ part: 0, pad: "1", net: "old" }],
    };

    const next = editCircuit(circuit, assignPad(0, "1", "new"));

    expect(next.terminals).toEqual([{ part: 0, pad: "1", net: "new" }]);
  });

  it("clones store payloads without sharing known mutable fields", () => {
    const circuit: Circuit = {
      leds: [{ a: 0, b: 1, component: "LED_0603" }],
      battery: { face: 0 },
      parts: [{ component: "C_1206", x: 1, y: 2, free: true, rot: 90 }],
      wires: [{ id: "w1", pts: [{ kind: "free", x: 0, y: 0 }] }],
    };

    const cloned = cloneCircuit(circuit);

    expect(cloned).toEqual({
      ...circuit,
      resistors: [],
      switches: [],
      nets: [],
      terminals: [],
    });
    expect(cloned.leds).not.toBe(circuit.leds);
    expect(cloned.parts![0]).not.toBe(circuit.parts![0]);
    expect(cloned.wires![0].pts[0]).not.toBe(circuit.wires![0].pts[0]);
  });
});
