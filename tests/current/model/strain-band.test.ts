import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHEET,
  outerFibreMm,
  foldStrain,
  strainBand,
  STRAIN_BAND_CAP,
  STRAIN_BAND_RATIO,
} from "../../../src/model/fold-strain.js";

const hinge = 2;

describe("strainBand", () => {
  it("puts a fold the copper survives in band 0", () => {
    // Below the fatigue strain there is nothing to route around, so the band must not distinguish it.
    const gentle = 0.5;
    expect(foldStrain(hinge, gentle)).toBeLessThan(DEFAULT_SHEET.routingThresholdStrain);
    expect(strainBand(hinge, gentle)).toBe(0);
  });

  it("puts a flat crease in band 0", () => {
    expect(strainBand(hinge, 0)).toBe(0);
  });

  it("charges a valley nothing, whichever way it is folded", () => {
    // Compression wrinkles the foil; it does not part it. Only tension is banded.
    expect(strainBand(hinge, -90)).toBe(0);
    expect(strainBand(hinge, -170)).toBe(0);
  });

  it("rises with the fold, in ratio-fold steps", () => {
    const eps = DEFAULT_SHEET.routingThresholdStrain;
    // Pick angles whose strain is a known multiple of the routing threshold. The fibre distance comes
    // from `outerFibreMm` rather than being re-derived here: it gained the adhesive term when the tape's
    // datasheet was read, and a copy of the old expression would have quietly kept testing the old one.
    const degFor = (mult: number) =>
      ((eps * mult * hinge) / outerFibreMm(DEFAULT_SHEET)) * (180 / Math.PI);
    expect(strainBand(hinge, degFor(0.9), DEFAULT_SHEET, STRAIN_BAND_RATIO, 99)).toBe(0);
    expect(strainBand(hinge, degFor(1.5), DEFAULT_SHEET, STRAIN_BAND_RATIO, 99)).toBe(1);
    expect(strainBand(hinge, degFor(3), DEFAULT_SHEET, STRAIN_BAND_RATIO, 99)).toBe(2);
    expect(strainBand(hinge, degFor(9), DEFAULT_SHEET, STRAIN_BAND_RATIO, 99)).toBe(4);
  });

  it("is monotone in the fold angle", () => {
    let last = -1;
    for (const deg of [0, 1, 5, 10, 30, 60, 90, 150, 179]) {
      const b = strainBand(hinge, deg, DEFAULT_SHEET, STRAIN_BAND_RATIO, 99);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
  });

  it("caps, so two hopeless creases compare equal", () => {
    // Past a few multiples of the threshold the copper is taken to be failing either way, and detouring between them buys
    // nothing while costing real crossings.
    expect(strainBand(hinge, 60)).toBe(STRAIN_BAND_CAP);
    expect(strainBand(hinge, 170)).toBe(STRAIN_BAND_CAP);
    expect(strainBand(hinge, 60)).toBe(strainBand(hinge, 170));
  });

  it("widens with a thinner substrate, because a thin film survives more", () => {
    const thin = { ...DEFAULT_SHEET, substrateMm: 0.05 };
    // On this 2 mm hinge the shipped sheet passes the threshold at 12.1 degrees and the film at 31.3, so
    // 20 degrees separates them. The gap between the two is narrower than the substrate ratio suggests:
    // the tape is 0.085 mm of adhesive and foil, so on a 0.05 mm film the TAPE is most of the bending
    // stack and thinning the substrate has little left to buy. The direction is what this test is for.
    expect(strainBand(hinge, 20)).toBeGreaterThan(0);
    expect(strainBand(hinge, 20, thin)).toBe(0);
  });

  it("reports band 0 when the sheet declares no routing threshold", () => {
    expect(strainBand(hinge, 90, { ...DEFAULT_SHEET, routingThresholdStrain: 0 })).toBe(0);
  });
});
