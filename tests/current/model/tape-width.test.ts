/**
 * Which roll of copper tape the router plans for.
 *
 * The width is a physical quantity — a roll is one width and you buy it that way — and everything else in
 * the router is derived from it: every clearance is a multiple of it, and every millimetre figure crosses
 * into pattern units by `tapeW / tapeMm`. So the two have to be read together, and the scale has to be
 * independent of which roll was picked. Both are asserted here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, gapGraph, ledOf, type Circuit, type Led } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { TAPE_MM, planRoutes, tapeMmFor, tapeWidthFor } from "../../../src/model/electronics-routing.js";
import { CALIBRATED_DEMAND, traceDemand } from "../../../src/model/tape-demand.js";
import {
  DEFAULT_SHEET,
  STOCK_TAPE_MM,
  TAPE_TILE_SHARE,
  tapeMmForTile,
  type SheetSpec,
} from "../../../src/model/fold-strain.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const load = (n: string): FoldFile => JSON.parse(readFileSync(`${EXAMPLES}${n}`, "utf8")) as FoldFile;
const BY_AREA: SheetSpec = { ...DEFAULT_SHEET, tapeChoice: "area" };
const PATTERNS = [
  "house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld",
  "akde-decagon-pyramid.fkld", "akde-square-pyramid.fkld", "bistable-star-tiling.fkld",
  "kirigami-flap.fkld",
];

describe("model/tape-width", () => {
  describe("picking a roll", () => {
    it("offers only widths that exist on a roll", () => {
      // A router that plans for 4.1mm is planning for something nobody stocks.
      for (const tile of [10, 20, 40, 80, 200]) {
        expect(STOCK_TAPE_MM as readonly number[]).toContain(tapeMmForTile(tile));
      }
    });

    it("widens with the tile and never goes below the narrowest roll", () => {
      expect(tapeMmForTile(200)).toBeGreaterThan(tapeMmForTile(20));
      expect(tapeMmForTile(1)).toBe(STOCK_TAPE_MM[0]); // nothing narrower exists to offer
      expect(tapeMmForTile(0)).toBe(STOCK_TAPE_MM[0]);
    });

    it("keeps the tape under its share of the tile, which is what stops it crowding", () => {
      for (const tile of [15, 30, 60, 120]) {
        const w = tapeMmForTile(tile);
        if (w > STOCK_TAPE_MM[0]) expect(w).toBeLessThanOrEqual(tile * TAPE_TILE_SHARE);
      }
    });
  });

  describe("on the bundled patterns", () => {
    it("plans for the 3.25mm roll by default, everywhere", () => {
      // The default is what every recorded measurement in this suite was taken against.
      expect(DEFAULT_SHEET.tapeChoice).toBe("roll");
      for (const name of PATTERNS) {
        const faces = flatFaces(load(name));
        expect(tapeMmFor(faces), name).toBeLessThanOrEqual(TAPE_MM);
      }
    });

    it("records what choosing by area would do to each pattern", () => {
      // Not inert, and worth seeing rather than arguing about: the patterns with large tiles are allowed
      // a wider roll, and the crowded ones keep 3.25. This is the number to look at before switching.
      const rows = PATTERNS.map((name) => {
        const faces = flatFaces(load(name));
        return `${name.replace(".fkld", "")} ${tapeMmFor(faces)}->${tapeMmFor(faces, undefined, BY_AREA)}`;
      });
      // eslint-disable-next-line no-console
      console.log("tape by area:", rows.join("  "));
      for (const name of PATTERNS) {
        const faces = flatFaces(load(name));
        expect(tapeMmFor(faces, undefined, BY_AREA), name).toBeGreaterThanOrEqual(tapeMmFor(faces));
      }
    });
  });

  describe("how many runs have to fit", () => {
    // The width depends on the circuit as well as the sheet, and the circuit reaches it as a circuit
    // rather than as a count — so no caller can hand it a demand that has drifted from the parts on the
    // board. These pin the three things that threading could get wrong.
    const fourLeds = (name: string): { faces: ReturnType<typeof flatFaces>; circuit: Circuit } => {
      const fold = load(name);
      const faces = flatFaces(fold);
      const { gaps } = gapGraph(fold, faces);
      const leds: Led[] = [];
      const seen = new Set<string>();
      for (const g of gaps) {
        const l = ledOf(g.faceA, g.faceB);
        const k = `${l.a}_${l.b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        leds.push(l);
        if (leds.length >= 4) break;
      }
      return { faces, circuit: { leds, battery: { face: 0 } } };
    };

    it("leaves the default alone: under `roll` the demand cannot move the width", () => {
      // The one that matters for everything already measured. `roll` is what ships, and a circuit with
      // six runs on it must still plan for the 3.25mm roll — otherwise every recorded budget in this
      // suite moved without anyone choosing to move it.
      for (const name of PATTERNS) {
        const { faces, circuit } = fourLeds(name);
        const crowded: Circuit = {
          ...circuit,
          wires: [1, 2, 3, 4].map((i) => ({ id: `w${i}`, pts: [] })),
        };
        expect(traceDemand(crowded)).toBeGreaterThan(CALIBRATED_DEMAND);
        expect(tapeMmFor(faces, undefined, undefined, crowded), name).toBe(TAPE_MM);
      }
    });

    it("reproduces the tile-only width exactly when no circuit is given", () => {
      // `CALIBRATED_DEMAND` is the demand `TAPE_TILE_SHARE` was measured at, so a caller with no circuit
      // gets the answer the tile alone used to give. A drift here would mean the sites that legitimately
      // have no circuit silently disagree with the ones that do.
      for (const name of PATTERNS) {
        const { faces, circuit } = fourLeds(name);
        expect(traceDemand(circuit), `${name} is not at the calibrated demand`).toBe(CALIBRATED_DEMAND);
        expect(tapeMmFor(faces, undefined, BY_AREA, circuit), name)
          .toBeCloseTo(tapeMmFor(faces, undefined, BY_AREA), 12);
      }
    });

    it("narrows as more runs are asked for — strictly, on every pattern", () => {
      // Monotonicity alone is not worth asserting: a width that ignored the circuit entirely would satisfy
      // it. So this demands a STRICT narrowing from two runs to four, which every bundled pattern has room
      // to show — measured house 5.17 -> 3.25 and kirigami-flap 10.00 -> 4.57 — and only then checks that
      // nothing widens along the way.
      for (const name of PATTERNS) {
        const { faces, circuit } = fourLeds(name);
        const at = (extra: number): number => tapeMmFor(faces, undefined, BY_AREA, {
          ...circuit,
          wires: Array.from({ length: extra }, (_, i) => ({ id: `w${i}`, pts: [] })),
        });
        expect(at(2), `${name} did not narrow when two more runs were added`).toBeLessThan(at(0));
        expect(at(1), `${name} widened between two runs and three`).toBeLessThanOrEqual(at(0));
        expect(at(4), `${name} widened between four runs and six`).toBeLessThanOrEqual(at(2));
      }
    });
  });

  describe("the scale, which must not depend on the roll", () => {
    it("gives the same pattern units per millimetre whichever roll is chosen", () => {
      // The load-bearing invariant. `tapeW / tapeMm` is how every millimetre figure in the router reaches
      // pattern units; if picking a wider roll moved that ratio, every footprint dimension would convert
      // to a different length and the parts would be drawn the wrong size — plausibly, and silently.
      for (const name of PATTERNS) {
        const faces = flatFaces(load(name));
        const roll = tapeWidthFor(faces) / tapeMmFor(faces);
        const area = tapeWidthFor(faces, undefined, BY_AREA) / tapeMmFor(faces, undefined, BY_AREA);
        expect(area, `${name} scale moved with the roll`).toBeCloseTo(roll, 12);
      }
    });

    it("still routes, and lays wider copper, when the roll is chosen by area", () => {
      // A width nothing else honoured would show up here: the plan would come out empty, or unchanged.
      const fold = load("akde-hex.fkld");
      const faces = flatFaces(fold);
      const { gaps } = gapGraph(fold, faces);
      const leds: Led[] = [];
      const seen = new Set<string>();
      for (const g of gaps) {
        const l = ledOf(g.faceA, g.faceB);
        const k = `${l.a}_${l.b}`;
        if (seen.has(k)) continue;
        seen.add(k);
        leds.push(l);
        if (leds.length >= 4) break;
      }
      expect(tapeMmFor(faces, undefined, BY_AREA)).toBeGreaterThan(tapeMmFor(faces));
      const wide = planRoutes(faces, gaps, { leds, battery: { face: 0 } }, undefined, BY_AREA);
      expect(wide.traces.length).toBeGreaterThan(0);
      expect(wide.unreachable.length).toBeLessThan(leds.length);
    });
  });
});
