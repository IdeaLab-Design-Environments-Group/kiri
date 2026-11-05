import { describe, expect, it } from "vitest";
import { exportBaseName } from "../../../src/services/export-base-name.js";

describe("services/export-base-name", () => {
  it("keeps a plain file name, minus its extension", () => {
    expect(exportBaseName("house.fkld")).toBe("house");
    expect(exportBaseName("loaded.JSON")).toBe("loaded");
    expect(exportBaseName("cube.stl")).toBe("cube");
  });

  it("takes only the last path segment: the viewer reports where a model came from", () => {
    // `../examples/house.fkld` is what the bundled house arrives as. It used to put `../` entries in the zip
    // and save the file as `_examples_house.zip`.
    expect(exportBaseName("../examples/house.fkld")).toBe("house");
    expect(exportBaseName("./examples/house.fkld")).toBe("house");
    expect(exportBaseName("C:\\Users\\sedat\\kiri\\house.fkld")).toBe("house");
    expect(exportBaseName("http://localhost:5173/examples/house.fkld?v=3#top")).toBe("house");
  });

  it("never lets a name climb out of the folder it is unpacked into", () => {
    for (const name of ["../../etc/passwd", "..", "../", "a/../../b.fkld", "/abs/path/x.fold"]) {
      const out = exportBaseName(name);
      expect(out, name).not.toMatch(/[\\/]/);
      expect(out, name).not.toMatch(/^\./);
      expect(out, name).not.toContain("..");
    }
  });

  it("turns Turkish letters into plain ASCII rather than dropping them", () => {
    // The zip writer does not mark names as UTF-8, so an accented name reads garbled in some extractors.
    expect(exportBaseName("ev şablonu.fkld")).toBe("ev-sablonu");
    expect(exportBaseName("İğne ışık çöl.fkld")).toBe("Igne-isik-col");
    expect(exportBaseName("üzüm.fold")).toBe("uzum");
  });

  it("collapses anything else unsafe, and trims dots and dashes from the ends", () => {
    expect(exportBaseName("my model (v2)!.fkld")).toBe("my-model-v2");
    expect(exportBaseName("..hidden.fkld")).toBe("hidden");
    expect(exportBaseName("---x---.fkld")).toBe("x");
  });

  it("falls back when nothing usable is left", () => {
    expect(exportBaseName("")).toBe("kirigami");
    expect(exportBaseName(".fkld")).toBe("kirigami");
    expect(exportBaseName("???")).toBe("kirigami");
    expect(exportBaseName("***", "kiri")).toBe("kiri");
  });
});
