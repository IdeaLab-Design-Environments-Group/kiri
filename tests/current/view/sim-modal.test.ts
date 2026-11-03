import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoldScene } from "../../../src/sim/index.js";
import { installDom, MockElement } from "./mock-dom.js";
import type { SimView } from "../../../src/view/sim-view.js";

/** The stand-in 3D view. Typed against `SimView`, so a method the modal starts calling cannot be missing
 *  here -- which is exactly what happened: the modal grew `setTileGap`, `setOverlay` and
 *  `setOverlayVisible`, this did not, and the resulting TypeError was swallowed by the `try` around the
 *  scene load. The viewer failed silently, and this test was what hid it. */
class MockCanvas implements SimView {
  readonly mount: MockElement;
  readonly start = vi.fn();
  readonly stop = vi.fn();
  readonly setScene = vi.fn();
  readonly setFoldPercent = vi.fn();
  readonly setTileDetail = vi.fn();
  readonly setTileGap = vi.fn();
  readonly setOverlay = vi.fn();
  readonly setOverlayVisible = vi.fn();
  readonly setStatusListener = vi.fn();
  readonly warmToTarget = vi.fn();

  constructor(mount: MockElement) {
    if (failNextConstruct) {
      failNextConstruct = false;
      throw new Error("no WebGL");
    }
    this.mount = mount;
    canvasInstances.push(this);
  }
}

const canvasInstances: MockCanvas[] = [];
let failNextConstruct = false;

vi.mock("../../../src/view/sim-canvas.js", () => ({ SimCanvas: MockCanvas }));

describe("view/sim-modal", () => {
  beforeEach(() => {
    canvasInstances.length = 0;
  });

  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).requestAnimationFrame;
  });

  it("mounts the trigger and toggles its enabled state", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    const host = document.createElement("div");
    modal.mountTrigger(host as unknown as HTMLElement);
    modal.setEnabled(true);

    expect(host.children).toHaveLength(1);
    expect(host.children[0]?.textContent).toBe("Simulate");
    expect(host.children[0]?.disabled).toBe(false);
  });

  it("titles the dialog as the 3D fold simulation, not routing", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    new SimModal();
    const overlay = document.body.children[0]!;
    expect(overlay.querySelector(".sim-modal-title")!.textContent).toBe("3D fold simulation — the copper on the folded model");
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

  it("paints a material selection before requesting its scene", async () => {
    const { document } = installDom();
    const frames: (() => void)[] = [];
    (globalThis as any).requestAnimationFrame = (cb: () => void) => { frames.push(cb); return frames.length; };
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal() as any;
    const scene = {
      net: { vertices: [{}, {}], faces: [[0, 1, 0]], edges: [] },
      model: { creases: { count: 0 } },
    } as unknown as FoldScene;
    const requested: string[] = [];
    modal.setProvider((material?: string) => {
      requested.push(material ?? "default");
      return { scene, title: material ?? "vinyl" };
    });

    await modal.open();
    modal.selectMaterial("printed");

    expect(requested).toEqual(["vinyl"]);
    expect(modal.statusEl.textContent).toContain("Preparing 3D-printed");
    frames.shift()?.();
    expect(requested).toEqual(["vinyl", "printed"]);
  });

  it("reports missing provider output and closes on overlay click or Escape", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal();
    modal.setProvider(() => null);

    await modal.open();
    const overlay = document.body.children[0]!;
    const status = overlay.querySelector(".sim-status")!;
    expect(status.textContent).toContain("no foldable model");
    expect(canvasInstances[0]?.stop).toHaveBeenCalled();

    overlay.dispatch("click", { target: overlay });
    expect(overlay.hidden).toBe(true);

    await modal.open();
    document.dispatch("keydown", { key: "Escape" });
    expect(overlay.hidden).toBe(true);
  });

  it("reports a provider exception as a scene error, not a viewer-load failure", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const modal = new SimModal();
    modal.setProvider(() => {
      throw new Error("bad scene");
    });
    await modal.open();
    const status = document.body.children[0]!.querySelector(".sim-status")!;
    expect(status.textContent).toContain("Cannot build the 3D scene for this model: bad scene");
    expect(status.textContent).not.toContain("Click again");
  });

  it("says WebGL is unavailable when the canvas cannot be constructed", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const modal = new SimModal();
    modal.setProvider(() => null);
    failNextConstruct = true;
    await modal.open();
    const status = document.body.children[0]!.querySelector(".sim-status")!;
    expect(status.textContent).toContain("3D rendering is not available");
    expect(canvasInstances).toHaveLength(0);
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

  it("offers an electronics toggle only when there is something to show", async () => {
    const { document } = installDom();
    const { SimModal } = await import("../../../src/view/sim-modal.js");
    const modal = new SimModal() as any;
    modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);

    // Nothing placed: a switch for an empty layer is a puzzle, not a control.
    expect(modal.elecControl.hidden).toBe(true);

    modal.setTraces([{ kind: "pwr", tris: [] }]);
    expect(modal.elecControl.hidden).toBe(false);
    expect(modal.showElectronics).toBe(true);

    modal.elecToggle.checked = false;
    modal.elecToggle.dispatch("change", {});
    expect(modal.showElectronics).toBe(false);

    modal.setTraces([]);
    expect(modal.elecControl.hidden).toBe(true);
  });
});
