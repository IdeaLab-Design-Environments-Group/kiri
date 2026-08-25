import { describe, expect, it } from "vitest";
import type { Circuit, Net } from "../../../src/model/electronics.js";
import {
  GND_COLOUR,
  GND_NET_ID,
  NET_PALETTE,
  PWR_COLOUR,
  PWR_NET_ID,
  defaultNets,
  netColour,
  nextNetColour,
  withDefaultNets,
} from "../../../src/model/net-palette.js";

const bare = (): Circuit => ({ leds: [], battery: null });

describe("model/net-palette", () => {
  describe("defaultNets", () => {
    it("is the battery's two rails, under the ids the bus router already tags its copper with", () => {
      // Not cosmetic: `copper-svg-export` takes a run onto one of its two cut layers by matching these
      // exact strings, so a declared PWR net under any other id is dropped from the strips file.
      const nets = defaultNets();
      expect(nets.map((n) => n.id)).toEqual([PWR_NET_ID, GND_NET_ID]);
      expect(nets.map((n) => n.name)).toEqual(["PWR", "GND"]);
    });

    it("gives the rails the colours the canvas already draws them in", () => {
      // `.el-tape-pwr` and `.el-tape-gnd` in the stylesheet are these values. A seeded net that
      // disagreed would be the sidebar contradicting the copper drawn under it.
      const [pwr, gnd] = defaultNets();
      expect(pwr!.color).toBe(PWR_COLOUR);
      expect(gnd!.color).toBe(GND_COLOUR);
    });

    it("hands back a fresh pair each call, so editing one circuit's nets cannot edit the next one's", () => {
      const a = defaultNets();
      const b = defaultNets();
      expect(a).not.toBe(b);
      expect(a[0]).not.toBe(b[0]);
      a[0]!.name = "VCC";
      expect(b[0]!.name).toBe("PWR");
    });
  });

  describe("nextNetColour", () => {
    it("takes the first colour nobody is using", () => {
      expect(nextNetColour([])).toBe(NET_PALETTE[0]);
      expect(nextNetColour([NET_PALETTE[0]!])).toBe(NET_PALETTE[1]);
    });

    it("reuses a colour freed by a deleted net rather than walking past it", () => {
      // Otherwise deleting the first of five nets and adding one leaves a gap that never fills, and the
      // palette is exhausted by a circuit that only ever had five nets at once.
      const taken = [NET_PALETTE[1]!, NET_PALETTE[2]!];
      expect(nextNetColour(taken)).toBe(NET_PALETTE[0]);
    });

    it("ignores case, so a colour typed in upper case is not handed out twice", () => {
      expect(nextNetColour([NET_PALETTE[0]!.toUpperCase()])).toBe(NET_PALETTE[1]);
    });

    it("wraps once the palette is spent instead of running out", () => {
      const all = [...NET_PALETTE];
      const got = nextNetColour(all);
      expect(NET_PALETTE).toContain(got);
    });
  });

  describe("netColour", () => {
    it("uses the net's own colour when it has one", () => {
      expect(netColour({ id: "n1", name: "SDA", color: "#123456" }, 7)).toBe("#123456");
    });

    it("falls back on the rail colours for the two rails, whatever their position", () => {
      // A circuit saved before colours existed still has PWR and GND, and they still have to be red and
      // black — the canvas draws the bus that way regardless.
      expect(netColour({ id: PWR_NET_ID, name: "PWR" }, 4)).toBe(PWR_COLOUR);
      expect(netColour({ id: GND_NET_ID, name: "GND" }, 9)).toBe(GND_COLOUR);
    });

    it("gives two uncoloured nets different stand-ins, so they stay apart on the canvas", () => {
      const a: Net = { id: "n1", name: "SDA" };
      const b: Net = { id: "n2", name: "SCL" };
      expect(netColour(a, 0)).not.toBe(netColour(b, 1));
    });

    it("treats a blank colour as no colour rather than as a colour", () => {
      expect(netColour({ id: "n1", name: "SDA", color: "   " }, 0)).toBe(NET_PALETTE[0]);
    });
  });

  describe("withDefaultNets", () => {
    it("seeds the two rails into a circuit that has never declared a net", () => {
      const out = withDefaultNets(bare());
      expect(out.nets?.map((n) => n.name)).toEqual(["PWR", "GND"]);
      expect(out.terminals).toEqual([]);
    });

    it("seeds a circuit whose nets array is present but empty", () => {
      const out = withDefaultNets({ ...bare(), nets: [] });
      expect(out.nets?.map((n) => n.id)).toEqual([PWR_NET_ID, GND_NET_ID]);
    });

    it("does NOT put back a rail the author deleted", () => {
      // The whole point of seeding only an undeclared circuit. Re-seeding would restore PWR on every
      // reload and the author would have no way to say no.
      const kept: Net[] = [{ id: GND_NET_ID, name: "GND", color: GND_COLOUR }];
      const out = withDefaultNets({ ...bare(), nets: kept });
      expect(out.nets?.map((n) => n.id)).toEqual([GND_NET_ID]);
    });

    it("colours in a net saved before colours existed, and leaves the coloured ones alone", () => {
      const nets: Net[] = [
        { id: "n1", name: "SDA", color: "#abcdef" },
        { id: "n2", name: "SCL" },
      ];
      const out = withDefaultNets({ ...bare(), nets });
      expect(out.nets?.[0]!.color).toBe("#abcdef");
      expect(out.nets?.[1]!.color).toBeTruthy();
      expect(out.nets?.[1]!.color).not.toBe("#abcdef");
    });

    it("preserves terminals and everything else on the circuit", () => {
      const c: Circuit = {
        leds: [{ a: 0, b: 1 }],
        battery: { face: 2 },
        nets: [{ id: "n1", name: "SDA" }],
        terminals: [{ part: 0, pad: "1", net: "n1" }],
      };
      const out = withDefaultNets(c);
      expect(out.leds).toEqual(c.leds);
      expect(out.battery).toEqual(c.battery);
      expect(out.terminals).toEqual(c.terminals);
    });

    it("never mutates its argument — the editor holds circuits as immutable snapshots", () => {
      const c = bare();
      const out = withDefaultNets(c);
      expect(c.nets).toBeUndefined();
      expect(out).not.toBe(c);
    });

    it("hands back the same object when there is nothing to do, so an edit is not invented", () => {
      const c: Circuit = { ...bare(), nets: [{ id: "n1", name: "SDA", color: "#abcdef" }] };
      expect(withDefaultNets(c)).toBe(c);
    });
  });
});
