/**
 * The netlist: nets the author declares, and where their terminals land.
 *
 * Every test here is about one property — a netlist entry either becomes a point the router must join, or
 * becomes a fault the user can act on, and never nothing. A terminal that quietly disappears is a net that
 * quietly loses a connection, and the circuit then looks routed while being wrong.
 */
import { describe, expect, it } from "vitest";
import { defaultTerminals, resolveNetlist, padPosition } from "../../../src/model/netlist.js";
import type { Circuit } from "../../../src/model/electronics.js";
import { TAPE_MM } from "../../../src/model/electronics-routing.js";
import { BatteryContact_Keystone_555, LED_1206, R_1206, SW_SPDT } from "../../../src/model/footprints.generated.js";
import { padAt, terminals } from "../../../src/model/footprint.js";

/** A pattern whose tape is the full 3.25mm, so pattern units ARE millimetres and the arithmetic is legible. */
const TAPE_W = TAPE_MM;

function circuit(over: Partial<Circuit> = {}): Circuit {
  return {
    leds: [],
    battery: null,
    parts: [
      { component: "R_1206", x: 10, y: 0 },
      { component: "LED_1206", x: 20, y: 0 },
    ],
    nets: [{ id: "n1", name: "PWR" }],
    terminals: [
      { part: 0, pad: "1", net: "n1" },
      { part: 1, pad: "1", net: "n1" },
    ],
    ...over,
  };
}

describe("model/netlist", () => {
  it("puts a pad where the part is, offset by the pad's own place on the footprint", () => {
    // The one unit conversion in this file: a footprint is in millimetres about the part's origin, a part
    // is in flat pattern units. At a 3.25mm tape the two coincide, so the numbers can be read off.
    const at = padPosition({ component: "R_1206", x: 10, y: 4 }, R_1206, "1", TAPE_W, TAPE_MM)!;
    const local = padAt(R_1206["1"]!);
    expect(at.x).toBeCloseTo(10 + local.x, 9);
    expect(at.y).toBeCloseTo(4 + local.y, 9);
    // The two pads are the footprint's own pitch apart, not the tape's or the pattern's.
    const b = padPosition({ component: "R_1206", x: 10, y: 4 }, R_1206, "2", TAPE_W, TAPE_MM)!;
    expect(Math.hypot(b.x - at.x, b.y - at.y)).toBeCloseTo(Math.abs(padAt(R_1206["2"]!).x - local.x), 9);
  });

  it("turns a flipped part through half a turn, not through a mirror", () => {
    // A mirror would reverse the pads' order along the rail, which makes a polarised part read as a
    // different component. Half a turn keeps the order and swaps the ends, which is what flip means
    // everywhere else in this codebase.
    const up = padPosition({ component: "R_1206", x: 0, y: 0 }, R_1206, "1", TAPE_W, TAPE_MM)!;
    const over = padPosition({ component: "R_1206", x: 0, y: 0, flip: true }, R_1206, "1", TAPE_W, TAPE_MM)!;
    expect(over.x).toBeCloseTo(-up.x, 9);
    expect(over.y).toBeCloseTo(-up.y, 9);
  });

  it("resolves a well-formed netlist into one net with its two points, and no faults", () => {
    const { nets, faults } = resolveNetlist(circuit(), TAPE_W, TAPE_MM);
    expect(faults).toEqual([]);
    expect(nets).toHaveLength(1);
    expect(nets[0]!.name).toBe("PWR");
    expect(nets[0]!.points.map((p) => [p.part, p.pad])).toEqual([
      [0, "1"],
      [1, "1"],
    ]);
    // And each point is where that pad actually is, not where the part's origin is.
    const first = nets[0]!.points[0]!;
    expect(first.at.x).toBeCloseTo(10 + padAt(R_1206["1"]!).x, 9);
  });

  it("keeps the author's order, for nets and for the points within one", () => {
    // The router makes its own ordering decisions and they are the router's to make. Reordering here would
    // hide them behind a second, invisible one.
    const c = circuit({
      nets: [
        { id: "b", name: "GND" },
        { id: "a", name: "PWR" },
      ],
      terminals: [
        { part: 1, pad: "2", net: "b" },
        { part: 0, pad: "2", net: "b" },
        { part: 0, pad: "1", net: "a" },
        { part: 1, pad: "1", net: "a" },
      ],
    });
    const { nets } = resolveNetlist(c, TAPE_W, TAPE_MM);
    expect(nets.map((n) => n.name)).toEqual(["GND", "PWR"]);
    expect(nets[0]!.points.map((p) => p.part)).toEqual([1, 0]);
  });

  describe("faults — every bad entry is reported, never dropped", () => {
    const fault = (over: Partial<Circuit>): ReturnType<typeof resolveNetlist>["faults"] =>
      resolveNetlist(circuit(over), TAPE_W, TAPE_MM).faults;

    it("names a terminal pointing at a net that does not exist", () => {
      const f = fault({ terminals: [{ part: 0, pad: "1", net: "ghost" }] });
      expect(f.some((x) => x.kind === "no-such-net" && x.net === "ghost")).toBe(true);
    });

    it("names a terminal pointing past the end of the part list", () => {
      const f = fault({ terminals: [{ part: 9, pad: "1", net: "n1" }] });
      expect(f.some((x) => x.kind === "no-such-part" && x.part === 9)).toBe(true);
    });

    it("names a pad the footprint does not have", () => {
      const f = fault({ terminals: [{ part: 0, pad: "47", net: "n1" }] });
      const hit = f.find((x) => x.kind === "no-such-pad");
      expect(hit?.pad).toBe("47");
      expect(hit?.why).toContain("R_1206");
    });

    it("names a part whose component is not in the library", () => {
      const f = fault({
        parts: [{ component: "NOT_A_REAL_PART", x: 0, y: 0 }],
        terminals: [{ part: 0, pad: "1", net: "n1" }],
      });
      expect(f.some((x) => x.kind === "unknown-component")).toBe(true);
    });

    it("refuses to put one pad on two nets, and says which pad", () => {
      // Physically impossible and electrically a short. The second assignment is the one rejected, so the
      // first still stands and the rest of the net still routes.
      const f = fault({
        nets: [
          { id: "n1", name: "PWR" },
          { id: "n2", name: "GND" },
        ],
        terminals: [
          { part: 0, pad: "1", net: "n1" },
          { part: 1, pad: "1", net: "n1" },
          { part: 0, pad: "1", net: "n2" },
          { part: 1, pad: "2", net: "n2" },
        ],
      });
      const hit = f.find((x) => x.kind === "duplicate-terminal");
      expect(hit?.part).toBe(0);
      expect(hit?.pad).toBe("1");
    });

    it("reports a net with one terminal, and leaves it out of the routing set", () => {
      // The likeliest authoring slip there is: a pad assigned to a net nothing else is on. Routed, it is a
      // zero-length success that reports nothing wrong.
      const c = circuit({ terminals: [{ part: 0, pad: "1", net: "n1" }] });
      const { nets, faults } = resolveNetlist(c, TAPE_W, TAPE_MM);
      expect(nets).toEqual([]);
      expect(faults.some((x) => x.kind === "single-terminal-net" && x.why.includes("one terminal"))).toBe(true);
    });

    it("reports an empty net differently from a one-terminal net", () => {
      const c = circuit({ terminals: [] });
      const f = resolveNetlist(c, TAPE_W, TAPE_MM).faults;
      expect(f.some((x) => x.kind === "single-terminal-net" && x.why.includes("no terminals"))).toBe(true);
    });

    it("keeps routing the good nets when another one is broken", () => {
      // A fault in one net must not cost the user the rest of the circuit.
      const c = circuit({
        nets: [
          { id: "n1", name: "PWR" },
          { id: "bad", name: "SDA" },
        ],
        terminals: [
          { part: 0, pad: "1", net: "n1" },
          { part: 1, pad: "1", net: "n1" },
          { part: 0, pad: "99", net: "bad" },
        ],
      });
      const { nets, faults } = resolveNetlist(c, TAPE_W, TAPE_MM);
      expect(nets.map((n) => n.name)).toEqual(["PWR"]);
      expect(faults).toHaveLength(2); // the bad pad, and SDA left with nothing on it
    });
  });

  it("treats a circuit with no nets as the two-rail bus, not as an empty netlist", () => {
    // Every file saved before nets existed is this one. It must resolve to nothing at all rather than to a
    // netlist with no connections, which is what would make the router think it had been asked for nothing.
    const { nets, faults } = resolveNetlist({ leds: [], battery: null }, TAPE_W, TAPE_MM);
    expect(nets).toEqual([]);
    expect(faults).toEqual([]);
  });

  it("will not take a net assignment on a mounting peg", () => {
    // A peg is a pad in the footprint file and carries no signal, so honouring one would route copper to a
    // hole. `SW_SPDT` really has two — an unnamed pad and the `_1` the parser mints for a duplicate name —
    // which is what makes this test able to tell `terminals()` apart from "every key in the object".
    const pegs = Object.keys(SW_SPDT).filter((n) => !terminals(SW_SPDT).some(([t]) => t === n));
    expect(pegs).toContain("_1"); // the fixture is only meaningful while the peg is really there

    const c = circuit({
      parts: [{ component: "SW_SPDT", x: 0, y: 0 }, { component: "R_1206", x: 10, y: 0 }],
      terminals: [
        { part: 0, pad: "_1", net: "n1" },
        { part: 1, pad: "1", net: "n1" },
      ],
    });
    const { nets, faults } = resolveNetlist(c, TAPE_W, TAPE_MM);
    expect(faults.some((x) => x.kind === "no-such-pad" && x.pad === "_1")).toBe(true);
    // And the peg never becomes a point, so nothing downstream can route to it.
    expect(nets.flatMap((n) => n.points).some((p) => p.pad === "_1")).toBe(false);
  });

  it("refuses to place a mechanical pad even when asked for one directly", () => {
    // The same guard one level down. `resolveNetlist` screens pad names, but `padPosition` is exported and
    // a caller that skipped that screen would otherwise get a real position for a peg.
    expect(padPosition({ component: "SW_SPDT", x: 0, y: 0 }, SW_SPDT, "_1", TAPE_W, TAPE_MM)).toBeNull();
    expect(padPosition({ component: "SW_SPDT", x: 0, y: 0 }, SW_SPDT, "2", TAPE_W, TAPE_MM)).not.toBeNull();
  });


  describe("defaults for a newly placed part", () => {
    const RAILS = [{ id: "pwr" }, { id: "gnd" }];

    it("puts a two-pad part across the supply, one pad on each rail", () => {
      // The busywork this removes: an LED dropped on a tile used to arrive with no terminals at all and
      // stay unwired until the author assigned both pads by hand -- for the one part where there is exactly
      // one sensible answer.
      const t = defaultTerminals(3, LED_1206, RAILS);
      const names = terminals(LED_1206).map(([n]) => n);
      expect(t).toEqual([
        { part: 3, pad: names[0], net: "pwr" },
        { part: 3, pad: names[1], net: "gnd" },
      ]);
    });

    it("guesses nothing for a part with more than two pads", () => {
      // A three-pad part's terminals are not a supply pair. Putting its first two on PWR and GND would be
      // a short, stated as a default and never questioned because nobody typed it.
      expect(defaultTerminals(0, SW_SPDT, RAILS)).toEqual([]);
      expect(terminals(SW_SPDT).length).toBeGreaterThan(2);
    });

    it("guesses nothing when the rails are gone, rather than naming a net that does not exist", () => {
      // The author may rename or delete the seeded rails. A default pointing at a missing net would have
      // the app raise a `no-such-net` fault against the author for something they never wrote.
      expect(defaultTerminals(0, R_1206, [{ id: "sda" }, { id: "scl" }])).toEqual([]);
      expect(defaultTerminals(0, R_1206, [{ id: "pwr" }])).toEqual([]);
      expect(defaultTerminals(0, R_1206, [])).toEqual([]);
    });

    it("names pads the footprint really has, so the assignment resolves", () => {
      // The pair is read off the footprint, never assumed to be "1" and "2" -- a part whose datasheet
      // numbers its pads "A" and "K" would otherwise get two terminals that resolve to nothing.
      // A part whose pads are NOT called "1" and "2": this contact's two terminals are "1" and "1_1",
      // the second being the name the parser mints for a repeat. Hardcoding the usual pair would give it
      // two terminals naming a pad it does not have, and `resolveNetlist` would reject both.
      const odd = defaultTerminals(0, BatteryContact_Keystone_555, RAILS);
      expect(odd.map((x) => x.pad)).toEqual(["1", "1_1"]);

      const t = defaultTerminals(0, LED_1206, RAILS);
      const real = new Set(terminals(LED_1206).map(([n]) => n));
      for (const x of t) expect(real.has(x.pad)).toBe(true);
      const circuit: Circuit = {
        leds: [], battery: null,
        nets: [{ id: "pwr", name: "PWR" }, { id: "gnd", name: "GND" }],
        parts: [{ component: "LED_1206", x: 0, y: 0, free: true }],
        terminals: defaultTerminals(0, LED_1206, RAILS),
      };
      // Every pad and net named by the default resolves. The only faults left are `single-terminal-net`,
      // and those are correct rather than tolerated: one LED alone on the rails puts a single point on each,
      // and there genuinely is nothing to connect it to until a battery or a second part joins it. A default
      // that avoided them would have to invent the rest of the circuit.
      const faults = resolveNetlist(circuit, 1, TAPE_MM).faults;
      expect(faults.map((f) => f.kind)).toEqual(["single-terminal-net", "single-terminal-net"]);
    });
  });
});
