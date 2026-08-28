import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Led,
  flatFaces,
  gapGraph,
  ledOf,
  pinchMid,
} from "../../../src/model/electronics.js";
import {
  DEFAULT_LED,
  LED_GAP_FRAC,
  MIN_WEED_MM,
  TAPE_MM,
  landingWidth,
  ledSeat,
  planRoutes,
  seatLed,
  tapeWidthFor,
  weedGapFor,
} from "../../../src/model/electronics-routing.js";
import { DEFAULT_SHEET, minWebMm } from "../../../src/model/fold-strain.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;

function load(name: string) {
  const fold = JSON.parse(readFileSync(`${EXAMPLES}${name}`, "utf8"));
  const faces = flatFaces(fold);
  const gaps = gapGraph(fold, faces).gaps;
  return { fold, faces, gaps };
}

/** Up to `max` LEDs on distinct gaps, all of one part. */
function ledsOn(gaps: ReturnType<typeof load>["gaps"], max: number, component?: string): Led[] {
  const leds: Led[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const l = ledOf(g.faceA, g.faceB);
    const k = `${l.a}_${l.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    leds.push(component === undefined ? l : { ...l, component });
    if (leds.length >= max) break;
  }
  return leds;
}

/** Flat pattern units back to sheet millimetres — the inverse of the router's own `toFlat`. */
const toMm = (flat: number, tapeW: number): number => (flat * TAPE_MM) / tapeW;

const PATTERNS = ["house.fkld", "church.fkld", "puffin.fkld"];

describe("model/led-footprint", () => {
  describe("reading a part off the library", () => {
    it("reads the 1206 and the 0603 at their datasheet dimensions", () => {
      // The two numbers everything else here is measured against. If the library or the inch->mm
      // conversion ever moves, this fails first and every other failure below is explained by it.
      expect(ledSeat("LED_1206")).toMatchObject({
        pitch: expect.closeTo(3.4, 3),
        padW: expect.closeTo(1.4, 3),
        gap: expect.closeTo(2.0, 3),
      });
      expect(ledSeat("LED_0603")).toMatchObject({
        pitch: expect.closeTo(1.5, 3),
        padW: expect.closeTo(0.8, 3),
        gap: expect.closeTo(0.7, 3),
      });
    });

    it("takes an LED with no part named for the 1206, so circuits saved before the choice still mean it", () => {
      expect(DEFAULT_LED).toBe("LED_1206");
      expect(ledSeat()).toEqual(ledSeat("LED_1206"));
      expect(ledSeat(undefined)).toEqual(ledSeat("LED_1206"));
    });

    it("refuses a part the library does not have, and one no rail could run through", () => {
      expect(ledSeat("NOT_A_PART")).toBeNull();
      // Three terminals: a reading as two ends would silently drop one.
      expect(ledSeat("SW_SPDT")).toBeNull();
    });
  });

  describe("the copper sits at the part's own pad spacing", () => {
    it("puts an LED's two copper ends its own bare gap apart, not the tile's", { timeout: 60000 }, () => {
      // The measurement this whole change exists for. house.fkld's tile dents are 5.81mm apart, and a
      // 1206's legs are 3.40mm apart, so a real part dropped on that hinge could not reach its own
      // copper. The copper now stops `pitch - padW` = 2.00mm apart, which puts the legs at 3.40 with
      // each leg half on copper.
      for (const name of PATTERNS) {
        const { faces, gaps } = load(name);
        const tapeW = tapeWidthFor(faces);
        const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
        expect(r.unreachable, `${name} seats every 1206`).toEqual([]);
        for (const pad of r.pads) {
          const sep = toMm(Math.hypot(pad.pwr.x - pad.gnd.x, pad.pwr.y - pad.gnd.y), tapeW);
          expect(sep, `${name} copper ends`).toBeCloseTo(ledSeat("LED_1206")!.gap, 6);
        }
      }
    });

    it("centres the two pads on the hinge without moving the printed joinery", { timeout: 60000 }, () => {
      // `pinchMid` is the printed tile geometry as well as the old pad position -- printed-joinery and
      // sim-canvas draw the dents from it -- so the pad is what parts company with the dent, never the
      // other way round. Two things are checked: the pads' midpoint is still the hinge midpoint, and the
      // dents are still exactly where `pinchMid` puts them.
      const { faces, gaps } = load("house.fkld");
      const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
      for (const g of gaps) {
        const [pa, pb] = g.ends;
        const dentA = pinchMid(pa, pb, faces[g.faceA]!.centroid, Math.hypot(g.legA.x - (pa.x + pb.x) / 2, g.legA.y - (pa.y + pb.y) / 2));
        expect(g.legA.x).toBeCloseTo(dentA.x, 12);
        expect(g.legA.y).toBeCloseTo(dentA.y, 12);
      }
      for (const pad of r.pads) {
        const mid = { x: (pad.pwr.x + pad.gnd.x) / 2, y: (pad.pwr.y + pad.gnd.y) / 2 };
        const hinge = gaps.find((g) => Math.hypot(g.point.x - mid.x, g.point.y - mid.y) < 1e-9);
        expect(hinge, "a pad pair is centred on its hinge midpoint").toBeDefined();
      }
    });

    it("reaches in over the tile gap rather than sitting on the tile dent", () => {
      // "Extend the tape over the gap": the pad is now nearer the hinge than the dent is, i.e. out on the
      // bare membrane between two tiles. Anything else and the part still cannot reach.
      const { faces, gaps } = load("house.fkld");
      const seat = ledSeat("LED_1206")!;
      const tapeW = tapeWidthFor(faces);
      for (const g of gaps.slice(0, 6)) {
        const [padA] = seatLed(g, faces, seat, tapeW)!;
        const toPad = toMm(Math.hypot(padA.x - g.point.x, padA.y - g.point.y), tapeW);
        const toDent = toMm(Math.hypot(g.legA.x - g.point.x, g.legA.y - g.point.y), tapeW);
        expect(toPad).toBeCloseTo(seat.gap / 2, 6);
        expect(toPad, "the pad has come in off the tile toward the hinge").toBeLessThan(toDent);
      }
    });

    it("gives two LEDs of different parts on one circuit their own spacing each", { timeout: 60000 }, () => {
      // Nothing may read a single library LED's pitch: the placed part decides. A 1206 and a part with a
      // different pitch on the same circuit have to come out at different separations, or something is
      // reading the default for both.
      const { faces, gaps } = load("puffin.fkld");
      const tapeW = tapeWidthFor(faces);
      const wide = ledSeat("LED_Luminus_1206")!;
      expect(wide.gap).not.toBeCloseTo(ledSeat("LED_1206")!.gap, 2);
      const leds = ledsOn(gaps, 4);
      leds[1] = { ...leds[1]!, component: "LED_Luminus_1206" };
      leds[3] = { ...leds[3]!, component: "LED_Luminus_1206" };
      const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
      expect(r.unreachable).toEqual([]);
      const sep = (i: number) =>
        toMm(Math.hypot(r.pads[i]!.pwr.x - r.pads[i]!.gnd.x, r.pads[i]!.pwr.y - r.pads[i]!.gnd.y), tapeW);
      expect(sep(0)).toBeCloseTo(ledSeat("LED_1206")!.gap, 6);
      expect(sep(1)).toBeCloseTo(wide.gap, 6);
      expect(sep(2)).toBeCloseTo(ledSeat("LED_1206")!.gap, 6);
      expect(sep(3)).toBeCloseTo(wide.gap, 6);
    });

    it("reports which part each pad pair was seated from", () => {
      const { faces, gaps } = load("house.fkld");
      const leds = ledsOn(gaps, 3);
      leds[1] = { ...leds[1]!, component: "LED_Luminus_1206" };
      const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
      expect(r.pads.map((p) => p.component)).toEqual([
        "LED_1206", "LED_Luminus_1206", "LED_1206",
      ]);
    });
  });

  describe("a part that cannot be cut is reported, not drawn wrong", () => {
    it("holds the weeding floor at the number LED_GAP_FRAC has always meant", () => {
      // MIN_WEED_MM is the width of substrate the tweezers can lift, so a footprint can be compared with it.
      // It is NOT a new, smaller constant: if this drifts, the 0603 verdict below has been bought rather than
      // reasoned. 1.1375 is the figure this codebase has always cut to and is the assertion that matters.
      expect(MIN_WEED_MM).toBeCloseTo(1.1375, 6);
      // It used to be spelled `TAPE_MM * LED_GAP_FRAC`, and stopped being that when the tape narrowed to
      // 1.5mm on 2026-08-28: the tweezers do not know how wide the roll is, so a weeding floor that shrinks
      // with the tape claims thinner tape makes the web easier to lift, which is backwards. It now comes
      // from the sheet, whose thickness is what the web's stiffness actually depends on — and at the default
      // sheet that reproduces the old number exactly, which is why the line above is unchanged.
      expect(MIN_WEED_MM).toBeCloseTo(minWebMm(DEFAULT_SHEET), 12);
      expect(MIN_WEED_MM).not.toBeCloseTo(TAPE_MM * LED_GAP_FRAC, 6);
    });

    it("refuses an LED_0603: its 0.70mm bare gap is below what a vinyl cutter can weed", { timeout: 60000 }, () => {
      // The conflict, settled. The 0603 asks for 0.70mm of bare substrate between the two nets and the
      // floor is 1.14mm, so it is reported as not fitting rather than cut as a sliver that tears.
      const seat = ledSeat("LED_0603")!;
      expect(seat.gap).toBeLessThan(MIN_WEED_MM);
      for (const name of PATTERNS) {
        const { faces, gaps } = load(name);
        const leds = ledsOn(gaps, 6, "LED_0603");
        const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
        expect(r.unreachable, `${name} refuses every 0603`).toEqual(leds.map((_, i) => i));
        expect(r.traces, `${name} lays no copper for a part it cannot cut`).toEqual([]);
        for (const pad of r.pads) {
          expect(pad).toEqual({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } });
        }
      }
    });

    it("cannot be rescued by narrowing the landing either", () => {
      // The other half of the decision: it is not that we chose a landing width badly. Copper at its own
      // `landingWidth` floor on both legs eats MIN_WEED_MM of the pitch, so leaving a weedable strip
      // between them needs pitch >= 2*MIN_WEED_MM = 2.275mm whatever else is done. The 0603's pitch is
      // 1.50mm, so no width satisfies both; the 1206's 3.40mm clears it with room to spare.
      const tapeW = TAPE_MM;
      const bareGap = (pitchMm: number): number => {
        const sep = (pitchMm * tapeW) / TAPE_MM;
        return sep - landingWidth({ x: 0, y: 0 }, { x: sep, y: 0 }, tapeW);
      };
      expect(2 * MIN_WEED_MM).toBeCloseTo(2.275, 6);
      expect(bareGap(ledSeat("LED_0603")!.pitch)).toBeLessThan(MIN_WEED_MM);
      expect(bareGap(ledSeat("LED_1206")!.pitch)).toBeGreaterThanOrEqual(MIN_WEED_MM);
    });

    it("refuses a part too long for the tile it half sits on, rather than hanging copper off the sheet", () => {
      // The other seating refusal. Fed a part whose legs are further apart than the pattern is wide, the
      // copper end would land off the material; `seatLed` says so instead.
      const { faces, gaps } = load("house.fkld");
      const tapeW = tapeWidthFor(faces);
      const huge = { ...ledSeat("LED_1206")!, gap: 1e6 };
      expect(seatLed(gaps[0]!, faces, huge, tapeW)).toBeNull();
    });

    it("keeps pads index-aligned with circuit.leds even where some are refused", () => {
      // The modal indexes `pads` directly, so a refused LED has to keep its slot rather than being
      // squeezed out of the list.
      const { faces, gaps } = load("house.fkld");
      const leds = ledsOn(gaps, 4);
      leds[1] = { ...leds[1]!, component: "LED_0603" };
      leds[2] = { ...leds[2]!, component: "NOT_A_PART" };
      const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } });
      expect(r.pads).toHaveLength(4);
      expect(r.unreachable).toEqual([1, 2]);
      expect(r.pads[1]).toEqual({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } });
      expect(r.pads[2]).toEqual({ pwr: { x: 0, y: 0 }, gnd: { x: 0, y: 0 } });
      for (const i of [0, 3]) {
        expect(r.pads[i]!.component).toBe("LED_1206");
        expect(r.pads[i]!.pwr).not.toEqual({ x: 0, y: 0 });
      }
    });
  });

  describe("the copper is still cuttable where a part is seated", () => {
    it("leaves a weedable strip between the two nets under every seated LED", { timeout: 60000 }, () => {
      // Same guarantee the old bespoke pads had, re-measured against the new spacing: the landing narrows
      // so the two nets' copper does not meet under the chip.
      for (const name of PATTERNS) {
        const { faces, gaps } = load(name);
        const tapeW = tapeWidthFor(faces);
        const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
        for (const pad of r.pads) {
          const sep = Math.hypot(pad.pwr.x - pad.gnd.x, pad.pwr.y - pad.gnd.y);
          const a = landingWidth(pad.pwr, pad.gnd, tapeW);
          const b = landingWidth(pad.gnd, pad.pwr, tapeW);
          expect(sep - a / 2 - b / 2, `${name} copper gap under a chip`).toBeGreaterThan(0);
        }
      }
    });

    it("lands both legs of the part on copper", () => {
      // What the whole change is for. Each leg spans `padW` centred at `pitch/2` off the hinge; the copper
      // on that side starts `gap/2` off the hinge and runs outward. So the leg's near edge and the copper's
      // end coincide exactly, and the leg is on copper along its whole length.
      const seat = ledSeat("LED_1206")!;
      const legNear = seat.pitch / 2 - seat.padW / 2;
      const legFar = seat.pitch / 2 + seat.padW / 2;
      expect(legNear).toBeCloseTo(seat.gap / 2, 12);
      expect(legFar).toBeCloseTo(seat.gap / 2 + seat.padW, 12);
    });

    it("brings every landing in along the chip's axis, over the length of the leg", { timeout: 60000 }, () => {
      // The arithmetic above is only true if the tape ARRIVES along that line. It did not: a run that came
      // in diagonally and stopped left a butt cap lying ACROSS the leg, and on house.fkld half of every
      // anode was off its own copper while the two ends were still exactly 2.00mm apart. Rendering it is
      // what showed that; this is the number that keeps it fixed.
      //
      // So: wherever a run ends at an LED pad, its last segment runs down the chip's axis for the length of
      // that part's own leg. Measured as the cosine between the incoming segment and the axis.
      for (const name of PATTERNS) {
        const { faces, gaps } = load(name);
        const tapeW = tapeWidthFor(faces);
        const seat = ledSeat("LED_1206")!;
        const reach = (seat.padW * tapeW) / TAPE_MM;
        const r = planRoutes(faces, gaps, { leds: ledsOn(gaps, 12), battery: { face: 0 } });
        let landings = 0;
        let square = 0;
        for (const t of r.traces) {
          for (const end of [0, t.pts.length - 1]) {
            if (t.pts.length < 2) continue;
            const p = t.pts[end]!;
            const pad = r.pads.find(
              (q) => Math.hypot((t.net === "pwr" ? q.pwr : q.gnd).x - p.x, (t.net === "pwr" ? q.pwr : q.gnd).y - p.y) < 1e-9,
            );
            if (!pad?.component) continue;
            const mate = t.net === "pwr" ? pad.gnd : pad.pwr;
            const prev = t.pts[end === 0 ? 1 : t.pts.length - 2]!;
            const ax = { x: p.x - mate.x, y: p.y - mate.y };
            const inc = { x: prev.x - p.x, y: prev.y - p.y };
            const la = Math.hypot(ax.x, ax.y), li = Math.hypot(inc.x, inc.y);
            const cos = (ax.x * inc.x + ax.y * inc.y) / (la * li);
            landings++;
            // Square the whole way, or it does not count: a head-on stretch shorter than the leg still
            // leaves the far half of the pad off the tape, which is the fault this exists to fix.
            if (cos > 0.999 && li >= reach * 0.99) square++;
          }
        }
        expect(landings, `${name} has landings to check`).toBeGreaterThan(0);
        // Pinned counts rather than a share, because the landings that are NOT squared are not all one case.
        // `landPads` refuses a bend that would fold back on itself -- it tears at the bend and its mitre
        // reaches off the shape -- and it never sees a pad that a run passes THROUGH rather than ends at. On
        // puffin most landings are of that second kind, which is why its count here is low (2 of 13) while
        // its pads are among the best covered anywhere (median 73% of a leg's area on copper, against
        // house's 70% with half its landings squared). A share would read as a quality score; it is not one.
        //
        // So: a regression pin, measured rather than chosen, that catches a change quietly giving up on the
        // landings that CAN be squared.
        const want: Record<string, number> = { "house.fkld": 3, "church.fkld": 2, "puffin.fkld": 2 };
        expect(square, `${name} landings squared off`).toBeGreaterThanOrEqual(want[name]!);
      }
    });

    it("holds the copper's own weeding gap ahead of the leg's coverage, and records the trade", () => {
      // The residual, honestly stated, because it is a trade rather than a win.
      //
      // A 1206's leg is 1.40mm ALONG the axis and 1.70mm ACROSS it. Along the axis the copper covers it
      // exactly (the test above). Across it the copper is whatever `landingWidth` allows, and with the ends
      // only 2.00mm apart that is its floor, 1.1375mm -- so the leg overhangs the tape by 0.28mm each side
      // and lands about 70% of its area (measured over all six bundled patterns: median 45-72%, worst 27%).
      //
      // Widening the landing to the leg's own 1.70mm was built and measured, and it is the wrong trade: pad
      // coverage rises to a median of 83-89%, but the nearest approach of PWR copper to GND copper falls
      // from 0.71mm to 0.15mm on house and from 0.93mm to 0.26mm on akde-decagon-pyramid -- bare substrate
      // far too thin to weed. A leg soldered to a 1.14mm strip is a real joint; a 0.15mm web of backing
      // paper is not a cut. So the floor stays where it is, and this pins the two numbers that decide it.
      const seat = ledSeat("LED_1206")!;
      const across = 1.7; // the 1206's pad, across the chip's axis
      // In millimetres throughout, so `tapeMm` is `TAPE_MM` and the weeding gap is `MIN_WEED_MM` itself.
      const land = landingWidth({ x: 0, y: 0 }, { x: seat.gap, y: 0 }, TAPE_MM, weedGapFor(TAPE_MM, TAPE_MM));
      expect(land).toBeCloseTo(seat.gap - MIN_WEED_MM, 6);
      expect(land).toBeLessThan(across); // the leg still overhangs the tape, which is the trade above
      // What the copper leaves bare between the two nets is the floor exactly, and the floor is the sheet's,
      // not the roll's: narrowing the tape must not narrow the web the tweezers have to lift.
      expect(seat.gap - land).toBeCloseTo(MIN_WEED_MM, 6);
    });
  });
});
