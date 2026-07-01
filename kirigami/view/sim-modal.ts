import type { KirigamiState } from "../model/types.js";
import { buildFoldScene } from "../sim/index.js";
import type { SimCanvas } from "./sim-canvas.js";

/** Returns the current model state when the simulation opens; null when inputs are invalid. */
export type SimStateProvider = () => KirigamiState | null;

/**
 * "3D Sim" trigger + modal hosting the Three.js fold simulation (`SimCanvas`). Opening builds a
 * fold world from the current state and starts the solver; closing stops the loop (the WebGL
 * context is kept and reused). "Reset fold" rebuilds the world from the latest state.
 *
 * The canvas is constructed lazily on first open, after the overlay is shown, so its mount has
 * layout (non-zero size) when Three.js reads the dimensions.
 */
export class SimModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly mount: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly foldSlider: HTMLInputElement;
  private readonly foldValue: HTMLElement;
  private provider: SimStateProvider | null = null;
  private canvas: SimCanvas | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "3D Sim";
    this.trigger.addEventListener("click", () => {
      this.open().catch((err) => {
        this.statusEl.textContent = "Failed to load the 3D viewer.";
        console.error(err);
      });
    });

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal" role="dialog" aria-modal="true" aria-label="3D fold simulation">
        <header class="sim-modal-header">
          <span class="sim-modal-title">3D fold simulation</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body">
          <div class="sim-canvas-mount"></div>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status"></span>
          <label class="sim-fold-control">
            Fold <span class="sim-fold-value">100%</span>
            <input type="range" class="sim-fold-slider" min="0" max="100" step="1" value="100" />
          </label>
          <button type="button" class="sim-reset-btn">Reset fold</button>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.mount = this.overlay.querySelector(".sim-canvas-mount")!;
    this.statusEl = this.overlay.querySelector(".sim-status")!;
    this.foldSlider = this.overlay.querySelector(".sim-fold-slider")!;
    this.foldValue = this.overlay.querySelector(".sim-fold-value")!;

    this.foldSlider.addEventListener("input", () => this.applyFold());

    this.overlay
      .querySelector(".sim-modal-close")!
      .addEventListener("click", () => this.close());
    this.overlay
      .querySelector(".sim-reset-btn")!
      .addEventListener("click", () => this.loadWorld());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (!this.overlay.hidden && e.key === "Escape") this.close();
    });
  }

  /** Mount the "3D Sim" trigger button into a container. */
  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  /** Supply the current model state; called each time the simulation opens or resets. */
  setProvider(provider: SimStateProvider): void {
    this.provider = provider;
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    // Lazy-load Three.js (and the canvas) only on first open, so it stays out of the
    // initial app bundle. Construct after the overlay is shown so the mount has layout.
    if (!this.canvas) {
      this.statusEl.textContent = "Loading 3D viewer…";
      const { SimCanvas } = await import("./sim-canvas.js");
      if (this.overlay.hidden) return; // user closed before it finished loading
      this.canvas = new SimCanvas(this.mount);
    }
    this.loadWorld();
  }

  close(): void {
    this.overlay.hidden = true;
    this.canvas?.stop();
  }

  private loadWorld(): void {
    const state = this.provider?.() ?? null;
    if (!state) {
      this.statusEl.textContent =
        "Inputs are invalid — adjust the parameters, then reopen.";
      this.canvas?.stop();
      return;
    }
    if (!this.canvas) return;
    this.canvas.setScene(buildFoldScene(state));
    this.applyFold(); // honour the slider's current value for this scene
    this.canvas.start();
    const n = Math.round(state.inputs.edgeCount);
    this.statusEl.textContent = `Folding N=${n} pyramid — apex rises to H=${state.H.toFixed(0)} mm. Drag to orbit.`;
  }

  /** Push the slider value to the canvas and update the readout. */
  private applyFold(): void {
    const pct = Number(this.foldSlider.value);
    this.foldValue.textContent = `${pct}%`;
    this.canvas?.setFoldPercent(pct / 100);
  }
}
