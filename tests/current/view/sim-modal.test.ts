import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoldScene } from "../../../src/sim/index.js";
import { installDom, MockElement } from "./mock-dom.js";

const canvasInstances: Array<{
  mount: MockElement;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setScene: ReturnType<typeof vi.fn>;
  setFoldPercent: ReturnType<typeof vi.fn>;
  setTileDetail: ReturnType<typeof vi.fn>;
  warmToTarget: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../../../src/view/sim-canvas.js", () => ({
  SimCanvas: class {
    readonly mount: MockElement;
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly setScene = vi.fn();
    readonly setFoldPercent = vi.fn();
    readonly setTileDetail = vi.fn();
    readonly warmToTarget = vi.fn();

    constructor(mount: MockElement) {
      this.mount = mount;
      canvasInstances.push(this);
    }
  },
}));

describe("view/sim-modal", () => {
  beforeEach(() => {
    canvasInstances.length = 0;
  });

  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("mounts the trigger and toggles its enabled state", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    const host = document.createElement("div");
    modal.mountTrigger(host as unknown as HTMLElement);
    modal.setEnabled(true);

    expect(host.children).toHaveLength(1);
    expect(host.children[0]?.textContent).toBe("3D Sim");
    expect(host.children[0]?.disabled).toBe(false);
  });

  it("opens lazily, loads a scene, updates fold percent, and can be reset/closed", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    const scene = {
      net: {
        vertices: [{}, {}],
        faces: [[0, 1, 0]],
        edges: [{ faces: [0, 1] }, { faces: [0] }],
      },
    } as unknown as FoldScene;
    modal.setProvider(() => ({ scene, title: "sample (guided)" }));

    await modal.open();

    expect(canvasInstances).toHaveLength(1);
    expect(canvasInstances[0]?.setScene).toHaveBeenCalledWith(scene);
    expect(canvasInstances[0]?.start).toHaveBeenCalledTimes(1);
    // The modal opens flat (full sheet, all cuts visible); the user folds via the slider.
    expect(canvasInstances[0]?.setFoldPercent).toHaveBeenCalledWith(0);

    const overlay = document.body.children[0]!;
    const slider = overlay.querySelector(".sim-fold-slider")!;
    const value = overlay.querySelector(".sim-fold-value")!;
    slider.value = "35";
    slider.dispatch("input");
    expect(value.textContent).toBe("35%");
    expect(canvasInstances[0]?.setFoldPercent).toHaveBeenLastCalledWith(0.35);

    const reset = overlay.querySelector(".sim-reset-btn")!;
    reset.click();
    expect(canvasInstances[0]?.setScene).toHaveBeenCalledTimes(2);

    modal.close();
    expect(canvasInstances[0]?.stop).toHaveBeenCalled();
    expect(overlay.hidden).toBe(true);
  });

  it("reports missing provider output and closes on overlay click or Escape", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    modal.setProvider(() => null);

    await modal.open();
    const overlay = document.body.children[0]!;
    const status = overlay.querySelector(".sim-status")!;
    expect(status.textContent).toContain("No foldable model");
    expect(canvasInstances[0]?.stop).toHaveBeenCalled();

    overlay.dispatch("click", { target: overlay });
    expect(overlay.hidden).toBe(true);

    await modal.open();
    document.dispatch("keydown", { key: "Escape" });
    expect(overlay.hidden).toBe(true);
  });

  it("surfaces scene-loading failures without crashing", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    const scene = {
      net: { vertices: [], faces: [], edges: [] },
    } as unknown as FoldScene;
    modal.setProvider(() => ({ scene, title: "broken" }));

    await modal.open();
    canvasInstances[0]!.setScene.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const reset = document.body.children[0]!.querySelector(".sim-reset-btn")!;
    reset.click();

    const status = document.body.children[0]!.querySelector(".sim-status")!;
    expect(status.textContent).toContain("Cannot simulate this model: boom");
    expect(canvasInstances[0]?.stop).toHaveBeenCalled();
  });
});
