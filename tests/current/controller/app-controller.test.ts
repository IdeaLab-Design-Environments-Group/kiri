import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../../../src/controller/app-controller.js";
import { AppStore } from "../../../src/model/app-store.js";
import { canSimulate } from "../../../src/sim/scene.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";
import { PatternGrid, presetWaterbomb } from "../../../src/model/pattern-grid.js";

class ConvertPanelMock {
  factsCalls: [string, string][][] = [];
  statusCalls: Array<{ msg: string; kind: string }> = [];
  chosenHandler: ((file: File) => void) | null = null;

  onFileChosen(handler: (file: File) => void): void {
    this.chosenHandler = handler;
  }

  renderFacts(rows: [string, string][]): void {
    this.factsCalls.push(rows);
  }

  setStatus(msg: string, kind = ""): void {
    this.statusCalls.push({ msg, kind });
  }
}

class ViewerFrameMock {
  showCalls: Array<{ object: FoldFile; name: string }> = [];
  private shown: { object: FoldFile; name: string } | null = null;

  show(object: FoldFile, name: string): void {
    this.showCalls.push({ object, name });
    this.shown = { object, name };
  }

  current(): { object: FoldFile; name: string } | null {
    return this.shown;
  }

  loadedHandler: ((object: FoldFile, name: string) => void) | null = null;
  onLoaded(handler: (object: FoldFile, name: string) => void): void {
    this.loadedHandler = handler;
  }

  /** Simulate the viewer loading a model on its own (file picker / dropdown / drag-drop). */
  simulateViewerLoad(object: FoldFile, name: string): void {
    this.shown = { object, name };
    this.loadedHandler?.(object, name);
  }
}

class HeaderActionsMock {
  createPyramidHandler: (() => void) | null = null;
  loadSampleHandler: (() => void) | null = null;
  kirigamizeHandler: (() => void) | null = null;
  enabledCalls: boolean[] = [];

  onCreatePyramid(handler: () => void): void {
    this.createPyramidHandler = handler;
  }

  onLoadSample(handler: () => void): void {
    this.loadSampleHandler = handler;
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeHandler = handler;
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
}

type SimProvider = () => { scene: unknown; title: string } | null;

class SimModalMock {
  provider: SimProvider | null = null;
  enabledCalls: boolean[] = [];
  materialListener: ((m: unknown) => void) | null = null;
  detailListener: ((d: number) => void) | null = null;
  gapListener: ((g: number) => void) | null = null;

  setProvider(provider: SimProvider): void {
    this.provider = provider;
  }

  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }

  onMaterialChange(cb: (m: unknown) => void): void {
    this.materialListener = cb;
  }

  onDetailChange(cb: (d: number) => void): void {
    this.detailListener = cb;
  }

  onGapChange(cb: (g: number) => void): void {
    this.gapListener = cb;
  }
}

type ExportProviderFn = () => unknown;

class ExportModalMock {
  provider: ExportProviderFn | null = null;
  stlProvider: ((h: number | null, d: number | null) => unknown) | null = null;
  enabledCalls: boolean[] = [];

  setProvider(provider: ExportProviderFn): void {
    this.provider = provider;
  }

  setStlProvider(provider: (h: number | null, d: number | null) => unknown): void {
    this.stlProvider = provider;
  }

  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
}

class PatternEditorModalMock {
  useHandler: ((grid: unknown) => void) | null = null;
  serializer: ((grid: unknown) => unknown) | null = null;
  closeCalls = 0;

  onUse(handler: (grid: unknown) => void): void {
    this.useHandler = handler;
  }

  setSerializer(serializer: (grid: unknown) => unknown): void {
    this.serializer = serializer;
  }

  close(): void {
    this.closeCalls++;
  }
}

class ElectronicsModalMock {
  editHandler: ((circuit: unknown) => void) | null = null;
  enabledCalls: boolean[] = [];
  patternCalls: unknown[] = [];
  previewCalls: unknown[] = [];

  onEdit(handler: (circuit: unknown) => void): void {
    this.editHandler = handler;
  }
  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
  setPattern(fold: unknown): void {
    this.patternCalls.push(fold);
  }
  setPreview(routed: unknown): void {
    this.previewCalls.push(routed);
  }
}

function makeFold(overrides: Partial<FoldFile> = {}): FoldFile {
  return {
    vertices_coords: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    faces_vertices: [[0, 1, 2]],
    edges_vertices: [
      [0, 1],
      [1, 2],
      [2, 0],
    ],
    ...overrides,
  };
}

function setup() {
  const store = new AppStore();
  const convert = new ConvertPanelMock();
  const viewer = new ViewerFrameMock();
  const header = new HeaderActionsMock();
  const sim = new SimModalMock();
  const exporter = new ExportModalMock();
  const patternEditor = new PatternEditorModalMock();
  const electronics = new ElectronicsModalMock();
  const controller = new AppController(
    store,
    convert as never,
    viewer as never,
    header as never,
    sim as never,
    exporter as never,
    patternEditor as never,
    electronics as never,
  );
  return { controller, store, convert, viewer, header, sim, exporter, patternEditor, electronics };
}

describe("controller/app-controller", () => {
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  });

  it("renders initial empty state and wires a sim provider", () => {
    const { convert, header, sim } = setup();

    expect(convert.factsCalls[0]).toEqual([]);
    expect(convert.statusCalls[0]).toEqual({ msg: "No model loaded.", kind: "" });
    expect(header.enabledCalls[0]).toBe(false);
    expect(sim.enabledCalls[0]).toBe(false);
    expect(sim.provider?.()).toBeNull();
  });

  it("kirigamizes a loaded fold by passing it through to the viewer", () => {
    const { controller, store, viewer, convert } = setup();
    const fold = makeFold({ "fkld:meta_architecture": {} });
    store.update({ model: { kind: "fold", name: "sample.fkld", object: fold } });

    controller.kirigamize();

    expect(viewer.showCalls).toEqual([{ object: fold, name: "sample.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: 'Showing "sample.fkld" in the viewer (already a FOLD/FKLD pattern).',
      kind: "ok",
    });
  });

  it("kirigamizes a mesh model through the full M1–M5 pipeline", { timeout: 120_000 }, () => {
    const { controller, store, viewer, convert } = setup();
    // open 4-gon pyramid OBJ: apex + 4 base corners, lateral faces only
    const obj = [
      "v 0 0 30",
      "v 35.36 0 0",
      "v 0 35.36 0",
      "v -35.36 0 0",
      "v 0 -35.36 0",
      "f 1 2 3",
      "f 1 3 4",
      "f 1 4 5",
      "f 1 5 2",
    ].join("\n");
    store.update({ model: { kind: "mesh", name: "pyramid.obj", ext: "obj", text: obj } });

    controller.kirigamize();

    const m = store.model;
    expect(m?.kind).toBe("fold");
    if (m?.kind === "fold") {
      expect(m.name).toBe("pyramid.fkld");
      expect(Object.keys(m.object).some((k) => k.startsWith("fkld:"))).toBe(true);
    }
    expect(viewer.showCalls.at(-1)?.name).toBe("pyramid.fkld");
    const status = convert.statusCalls.at(-1);
    expect(status?.msg).toContain("d_H");
    expect(status?.msg).toContain("Kirigamized");
  });

  it("reports pipeline errors for unusable meshes", () => {
    const { controller, store, convert } = setup();
    store.update({
      model: { kind: "mesh", name: "broken.obj", ext: "obj", text: "v 0 0 0" },
    });

    controller.kirigamize();

    expect(convert.statusCalls.at(-1)?.kind).toBe("bad");
    expect(convert.statusCalls.at(-1)?.msg).toMatch(/import|no vertices/);
  });

  it("loads the bundled sample on fetch success and announces it", async () => {
    const { controller, viewer, convert } = setup();
    const fold = makeFold({ frame_title: "sample" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(fold),
    } as Response);

    await controller.loadSample(true);

    expect(viewer.showCalls).toEqual([{ object: fold, name: "akde-hex.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Loaded bundled sample into the viewer.",
      kind: "ok",
    });
  });

  it("creates the default AKDE pyramid and sends it to the viewer", () => {
    const { header, viewer, convert, sim } = setup();

    header.createPyramidHandler?.();

    expect(viewer.showCalls).toHaveLength(1);
    expect(viewer.showCalls[0]?.name).toBe("akde-pyramid.fkld");
    expect(viewer.showCalls[0]?.object.vertices_coords?.length).toBeGreaterThan(0);
    expect(canSimulate(viewer.showCalls[0]!.object)).toBe(true);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Created AKDE pyramid via the transferred creation pipeline. Open 3D Sim to fold it.",
      kind: "ok",
    });
    expect(sim.enabledCalls.at(-1)).toBe(true);
  });

  it("commits a drawn crease pattern (editor → FKLD) to the viewer and closes the modal", () => {
    const { patternEditor, viewer, convert, sim } = setup();

    const grid = new PatternGrid(4, 4, 10);
    presetWaterbomb(grid); // a foldable, simulable pattern
    patternEditor.useHandler?.(grid);

    expect(viewer.showCalls).toHaveLength(1);
    expect(viewer.showCalls[0]?.name).toBe("pattern-4x4.fkld");
    expect(viewer.showCalls[0]?.object.faces_vertices?.length).toBeGreaterThan(0);
    expect(canSimulate(viewer.showCalls[0]!.object)).toBe(true);
    expect(convert.statusCalls.at(-1)?.kind).toBe("ok");
    expect(patternEditor.closeCalls).toBe(1);
    expect(sim.enabledCalls.at(-1)).toBe(true);

    // The download serializer is wired and produces valid FKLD JSON text.
    const payload = patternEditor.serializer?.(grid) as { filename: string; text: string };
    expect(payload.filename).toBe("pattern-4x4.fkld");
    expect(() => JSON.parse(payload.text)).not.toThrow();
  });

  it("reports sample-fetch failure without throwing", async () => {
    const { controller, convert } = setup();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await controller.loadSample(true);

    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Sample fetch failed (serve over http). The viewer shows it by default.",
      kind: "",
    });
  });

  it("parses loaded FOLD files through FileReader", () => {
    const { convert, sim, header } = setup();
    const fold = makeFold();

    class FileReaderMock {
      result = JSON.stringify(fold);
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }

    globalThis.FileReader = FileReaderMock as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "ok.fold" } as File);

    expect(header.enabledCalls.at(-1)).toBe(true);
    expect(sim.enabledCalls.at(-1)).toBe(true);
  });

  it("handles parse errors and unsupported file types", () => {
    const { convert } = setup();

    class BadReader {
      result = "{broken";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }
    globalThis.FileReader = BadReader as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "broken.fold" } as File);
    expect(convert.statusCalls.at(-1)?.msg).toContain("Parse error in broken.fold");

    class PlainReader {
      result = "hello";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsText(): void {
        this.onload?.();
      }
    }
    globalThis.FileReader = PlainReader as unknown as typeof FileReader;
    convert.chosenHandler?.({ name: "note.txt" } as File);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Unsupported file type: .txt",
      kind: "bad",
    });
  });

  it("builds the sim provider only for current fold models", () => {
    const { store, sim } = setup();
    expect(sim.provider?.()).toBeNull();

    const mesh: LoadedModel = { kind: "mesh", name: "shape.obj", ext: "obj", text: "v 0 0 0" };
    store.update({ model: mesh });
    expect(sim.provider?.()).toBeNull();

    const fold = makeFold();
    store.update({ model: { kind: "fold", name: "shape.fold", object: fold } });
    const built = sim.provider?.();
    expect(built?.title).toContain("shape.fold");
  });

  it("sims the model shown in the VIEWER, even when it differs from the convert-panel model", () => {
    const { store, viewer, sim } = setup();
    // The convert panel / store holds model A …
    store.update({ model: { kind: "fold", name: "convert-A.fold", object: makeFold() } });
    // … but the viewer independently loaded model B (its own file picker / example / drag-drop).
    viewer.simulateViewerLoad(makeFold(), "viewer-B.fold");

    const built = sim.provider?.();
    expect(built).not.toBeNull();
    expect(built?.title).toContain("viewer-B.fold"); // sims what the viewer shows, not store's A
    expect(sim.enabledCalls.at(-1)).toBe(true); // 3D Sim button followed the viewer's model
  });

  it("builds the SVG export from the displayed pattern, null for none / a raw mesh", () => {
    const { store, exporter } = setup();
    expect(exporter.provider?.()).toBeNull(); // nothing loaded

    store.update({ model: { kind: "mesh", name: "x.obj", ext: "obj", text: "v 0 0 0" } });
    expect(exporter.provider?.()).toBeNull(); // a raw mesh has no pattern to cut

    store.update({ model: { kind: "fold", name: "p.fkld", object: makeFold({ edges_assignment: ["B", "B", "B"] }) } });
    const payload = exporter.provider?.() as { files: { filename: string }[] } | null;
    expect(payload).not.toBeNull();
    expect(payload!.files.some((f) => f.filename.includes("cut"))).toBe(true);
    expect(exporter.enabledCalls.at(-1)).toBe(true); // Export button enabled for a displayed pattern
  });
});
