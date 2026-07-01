import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  appChildren: [] as any[],
  headerChildren: [] as any[],
  loadSampleCalls: [] as any[],
  controllerArgs: [] as any[],
  viewCalls: [] as string[],
};

const appRoot = {
  append: (...nodes: any[]) => state.appChildren.push(...nodes),
};

const headerRoot = {
  appendChild: (node: any) => state.headerChildren.push(node),
};

vi.mock("../../src/styles.css", () => ({}));

vi.mock("../../src/model/app-store.js", () => ({
  AppStore: class AppStore {},
}));

vi.mock("../../src/view/convert-panel.js", () => ({
  ConvertPanel: class ConvertPanel {
    element = { id: "convert" };
  },
}));

vi.mock("../../src/view/viewer-frame.js", () => ({
  ViewerFrame: class ViewerFrame {
    element = { id: "viewer" };
  },
}));

vi.mock("../../src/view/layout.js", () => ({
  installResizableLayout: vi.fn(),
}));

vi.mock("../../src/view/sim-modal.js", () => ({
  SimModal: class SimModal {
    mountTrigger = vi.fn(() => state.viewCalls.push("sim.mountTrigger"));
    setProvider = vi.fn();
    setEnabled = vi.fn();
  },
}));

vi.mock("../../src/view/export-modal.js", () => ({
  ExportModal: class ExportModal {
    mountTrigger = vi.fn(() => state.viewCalls.push("export.mountTrigger"));
    setProvider = vi.fn();
    setEnabled = vi.fn();
  },
}));

vi.mock("../../src/view/pattern-editor-modal.js", () => ({
  PatternEditorModal: class PatternEditorModal {
    mountTrigger = vi.fn(() => state.viewCalls.push("patternEditor.mountTrigger"));
    onUse = vi.fn();
    setSerializer = vi.fn();
  },
}));

vi.mock("../../src/view/electronics-modal.js", () => ({
  ElectronicsModal: class ElectronicsModal {
    mountTrigger = vi.fn(() => state.viewCalls.push("electronics.mountTrigger"));
    onEdit = vi.fn();
    setEnabled = vi.fn();
    setPattern = vi.fn();
    setPreview = vi.fn();
  },
}));

vi.mock("../../src/view/header-actions.js", () => ({
  HeaderActions: class HeaderActions {
    element = { id: "header-actions" };
    appendActionButtons = vi.fn(() => state.viewCalls.push("header.appendActionButtons"));
    onCreatePyramid = vi.fn();
    onLoadSample = vi.fn();
    onKirigamize = vi.fn();
    setKirigamizeEnabled = vi.fn();
  },
}));

vi.mock("../../src/controller/app-controller.js", () => ({
  AppController: class AppController {
    constructor(...args: any[]) {
      state.controllerArgs.push(args);
    }
    loadSample(announce: boolean) {
      state.loadSampleCalls.push(announce);
      return Promise.resolve();
    }
  },
}));

describe("main.ts", () => {
  beforeEach(() => {
    state.appChildren = [];
    state.headerChildren = [];
    state.loadSampleCalls = [];
    state.controllerArgs = [];
    state.viewCalls = [];
    vi.resetModules();
    (globalThis as any).document = {
      getElementById: vi.fn((id: string) => (id === "app" ? appRoot : null)),
      querySelector: vi.fn((selector: string) => (selector === ".app-header" ? headerRoot : null)),
    };
  });

  afterEach(() => {
    delete (globalThis as any).document;
  });

  it("wires the composition root and loads the sample quietly", async () => {
    await import("../../src/main.ts");

    expect(state.appChildren.map((x) => x.id)).toEqual(["convert", "viewer"]);
    expect(state.headerChildren.map((x) => x.id)).toEqual(["header-actions"]);
    expect(state.controllerArgs).toHaveLength(1);
    expect(state.controllerArgs[0]).toHaveLength(8);
    expect(state.loadSampleCalls).toEqual([false]);
    expect(state.viewCalls).toEqual([
      "sim.mountTrigger",
      "export.mountTrigger",
      "patternEditor.mountTrigger",
      "electronics.mountTrigger",
      "header.appendActionButtons",
    ]);
  });

  it("throws when the #app root is missing", async () => {
    (globalThis as any).document.getElementById = vi.fn(() => null);
    await expect(import("../../src/main.ts")).rejects.toThrow(/Missing #app root/);
  });

  it("tolerates a missing .app-header host", async () => {
    (globalThis as any).document.querySelector = vi.fn(() => null);

    await import("../../src/main.ts");

    expect(state.appChildren.map((x) => x.id)).toEqual(["convert", "viewer"]);
    expect(state.headerChildren).toEqual([]);
    expect(state.loadSampleCalls).toEqual([false]);
  });
});
