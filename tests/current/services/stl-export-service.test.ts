import { describe, expect, it, vi } from "vitest";

const buildStlExport = vi.fn((object, name, height, detail) => ({ object, name, height, detail }));

vi.mock("../../../src/model/stl-export.js", () => ({
  buildStlExport,
}));

describe("services/stl-export-service", () => {
  it("prefers the shown viewer model and threads the height + detail through", async () => {
    const { resolveStlExport } = await import("../../../src/services/stl-export-service.js");
    const shown = { object: { file_spec: 1 }, name: "viewer.fkld" } as any;
    const model = { kind: "fold", name: "loaded.fold", object: { file_spec: 2 } } as any;

    const out = resolveStlExport(model, shown, 3.5, 3);

    expect(buildStlExport).toHaveBeenCalledWith(shown.object, "viewer", 3.5, 3, undefined, undefined);
    expect(out).toEqual({ object: shown.object, name: "viewer", height: 3.5, detail: 3 });
  });

  it("falls back to the loaded fold model and strips known extensions (incl. .stl/.obj)", async () => {
    const { resolveStlExport } = await import("../../../src/services/stl-export-service.js");
    buildStlExport.mockClear();
    const model = { kind: "fold", name: "house.STL", object: { file_spec: 2 } } as any;

    const out = resolveStlExport(model, null); // no args → undefined (builder uses its defaults)

    expect(buildStlExport).toHaveBeenCalledWith(model.object, "house", undefined, undefined, undefined, undefined);
    expect(out).toEqual({ object: model.object, name: "house", height: undefined, detail: undefined });
  });

  it("returns null when there is nothing exportable", async () => {
    const { resolveStlExport } = await import("../../../src/services/stl-export-service.js");
    buildStlExport.mockClear();
    expect(resolveStlExport(null, null)).toBeNull();
    expect(resolveStlExport({ kind: "mesh", name: "m.obj", ext: "obj", text: "" } as any, null)).toBeNull();
    expect(buildStlExport).not.toHaveBeenCalled();
  });
});
