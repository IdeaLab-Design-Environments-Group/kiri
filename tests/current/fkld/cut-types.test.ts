import { describe, expect, it } from "vitest";
import * as ct from "@dayangac/fkld/cut-types";

const { CUT_TYPES, CUT_TYPE_INFO, isCutType, validateEdgeCutTypes } = ct;

describe("fkld/cut-types — CUT_TYPES", () => {
  it("enumerates exactly the seven registered subtypes in fabrication-priority order", () => {
    expect([...CUT_TYPES]).toEqual([
      "major",
      "minor",
      "seam",
      "dart",
      "auxetic",
      "vent",
      "tab",
    ]);
  });

  it("contains no duplicates", () => {
    expect(new Set(CUT_TYPES).size).toBe(CUT_TYPES.length);
  });

  it("array is frozen", () => {
    expect(Object.isFrozen(CUT_TYPES)).toBe(true);
  });
});

describe("fkld/cut-types — CUT_TYPE_INFO", () => {
  it("has a record for every subtype in CUT_TYPES", () => {
    for (const type of CUT_TYPES) {
      expect(CUT_TYPE_INFO[type]).toBeDefined();
    }
  });

  it("has no extra keys beyond the registered subtypes", () => {
    expect(Object.keys(CUT_TYPE_INFO).sort()).toEqual([...CUT_TYPES].sort());
  });

  it("each record exposes category, description, fabricationLayer, citation", () => {
    for (const type of CUT_TYPES) {
      const info = CUT_TYPE_INFO[type];
      expect(typeof info.category).toBe("string");
      expect(typeof info.description).toBe("string");
      expect(info.description.length).toBeGreaterThan(20);
      expect(["cut", "score", "engrave"]).toContain(info.fabricationLayer);
      expect(typeof info.citation).toBe("string");
      expect(info.citation.length).toBeGreaterThan(0);
    }
  });

  it("categorizes major/minor/dart as geometry, seam as topology", () => {
    expect(CUT_TYPE_INFO.major.category).toBe("geometry");
    expect(CUT_TYPE_INFO.minor.category).toBe("geometry");
    expect(CUT_TYPE_INFO.dart.category).toBe("geometry");
    expect(CUT_TYPE_INFO.seam.category).toBe("topology");
  });

  it("categorizes auxetic as mechanical, vent as architectural, tab as fabrication", () => {
    expect(CUT_TYPE_INFO.auxetic.category).toBe("mechanical");
    expect(CUT_TYPE_INFO.vent.category).toBe("architectural");
    expect(CUT_TYPE_INFO.tab.category).toBe("fabrication");
  });

  it("info records are frozen", () => {
    for (const type of CUT_TYPES) {
      expect(Object.isFrozen(CUT_TYPE_INFO[type])).toBe(true);
    }
  });
});

describe("fkld/cut-types — isCutType", () => {
  it("accepts every registered subtype string", () => {
    for (const type of CUT_TYPES) {
      expect(isCutType(type)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isCutType("score")).toBe(false);
    expect(isCutType("MAJOR")).toBe(false); // case-sensitive
    expect(isCutType("")).toBe(false);
  });

  it("rejects non-string inputs without throwing", () => {
    expect(isCutType(null)).toBe(false);
    expect(isCutType(undefined)).toBe(false);
    expect(isCutType(0)).toBe(false);
    expect(isCutType({})).toBe(false);
  });
});

describe("fkld/cut-types — validateEdgeCutTypes", () => {
  it("accepts a fully consistent array", () => {
    const result = validateEdgeCutTypes(
      ["M", "V", "C", "C", "B"],
      [null, null, "major", "minor", null],
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags length mismatch", () => {
    const result = validateEdgeCutTypes(["M", "V"], [null]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain("length");
  });

  it("flags an unregistered subtype on a C edge", () => {
    const result = validateEdgeCutTypes(["C"], ["wibble"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].message).toContain("not a registered cut subtype");
  });

  it("flags a subtype on a non-C edge", () => {
    const result = validateEdgeCutTypes(["M"], ["minor"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0].index).toBe(0);
    expect(result.errors[0].message).toContain('requires edges_assignment[0] = "C"');
  });

  it("allows a C edge without a subtype", () => {
    // Permissive by design — Step 17's full validator will tighten this;
    // here we only flag inconsistencies, not omissions.
    const result = validateEdgeCutTypes(["C", "C"], [null, "major"]);
    expect(result.ok).toBe(true);
  });

  it("accumulates multiple errors in a single pass (no early abort)", () => {
    const result = validateEdgeCutTypes(
      ["M", "V", "C", "C"],
      ["minor", "vent", "wibble", "tab"],
    );
    expect(result.ok).toBe(false);
    // Errors at edge 0 (minor on M), edge 1 (vent on V), edge 2 (unknown).
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("rejects non-array inputs gracefully", () => {
    const r1 = validateEdgeCutTypes("nope" as unknown as string[], []);
    expect(r1.ok).toBe(false);
    expect(r1.errors[0].message).toContain("edges_assignment must be an array");

    const r2 = validateEdgeCutTypes([], "nope" as unknown as string[]);
    expect(r2.ok).toBe(false);
    expect(r2.errors[0].message).toContain("fkld:edges_cutType");
  });
});
