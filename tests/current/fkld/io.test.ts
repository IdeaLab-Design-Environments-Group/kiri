import { describe, expect, it } from "vitest";
import * as io from "@dayangac/fkld/io";

const { serializeFkld, parseFkld } = io as {
  serializeFkld: (file: unknown, indent?: number | null) => string;
  parseFkld: (text: string) => unknown;
};

describe("fkld/io — serializeFkld", () => {
  it("emits valid JSON terminated by a newline", () => {
    const out = serializeFkld({ vertices_coords: [[0, 0]] });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ vertices_coords: [[0, 0]] });
  });

  it("defaults to 2-space indent for diff-friendliness", () => {
    const out = serializeFkld({ a: 1, b: [1, 2] });
    expect(out).toContain('\n  "a"');
  });

  it("honours a custom indent argument", () => {
    const four = serializeFkld({ a: 1 }, 4);
    expect(four).toContain('\n    "a"');
  });

  it("preserves unknown fkld:* keys (round-trip pass-through)", () => {
    const file = {
      vertices_coords: [[0, 0]],
      "fkld:custom_extension": { foo: "bar" },
    };
    const reparsed = JSON.parse(serializeFkld(file));
    expect(reparsed).toEqual(file);
  });

  it("rejects null/undefined input", () => {
    expect(() => serializeFkld(null)).toThrow(TypeError);
    expect(() => serializeFkld(undefined)).toThrow(TypeError);
  });
});

describe("fkld/io — parseFkld", () => {
  it("parses valid JSON into an object", () => {
    const obj = parseFkld('{"vertices_coords":[[0,0]]}');
    expect(obj).toEqual({ vertices_coords: [[0, 0]] });
  });

  it("throws SyntaxError on malformed JSON", () => {
    expect(() => parseFkld("{not json")).toThrow(SyntaxError);
  });

  it("rejects non-string inputs with TypeError", () => {
    expect(() => parseFkld(42 as unknown as string)).toThrow(TypeError);
    expect(() => parseFkld({} as unknown as string)).toThrow(TypeError);
    expect(() => parseFkld(null as unknown as string)).toThrow(TypeError);
  });
});

describe("fkld/io — round-trip", () => {
  it("serialize → parse preserves every key, including FKLD extensions", () => {
    const original = {
      file_spec: 1.2,
      file_creator: "AKDE",
      file_classes: ["creasePattern"],
      vertices_coords: [
        [0, 0],
        [100, 0],
        [50, 86.6],
      ],
      edges_vertices: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
      edges_assignment: ["B", "B", "B"],
      faces_vertices: [[0, 1, 2]],
      "fkld:edges_cutType": [null, null, null],
      "fkld:edges_moleculeTheta": [null, null, null],
      "fkld:edges_moleculeWidth": [null, null, null],
      "fkld:meta_architecture": { scaleMeters: 0.001 },
    };
    const text = serializeFkld(original);
    expect(parseFkld(text)).toEqual(original);
  });
});
