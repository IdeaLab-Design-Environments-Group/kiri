import type { SvgExportPayload } from "../model/fkld-svg-export.js";
import { DEFAULT_PRINT_SIZE, type StlExport } from "../model/stl-export.js";

/** Returns the export payload for the current pattern when the modal opens, or null if none. */
export type ExportProvider = () => SvgExportPayload | null;
/**
 * Builds the STL (3D-printed tiles) at the given tile height (mm), adaptive-detail cap, and printable
 * sheet size (mm, longest flat dimension — the flat pattern has no inherent scale). Nulls → defaults.
 */
export type StlProvider = (heightUnits: number | null, maxSubdiv: number | null, printSizeMm: number | null) => StlExport | null;

/**
 * "Export SVG" trigger + modal for vinyl/Cricut cutting. Opening pulls a fresh {@link SvgExportPayload}
 * from the provider, shows cut / score / both previews, and offers the registered
 * **ZIP** of cut, score and combined SVGs (assign black=Cut, blue=Score in Design Space), plus the STL tiles.
 * Mirrors `SimModal`'s trigger/provider/enabled lifecycle.
 */
export class ExportModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly previews: { cut: HTMLElement; score: HTMLElement; both: HTMLElement };
  private readonly zipBtn: HTMLButtonElement;
  private readonly stlBtn: HTMLButtonElement;
  private readonly stlSizeInput: HTMLInputElement;
  private printSizeHandler: (mm: number) => void = () => {};
  private readonly stlHeightInput: HTMLInputElement;
  private readonly stlHeightUnit: HTMLElement;
  private provider: ExportProvider | null = null;
  private stlProvider: StlProvider | null = null;
  private payload: SvgExportPayload | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Export";
    this.trigger.disabled = true;
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal" role="dialog" aria-modal="true" aria-label="export pattern and mesh">
        <header class="sim-modal-header">
          <span class="sim-modal-title">Export — SVG (cut + score) · STL (3D-printed tiles)</span>
          <button type="button" class="sim-modal-close" aria-label="close">×</button>
        </header>
        <div class="sim-modal-body">
          <div class="export-previews">
            <figure><figcaption>Cut</figcaption><div class="export-preview" data-k="cut"></div></figure>
            <figure><figcaption>Score</figcaption><div class="export-preview" data-k="score"></div></figure>
            <figure><figcaption>Both</figcaption><div class="export-preview" data-k="both"></div></figure>
          </div>
        </div>
        <footer class="sim-modal-footer export-footer">
          <span class="sim-status" role="status"></span>
          <div class="export-group export-group-tiles" role="group" aria-label="3D tiles">
            <span class="export-group-title">3D tiles</span>
            <label class="export-stl-height-label" title="printable sheet size — longest dimension of the flat pattern.">size
              <input type="number" class="export-stl-size" min="1" step="1" />
              <span>mm</span>
            </label>
            <label class="export-stl-height-label">height
              <input type="number" class="export-stl-height" min="0" step="0.1" />
              <span class="export-stl-unit">units</span>
            </label>
            <button type="button" class="export-stl-btn">tiles (STL)</button>
          </div>
          <div class="export-group export-group-cut" role="group" aria-label="Cut files">
            <span class="export-group-title">Cut files</span>
            <button type="button" class="export-zip-btn">cut + score + combined (zip)</button>
          </div>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.statusEl = this.overlay.querySelector(".sim-status")!;
    this.previews = {
      cut: this.overlay.querySelector('[data-k="cut"]')!,
      score: this.overlay.querySelector('[data-k="score"]')!,
      both: this.overlay.querySelector('[data-k="both"]')!,
    };
    this.zipBtn = this.overlay.querySelector(".export-zip-btn")!;
    this.stlBtn = this.overlay.querySelector(".export-stl-btn")!;
    this.stlSizeInput = this.overlay.querySelector(".export-stl-size")!;
    // Announce edits as they happen: the copper is planned and cut at this size, so it must not go stale.
    this.stlSizeInput.addEventListener("change", () => this.printSizeHandler(this.printSizeMm()));
    this.stlHeightInput = this.overlay.querySelector(".export-stl-height")!;
    this.stlHeightUnit = this.overlay.querySelector(".export-stl-unit")!;

    this.zipBtn.addEventListener("click", () => this.downloadZip());
    this.stlBtn.addEventListener("click", () => this.downloadStl());
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (!this.overlay.hidden && e.key === "Escape") this.close();
    });
  }

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setProvider(provider: ExportProvider): void {
    this.provider = provider;
  }

  setStlProvider(provider: StlProvider): void {
    this.stlProvider = provider;
  }

  /**
   * Register a handler told whenever the print size changes.
   *
   * The size is not the STL's alone: the cut, score and copper layers are all cut at it, and the router
   * plans to it, so everything downstream has to hear about an edit rather than reading it at download time.
   */
  onPrintSize(handler: (mm: number) => void): void {
    this.printSizeHandler = handler;
  }

  /** The print size currently in the box, or the default when it is empty or nonsense. */
  printSizeMm(): number {
    const raw = parseFloat(this.stlSizeInput.value);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRINT_SIZE;
  }

  /** Enable/disable the Export button (only when there's a cuttable pattern on screen). */
  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  open(): void {
    this.payload = this.provider?.() ?? null;
    // Probe the STL at the model's defaults to prefill the menu inputs and enable the button.
    if (!this.stlSizeInput.value) this.stlSizeInput.value = String(DEFAULT_PRINT_SIZE);
    const probeSize = parseFloat(this.stlSizeInput.value) || DEFAULT_PRINT_SIZE;
    const stlDefault = this.stlProvider?.(null, null, probeSize) ?? null;
    this.stlBtn.disabled = !stlDefault; // the tiles export independently of the cut pattern
    if (stlDefault) {
      this.stlHeightInput.value = String(Math.round(stlDefault.height * 100) / 100);
      this.stlHeightUnit.textContent = stlDefault.unit;
    }
    this.overlay.hidden = false;
    this.writePreviews();
  }

  /**
   * Re-run the provider and rewrite the SVG previews, for when something they depend on (the print
   * size) changed while the modal is open. Debounced because planning is synchronous and slow on big
   * boards; a no-op while the modal is closed.
   */
  refreshPreviews(delayMs = 250): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.overlay.hidden) return;
      this.payload = this.provider?.() ?? null;
      this.writePreviews();
    }, delayMs);
  }

  private writePreviews(): void {
    if (!this.payload) {
      this.previews.cut.innerHTML = this.previews.score.innerHTML = this.previews.both.innerHTML = "";
      this.statusEl.textContent = this.stlBtn.disabled
        ? "No pattern to export — load a model and press Cut & fold first."
        : "No cut pattern, but the 3D-printed tiles are exportable as STL.";
      this.zipBtn.disabled = true;
      return;
    }
    this.previews.cut.innerHTML = this.payload.previews.cut;
    this.previews.score.innerHTML = this.payload.previews.score;
    this.previews.both.innerHTML = this.payload.previews.both;
    this.zipBtn.disabled = false;
    this.statusEl.textContent =
      "black = Cut, blue = Score. The zip holds cut, score and combined SVGs (registered, in mm); import the cut and score ones and set the layer ops.";
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private downloadZip(): void {
    if (!this.payload) return;
    download(this.payload.archive.filename, new Blob([this.payload.archive.bytes], { type: "application/zip" }));
  }

  private downloadStl(): void {
    const rawH = parseFloat(this.stlHeightInput.value);
    const height = Number.isFinite(rawH) && rawH > 0 ? rawH : null; // null → builder's default
    const rawS = parseFloat(this.stlSizeInput.value);
    const size = Number.isFinite(rawS) && rawS > 0 ? rawS : null; // null → builder's print-size default
    const stl = this.stlProvider?.(height, null, size) ?? null;
    if (!stl) return;
    download(stl.filename, new Blob([stl.text], { type: "model/stl" }));
  }
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
