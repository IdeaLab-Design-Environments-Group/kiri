import { describe, expect, it } from "vitest";
import * as spec from "@dayangac/fkld/spec";

const { NAMESPACE, KEYS, KEY_LIST, isRegisteredKey, isFkldKey } = spec;

describe("fkld/spec — namespace", () => {
  it("uses the colon-terminated FKLD prefix", () => {
    expect(NAMESPACE).toBe("fkld:");
  });

  it("every registered key starts with the namespace prefix", () => {
    for (const key of KEY_LIST) {
      expect(key.startsWith(NAMESPACE)).toBe(true);
    }
  });
});

describe("fkld/spec — KEYS registry", () => {
  it("exposes the Step 2 cutType key under edges", () => {
    expect(KEYS.edges.cutType).toBe("fkld:edges_cutType");
  });

  it("exposes the Step 3 molecule parameters", () => {
    expect(KEYS.edges.moleculeTheta).toBe("fkld:edges_moleculeTheta");
    expect(KEYS.edges.moleculeWidth).toBe("fkld:edges_moleculeWidth");
    expect(KEYS.edges.moleculeDepth).toBe("fkld:edges_moleculeDepth");
    expect(KEYS.edges.dihedralTarget).toBe("fkld:edges_dihedralTarget");
  });

  it("exposes the Step 4 vertex-curvature trio", () => {
    expect(KEYS.vertices.curvatureClass).toBe("fkld:vertices_curvatureClass");
    expect(KEYS.vertices.angleDefect).toBe("fkld:vertices_angleDefect");
    expect(KEYS.vertices.reliefStrategy).toBe("fkld:vertices_reliefStrategy");
  });

  it("exposes the Step 5 face metadata quartet", () => {
    expect(KEYS.faces.materialId).toBe("fkld:faces_materialId");
    expect(KEYS.faces.thickness).toBe("fkld:faces_thickness");
    expect(KEYS.faces.structuralRole).toBe("fkld:faces_structuralRole");
    expect(KEYS.faces.panelId).toBe("fkld:faces_panelId");
  });

  it("exposes the top-level architecture metadata key", () => {
    expect(KEYS.meta.architecture).toBe("fkld:meta_architecture");
  });

  it("registry is frozen — accidental writes throw in strict mode", () => {
    // CoffeeScript modules run in strict mode by default; mutating a frozen
    // object must throw rather than silently no-op. This guards against
    // downstream code mutating the shared registry.
    expect(() => {
      (KEYS as unknown as { edges: { cutType: string } }).edges.cutType = "x";
    }).toThrow();
  });
});

describe("fkld/spec — KEY_LIST", () => {
  it("contains exactly the registered keys, no duplicates", () => {
    const expected = [
      "fkld:edges_cutType",
      "fkld:edges_moleculeTheta",
      "fkld:edges_moleculeWidth",
      "fkld:edges_moleculeDepth",
      "fkld:edges_dihedralTarget",
      "fkld:vertices_curvatureClass",
      "fkld:vertices_angleDefect",
      "fkld:vertices_reliefStrategy",
      "fkld:faces_materialId",
      "fkld:faces_thickness",
      "fkld:faces_structuralRole",
      "fkld:faces_panelId",
      "fkld:meta_architecture",
    ];
    expect([...KEY_LIST]).toEqual(expected);
    expect(new Set(KEY_LIST).size).toBe(KEY_LIST.length);
  });
});

describe("fkld/spec — isRegisteredKey (strict)", () => {
  it("accepts every key in KEY_LIST", () => {
    for (const key of KEY_LIST) {
      expect(isRegisteredKey(key)).toBe(true);
    }
  });

  it("rejects unregistered fkld:* keys", () => {
    expect(isRegisteredKey("fkld:edges_unknown")).toBe(false);
    expect(isRegisteredKey("fkld:future_extension")).toBe(false);
  });

  it("rejects plain FOLD keys", () => {
    expect(isRegisteredKey("vertices_coords")).toBe(false);
    expect(isRegisteredKey("edges_assignment")).toBe(false);
  });

  it("rejects non-string inputs without throwing", () => {
    expect(isRegisteredKey(null)).toBe(false);
    expect(isRegisteredKey(undefined)).toBe(false);
    expect(isRegisteredKey(42)).toBe(false);
    expect(isRegisteredKey({})).toBe(false);
  });
});

describe("fkld/spec — isFkldKey (lenient)", () => {
  it("accepts every registered key", () => {
    for (const key of KEY_LIST) {
      expect(isFkldKey(key)).toBe(true);
    }
  });

  it("accepts unregistered fkld:* keys (forward-compat with extensions)", () => {
    expect(isFkldKey("fkld:edges_unknown")).toBe(true);
    expect(isFkldKey("fkld:downstream_annotation")).toBe(true);
  });

  it("rejects keys without the namespace prefix", () => {
    expect(isFkldKey("edges_assignment")).toBe(false);
    expect(isFkldKey("xfkld:something")).toBe(false);
    expect(isFkldKey("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isFkldKey(null)).toBe(false);
    expect(isFkldKey(undefined)).toBe(false);
    expect(isFkldKey(42)).toBe(false);
  });
});
