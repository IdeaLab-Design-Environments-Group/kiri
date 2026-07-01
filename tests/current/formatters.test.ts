import { describe, expect, it } from "vitest";
import {
  formatAngleDeg,
  formatMm,
  radToDeg,
} from "@kirigami/controller/formatters.js";

describe("radToDeg", () => {
  it("converts radians to degrees", () => {
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 9);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 9);
    expect(radToDeg(0)).toBe(0);
  });
});

describe("formatAngleDeg", () => {
  it("formats with a degree sign, 2 decimals by default", () => {
    expect(formatAngleDeg(Math.PI / 4)).toBe("45.00°");
  });
  it("honours a custom digit count", () => {
    expect(formatAngleDeg(Math.PI, 0)).toBe("180°");
    expect(formatAngleDeg(Math.PI / 6, 3)).toBe("30.000°");
  });
});

describe("formatMm", () => {
  it("appends ' mm' and rounds to 2 decimals by default", () => {
    expect(formatMm(3.14159)).toBe("3.14 mm");
  });
  it("honours a custom digit count", () => {
    expect(formatMm(10, 0)).toBe("10 mm");
    expect(formatMm(2.5, 1)).toBe("2.5 mm");
  });
  it("rounds to the chosen precision", () => {
    expect(formatMm(3.148, 2)).toBe("3.15 mm");
    expect(formatMm(3.142, 2)).toBe("3.14 mm");
  });
});
