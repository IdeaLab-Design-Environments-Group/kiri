import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../../../src/controller/app-controller.js";
import { AppStore } from "../../../src/model/app-store.js";
import { canSimulate } from "../../../src/sim/scene.js";
import type { FoldFile, LoadedModel } from "../../../src/model/fold-file.js";
import { PatternGrid, presetWaterbomb } from "../../../src/model/pattern-grid.js";
import { readFileSync } from "node:fs";
import { flatFaces, gapGraph, ledOf } from "../../../src/model/electronics.js";
import { TILE_INSET_FRAC } from "../../../src/model/tile-subdiv.js";

// Counts the router's runs, so a test can tell a re-plan from a reused plan. Not a `vi.fn`: the
// `restoreAllMocks` below would strip its implementation and the real router with it.
const routing = vi.hoisted(() => ({ plans: 0 }));
vi.mock("../../../src/model/electronics-routing.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/model/electronics-routing.js")>();
  return {
    ...real,
    planRoutes: (...args: Parameters<typeof real.planRoutes>) => {
      routing.plans++;
      return real.planRoutes(...args);
    },
  };
});

class ConvertPanelMock {
  factsCalls: [string, string][][] = [];
  statusCalls: Array<{ msg: string; kind: string }> = [];
  chosenHandler: ((file: File) => void) | null = null;
  cutHandler: (() => void) | null = null;
  /** Every state the Cut & fold button was put in, in order. */
  cutCalls: Array<{ enabled: boolean; busy?: boolean; hint: string }> = [];

  onCutAndFold(handler: () => void): void {
    this.cutHandler = handler;
  }

  setCutAndFold(state: { enabled: boolean; busy?: boolean; hint: string }): void {
    this.cutCalls.push(state);
  }

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

type SimProvider = () => { scene: unknown; title: string } | null;

class SimModalMock {
  provider: SimProvider | null = null;
  enabledCalls: boolean[] = [];
  materialListener: ((m: unknown) => void) | null = null;
  detailListener: ((d: number) => void) | null = null;
  gapListener: ((g: number) => void) | null = null;
  traces: unknown[] = [];

  setProvider(provider: SimProvider): void {
    this.provider = provider;
  }

  /** The copper handed to the 3D view, so a test can assert it follows the circuit. */
  setTraces(traces: unknown[]): void {
    this.traces = traces;
  }

  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }

  openCalls = 0;
  open(): Promise<void> {
    this.openCalls++;
    return Promise.resolve();
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

  /** The print size every layer is cut at, and the router plans to. */
  printSize = 130;
  printSizeHandler: ((mm: number) => void) | null = null;

  onPrintSize(handler: (mm: number) => void): void {
    this.printSizeHandler = handler;
  }

  printSizeMm(): number {
    return this.printSize;
  }

  refreshCalls = 0;
  refreshPreviews(): void {
    this.refreshCalls++;
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
  editHandler: ((circuit: unknown, side: string) => void) | null = null;
  enabledCalls: boolean[] = [];
  patternCalls: unknown[] = [];
  printSizeCalls: number[] = [];
  setPrintSize(mm: number): void {
    this.printSizeCalls.push(mm);
  }
  gapCalls: number[] = [];
  previewCalls: unknown[] = [];

  onEdit(handler: (circuit: unknown, side: string) => void): void {
    this.editHandler = handler;
  }
  setEnabled(enabled: boolean): void {
    this.enabledCalls.push(enabled);
  }
  setPattern(fold: unknown): void {
    this.patternCalls.push(fold);
  }
  setTileGap(gap: number): void {
    this.gapCalls.push(gap);
  }
  setPreview(routed: unknown): void {
    this.previewCalls.push(routed);
  }
  materialListener: ((m: unknown) => void) | null = null;
  formListener: (() => void) | null = null;
  materialCalls: unknown[] = [];
  closeCalls = 0;
  onMaterialChange(cb: (m: unknown) => void): void {
    this.materialListener = cb;
  }
  onOpenForm(cb: () => void): void {
    this.formListener = cb;
  }
  setMaterial(m: unknown): void {
    this.materialCalls.push(m);
  }
  close(): void {
    this.closeCalls++;
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
  const sim = new SimModalMock();
  const exporter = new ExportModalMock();
  const patternEditor = new PatternEditorModalMock();
  const electronics = new ElectronicsModalMock();
  const controller = new AppController(
    store,
    convert as never,
    viewer as never,
    sim as never,
    exporter as never,
    patternEditor as never,
    electronics as never,
  );
  return { controller, store, convert, viewer, sim, exporter, patternEditor, electronics };
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
    const { convert, sim } = setup();

    expect(convert.factsCalls[0]).toEqual([]);
    expect(convert.statusCalls[0]).toEqual({ msg: "No model loaded.", kind: "" });
    expect(convert.cutCalls[0]).toMatchObject({ enabled: false });
    expect(convert.cutCalls[0]!.hint).toContain("Load a 3D model");
    expect(sim.enabledCalls[0]).toBe(false);
    expect(sim.provider?.()).toBeNull();
  });

  it("kirigamizes a loaded fold by passing it through to the viewer", async () => {
    const { controller, store, viewer, convert } = setup();
    const fold = makeFold({ "fkld:meta_architecture": {} });
    store.update({ model: { kind: "fold", name: "sample.fkld", object: fold } });

    await controller.kirigamize();

    expect(viewer.showCalls).toEqual([{ object: fold, name: "sample.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: 'Showing "sample.fkld" in the viewer (already a FOLD/FKLD pattern).',
      kind: "ok",
    });
  });

  it("kirigamizes a mesh model through the full M1–M5 pipeline", { timeout: 120_000 }, async () => {
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

    await controller.kirigamize();

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

  it("reports pipeline errors for unusable meshes", async () => {
    const { controller, store, convert } = setup();
    store.update({
      model: { kind: "mesh", name: "broken.obj", ext: "obj", text: "v 0 0 0" },
    });

    await controller.kirigamize();

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

    // `house.fkld`, which is what `SAMPLE_URL`/`SAMPLE_NAME` have always said. This expected
    // `akde-hex.fkld` and so had never passed: both sides date to `633be99 previous repo corrupted`, the
    // commit this repo was reconstructed in, so the mismatch came in with the reconstruction rather than
    // from any change since. Matching the test to the code, not the other way round — the app has only
    // ever loaded house, and nothing has reported it loading the wrong sample.
    expect(viewer.showCalls).toEqual([{ object: fold, name: "house.fkld" }]);
    expect(convert.statusCalls.at(-1)).toEqual({
      msg: "Loaded bundled sample into the viewer.",
      kind: "ok",
    });
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
      msg: "Could not load the house example: serve the app over http (run \"npm run dev\" and open the printed address), or drop a model file on the left.",
      kind: "",
    });
  });

  it("parses loaded FOLD files through FileReader", () => {
    const { convert, sim } = setup();
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

    // A FOLD file is already a pattern: Cut & fold is off for it, and the hint says why.
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: false });
    expect(convert.cutCalls.at(-1)!.hint).toContain("already a pattern");
    expect(sim.enabledCalls.at(-1)).toBe(true);
  });

  it("keeps the kirigamize button disabled and shows the status before the heavy work runs", async () => {
    const { controller, store, convert } = setup();
    store.update({ model: { kind: "mesh", name: "broken.obj", ext: "obj", text: "v 0 0 0" } });
    const pending = controller.kirigamize();
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: false, busy: true });
    expect(convert.statusCalls.at(-1)?.msg).toContain("Kirigamizing broken.obj");
    // nothing has run yet: the failure status only arrives after the yield
    expect(convert.statusCalls.at(-1)?.kind).toBe("");
    await pending;
    expect(convert.statusCalls.at(-1)?.kind).toBe("bad");
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: true });
  });

  it("turns Cut & fold on for a 3D mesh only, with a hint for each case", () => {
    const { store, convert } = setup();
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: false });
    expect(convert.cutCalls.at(-1)!.hint).toContain("Load a 3D model");

    store.update({ model: { kind: "mesh", name: "cube.stl", ext: "stl", text: "solid" } });
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: true });
    expect(convert.cutCalls.at(-1)!.hint).toContain("Cuts the mesh");

    store.update({ model: { kind: "fold", name: "house.fkld", object: { file_spec: 1 } as unknown as FoldFile } });
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: false });
    expect(convert.cutCalls.at(-1)!.hint).toContain("already a pattern");

    store.update({ model: null });
    expect(convert.cutCalls.at(-1)).toMatchObject({ enabled: false });
  });

  it("runs the pipeline when the panel's Cut & fold button is pressed", async () => {
    const { store, convert } = setup();
    store.update({ model: { kind: "mesh", name: "broken.obj", ext: "obj", text: "v 0 0 0" } });
    convert.cutHandler?.();
    expect(convert.cutCalls.at(-1)).toMatchObject({ busy: true }); // it started
    await Promise.resolve();
  });

  function readerReturning(text: string): typeof FileReader {
    class R {
      result = text;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText(): void {
        this.onload?.();
      }
    }
    return R as unknown as typeof FileReader;
  }

  it("an imported FKLD becomes what the viewer and Sim/Export use", () => {
    const { store, viewer, convert } = setup();
    store.update({ viewerShown: { object: makeFold({ frame_title: "old" }), name: "old.fkld" } });
    globalThis.FileReader = readerReturning(JSON.stringify(makeFold({ frame_title: "fresh" })));
    convert.chosenHandler?.({ name: "fresh.fkld", size: 10 } as File);
    expect(viewer.showCalls.at(-1)?.name).toBe("fresh.fkld");
    expect(store.getState().viewerShown?.name).toBe("fresh.fkld");
  });

  it("an imported mesh drops the stale viewer model and says so", () => {
    const { store, convert } = setup();
    store.update({ viewerShown: { object: makeFold(), name: "old.fkld" } });
    globalThis.FileReader = readerReturning("v 0 0 0");
    convert.chosenHandler?.({ name: "m.obj", size: 10 } as File);
    expect(store.getState().viewerShown).toBeNull();
    expect(convert.statusCalls.at(-1)?.msg).toContain("still shows the previous pattern");
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

  it("hands the planned copper to the 3D view, pinned to the mesh", () => {
    // The simulation draws the copper on the folded model, so the controller has to route the circuit and pin
    // it to the mesh -- the Electronics modal may never have been opened.
    const { controller, store, sim } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    expect(sim.traces).toEqual([]); // nothing placed yet

    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    const led = ledOf(gaps[0]!.faceA, gaps[0]!.faceB);
    controller.updateCircuit({ leds: [led], battery: { face: 0 } });

    // The whole electronics layer, not just the copper: the pads and the chip footprints go on the model too.
    const kinds = new Set((sim.traces as { kind: string }[]).map((m) => m.kind));
    expect(kinds.has("pwr") || kinds.has("gnd")).toBe(true);
    expect(kinds.has("led-pwr")).toBe(true);
    expect(kinds.has("batt-pwr")).toBe(true);
    for (const m of sim.traces as { tris: unknown[] }[]) {
      expect(m.tris.length % 3).toBe(0); // triangles, in threes
      expect(m.tris.length).toBeGreaterThan(0);
    }
  });

  it("does not re-plan the folded copper on a store update that leaves the circuit alone", () => {
    // Every store update renders, and a big board takes seconds to route: a status message or a setting
    // the copper does not depend on must reuse the plan in hand.
    const { controller, store, sim } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    const gaps = gapGraph(fold, flatFaces(fold)).gaps;
    controller.updateCircuit({ leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } });
    const plans = routing.plans;
    const traces = sim.traces;

    store.setStatus("Something unrelated.", "ok");
    store.update({ simDetail: 3 });
    expect(routing.plans).toBe(plans);
    expect(sim.traces).toBe(traces);

    controller.updateCircuit({ leds: [ledOf(gaps[1]!.faceA, gaps[1]!.faceB)], battery: { face: 0 } });
    expect(routing.plans).toBe(plans + 1); // a real edit still re-plans
  });

  it("keeps reporting a copper failure once, through unrelated updates, and clears it on success", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { controller, store } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    const broken = () => ({ leds: [{ face: 0 }], battery: { face: 0 }, wires: 5 }) as never;
    const copperWarning = () => store.getState().status.msg.startsWith("Copper could not be placed");
    controller.updateCircuit(broken());
    expect(copperWarning()).toBe(true);
    expect(store.getState().status.kind).toBe("bad");
    const plans = routing.plans;

    // Once shown, the warning is not pushed back over a later message by renders that reuse the plan.
    store.setStatus("Something else.", "ok");
    store.update({ simDetail: 3 });
    expect(routing.plans).toBe(plans);
    expect(store.getState().status.msg).toBe("Something else.");

    // A working circuit forgets the warning, so the same failure later is reported afresh.
    const gaps = gapGraph(fold, flatFaces(fold)).gaps;
    controller.updateCircuit({ leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } });
    controller.updateCircuit(broken());
    expect(copperWarning()).toBe(true);
  });

  it("drops the stored circuit when the viewer shows a different pattern", () => {
    // The Electronics tool starts a fresh circuit for every new pattern, so the stored one has to go too:
    // kept, the sim routed the old pattern's faces and gaps onto the new one until the next edit.
    const { controller, store, sim, viewer } = setup();
    const text = readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8");
    const fold = JSON.parse(text);
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    const gaps = gapGraph(fold, flatFaces(fold)).gaps;
    controller.updateCircuit({ leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } });
    expect(sim.traces).not.toEqual([]);

    viewer.simulateViewerLoad(JSON.parse(text), "other.fkld"); // a pattern the viewer loaded by itself
    expect(store.getState().circuits).toEqual({ inside: null, outside: null });
    expect(sim.traces).toEqual([]);
  });

  it("keeps the stored circuit when the viewer re-reports the pattern it already shows", () => {
    const { controller, store, viewer } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    viewer.simulateViewerLoad(fold, "house.fkld");
    controller.updateCircuit({ leds: [], battery: { face: 0 } });
    viewer.simulateViewerLoad(fold, "house.fkld");
    expect(store.getState().circuits.inside).toEqual({ leds: [], battery: { face: 0 } });
  });

  it("keeps both sides' circuits, and shows the side the editor has open", () => {
    // Inside and outside are separate circuits. Editing one must not replace the other in the store, and
    // the 3D view draws whichever side the editor last reported as open.
    const { store, sim, electronics } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    const gaps = gapGraph(fold, flatFaces(fold)).gaps;
    const inside = { leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } };
    const outside = { leds: [], battery: { face: 1 } };
    const kinds = () => new Set((sim.traces as { kind: string }[]).map((m) => m.kind));

    electronics.editHandler!(inside, "inside");
    expect(kinds().has("led-pwr")).toBe(true);
    electronics.editHandler!(outside, "outside");
    expect(kinds().has("led-pwr")).toBe(false); // the outside has a battery and no LED
    expect(kinds().has("batt-pwr")).toBe(true);
    expect(store.getState().circuits).toEqual({ inside, outside });

    electronics.editHandler!(inside, "inside"); // switching back
    expect(kinds().has("led-pwr")).toBe(true);
  });

  it("lays the copper on the build the sim folds — one material, whichever control moves it", () => {
    // The two are not two views of one sheet: the printed build has a hinge gap cut between its tiles and
    // the vinyl one does not, and that gap is what a component bridges and what the crease strain is
    // measured across. Routing for one while folding the other would be routing for neither.
    const { store, sim, electronics } = setup();
    expect(electronics.materialCalls.at(-1)).toBe("vinyl"); // the store's default reaches the editor

    electronics.materialListener!("printed"); // the editor's Build toggle
    expect(store.getState().simMaterial).toBe("printed");
    expect(electronics.materialCalls.at(-1)).toBe("printed");

    sim.materialListener!("vinyl"); // …and the sim's own tabs, the other way round
    expect(store.getState().simMaterial).toBe("vinyl");
    expect(electronics.materialCalls.at(-1)).toBe("vinyl");
  });

  it("opens the folded form on the build the editor is laid out for", () => {
    const { sim, electronics } = setup();
    electronics.formListener!();
    expect(electronics.closeCalls).toBe(1); // leaves the editor page…
    expect(sim.openCalls).toBe(1); // …and folds what it was showing
  });

  it("refreshes the open Export previews when the print size changes", () => {
    const { store, exporter } = setup();
    store.update({ model: { kind: "fold", name: "p.fkld", object: makeFold() } });
    const before = exporter.refreshCalls;
    exporter.printSizeHandler?.(200);
    expect(exporter.refreshCalls).toBe(before + 1);
  });

  it("drives the Electronics tool's gap from the sim's Gap slider", () => {
    // One gap in the build: the tiles the Electronics tool lays components on are the tiles that get
    // printed, so moving the sim's slider has to move them too -- not just the 3D render and the STL.
    const { store, sim, electronics } = setup();
    store.update({ model: { kind: "fold", name: "p.fkld", object: makeFold() } });

    expect(electronics.gapCalls.at(-1)).toBe(TILE_INSET_FRAC); // the shared default, before any drag

    sim.gapListener?.(0.3);
    expect(store.getState().simTileGap).toBe(0.3);
    expect(electronics.gapCalls.at(-1)).toBe(0.3);
  });

  it("keeps an LED's pads where the chip is, not where the tile gap happens to be", () => {
    // This used to assert the opposite: that moving the gap moved the copper, because an LED's pads WERE
    // the pinched tile dents and travelled with them. They are not any more. `seatLed` puts them at the
    // part's own pitch about the hinge midpoint, so a 1206's legs are 3.40mm apart because that is what a
    // 1206 is — not because of how the tiles happen to be drawn.
    //
    // The old comment justified the coupling as keeping the copper on the tile. Measured, that was never
    // true: across house, church and puffin, at gaps of 16/25/35/45%, **0 of 6 pads lie on a tile at any
    // setting**, the default included — nearest tile edge 2.17mm away on house at 16%, against a pad
    // 1.70mm long. It cannot be otherwise. A hinge is the boundary between two tiles and both are inset
    // from it, so a part straddling the hinge sits in the bare membrane by construction. The gap only
    // moves the tile away from the pad; it never moved the pad onto a tile.
    //
    // So the coupling guarded nothing, and what matters is the opposite property: the chip's geometry is
    // the chip's, and the slider cannot deform it.
    const { controller, store, sim } = setup();
    const fold = JSON.parse(
      readFileSync(new URL("../../../public/examples/house.fkld", import.meta.url).pathname, "utf8"),
    );
    store.update({ model: { kind: "fold", name: "house.fkld", object: fold } });
    const faces = flatFaces(fold);
    const gaps = gapGraph(fold, faces).gaps;
    controller.updateCircuit({ leds: [ledOf(gaps[0]!.faceA, gaps[0]!.faceB)], battery: { face: 0 } });

    const atDefault = JSON.stringify(sim.traces);
    sim.gapListener?.(0.45); // widest gap: the tiles shrink hard, and the part must not shrink with them
    expect(JSON.stringify(sim.traces)).toBe(atDefault);
  });
});
