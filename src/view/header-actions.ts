/**
 * **View** — the header action bar: "Create pyramid" and "cut&fold ▶", plus a slot for the page
 * triggers mounted before them. Emits intents (`onCreatePyramid`, `onKirigamize`) and exposes
 * `setKirigamizeEnabled`; it holds no app state.
 *
 * "Load sample" used to sit between the two. It fetched `public/examples/house.fkld` -- the same file
 * the viewer's own one-entry Example dropdown pointed at -- so the header and the viewer's toolbar
 * carried the same action twice. The button now lives in the viewer, where that dropdown was.
 */
import { el } from "./dom.js";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.createBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.createBtn.type = "button";
    this.createBtn.textContent = "create pyramid";
    this.kirigamizeBtn = el("button", "export-trigger") as HTMLButtonElement;
    this.kirigamizeBtn.type = "button";
    this.kirigamizeBtn.textContent = "cut&fold ▶";
    this.kirigamizeBtn.disabled = true;
  }

  /**
   * Append the action buttons. Call *after* any earlier triggers (e.g. the
   * 3D-Sim button) have been mounted into `element`, to preserve their order:
   * [3D Sim] … [Create pyramid] [cut&fold ▶].
   */
  appendActionButtons(): void {
    this.element.append(this.createBtn, this.kirigamizeBtn);
  }

  /** Generate an AKDE pyramid from the transferred creation pipeline. */
  onCreatePyramid(handler: () => void): void {
    this.createBtn.addEventListener("click", handler);
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeBtn.addEventListener("click", () => handler());
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.kirigamizeBtn.disabled = !enabled;
  }
}
