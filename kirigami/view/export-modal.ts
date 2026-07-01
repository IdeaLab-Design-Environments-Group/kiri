import type {
  CricutSvgFile,
  ExportArchive,
  ExportPayload,
} from "../model/svg-export.js";
import type { FkldDownload } from "../model/fkld-export.js";

/** Returns the current export payload (previews + archive) when the modal opens. */
export type ExportProvider = () => ExportPayload | null;

/**
 * Export submenu: an "Export" trigger button plus a modal overlay (header / body / footer)
 * styled after the app's dialogs. The body shows three previews — cut, score, and both
 * overlaid — and offers two downloads: "Cut + score (zip)" packs the separate cut and
 * score SVGs in one folder, while "Single SVG" downloads one colour-coded file (black =
 * cut, blue = score) for slicebug / single-import Cricut workflows. The cut layer holds the
 * outline, the major cut, and the minor relief slits (the slits sit a small gap from the
 * outline so they stay separate lines).
 */
export class ExportModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private provider: ExportProvider | null = null;
  private archive: ExportArchive | null = null;
  private combined: CricutSvgFile | null = null;
  private fkld: FkldDownload | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "export-trigger";
    this.trigger.textContent = "Export";
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "export-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="export-modal" role="dialog" aria-modal="true" aria-label="Export">
        <header class="export-modal-header">
          <span class="export-modal-title">Export</span>
          <button type="button" class="export-modal-close" aria-label="Close">×</button>
        </header>
        <div class="export-modal-body">
          <div class="export-squares">
            <figure class="export-preview">
              <div class="export-square" data-preview="cut"></div>
              <figcaption>Cut</figcaption>
            </figure>
            <figure class="export-preview">
              <div class="export-square" data-preview="score"></div>
              <figcaption>Score</figcaption>
            </figure>
            <figure class="export-preview">
              <div class="export-square" data-preview="both"></div>
              <figcaption>Both</figcaption>
            </figure>
          </div>
        </div>
        <footer class="export-modal-footer">
          <button type="button" class="export-svg-btn export-svg-btn--secondary export-fkld-btn">FKLD (.fkld)</button>
          <button type="button" class="export-svg-btn export-svg-btn--secondary export-single-btn">Single SVG</button>
          <button type="button" class="export-svg-btn">Cut + score (zip)</button>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.overlay
      .querySelector(".export-modal-close")!
      .addEventListener("click", () => this.close());
    this.overlay
      .querySelector(".export-svg-btn:not(.export-single-btn):not(.export-fkld-btn)")!
      .addEventListener("click", () => this.exportSvg());
    this.overlay
      .querySelector(".export-single-btn")!
      .addEventListener("click", () => this.exportCombined());
    this.overlay
      .querySelector(".export-fkld-btn")!
      .addEventListener("click", () => this.exportFkld());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (!this.overlay.hidden && e.key === "Escape") this.close();
    });
  }

  /** Mount the "Export" trigger button into a container. */
  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  /** Supply the current export payload; called each time the modal opens. */
  setProvider(provider: ExportProvider): void {
    this.provider = provider;
  }

  open(): void {
    this.renderPreviews(this.provider?.() ?? null);
    this.overlay.hidden = false;
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private renderPreviews(payload: ExportPayload | null): void {
    const set = (key: string, svg: string): void => {
      const el = this.overlay.querySelector(`[data-preview="${key}"]`);
      if (el) el.innerHTML = svg;
    };
    set("cut", payload?.previews.cut ?? "");
    set("score", payload?.previews.score ?? "");
    set("both", payload?.previews.both ?? "");
    this.archive = payload?.archive ?? null;
    this.combined = payload?.combined ?? null;
    this.fkld = payload?.fkld ?? null;

    const zipBtn = this.overlay.querySelector(
      ".export-svg-btn:not(.export-single-btn):not(.export-fkld-btn)",
    ) as HTMLButtonElement | null;
    if (zipBtn) zipBtn.disabled = this.archive === null;

    const singleBtn = this.overlay.querySelector(
      ".export-single-btn",
    ) as HTMLButtonElement | null;
    if (singleBtn) singleBtn.disabled = this.combined === null;

    const fkldBtn = this.overlay.querySelector(
      ".export-fkld-btn",
    ) as HTMLButtonElement | null;
    if (fkldBtn) fkldBtn.disabled = this.fkld === null;
  }

  private exportSvg(): void {
    if (!this.archive) return;
    downloadBlob(this.archive.filename, this.archive.bytes, "application/zip");
    this.close();
  }

  private exportCombined(): void {
    if (!this.combined) return;
    downloadBlob(this.combined.filename, this.combined.svg, "image/svg+xml");
    this.close();
  }

  private exportFkld(): void {
    if (!this.fkld) return;
    downloadBlob(this.fkld.filename, this.fkld.text, "application/json");
    this.close();
  }
}

function downloadBlob(filename: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
