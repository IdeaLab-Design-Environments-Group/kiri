/**
 * The netlist: nets the author declares, and where their terminals land.
 *
 * Every test here is about one property — a netlist entry either becomes a point the router must join, or
 * becomes a fault the user can act on, and never nothing. A terminal that quietly disappears is a net that
 * quietly loses a connection, and the circuit then looks routed while being wrong.
 */
import { describe, expect, it } from "vitest";
import { resolveNetlist, padPosition } from "../../../src/model/netlist.js";
import type { Circuit, Vec2 } from "../../../src/model/electronics.js";
import { TAPE_MM, partFit } from "../../../src/model/electronics-routing.js";
import { BatteryContact_Keystone_555, LED_1206, R_1206, SW_SPDT } from "../../../src/model/footprints.generated.js";
import { Module_XIAO_Generic_SocketSMD } from "../../../src/model/footprints.rest.generated.js";
import { padAt, padNamed, padSize, terminals } from "../../../src/model/footprint.js";
import { partShape } from "../../../src/model/copper-svg-export.js";

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
    // And carries the pad's own narrowest extent, for a leg to taper down onto — the smaller of its two
    // footprint dimensions, converted through the same tape-width scale as its position.
    const size = padSize(R_1206["1"]!);
    expect(first.padWidth).toBeCloseTo(Math.min(size.w, size.h), 9);
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

    it("keeps a one-terminal net when the bus has already laid its rail", () => {
      // Not a slip when there IS something to connect it to. A single pad on PWR is a part asking to be
      // tapped onto the rail the bus already laid, and `planNets` can lay that tap — so reporting it a
      // fault and dropping the net gave that pad no copper at all while the editor's sidebar counted it
      // alongside the battery and the LEDs and showed the net as wired.
      const c = circuit({ terminals: [{ part: 0, pad: "1", net: "n1" }] });
      const { nets, faults } = resolveNetlist(c, TAPE_W, TAPE_MM, new Set(["n1"]));
      expect(nets.map((n) => n.name)).toEqual(["PWR"]);
      expect(nets[0]!.points).toHaveLength(1);
      expect(faults).toEqual([]);
    });

    it("still reports an empty net when its rail exists, because there is nothing to tap", () => {
      // The other half of the same rule, and the reason it is not simply "rail nets are exempt": a rail
      // with no pad on it is not a connection waiting to be made, it is a net nobody has wired yet.
      const c = circuit({ terminals: [] });
      const f = resolveNetlist(c, TAPE_W, TAPE_MM, new Set(["n1"])).faults;
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

  describe("a free part on a two-row footprint", () => {
    // The bug this guards: a 14-pad socket like the XIAO's, dropped free and turned, routed a declared
    // net to the wrong physical pin -- the trace tapped the bus cleanly and still missed the pad, because
    // `padPosition` placed every pad at its raw, unrotated footprint coordinate while the canvas drew the
    // part turned by `rot` and anchored on `rowShape`'s own `common` pad, not the footprint's origin.
    const fp = Module_XIAO_Generic_SocketSMD;

    /** Where the canvas actually draws a named pad's centre — same construction as `freeParts()`. */
    function drawnCentre(cx: number, cy: number, rot: number, flip: boolean | undefined, padName: string): Vec2 {
      const half = ((partFit(fp).gap * TAPE_W) / TAPE_MM) / 2;
      const th = (rot * Math.PI) / 180;
      const ux = Math.cos(th), uy = Math.sin(th);
      const a = { x: cx - ux * half, y: cy - uy * half };
      const b = { x: cx + ux * half, y: cy + uy * half };
      const shape = partShape(fp, a, b, flip)!;
      const lead = shape.leads.find((l) => l.name === padName)!;
      return { x: (lead.a.x + lead.b.x) / 2, y: (lead.a.y + lead.b.y) / 2 };
    }

    it.each([0, 90, 137, -40])("routes pad 1 to where it is drawn, turned %s°", (rot) => {
      const part = { component: "Module_XIAO_Generic_SocketSMD", x: 5, y: -2, free: true, rot };
      const routed = padPosition(part, fp, "1", TAPE_W, TAPE_MM)!;
      const drawn = drawnCentre(5, -2, rot, undefined, "1");
      expect(routed.x).toBeCloseTo(drawn.x, 6);
      expect(routed.y).toBeCloseTo(drawn.y, 6);
    });

    it("does not confuse pad 1 with pad 7 once rotated", () => {
      // Exactly the reported symptom: at some turn, the unrotated formula's pad "1" landed near where
      // pad "7" is actually drawn.
      const part = { component: "Module_XIAO_Generic_SocketSMD", x: 0, y: 0, free: true, rot: 55 };
      const pad1 = padPosition(part, fp, "1", TAPE_W, TAPE_MM)!;
      const drawn7 = drawnCentre(0, 0, 55, undefined, "7");
      expect(Math.hypot(pad1.x - drawn7.x, pad1.y - drawn7.y)).toBeGreaterThan(1);
      const drawn1 = drawnCentre(0, 0, 55, undefined, "1");
      expect(pad1.x).toBeCloseTo(drawn1.x, 6);
      expect(pad1.y).toBeCloseTo(drawn1.y, 6);
    });

    it("turns a seated part by its stored angle, and leaves one saved without an angle exactly where it was", () => {
      // **This rule changed on 2026-08-27, and the old one was the bug.** It used to read "`rot` is only
      // meaningful with `free`; a seated part must not suddenly start rotating" — so a seated part routed to
      // unrotated footprint coordinates while being DRAWN along the run it breaks. Measured on the bundled
      // patterns, that put an R_1206's pads 2.59mm to 3.54mm from where they are drawn, which on a part
      // whose pads are 3mm apart is a whole pitch: a net wired to pad 1 had its copper laid on pad 2.
      //
      // A seated part is now stored with the angle of the run it lands on, decided once by
      // `electronics-modal.ts` when it is dropped, and placed like any other part thereafter.
      const turned = padPosition({ component: "Module_XIAO_Generic_SocketSMD", x: 0, y: 0, rot: 90 }, fp, "1", TAPE_W, TAPE_MM)!;
      const upright = padPosition({ component: "Module_XIAO_Generic_SocketSMD", x: 0, y: 0, rot: 0 }, fp, "1", TAPE_W, TAPE_MM)!;
      expect(Math.hypot(turned.x - upright.x, turned.y - upright.y)).toBeGreaterThan(0);

      // But a circuit saved before seated parts had an angle keeps the placement it was cut to. Re-placing
      // a part in a file the author has already cut copper for would be worse than leaving it wrong, and
      // re-dropping the part is what fixes it.
      const legacy = padPosition({ component: "Module_XIAO_Generic_SocketSMD", x: 0, y: 0 }, fp, "1", TAPE_W, TAPE_MM)!;
      const local = padAt(padNamed(fp, "1"));
      expect(legacy.x).toBeCloseTo((local.x * TAPE_W) / TAPE_MM, 9);
      expect(legacy.y).toBeCloseTo((local.y * TAPE_W) / TAPE_MM, 9);
    });
  });

});
