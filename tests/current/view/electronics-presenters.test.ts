import { describe, expect, it } from "vitest";
import {
  buildNetRows,
  buildPadRows,
  buildPartRows,
  derivedNetRows,
  netPanelRows,
  netTally,
  netlistTrouble,
  partsTally,
  statusLine,
  strandedOn,
} from "../../../src/view/electronics-presenters.js";
import type { Circuit } from "../../../src/model/electronics.js";
import { EMPTY_ROUTE, type RoutedCircuit } from "../../../src/model/electronics-routing.js";
import { GND_NET_ID, PWR_NET_ID } from "../../../src/model/net-palette.js";
import { terminals } from "../../../src/model/footprint.js";
import { PART_BY_ID } from "../../../src/view/electronics-palette.js";

/** The emptiest circuit that still typechecks: nothing placed, nothing declared. */
function bare(over: Partial<Circuit> = {}): Circuit {
  return { leds: [], battery: null, ...over } as Circuit;
}

/** The two rails as `withDefaultNets` seeds them — every fresh pattern starts here. */
function rails(): Circuit["nets"] {
  return [
    { id: PWR_NET_ID, name: "PWR", color: "#ff0000" },
    { id: GND_NET_ID, name: "GND", color: "#000000" },
  ];
}

/** A route that laid *something*, so the derived rows are allowed to claim the rails. */
function routedSomething(over: Partial<RoutedCircuit> = {}): RoutedCircuit {
  return {
    ...EMPTY_ROUTE,
    traces: [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], width: 1 }],
    ...over,
  } as RoutedCircuit;
}

const zero = { x: 0, y: 0 };
const somewhere = { x: 3, y: 4 };

describe("view/electronics-presenters > derivedNetRows", () => {
  it("claims nothing before anything has been routed", () => {
    const c = bare({ nets: rails(), battery: { face: 0, x: 0, y: 0 } as never });
    expect(derivedNetRows(c, EMPTY_ROUTE)).toEqual([]);
  });

  it("claims nothing when the rails have not been declared", () => {
    const c = bare({ nets: [], battery: { face: 0, x: 0, y: 0 } as never });
    expect(derivedNetRows(c, routedSomething())).toEqual([]);
  });

  it("puts the battery on both rails once copper exists", () => {
    const c = bare({ nets: rails(), battery: { face: 0, x: 0, y: 0 } as never });
    expect(derivedNetRows(c, routedSomething())).toEqual([
      { net: PWR_NET_ID, label: "Battery +", derived: true },
      { net: GND_NET_ID, label: "Battery −", derived: true },
    ]);
  });

  it("counts a routed LED's two legs, and says nothing for an unreachable one", () => {
    const c = bare({
      nets: rails(),
      battery: null,
      leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    });
    const routed = routedSomething({
      pads: [{ pwr: somewhere, gnd: somewhere }, { pwr: zero, gnd: zero }] as never,
      unreachable: [1],
    });
    expect(derivedNetRows(c, routed).map((r) => r.label)).toEqual(["LED 1 +", "LED 1 −"]);
  });

  it("says nothing for an LED whose pads came back zeroed, even when it is not listed unreachable", () => {
    const c = bare({ nets: rails(), leds: [{ a: 0, b: 1 }] });
    const routed = routedSomething({ pads: [{ pwr: zero, gnd: zero }] as never });
    expect(derivedNetRows(c, routed)).toEqual([]);
  });

  it("never marks a derived row as storable — no part or pad to point at", () => {
    const c = bare({ nets: rails(), battery: { face: 0, x: 0, y: 0 } as never });
    for (const row of derivedNetRows(c, routedSomething())) {
      expect(row.derived).toBe(true);
      expect(row.part).toBeUndefined();
      expect(row.pad).toBeUndefined();
    }
  });
});

describe("view/electronics-presenters > netPanelRows", () => {
  it("is empty for a circuit with nothing wired and nothing routed", () => {
    expect(netPanelRows(bare({ nets: rails() }), EMPTY_ROUTE)).toEqual([]);
  });

  it("names a stored pad by designator, and keeps the indices that unwire it", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "2", net: PWR_NET_ID }],
    });
    expect(netPanelRows(c, EMPTY_ROUTE)).toEqual([
      { net: PWR_NET_ID, label: "R1 · 2", derived: false, part: 0, pad: "2" },
    ]);
  });

  it("falls back to the raw index when the terminal names a part that is not there", () => {
    const c = bare({ nets: rails(), parts: [], terminals: [{ part: 7, pad: "1", net: PWR_NET_ID }] });
    expect(netPanelRows(c, EMPTY_ROUTE)[0]!.label).toBe("part 7 · 1");
  });

  it("puts the stored rows first and the router's own rows after them", () => {
    const c = bare({
      nets: rails(),
      battery: { face: 0, x: 0, y: 0 } as never,
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: PWR_NET_ID }],
    });
    expect(netPanelRows(c, routedSomething()).map((r) => r.derived)).toEqual([false, true, true]);
  });
});

describe("view/electronics-presenters > strandedOn", () => {
  it("is null for a net the router finished", () => {
    const routed = routedSomething({
      nets: [{ id: PWR_NET_ID, name: "PWR", traces: [], stranded: [], railTap: "none" }] as never,
    });
    expect(strandedOn(routed, PWR_NET_ID)).toBeNull();
  });

  it("is null for a net the router never saw", () => {
    expect(strandedOn(EMPTY_ROUTE, "n9")).toBeNull();
  });

  it("counts the stranded terminals and carries the router's own sentence", () => {
    const routed = routedSomething({
      nets: [
        { id: "n1", name: "SDA", traces: [], stranded: [0, 2], why: "crossed n2", railTap: "none" },
      ] as never,
    });
    expect(strandedOn(routed, "n1")).toEqual({ count: 2, why: "crossed n2" });
  });

  it("writes its own sentence when the router did not", () => {
    const routed = routedSomething({
      nets: [{ id: "n1", name: "SDA", traces: [], stranded: [0], railTap: "none" }] as never,
    });
    expect(strandedOn(routed, "n1")!.why).toBe("1 terminals could not be reached");
  });
});

describe("view/electronics-presenters > buildNetRows", () => {
  it("is empty when nothing has been declared", () => {
    expect(buildNetRows(bare(), EMPTY_ROUTE, new Set())).toEqual([]);
    expect(netTally(bare())).toEqual({ text: "0", title: "0 nets declared" });
  });

  it("counts one net in the singular", () => {
    expect(netTally(bare({ nets: [{ id: "n1", name: "SDA" }] }))).toEqual({
      text: "1",
      title: "1 net declared",
    });
  });

  it("disables the twisty and reads a dot on a net with no pads", () => {
    const [pwr] = buildNetRows(bare({ nets: rails() }), EMPTY_ROUTE, new Set());
    expect(pwr!.twist).toEqual({
      glyph: "·",
      disabled: true,
      label: "PWR has no pads",
      title: "No pads on this net yet",
    });
    expect(pwr!.tally).toEqual({ text: "0", title: "0 pads on this net" });
    expect(pwr!.pads).toEqual([]);
  });

  it("offers to expand a closed net that has pads, and to collapse an open one", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: PWR_NET_ID }],
    });
    const closed = buildNetRows(c, EMPTY_ROUTE, new Set())[0]!;
    expect(closed.open).toBe(false);
    expect(closed.twist).toEqual({
      glyph: "▸",
      disabled: false,
      label: "Expand PWR",
      title: "Show this net's pads",
    });
    expect(closed.tally).toEqual({ text: "1", title: "1 pad on this net" });

    const open = buildNetRows(c, EMPTY_ROUTE, new Set([PWR_NET_ID]))[0]!;
    expect(open.open).toBe(true);
    expect(open.twist.glyph).toBe("▾");
    expect(open.twist.label).toBe("Collapse PWR");
    expect(open.pads.map((p) => p.label)).toEqual(["R1 · 1"]);
  });

  it("counts the router's derived rows in the tally, so a routed rail does not read 0", () => {
    const c = bare({ nets: rails(), battery: { face: 0, x: 0, y: 0 } as never });
    const rows = buildNetRows(c, routedSomething(), new Set());
    expect(rows.map((r) => r.tally.text)).toEqual(["1", "1"]);
  });

  it("keeps declaration order and resolves each net's colour", () => {
    const c = bare({ nets: [{ id: "n1", name: "SDA", color: "#123456" }, ...rails()!] });
    const rows = buildNetRows(c, EMPTY_ROUTE, new Set());
    expect(rows.map((r) => r.name)).toEqual(["SDA", "PWR", "GND"]);
    expect(rows[0]!.colour).toBe("#123456");
    expect(rows[1]!.colour).toBe("#ff0000");
  });

  it("carries the stranded marker through onto the net's row", () => {
    const routed = routedSomething({
      nets: [{ id: PWR_NET_ID, name: "PWR", traces: [], stranded: [1], why: "no room", railTap: "none" }] as never,
    });
    const rows = buildNetRows(bare({ nets: rails() }), routed, new Set());
    expect(rows[0]!.stranded).toEqual({ count: 1, why: "no room" });
    expect(rows[1]!.stranded).toBeNull();
  });

  it("labels every control with the net's own name", () => {
    const row = buildNetRows(bare({ nets: [{ id: "n1", name: "SDA" }] }), EMPTY_ROUTE, new Set())[0]!;
    expect(row.colourTitle).toBe("Colour for SDA");
    expect(row.colourLabel).toBe("Colour for net SDA");
    expect(row.nameLabel).toBe("Net name: SDA");
    expect(row.deleteTitle).toBe("Delete the net SDA, and unwire its pads");
  });
});

describe("view/electronics-presenters > buildPartRows", () => {
  it("is empty for a circuit with no library parts", () => {
    expect(buildPartRows(bare(), null)).toEqual([]);
    expect(partsTally(bare())).toEqual({ text: "0", title: "0 parts placed" });
    expect(partsTally(bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] }))).toEqual({
      text: "1",
      title: "1 part placed",
    });
  });

  it("reads the designator, the note and the wired count off the part", () => {
    const pads = terminals(PART_BY_ID.get("R_1206")!.footprint).length;
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: PWR_NET_ID }],
    });
    const row = buildPartRows(c, null)[0]!;
    expect(row.index).toBe(0);
    expect(row.tag).toBe("R1");
    expect(row.wired).toEqual({
      on: 1,
      pads,
      text: `1/${pads}`,
      title: `1 of ${pads} pads on a net`,
    });
    expect(row.unassigned).toBe(false);
  });

  it("marks a part with nothing on a net, and only when it has pads to wire", () => {
    const c = bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] });
    expect(buildPartRows(c, null)[0]!.unassigned).toBe(true);
    const unknown = bare({ parts: [{ component: "NOT_A_PART", x: 0, y: 0 }] });
    const row = buildPartRows(unknown, null)[0]!;
    expect(row.wired.pads).toBe(0);
    expect(row.wired.text).toBe("0/0");
    expect(row.unassigned).toBe(false);
    // Nothing to read a note from, so the raw component id is what is left to say.
    expect(row.note).toBe("NOT_A_PART");
  });

  it("lights the row the canvas has selected, and only that one", () => {
    const c = bare({
      parts: [{ component: "R_1206", x: 0, y: 0 }, { component: "R_1206", x: 1, y: 0 }],
    });
    expect(buildPartRows(c, { kind: "part", index: 1 }).map((r) => r.active)).toEqual([false, true]);
    // A selected LED or legacy part is not a row in this list.
    expect(buildPartRows(c, { kind: "led", index: 0 }).map((r) => r.active)).toEqual([false, false]);
    expect(buildPartRows(c, { kind: "resistor", index: 1 }).map((r) => r.active)).toEqual([false, false]);
  });

  it("numbers parts of the same family in placement order", () => {
    const c = bare({
      parts: [{ component: "R_1206", x: 0, y: 0 }, { component: "R_1206", x: 1, y: 0 }],
    });
    expect(buildPartRows(c, null).map((r) => r.tag)).toEqual(["R1", "R2"]);
  });
});

describe("view/electronics-presenters > buildPadRows", () => {
  it("is null with nothing selected", () => {
    expect(buildPadRows(bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] }), null)).toBeNull();
  });

  it("is null for an LED or a legacy part, which have no pads to offer", () => {
    const c = bare({ leds: [{ a: 0, b: 1 }], parts: [{ component: "R_1206", x: 0, y: 0 }] });
    expect(buildPadRows(c, { kind: "led", index: 0 })).toBeNull();
    expect(buildPadRows(c, { kind: "resistor", index: 0 })).toBeNull();
  });

  it("is null when the selection points past the end of the list", () => {
    const c = bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] });
    expect(buildPadRows(c, { kind: "part", index: 4 })).toBeNull();
  });

  it("is null for a part whose component id is not in the library", () => {
    const c = bare({ parts: [{ component: "NOT_A_PART", x: 0, y: 0 }] });
    expect(buildPadRows(c, { kind: "part", index: 0 })).toBeNull();
  });

  it("names every terminal the footprint offers, and closes the last row", () => {
    const c = bare({ nets: rails(), parts: [{ component: "R_1206", x: 0, y: 0 }] });
    const panel = buildPadRows(c, { kind: "part", index: 0 })!;
    expect(panel.heading).toBe("R_1206 pads");
    expect(panel.rows.map((r) => r.pad)).toEqual(
      terminals(PART_BY_ID.get("R_1206")!.footprint).map(([name]) => name),
    );
    expect(panel.rows.map((r) => r.last)).toEqual(panel.rows.map((_r, i) => i === panel.rows.length - 1));
    expect(panel.rows[0]!.padTitle).toBe(`Pad ${panel.rows[0]!.pad}`);
  });

  it("suggests the declared names, in declaration order", () => {
    const c = bare({
      nets: [...rails()!, { id: "n1", name: "SDA", color: "#123456" }],
      parts: [{ component: "R_1206", x: 0, y: 0 }],
    });
    expect(buildPadRows(c, { kind: "part", index: 0 })!.suggestions).toEqual(["PWR", "GND", "SDA"]);
  });

  it("shows the net a pad is on, in that net's colour, and nothing for an unwired pad", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: GND_NET_ID }],
    });
    const rows = buildPadRows(c, { kind: "part", index: 0 })!.rows;
    const one = rows.find((r) => r.pad === "1")!;
    expect(one.netName).toBe("GND");
    expect(one.colour).toBe("#000000");
    const other = rows.find((r) => r.pad !== "1")!;
    expect(other.netName).toBe("");
    expect(other.colour).toBeNull();
  });

  it("reads only the selected part's own terminals", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }, { component: "R_1206", x: 1, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: PWR_NET_ID }],
    });
    const second = buildPadRows(c, { kind: "part", index: 1 })!;
    expect(second.rows.every((r) => r.netName === "")).toBe(true);
  });

  it("leaves a pad blank when its net has been deleted out from under it", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: "n9" }],
    });
    const one = buildPadRows(c, { kind: "part", index: 0 })!.rows.find((r) => r.pad === "1")!;
    expect(one.netName).toBe("");
    expect(one.colour).toBeNull();
  });
});

describe("view/electronics-presenters > netlistTrouble", () => {
  it("is silent on a clean netlist", () => {
    expect(netlistTrouble(bare({ nets: rails() }), EMPTY_ROUTE)).toBe("");
  });

  it("stays silent about a net nobody has wired yet, which is not a fault", () => {
    const routed = routedSomething({
      netFaults: [{ kind: "single-terminal-net", net: PWR_NET_ID, why: "fewer than two terminals" }] as never,
    });
    expect(netlistTrouble(bare({ nets: rails() }), routed)).toBe("");
  });

  it("reports a net with exactly one pad on it, which is a mistake worth pointing at", () => {
    const c = bare({
      nets: rails(),
      parts: [{ component: "R_1206", x: 0, y: 0 }],
      terminals: [{ part: 0, pad: "1", net: PWR_NET_ID }],
    });
    const routed = routedSomething({
      netFaults: [{ kind: "single-terminal-net", net: PWR_NET_ID, why: "fewer than two terminals" }] as never,
    });
    expect(netlistTrouble(c, routed)).toBe(" · 1 netlist fault: fewer than two terminals");
  });

  it("counts faults and quotes the first one", () => {
    const routed = routedSomething({
      netFaults: [
        { kind: "no-such-net", why: "pad 1 names a net that is gone" },
        { kind: "duplicate-terminal", why: "pad 2 is on two nets" },
      ] as never,
    });
    expect(netlistTrouble(bare(), routed)).toBe(
      " · 2 netlist faults: pad 1 names a net that is gone",
    );
  });

  it("adds up the stranded terminals across every net", () => {
    const routed = routedSomething({
      nets: [
        { id: "n1", name: "A", traces: [], stranded: [0], railTap: "none" },
        { id: "n2", name: "B", traces: [], stranded: [0, 1], railTap: "none" },
      ] as never,
    });
    expect(netlistTrouble(bare(), routed)).toBe(
      " · 3 terminals could not be reached without crossing another net",
    );
  });

  it("says both, in that order, when both are wrong", () => {
    const routed = routedSomething({
      netFaults: [{ kind: "no-such-pad", why: "R1 has no pad 9" }] as never,
      nets: [{ id: "n1", name: "A", traces: [], stranded: [0], railTap: "none" }] as never,
    });
    expect(netlistTrouble(bare(), routed)).toBe(
      " · 1 netlist fault: R1 has no pad 9 · 1 terminal could not be reached without crossing another net",
    );
  });
});

describe("view/electronics-presenters > statusLine", () => {
  /** The status of a circuit at rest: auto-routing, nothing selected, no wire under the hand. */
  function status(over: Partial<Parameters<typeof statusLine>[0]> = {}): string {
    return statusLine({
      circuit: bare(),
      routed: EMPTY_ROUTE,
      routedPartCount: 0,
      wireCount: 0,
      wiring: false,
      wireFaults: [],
      wireDrawing: false,
      stale: false,
      autoRoute: true,
      placedCount: 0,
      selected: null,
      picked: undefined,
      ...over,
    });
  }

  it("opens with the counts, and says so when there is nothing at all", () => {
    expect(status()).toBe("0 LEDs · no battery");
  });

  it("asks for a battery only once there is an LED to power", () => {
    expect(status({ circuit: bare({ leds: [{ a: 0, b: 1 }] }) })).toBe(
      "1 LED · no battery · add a battery · click a component to select it",
    );
  });

  it("tells an unreachable LED apart from one that will not sit on its hinge", () => {
    const circuit = bare({
      leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }],
      battery: { face: 0, x: 0, y: 0 } as never,
    });
    const routed = { ...EMPTY_ROUTE, unreachable: [0, 1, 2], unseated: [1, 2] };
    expect(status({ circuit, routed })).toContain("· 1 unreachable");
    expect(status({ circuit, routed })).toContain("· 2 LEDs do not fit on their hinge");
    const one = { ...EMPTY_ROUTE, unreachable: [0], unseated: [0] };
    expect(status({ circuit, routed: one })).toContain("· 1 LED does not fit on its hinge");
    expect(status({ circuit, routed: one })).not.toContain("unreachable");
  });

  it("stays quiet about unreachable LEDs while there is no battery to reach them from", () => {
    const circuit = bare({ leds: [{ a: 0, b: 1 }] });
    expect(status({ circuit, routed: { ...EMPTY_ROUTE, unreachable: [0] } })).not.toContain(
      "unreachable",
    );
  });

  it("names each kind of part the router had to drop", () => {
    const circuit = bare({
      switches: [{ x: 0, y: 0 }, { x: 1, y: 0 }] as never,
      resistors: [{ x: 0, y: 1 }] as never,
      parts: [{ component: "R_1206", x: 0, y: 0 }],
    });
    const msg = status({ circuit });
    // "switchs", not "switches": the plural is a bare `s`. Recorded as it behaves, not as it reads.
    expect(msg).toContain("· 2 switchs did not fit — that run is too short for the part");
    expect(msg).toContain("· 1 resistor did not fit — that run is too short for the part");
    expect(msg).toContain("· 1 part did not fit — that run is too short for the part");
  });

  it("counts the hand-drawn wires", () => {
    expect(status({ wireCount: 1 })).toContain("· 1 hand wire");
    expect(status({ wireCount: 3 })).toContain("· 3 hand wires");
  });

  it("hints at the wire tool only while it holds the canvas", () => {
    expect(status()).not.toContain("start a wire");
    expect(status({ wiring: true })).toContain("· tap the pattern to start a wire");
    expect(status({ wiring: true, wireDrawing: true })).toContain(
      "· tap to lay a point, tap the last one or press Enter to finish",
    );
  });

  it("says a wire cannot be cut when the fault is an error, and warns when it is not", () => {
    const bad = status({
      wiring: true,
      wireFaults: [{ kind: "off-body", why: "leaves the sheet" }],
    });
    expect(bad).toContain("· this wire cannot be cut: leaves the sheet");
    const warn = status({
      wiring: true,
      wireFaults: [{ kind: "fold-fatigue", why: "crosses a fold" }],
    });
    expect(warn).toContain("· 1 warning, still cuttable: crosses a fold");
  });

  it("puts stale copper ahead of the selection hint, and manual routing when it is not stale", () => {
    const circuit = bare({ leds: [{ a: 0, b: 1 }], battery: { face: 0, x: 0, y: 0 } as never });
    expect(status({ circuit, stale: true })).toBe(
      "1 LED · battery set · copper is out of date — press Route · click a component to select it",
    );
    expect(status({ circuit, autoRoute: false })).toBe(
      "1 LED · battery set · routing on request · click a component to select it",
    );
    expect(status({ circuit, stale: true, autoRoute: false })).not.toContain("routing on request");
  });

  it("names what is selected, and whether its orientation is the author's or the router's", () => {
    const circuit = bare({ leds: [{ a: 0, b: 1 }], battery: { face: 0, x: 0, y: 0 } as never });
    expect(status({ circuit, selected: { kind: "led", index: 0 }, picked: { a: 0, b: 1 } as never }))
      .toContain("· LED 1 selected — R to turn it round, Delete to remove (router chooses)");
    expect(status({ circuit, selected: { kind: "led", index: 0 }, picked: { flip: true } }))
      .toContain("(orientation fixed — R again to let the router choose)");
  });

  it("reads a selected library part's name off the library", () => {
    const circuit = bare({ parts: [{ component: "R_1206", x: 0, y: 0 }] });
    const note = PART_BY_ID.get("R_1206")!.note || "Part";
    expect(status({
      circuit,
      routedPartCount: 1,
      placedCount: 1,
      selected: { kind: "part", index: 0 },
      picked: { x: 0, y: 0 } as never,
    })).toContain(`· ${note} 1 selected`);
  });

  it("falls back to the legacy names for the two pre-library lists", () => {
    const circuit = bare({ resistors: [{ x: 0, y: 0 }] as never, switches: [{ x: 1, y: 0 }] as never });
    const args = { routed: { ...EMPTY_ROUTE, resistors: [{}], switches: [{}] } as never, placedCount: 2 };
    expect(status({ ...args, circuit, selected: { kind: "resistor", index: 0 }, picked: {} }))
      .toContain("· Resistor 1 selected");
    expect(status({ ...args, circuit, selected: { kind: "switch", index: 0 }, picked: {} }))
      .toContain("· Switch 1 selected");
  });

  it("offers the selection hint whenever there is something to select and nothing is", () => {
    expect(status({ placedCount: 1 })).toContain("· click a component to select it");
    // A selection whose index no longer names anything is not a selection.
    expect(status({ placedCount: 1, selected: { kind: "part", index: 3 }, picked: undefined }))
      .toContain("· click a component to select it");
  });

  it("carries the netlist trouble, ahead of the staleness", () => {
    const routed = routedSomething({
      nets: [{ id: "n1", name: "A", traces: [], stranded: [0], railTap: "none" }] as never,
    });
    expect(status({ routed, stale: true })).toBe(
      "0 LEDs · no battery · 1 terminal could not be reached without crossing another net" +
        " · copper is out of date — press Route",
    );
  });
});
