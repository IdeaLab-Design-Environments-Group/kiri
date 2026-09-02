import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { flatFaces, gapGraph, ledOf } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { buildCorridor, planRoutes, tapeWidthFor,
  TAPE_MM,
} from "../../../src/model/electronics-routing.js";
import {
  CLOSED_DEG,
  CLOSING_DEG,
  DEFAULT_SHEET,
  bendRadiusMm,
  closureFraction,
  creaseCostFraction,
  fatigueFraction,
  foldStrain,
  maxTraceWidthMm,
  minWebMm,
  type SheetSpec,
} from "../../../src/model/fold-strain.js";

/** A hinge width in the middle of what these patterns actually produce, in mm. */
const HINGE = 5;

describe("model/fold-strain", () => {
  describe("the bend", () => {
    it("is the arc the hinge makes: R = w / theta", () => {
      // Checked against the closed form rather than a remembered number, so the test says what the
      // formula is instead of only that it has not changed.
      for (const deg of [10, 45, 90, 160]) {
        expect(bendRadiusMm(HINGE, deg)).toBeCloseTo(HINGE / ((deg * Math.PI) / 180), 9);
      }
    });

    it("opens out as the fold shallows, and stays finite when it is flat", () => {
      expect(bendRadiusMm(HINGE, 10)).toBeGreaterThan(bendRadiusMm(HINGE, 90));
      expect(Number.isFinite(bendRadiusMm(HINGE, 0))).toBe(true);
    });
  });

  describe("the strain", () => {
    it("is the outer fibre over the bend radius", () => {
      const eps = foldStrain(HINGE, 90);
      const fibre = DEFAULT_SHEET.substrateMm / 2 + DEFAULT_SHEET.foilMm;
      expect(eps).toBeCloseTo(fibre / bendRadiusMm(HINGE, 90), 12);
    });

    it("vanishes with the fold, which is the limit that has to hold", () => {
      expect(foldStrain(HINGE, 0)).toBeCloseTo(0, 3);
      expect(foldStrain(HINGE, 0.001)).toBeLessThan(foldStrain(HINGE, 1));
    });

    it("grows with the sheet and shrinks with the hinge", () => {
      // The two couplings the whole module exists to provide. A thicker sheet strains its copper more; a
      // wider hinge takes the same fold more gently.
      const thick: SheetSpec = { ...DEFAULT_SHEET, substrateMm: DEFAULT_SHEET.substrateMm * 2 };
      expect(foldStrain(HINGE, 90, thick)).toBeGreaterThan(foldStrain(HINGE, 90));
      expect(foldStrain(HINGE * 2, 90)).toBeLessThan(foldStrain(HINGE, 90));
    });

    it("scales linearly in the fold angle, so the same fold twice over strains twice as hard", () => {
      expect(foldStrain(HINGE, 80)).toBeCloseTo(2 * foldStrain(HINGE, 40), 12);
    });

    it("is dimensionless, and of the size a folded sheet actually sees", () => {
      // A sanity band, not a pinned value: 0.4mm of substrate folded 90 degrees over a 5mm hinge is a few
      // per cent of strain. Anything outside this band means a unit has gone astray somewhere.
      const eps = foldStrain(HINGE, 90);
      expect(eps).toBeGreaterThan(0.005);
      expect(eps).toBeLessThan(0.2);
    });

    it("has no bend to speak of where there is no hinge", () => {
      expect(foldStrain(0, 90)).toBe(0);
    });
  });

  describe("which way the copper is loaded", () => {
    it("puts a mountain in tension and a valley in compression, at equal magnitude", () => {
      // The one thing a model on |theta| would lose. Nakaya et al. measured the mountain fracturing and
      // the valley surviving; the geometry cannot tell them apart, so the sign has to.
      const m = foldStrain(HINGE, 120);
      const v = foldStrain(HINGE, -120);
      expect(m).toBeGreaterThan(0);
      expect(v).toBeLessThan(0);
      expect(Math.abs(v)).toBeCloseTo(m, 12);
    });

    it("charges the mountain for fatigue and the valley nothing", () => {
      expect(fatigueFraction(HINGE, 120)).toBeGreaterThan(0);
      expect(fatigueFraction(HINGE, -120)).toBe(0);
    });

    it("saturates once the copper is past its fatigue strain rather than running away", () => {
      expect(fatigueFraction(HINGE, 120)).toBe(1);
      expect(fatigueFraction(HINGE, 179)).toBe(1);
    });

    it("charges a gentle fold in proportion, which is what the old M/V letter could not do", () => {
      // A shallow mountain on a wide hinge is under the limit and is priced below a full crossing --
      // the case the class rule charged full price for.
      const gentle = fatigueFraction(40, 20);
      expect(gentle).toBeGreaterThan(0);
      expect(gentle).toBeLessThan(1);
      expect(fatigueFraction(40, 30)).toBeGreaterThan(gentle);
    });

    it("lets a thinner sheet cross a fold the thicker one could not", () => {
      // Below the knee, where the term has not saturated -- which is the only place a sheet property can
      // still make a difference, and the reason the knee is pinned in its own test below.
      const thin: SheetSpec = { ...DEFAULT_SHEET, substrateMm: 0.05 };
      expect(fatigueFraction(HINGE, 30, thin)).toBeLessThan(fatigueFraction(HINGE, 30));
      expect(fatigueFraction(HINGE, 30, thin)).toBeGreaterThan(0);
    });

    it("saturates past a knee that the sheet thickness sets, and the knee is low", () => {
      // Worth recording plainly, because it bounds what this model can buy. Strain is
      // (h/2 + t)·theta/w, so on a 0.4mm sheet over a 5mm hinge the copper is past 1% by about 12
      // degrees of fold -- which means nearly every real mountain on these patterns is charged full
      // price, exactly as the class rule charged it. Thinning the sheet to 0.05mm moves the knee out to
      // about 48 degrees. So sheet thickness is a real lever here and a short one: it moves where the
      // ceiling starts, not how high it is.
      const knee = (spec: SheetSpec): number => {
        for (let deg = 1; deg < 180; deg++) if (fatigueFraction(HINGE, deg, spec) >= 1) return deg;
        return 180;
      };
      expect(knee(DEFAULT_SHEET)).toBeLessThan(20);
      expect(knee({ ...DEFAULT_SHEET, substrateMm: 0.05 })).toBeGreaterThan(40);
    });
  });

  describe("a fold closing on itself", () => {
    it("costs nothing until it starts to close, then ramps to full", () => {
      expect(closureFraction(CLOSING_DEG - 1)).toBe(0);
      expect(closureFraction(CLOSED_DEG)).toBe(1);
      expect(closureFraction((CLOSING_DEG + CLOSED_DEG) / 2)).toBeCloseTo(0.5, 9);
    });

    it("is a ramp and not a step, so no single degree decides it", () => {
      // The rule this replaces was `> 170 degrees`, which says a 169-degree fold is perfectly safe and a
      // 171-degree one is ruinous. It also never fired: the data it read was in radians.
      const a = closureFraction(169);
      const b = closureFraction(171);
      expect(a).toBeGreaterThan(0);
      expect(b - a).toBeLessThan(0.2);
    });

    it("does not care which way a closed fold went", () => {
      expect(closureFraction(-175)).toBe(closureFraction(175));
    });

    it("catches the valley that fatigue lets through", () => {
      // A valley is never in tension, so fatigue alone would carry copper over a fold shut flat against
      // itself for free -- with the two banks of copper face to face.
      expect(fatigueFraction(HINGE, -175)).toBe(0);
      expect(creaseCostFraction(HINGE, -175)).toBeCloseTo(closureFraction(175), 12);
      expect(creaseCostFraction(HINGE, -175)).toBeGreaterThan(0.8);
    });
  });

  describe("the crease price", () => {
    it("is the worse of the two failures, never their sum", () => {
      // A mountain shut flat is both fully fatigued and fully closed. Summed it would price at two full
      // creases; it is one crease, and one is what it costs.
      expect(creaseCostFraction(HINGE, 180)).toBe(1);
      expect(creaseCostFraction(HINGE, 175)).toBe(1); // fatigue alone already saturates a mountain
    });

    it("is zero for a flat facet, whatever the sheet is made of", () => {
      expect(creaseCostFraction(HINGE, 0)).toBe(0);
      expect(creaseCostFraction(HINGE, 0, { ...DEFAULT_SHEET, substrateMm: 3 })).toBe(0);
    });
  });

  describe("what the sheet lets the copper be", () => {
    it("bounds trace width by the hinge it splints, and the bound is a length", () => {
      const w = maxTraceWidthMm(10);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
      expect(maxTraceWidthMm(20)).toBeCloseTo(2 * w, 9);
    });

    it("widens with the cube of the substrate and narrows with the cube of the foil", () => {
      const thick: SheetSpec = { ...DEFAULT_SHEET, substrateMm: DEFAULT_SHEET.substrateMm * 2 };
      expect(maxTraceWidthMm(10, thick)).toBeCloseTo(8 * maxTraceWidthMm(10), 6);
      const thickFoil: SheetSpec = { ...DEFAULT_SHEET, foilMm: DEFAULT_SHEET.foilMm * 2 };
      expect(maxTraceWidthMm(10, thickFoil)).toBeCloseTo(maxTraceWidthMm(10) / 8, 6);
    });

    it("does not bind on the sheets this system prints, which is worth stating out loud", () => {
      // Recorded rather than asserted as a design goal: on 0.4mm of PLA the bound is two orders of
      // magnitude above 3.25mm tape, so the roll governs. A sheet thin enough to bring it down would
      // change that, which is exactly why the check exists.
      expect(maxTraceWidthMm(10)).toBeGreaterThan(100);
      const foil: SheetSpec = { ...DEFAULT_SHEET, substrateMm: 0.05 };
      expect(maxTraceWidthMm(10, foil)).toBeLessThan(TAPE_MM);
    });

    it("widens the weeding web as the sheet thins, and matches the old fixed figure at the default", () => {
      expect(minWebMm()).toBeCloseTo(1.1375, 9);
      expect(minWebMm({ ...DEFAULT_SHEET, substrateMm: 0.2 })).toBeCloseTo(2.275, 9);
      expect(minWebMm({ ...DEFAULT_SHEET, substrateMm: 0.8 })).toBeCloseTo(0.56875, 9);
    });
  });

  describe("what the router charges for a crease", () => {
    /** Two tiles sharing one hinge, folded by `deg` — the smallest thing that has a crease at all. */
    function twoTiles(assignment: string, deg: number | null): FoldFile {
      return {
        vertices_coords: [[0, 0], [40, 0], [80, 0], [0, 40], [40, 40], [80, 40]],
        faces_vertices: [[0, 1, 4, 3], [1, 2, 5, 4]],
        edges_vertices: [[1, 4]],
        edges_assignment: [assignment],
        ...(deg == null ? {} : { edges_foldAngle: [deg] }),
      } as unknown as FoldFile;
    }

    /** The extra price the corridor puts on crossing that one hinge. */
    function creasePrice(fold: FoldFile, full = 1000): number {
      const faces = flatFaces(fold);
      const { gaps } = gapGraph(fold, faces);
      expect(gaps, "the fixture has no hinge to price").toHaveLength(1);
      const c = buildCorridor(faces, gaps, full, 3.25);
      // Every node on that hinge carries the same price; the first one is the price.
      const on = [...c.cost.entries()];
      return on.length ? on[0]![1] : 0;
    }

    it("charges a fatiguing mountain at least the full price, and the worst one double", () => {
      // The floor is the class rule's flat price: a shallow-but-fatiguing mountain must never be a
      // bargain, or the router buys a tensile crossing with its own gradient (measured: at price parity
      // the benchmark's router crossed one on bat_body/C rather than detour).  Above the floor the charge
      // grades to twice the flat price at the pattern's worst crossing -- which, on a two-tile pattern,
      // the only crossing is.
      expect(creasePrice(twoTiles("M", 180))).toBe(2000);
      expect(creasePrice(twoTiles("M", 30))).toBeGreaterThanOrEqual(1000);
    });

    it("charges a gentle mountain less, which the rule it replaces could not", () => {
      // The whole point of the change. A hinge folded a few degrees strains its copper a fraction of what
      // one folded flat does, and now pays a fraction. Under the class rule both were 1000.
      const gentle = creasePrice(twoTiles("M", 2));
      expect(gentle).toBeGreaterThan(0);
      expect(gentle).toBeLessThan(1000);
    });

    it("leaves an ordinary valley free and charges one folded back on itself", () => {
      // Nakaya et al.'s asymmetry, now derived from which way the copper is loaded rather than asserted
      // from the letter. The closed valley is charged for shorting across, not for fatigue.
      expect(creasePrice(twoTiles("V", 90))).toBe(0);
      expect(creasePrice(twoTiles("V", 170))).toBeGreaterThan(0);
    });

    it("falls back to the class rule where the pattern records no angle at all", () => {
      // Two of the eight bundled patterns record none. Inventing an angle for them would be worse than
      // saying the model cannot run, so the letter decides and the result is reported as what it is.
      expect(creasePrice(twoTiles("M", null))).toBe(1000);
      expect(creasePrice(twoTiles("V", null))).toBe(0);
    });

    it("charges more on a thicker sheet, at the same fold", () => {
      // The coupling the router did not have: nothing about the substrate reached the crease price before.
      const faces = flatFaces(twoTiles("M", 3));
      const { gaps } = gapGraph(twoTiles("M", 3), faces);
      const priceOn = (substrateMm: number): number => {
        const c = buildCorridor(faces, gaps, 1000, 3.25, { ...DEFAULT_SHEET, substrateMm });
        return [...c.cost.values()][0] ?? 0;
      };
      expect(priceOn(0.8)).toBeGreaterThan(priceOn(0.2));
    });

    it("narrows the tape itself when the sheet is too thin to carry it", () => {
      // The other half of the coupling, and the half that never binds in practice. A strip of copper
      // splints the hinge it crosses; on 0.4mm of substrate the bound is two orders of magnitude above
      // the roll, so the roll governs. Take the substrate down to a film and the sheet governs instead --
      // and every clearance in the router is a multiple of this number, so they all follow it down.
      //
      // The film is 0.02mm, and it was 0.05mm until 2026-08-28. The bound goes as the cube of the substrate,
      // so it is a steep function of that number, and when `TAPE_MM` fell from 3.25 to 1.5 the roll dropped
      // below what 0.05mm of film can carry — the sheet stopped governing and the demonstration stopped
      // demonstrating. Swept on this hinge: 0.05mm now yields the roll exactly, 0.03mm gives 0.377 and
      // 0.02mm gives 0.112 against the roll's 0.923. Thinner tape means the sheet has to be thinner still
      // before it is the binding constraint, which is the coupling working, not failing.
      const fold = twoTiles("M", 90);
      const faces = flatFaces(fold);
      const roll = tapeWidthFor(faces);
      const film = tapeWidthFor(faces, undefined, { ...DEFAULT_SHEET, substrateMm: 0.02 });
      expect(film).toBeLessThan(roll);
      // And the roll really is what governs on a sheet anyone would print on, which is the first sentence
      // of this comment stated as an assertion rather than as a claim.
      expect(tapeWidthFor(faces, undefined, { ...DEFAULT_SHEET, substrateMm: 0.05 })).toBe(roll);
      expect(tapeWidthFor(faces, undefined, DEFAULT_SHEET)).toBe(roll);
    });

    it("gives the same routes over an order of magnitude of fatigue strain", () => {
      // The one constant in DEFAULT_SHEET that is an assumption rather than a measurement, so the honest
      // thing is to show what rides on it. Swept over the six bundled patterns at 12 LEDs, copper length
      // and PWR/GND crossings are identical from 0.003 to 0.01, and five of the six are identical up to
      // 0.03; only puffin moves (810 -> 760) because it is the one pattern with mountains gentle enough
      // to sit under the knee. Pinned on the cheapest two patterns here rather than all six, since this
      // runs on every suite.
      //
      // What it means for a write-up: a paper quoting 1% does not have to defend 1%, only the claim that
      // the answer is flat across the plausible band -- which is this test.
      const fold = JSON.parse(
        readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
      );
      const faces = flatFaces(fold);
      const { gaps } = gapGraph(fold, faces);
      const leds = [ledOf(gaps[0]!.faceA, gaps[0]!.faceB), ledOf(gaps[1]!.faceA, gaps[1]!.faceB)];
      const copper = (fatigueStrain: number): number => {
        const r = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined, {
          ...DEFAULT_SHEET,
          fatigueStrain,
        });
        let len = 0;
        for (const t of r.traces) {
          for (let i = 1; i < t.pts.length; i++) {
            len += Math.hypot(t.pts[i]!.x - t.pts[i - 1]!.x, t.pts[i]!.y - t.pts[i - 1]!.y);
          }
        }
        return +len.toFixed(6);
      };
      const base = copper(0.01);
      expect(copper(0.003)).toBe(base);
      expect(copper(0.03)).toBe(base);
    });

    it("prices every node of the hinge alike, so no crossing point is a bargain", () => {
      const fold = twoTiles("M", 2);
      const faces = flatFaces(fold);
      const { gaps } = gapGraph(fold, faces);
      const c = buildCorridor(faces, gaps, 1000, 3.25);
      // Two crossing points per edge, both on the one hinge, both at the one price. Only hinge nodes are
      // priced at all -- the tiles' other edges are boundary, and travelling over those is free.
      const prices = new Set([...c.cost.values()]);
      expect(prices.size).toBe(1);
      expect(c.cost.size).toBe(2);
      for (const key of c.cost.keys()) expect(c.point.has(key)).toBe(true);
    });
  });
});
