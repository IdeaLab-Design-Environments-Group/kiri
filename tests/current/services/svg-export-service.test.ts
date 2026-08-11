import { describe, expect, it, vi } from "vitest";

const buildFkldSvgExport = vi.fn((object, name) => ({ object, name }));

vi.mock("../../../src/model/fkld-svg-export.js", () => ({
  buildFkldSvgExport,
}));

describe("services/svg-export-service", () => {
  it("prefers the shown viewer model over the loaded fold model", async () => {
    const { resolveSvgExport } = await import("../../../src/services/svg-export-service.js");
    const shown = { object: { file_spec: 1 }, name: "viewer.fkld" } as any;
    const model = { kind: "fold", name: "loaded.fold", object: { file_spec: 2 } } as any;

    const out = resolveSvgExport(model, shown);

    expect(buildFkldSvgExport).toHaveBeenCalledWith(shown.object, "viewer");
    expect(out).toEqual({ object: shown.object, name: "viewer" });
  });

  it("falls back to the loaded fold model and strips known extensions", async () => {
    const { resolveSvgExport } = await import("../../../src/services/svg-export-service.js");
    buildFkldSvgExport.mockClear();
    const model = { kind: "fold", name: "loaded.JSON", object: { file_spec: 2 } } as any;

    const out = resolveSvgExport(model, null);

    expect(buildFkldSvgExport).toHaveBeenCalledWith(model.object, "loaded");
    expect(out).toEqual({ object: model.object, name: "loaded" });
  });

  it("returns null when there is nothing exportable", async () => {
    const { resolveSvgExport } = await import("../../../src/services/svg-export-service.js");
    buildFkldSvgExport.mockClear();
    expect(resolveSvgExport(null, null)).toBeNull();
    expect(resolveSvgExport({ kind: "mesh", name: "m.obj", ext: "obj", text: "" } as any, null)).toBeNull();
    expect(buildFkldSvgExport).not.toHaveBeenCalled();
  });
});
