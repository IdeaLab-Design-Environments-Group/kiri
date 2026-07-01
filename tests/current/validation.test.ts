import { describe, expect, it } from "vitest";
import { computeState } from "@kirigami/model/geometry.js";
import {
  APEX_HEIGHT_ERROR,
  MATERIAL_THICKNESS_ERROR,
  validateInputs,
} from "@kirigami/model/validation.js";

describe("input validation", () => {
  const base = { edgeCount: 4, edgeLength: 100, materialThickness: 1 };

  it("accepts H > 0 and T > 0", () => {
    expect(validateInputs({ ...base, totalCurvature: 70.7 })).toBeNull();
  });

  it("rejects H = 0", () => {
    expect(validateInputs({ ...base, totalCurvature: 0 })).toBe(APEX_HEIGHT_ERROR);
  });

  it("rejects H < 0", () => {
    expect(validateInputs({ ...base, totalCurvature: -1 })).toBe(APEX_HEIGHT_ERROR);
  });

  it("rejects T = 0", () => {
    expect(
      validateInputs({ ...base, totalCurvature: 70.7, materialThickness: 0 }),
    ).toBe(MATERIAL_THICKNESS_ERROR);
  });

  it("rejects T < 0", () => {
    expect(
      validateInputs({ ...base, totalCurvature: 70.7, materialThickness: -0.1 }),
    ).toBe(MATERIAL_THICKNESS_ERROR);
  });

  it("computeState throws when H <= 0", () => {
    expect(() =>
      computeState({ ...base, totalCurvature: 0 }),
    ).toThrow(/greater than 0/);
  });
});
