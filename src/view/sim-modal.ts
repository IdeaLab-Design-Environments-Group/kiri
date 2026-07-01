import type { FoldScene, SimMaterial } from "../sim/index.js";
import { DEFAULT_MAX_SUBDIV, TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import type { SimCanvas } from "./sim-canvas.js";

/** Returns a ready fold scene when the sim opens, or null when no model is loaded. */
export type SimSceneProvider = () => { scene: FoldScene; title: string } | null;

/**
 * "3D Sim" trigger + modal hosting the Three.js fold simulation. Opening
 * builds the scene from the current model and starts the CPU solver; the
 * fold slider scrubs `foldPercent` 0→1; "Reset fold" rebuilds from the
 * current model. The canvas (and Three.js) load lazily on first open.
 */
export class SimModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly mount: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly foldSlider: HTMLInputElement;
  private readonly foldValue: HTMLElement;
  private readonly detailControl: HTMLElement;
  private readonly detailSlider: HTMLInputElement;
  private readonly detailValue: HTMLElement;
  private readonly gapControl: HTMLElement;
  private readonly gapSlider: HTMLInputElement;
  private readonly gapValue: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private provider: SimSceneProvider | null = null;
  private canvas: SimCanvas | null = null;
  private material: SimMaterial = "vinyl";
  private detail = DEFAULT_MAX_SUBDIV;
  private gap = TILE_INSET_FRAC;
  private materialListener: ((m: SimMaterial) => void) | null = null;
  private detailListener: ((d: number) => void) | null = null;
  private gapListener: ((g: number) => void) | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "3D Sim";
    this.trigger.disabled = true;
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
          <div class="sim-tabs" role="tablist">
            <button type="button" class="sim-tab is-active" data-material="vinyl" role="tab" aria-selected="true">Vinyl / paper</button>
            <button type="button" class="sim-tab" data-material="printed" role="tab" aria-selected="false">3D-printed</button>
          </div>
          <div class="sim-canvas-mount"></div>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status"></span>
          <label class="sim-fold-control sim-detail-control" title="More tile subdivision on harder-folding faces. Level 0 = 1 subdivision; 4 = 5. Matches the STL export.">
            Detail <span class="sim-detail-value">0</span>
            <input type="range" class="sim-detail-slider" min="0" max="4" step="1" value="0" />
          </label>
          <label class="sim-fold-control sim-gap-control" title="Width of the bare-hinge gaps between the printed tiles (tile shrink toward its centroid). Matches the STL export.">
            Gap <span class="sim-gap-value">16%</span>
            <input type="range" class="sim-gap-slider" min="2" max="45" step="1" value="16" />
          </label>
          <label class="sim-fold-control">
            Fold <span class="sim-fold-value">0%</span>
            <input type="range" class="sim-fold-slider" min="0" max="100" step="1" value="0" />
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
    this.detailControl = this.overlay.querySelector(".sim-detail-control")!;
    this.detailSlider = this.overlay.querySelector(".sim-detail-slider")!;
    this.detailValue = this.overlay.querySelector(".sim-detail-value")!;
    this.gapControl = this.overlay.querySelector(".sim-gap-control")!;
    this.gapSlider = this.overlay.querySelector(".sim-gap-slider")!;
    this.gapValue = this.overlay.querySelector(".sim-gap-value")!;
    this.tabs = Array.from(this.overlay.querySelectorAll<HTMLButtonElement>(".sim-tab[data-material]"));
    for (const tab of this.tabs) {
      tab.addEventListener("click", () => this.selectMaterial(tab.dataset.material as SimMaterial));
    }

    this.foldSlider.addEventListener("input", () => this.applyFold());
    this.detailSlider.addEventListener("input", () => this.applyDetail());
    this.gapSlider.addEventListener("input", () => this.applyGap());
    this.syncDetailVisibility();
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.querySelector(".sim-reset-btn")!.addEventListener("click", () => this.loadWorld());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if (e.key === "Escape") this.close();
    });
  }

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setProvider(provider: SimSceneProvider): void {
    this.provider = provider;
  }

  /** Notified when the user switches the Vinyl / 3D-printed tab (controller stores it). */
  onMaterialChange(cb: (m: SimMaterial) => void): void {
    this.materialListener = cb;
  }

  /** Notified when the user changes the adaptive-detail slider (controller stores it; export shares it). */
  onDetailChange(cb: (d: number) => void): void {
    this.detailListener = cb;
  }

  /** Notified when the user changes the gap slider (controller stores it; the STL export shares it). */
  onGapChange(cb: (g: number) => void): void {
    this.gapListener = cb;
  }

  /** Switch the sim material tab: update state, then rebuild (fold % preserved). */
  private selectMaterial(m: SimMaterial): void {
    this.setMaterialTabsActive(m);
    if (m === this.material) return;
    this.material = m;
    this.syncDetailVisibility(); // detail only affects the 3D-printed tiles
    this.materialListener?.(m); // update the store before rebuilding so the provider sees the new material
    if (this.canvas) this.loadWorld();
  }

  private setMaterialTabsActive(m: SimMaterial): void {
    for (const tab of this.tabs) {
      const on = tab.dataset.material === m;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
    }
  }

  /** Detail and gap only matter for 3D-printed tiles — hide both in vinyl/paper mode. */
  private syncDetailVisibility(): void {
    const hidden = this.material !== "printed";
    this.detailControl.hidden = hidden;
    this.gapControl.hidden = hidden;
  }

  private applyDetail(): void {
    this.detail = Number(this.detailSlider.value);
    this.detailValue.textContent = String(this.detail);
    this.canvas?.setTileDetail(this.detail);
    this.detailListener?.(this.detail);
  }

  private applyGap(): void {
    this.gap = Number(this.gapSlider.value) / 100; // slider shows a %, stored as the corner→centroid shrink fraction
    this.gapValue.textContent = `${this.gapSlider.value}%`;
    this.canvas?.setTileGap(this.gap);
    this.gapListener?.(this.gap);
  }

  /** Enable/disable the 3D Sim button (e.g. only when a foldable model is loaded). */
  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    if (!this.canvas) {
      this.statusEl.textContent = "Loading 3D viewer…";
      const { SimCanvas } = await import("./sim-canvas.js");
      if (this.overlay.hidden) return;
      this.canvas = new SimCanvas(this.mount);
    }
    this.loadWorld();
  }

  close(): void {
    this.overlay.hidden = true;
    this.canvas?.stop();
  }

  private loadWorld(): void {
    const built = this.provider?.() ?? null;
    if (!built) {
      this.statusEl.textContent = "No foldable model — load a FOLD/FKLD crease pattern, then reopen.";
      this.canvas?.stop();
      return;
    }
    if (!this.canvas) return;
    try {
      this.canvas.setScene(built.scene);
      this.canvas.setTileDetail(this.detail); // honor the current adaptive-detail setting
      this.canvas.setTileGap(this.gap); // …and the current gap width
      this.syncDetailVisibility();
      this.applyFold();
      this.canvas.warmToTarget();
      this.canvas.start();
      const { net } = built.scene;
      const shell = net.meta.N > 0 && net.faces.length === 7 * net.meta.N;
      const triLabel = shell
        ? `${net.faces.length} tris (${net.meta.N}-tri shell at full fold)`
        : `${net.faces.length} tris`;
      this.statusEl.textContent =
        `Folding ${built.title} — ${net.vertices.length} verts, ${triLabel}, ` +
        `${built.scene.model.creases.count} creases. Drag to orbit.`;
    } catch (err) {
      this.statusEl.textContent = `Cannot simulate this model: ${(err as Error).message}`;
      this.canvas.stop();
    }
  }

  private applyFold(): void {
    const pct = Number(this.foldSlider.value);
    this.foldValue.textContent = `${pct}%`;
    this.canvas?.setFoldPercent(pct / 100);
  }
}
