/**
 * How wide the copper may be once the model's size and the circuit's appetite are both taken into account.
 *
 * Two claims, and the first is the one that matters: the new rule must reproduce the OLD one exactly at
 * the demand the old one was calibrated at. A width rule that quietly re-cuts every pattern in the corpus
 * while claiming to generalise the measurement it was built from is worse than no rule, because nothing
 * fails — the sheets just come out different.
 *
 * The second is that it moves in the directions it claims to: wider tile, wider tape; more runs, narrower
 * tape; thinner substrate, narrower tape, because the webs between the strips have to be weedable.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flatFaces, type Circuit } from "../../../src/model/electronics.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import {
  DEFAULT_SHEET,
  STOCK_TAPE_MM,
  TAPE_TILE_SHARE,
  minWebMm,
  tapeMmForTile,
  type SheetSpec,
} from "../../../src/model/fold-strain.js";
import {
  CALIBRATED_DEMAND,
  TAPE_FLOOR_MM,
  tapeFitsDemand,
  tapeMmForDemand,
  traceDemand,
} from "../../../src/model/tape-demand.js";
import { MIN_WEED_MM, TAPE_MM } from "../../../src/model/electronics-routing.js";
import { buildCopperSvgExport, sheetFrame } from "../../../src/model/copper-svg-export.js";
import { GND_NET_ID, PWR_NET_ID } from "../../../src/model/net-palette.js";

const EXAMPLES = new URL("../../../public/examples/", import.meta.url).pathname;
const load = (n: string): FoldFile => JSON.parse(readFileSync(`${EXAMPLES}${n}`, "utf8")) as FoldFile;

/** The characteristic tile of a real pattern, in the units `tapeMmForDemand` expects. */
function tileOf(name: string): number {
  const faces = flatFaces(load(name));
  let area2 = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of faces) {
    const n = f.poly.length;
    for (let i = 0; i < n; i++) {
      const a = f.poly[i]!, b = f.poly[(i + 1) % n]!;
      area2 += a.x * b.y - b.x * a.y;
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y);
    }
  }
  // The same unit-scale reading the router does: a pattern under sheet size is read as though cut at it.
  const longest = Math.max(maxX - minX, maxY - minY);
  const perMm = longest < 130 ? longest / 130 : 1;
  return Math.sqrt(Math.abs(area2) / 2 / faces.length) / perMm;
}

const TILES = [8, 13.2, 20.7, 28.7, 41.1, 80, 200];

/** The physical clamp the rule works to: no narrower than a blade tracks, no wider than the stock. */
const clamp = (mm: number): number =>
  Math.min(STOCK_TAPE_MM[STOCK_TAPE_MM.length - 1]!, Math.max(STOCK_TAPE_MM[0], mm));

describe("model/tape-demand", () => {
  describe("the width a tile can carry", () => {
    it("returns the old rule's own ceiling at the demand that ceiling was calibrated at", () => {
      // THE load-bearing test. `TAPE_TILE_SHARE` was measured on the bundled patterns, and every one of
      // them carries the two-rail bus -- so a quarter of a tile is known good for TWO runs. At that demand
      // this rule must reduce to that quarter exactly, or it has re-cut the whole corpus while claiming to
      // generalise the measurement it came from, and nothing in the suite would say so.
      //
      // Against the CEILING and not against `tapeMmForTile`'s return, because that function rounds down to
      // a stocked roll and this one does not -- see the docblock. Rounding is the difference between the
      // two, and it is a difference about buying tape, not about how wide to cut a strip.
      for (const tile of TILES) {
        const want = clamp(TAPE_TILE_SHARE * tile);
        expect(tapeMmForDemand(tile, CALIBRATED_DEMAND), `tile ${tile}`).toBeCloseTo(want, 9);
        // And the old answer is this one rounded down to a roll: never wider, so nothing gets a strip the
        // calibration did not sanction.
        expect(tapeMmForTile(tile), `tile ${tile}`).toBeLessThanOrEqual(tapeMmForDemand(tile, CALIBRATED_DEMAND));
      }
    });

    it("agrees with the old answer on every bundled pattern, at the bus's own demand", () => {
      // The same claim against real geometry rather than round numbers, because the corpus is what the
      // constant was calibrated on and a synthetic tile could miss a pattern that straddles a roll edge.
      for (const p of [
        "house.fkld", "church.fkld", "puffin.fkld", "akde-hex.fkld",
        "akde-decagon-pyramid.fkld", "akde-square-pyramid.fkld", "bistable-star-tiling.fkld",
        "kirigami-flap.fkld",
      ]) {
        const tile = tileOf(p);
        expect(tapeMmForDemand(tile, CALIBRATED_DEMAND), p).toBeCloseTo(clamp(TAPE_TILE_SHARE * tile), 9);
        expect(tapeMmForTile(tile), p).toBeLessThanOrEqual(tapeMmForDemand(tile, CALIBRATED_DEMAND));
      }
    });

    it("narrows as more runs have to share the tile, and never widens", () => {
      // A 41mm tile (kirigami-flap) has room to show the whole range; a 13mm one is already at the floor.
      const widths = [1, 2, 3, 4, 6, 10, 20].map((k) => tapeMmForDemand(41.1, k));
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i]!, `demand ${i}`).toBeLessThanOrEqual(widths[i - 1]!);
      }
      expect(widths[0]!).toBeGreaterThan(widths[widths.length - 1]!); // it really does vary
    });

    it("gives a lone run more than the pair gets, on a tile with the room for it", () => {
      expect(tapeMmForDemand(20.7, 1)).toBeGreaterThan(tapeMmForDemand(20.7, 2));
    });

    it("widens with the tile at a fixed demand", () => {
      for (let i = 1; i < TILES.length; i++) {
        expect(tapeMmForDemand(TILES[i]!, 3)).toBeGreaterThanOrEqual(tapeMmForDemand(TILES[i - 1]!, 3));
      }
      expect(tapeMmForDemand(200, 3)).toBeGreaterThan(tapeMmForDemand(8, 3));
    });

    it("never answers narrower than a blade can cut or wider than the stock it is cut from", () => {
      for (const tile of [...TILES, 0.5, 1000]) {
        for (const k of [1, 2, 3, 5, 9, 40]) {
          const w = tapeMmForDemand(tile, k);
          expect(w, `${tile}/${k}`).toBeGreaterThanOrEqual(STOCK_TAPE_MM[0]);
          expect(w, `${tile}/${k}`).toBeLessThanOrEqual(STOCK_TAPE_MM[STOCK_TAPE_MM.length - 1]!);
        }
      }
    });

    it("floors at the narrowest roll rather than inventing tape nobody sells", () => {
      expect(tapeMmForDemand(8, 40)).toBe(STOCK_TAPE_MM[0]);
      expect(tapeMmForDemand(0, 1)).toBe(STOCK_TAPE_MM[0]);
      expect(tapeMmForDemand(-5, 1)).toBe(STOCK_TAPE_MM[0]);
    });

    it("says out loud when the narrowest roll does not actually fit", () => {
      // The floor makes a crowded sheet and a comfortable one give the same number, and they are not the
      // same thing to whoever is holding the cutter.
      expect(tapeFitsDemand(41.1, 2)).toBe(true);
      expect(tapeFitsDemand(8, 40)).toBe(false);
      expect(tapeMmForDemand(8, 40)).toBe(tapeMmForDemand(6, 30)); // indistinguishable by width alone
    });

    it("crowds sooner on a thinner sheet, because the webs between the strips get wider", () => {
      // The substrate reaching the trace width by a second, independent path: `minWebMm` goes inversely
      // with thickness, so a thin sheet spends more of the tile on substrate it can still weed out.
      const thin: SheetSpec = { ...DEFAULT_SHEET, substrateMm: DEFAULT_SHEET.substrateMm / 4 };
      expect(minWebMm(thin)).toBeGreaterThan(minWebMm(DEFAULT_SHEET));
      expect(tapeMmForDemand(41.1, 4, thin)).toBeLessThan(tapeMmForDemand(41.1, 4, DEFAULT_SHEET));
      expect(tapeFitsDemand(41.1, 4, thin)).toBe(false);
      expect(tapeFitsDemand(41.1, 4, DEFAULT_SHEET)).toBe(true);
    });

    it("pays for the webs, and not only for the copper", () => {
      // Doubling the demand does not merely halve the width: the substrate between the strips has to
      // survive being lifted out with tweezers, and that does not shrink because there are more runs.
      // On a 41mm tile, where demand 4 is still clear of the floor -- below it the clamp answers instead of
      // the rule, and the test would be reading the clamp.
      const two = tapeMmForDemand(41.1, CALIBRATED_DEMAND);
      const four = (41.1 * TAPE_TILE_SHARE * CALIBRATED_DEMAND) / 4; // the copper-only answer at demand 4
      expect(tapeMmForDemand(41.1, 4)).toBeGreaterThan(STOCK_TAPE_MM[0]); // the rule, not the clamp
      expect(tapeMmForDemand(41.1, 4)).toBeLessThan(four);
      expect(tapeMmForDemand(41.1, 4)).toBeLessThan(two);
    });
  });

  describe("counting what the circuit will need", () => {
    const empty: Circuit = { leds: [], battery: null };

    it("never reports less than one run", () => {
      // Zero would be a division by zero wearing the costume of a very wide strip.
      expect(traceDemand(empty)).toBe(1);
    });

    it("counts the two-rail bus as two, and only where the rails actually get laid", () => {
      expect(traceDemand({ ...empty, battery: { face: 0 } })).toBe(2);
      expect(traceDemand({ leds: [{ a: 0, b: 1 }], battery: { face: 0 } })).toBe(2);
      // LEDs with no battery are NOT two. There is nothing for the rails to leave from, so `planRoutes`
      // marks every LED unreachable and lays no rails -- narrowing the tape there would be paying for
      // copper that is never planned.
      expect(traceDemand({ ...empty, leds: [{ a: 0, b: 1 }, { a: 1, b: 2 }] })).toBe(1);
    });

    it("does not charge the bus twice for the rails the author also declared", () => {
      // A circuit is SEEDED with PWR and GND, and a placed LED wires its pads to them. Counted again as
      // declared nets, an ordinary one-LED circuit would read four runs and lose half its tape width to
      // copper that does not exist.
      const seeded: Circuit = {
        leds: [],
        battery: { face: 0 },
        nets: [{ id: PWR_NET_ID, name: "PWR" }, { id: GND_NET_ID, name: "GND" }],
        terminals: [
          { part: 0, pad: "1", net: PWR_NET_ID },
          { part: 1, pad: "1", net: PWR_NET_ID },
          { part: 0, pad: "2", net: GND_NET_ID },
          { part: 1, pad: "2", net: GND_NET_ID },
        ],
      };
      expect(traceDemand(seeded)).toBe(2);
    });

    it("counts a declared net once it has two terminals, and not before", () => {
      const base: Circuit = {
        leds: [],
        battery: null,
        nets: [{ id: "n1", name: "SDA" }],
        terminals: [{ part: 0, pad: "1", net: "n1" }],
      };
      // One terminal is an authoring mistake `resolveNetlist` already reports. It gets no copper, so it
      // must not take width from the runs that do.
      // Still 1 -- but that is the floor talking, so the real reading is taken with two nets, where the
      // half-wired one has somewhere to be visible against the fully-wired one.
      expect(traceDemand(base)).toBe(1);
      const two = { id: "n2", name: "SCL" };
      const wired = [{ part: 0, pad: "2", net: "n2" }, { part: 1, pad: "2", net: "n2" }];
      expect(traceDemand({ ...base, nets: [...base.nets!, two], terminals: [...base.terminals!, ...wired] }))
        .toBe(1); // n2 counts, n1 does not
      expect(traceDemand({
        ...base,
        nets: [...base.nets!, two],
        terminals: [...base.terminals!, ...wired, { part: 2, pad: "1", net: "n1" }],
      })).toBe(2); // now both are wired, and both count
    });

    it("counts each declared net separately", () => {
      const nets = [{ id: "n1", name: "SDA" }, { id: "n2", name: "SCL" }, { id: "n3", name: "INT" }];
      const terminals = nets.flatMap((n) => [
        { part: 0, pad: "1", net: n.id },
        { part: 1, pad: "1", net: n.id },
      ]);
      expect(traceDemand({ leds: [], battery: null, nets, terminals })).toBe(3);
      expect(traceDemand({ leds: [], battery: { face: 0 }, nets, terminals })).toBe(5); // plus the bus
    });

    it("counts hand-drawn copper too", () => {
      // The author's wire occupies the tile whether or not the router put it there.
      const withWires: Circuit = {
        leds: [],
        battery: { face: 0 },
        wires: [
          { id: "w1", pts: [{ kind: "free", x: 0, y: 0 }, { kind: "free", x: 1, y: 1 }] },
          { id: "w2", pts: [{ kind: "free", x: 2, y: 2 }, { kind: "free", x: 3, y: 3 }] },
        ],
      };
      expect(traceDemand(withWires)).toBe(4);
    });

    it("turns a real circuit into a narrower roll than the same model empty", () => {
      // The two halves meeting, on a real pattern: same model, more to fit, less tape.
      const tile = tileOf("kirigami-flap.fkld");
      const bus: Circuit = { leds: [{ a: 0, b: 1 }], battery: { face: 0 } };
      const busy: Circuit = {
        ...bus,
        nets: [1, 2, 3, 4].map((i) => ({ id: `n${i}`, name: `N${i}` })),
        terminals: [1, 2, 3, 4].flatMap((i) => [
          { part: 0, pad: String(i), net: `n${i}` },
          { part: 1, pad: String(i), net: `n${i}` },
        ]),
      };
      expect(traceDemand(bus)).toBe(2);
      expect(traceDemand(busy)).toBe(6);
      expect(tapeMmForDemand(tile, traceDemand(busy)))
        .toBeLessThan(tapeMmForDemand(tile, traceDemand(bus)));
    });
  });
});

describe("model/tape-demand — the floor, against the one the cutter actually enforces", () => {
  /**
   * The export's own narrowness threshold, found through its public interface rather than by importing
   * its constant.
   *
   * Deliberately behavioural. `MIN_CUTTABLE_MM` is private to `copper-svg-export.ts`, and copying the
   * number here would be a second reading of "how narrow may copper be" that can drift from the first —
   * which is the failure this test exists to prevent, not one to commit while preventing it. Binary search
   * on the width the export is given, reading the `tooNarrow` flag it reports back, finds the same number
   * without either file naming it twice.
   */
  function exportThresholdMm(): number {
    const fold = load("akde-hex.fkld");
    const { scale } = sheetFrame(fold, undefined, 130);
    const flat = (mm: number): number => mm / scale; // the export multiplies by `scale` to get millimetres
    const narrow = (mm: number): boolean =>
      buildCopperSvgExport(fold, [{ net: "pwr", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }], flat(mm)).tooNarrow;
    expect(narrow(0.1)).toBe(true);   // the search needs a bracket, and an unbracketed search finds nothing
    expect(narrow(50)).toBe(false);
    let lo = 0.1, hi = 50;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (narrow(mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  it("never plans a strip the export would refuse to cut", () => {
    // The ordering that has to hold: what this file will PLAN must be at least what that file will EMIT.
    // They live apart on purpose -- planning and emitting are different jobs -- and this is what keeps them
    // from crossing without anyone noticing.
    const threshold = exportThresholdMm();
    expect(threshold).toBeCloseTo(3, 6); // the export's own figure, read back rather than assumed
    expect(TAPE_FLOOR_MM).toBeGreaterThanOrEqual(threshold);
  });

  it("holds the floor for every tile and demand, not just at the clamp", () => {
    for (const tile of [...TILES, 0.5, 1000]) {
      for (const k of [1, 2, 3, 7, 40]) {
        expect(tapeMmForDemand(tile, k), `${tile}/${k}`).toBeGreaterThanOrEqual(TAPE_FLOOR_MM);
      }
    }
  });

  it("does not mistake the weeding web for a floor on the copper", () => {
    // A THIRD number lives one file away: `MIN_WEED_MM`, about 1.14mm, whose docblock calls it "the
    // narrowest strip this process can produce". It is not a contradiction of the 3mm figure and it is not
    // exempt by accident -- it measures the bare SUBSTRATE web between two runs, not the copper of a run.
    // Named here because the next reader who finds three narrowness constants will otherwise assume one of
    // them is stale, and pick the wrong one to delete.
    expect(MIN_WEED_MM).toBeLessThan(TAPE_FLOOR_MM);
    expect(MIN_WEED_MM).toBeCloseTo(TAPE_MM * 0.35, 9);
  });
});
