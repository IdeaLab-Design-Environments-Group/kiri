import type { StlExport } from "../model/stl-export.js";

/** A 3D drawing of the STL tiles, mounted in the Export dialog. `show` replaces what is drawn. */
export interface TilePreviewView {
  show(stlText: string): void;
  /** Free the renderer and take its canvas out of the page. */
  dispose(): void;
}
/** Makes a viewer inside `mount`. May throw, typically when WebGL cannot start. */
export type TilePreviewFactory = (mount: HTMLElement) => TilePreviewView;
/** Fetches the viewer's code, which is kept out of the main bundle (it carries three.js). */
export type TilePreviewLoader = () => Promise<TilePreviewFactory>;

/** How long the boxes must be still before the tiles are rebuilt: building the STL is synchronous. */
const REBUILD_DELAY_MS = 300;

/**
 * When the Export dialog's 3D tile preview is built, redrawn and thrown away.
 *
 * Nothing is built unless the dialog is open, the collapsible section is expanded, and there are tiles. Edits
 * to the boxes are debounced into one rebuild; a rebuild still waiting when the section collapses or the dialog
 * closes is dropped, and so is a viewer whose code arrives after that. Closing frees the renderer, so a WebGL
 * context is held only while the picture is on screen. The drawing itself is the loader's business.
 */
export class TilePreviewSection {
  private loader: TilePreviewLoader | null = null;
  private view: TilePreviewView | null = null;
  /** Bumped whenever what was asked for is withdrawn, so a late answer can tell it is no longer wanted. */
  private generation = 0;
  /** The generation a viewer is being fetched for, or null when none is. */
  private loadingFor: number | null = null;
  /** The newest STL to draw, kept so a viewer that is still loading draws that and not an older one. */
  private latest: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor(
    private readonly section: HTMLDetailsElement,
    private readonly mount: HTMLElement,
    private readonly build: () => StlExport | null,
  ) {
    section.addEventListener("toggle", () => {
      if (this.section.open) this.schedule(0);
      else this.withdraw();
    });
  }

  setLoader(loader: TilePreviewLoader): void {
    this.loader = loader;
  }

  /** The dialog opened with `stl` already built (the probe that prefills the boxes): draw it, if anything is wanted. */
  open(stl: StlExport | null): void {
    this.active = true;
    this.section.hidden = !stl || !this.loader;
    if (stl && this.wanted()) this.show(stl.text);
  }

  /** A box the tiles depend on changed: rebuild once it has been still for a moment. */
  schedule(delayMs = REBUILD_DELAY_MS): void {
    this.cancelTimer();
    if (!this.wanted()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.wanted()) return;
      const stl = this.build();
      if (stl) this.show(stl.text);
    }, delayMs);
  }

  close(): void {
    this.active = false;
    this.withdraw();
  }

  private wanted(): boolean {
    return this.active && this.section.open && !this.section.hidden;
  }

  private show(text: string): void {
    this.latest = text;
    if (this.view) {
      this.view.show(text);
      return;
    }
    if (!this.loader || this.loadingFor === this.generation) return;
    const asked = this.generation;
    this.loadingFor = asked;
    const fail = (err: unknown): void => {
      const reason = String((err as Error)?.message ?? err).replace(/\.$/, "");
      this.mount.textContent = `The 3D preview is not available in this browser (${reason}).`;
    };
    this.loader().then(
      (factory) => {
        if (asked !== this.generation) return;
        this.loadingFor = null;
        if (!this.wanted()) return;
        try {
          this.view = factory(this.mount);
        } catch (err) {
          fail(err);
          return;
        }
        if (this.latest !== null) this.view.show(this.latest);
      },
      (err) => {
        if (asked !== this.generation) return;
        this.loadingFor = null;
        fail(err);
      },
    );
  }

  /** Drop any pending rebuild, any viewer still loading, and the viewer on screen. */
  private withdraw(): void {
    this.cancelTimer();
    this.generation++;
    this.loadingFor = null;
    this.latest = null;
    this.view?.dispose();
    this.view = null;
    this.mount.textContent = "";
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
