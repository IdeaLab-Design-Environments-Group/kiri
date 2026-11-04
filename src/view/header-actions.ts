/**
 * **View** — the header action bar: "Cut & fold", plus a slot for the page triggers mounted before it.
 * Emits the `onKirigamize` intent and exposes `setKirigamizeEnabled`; it holds no app state.
 *
 * "Load sample" used to sit between the two. It fetched `public/examples/house.fkld` -- the same file
 * the viewer's own one-entry Example dropdown pointed at -- so the header and the viewer's toolbar
 * carried the same action twice. The button now lives in the viewer, where that dropdown was.
 *
 * "Create pyramid" sat before "Cut & fold" and made the one AKDE pyramid. It was removed: a single fixed
 * pattern did not earn a header button, and the bundled examples cover trying the simulator and router.
 */
import { el } from "./dom.js";
import { applyHeaderCopy } from "./header-copy.js";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.kirigamizeBtn = el("button", "export-trigger") as HTMLButtonElement;
    this.kirigamizeBtn.type = "button";
    this.kirigamizeBtn.textContent = "Cut & fold";
    this.kirigamizeBtn.disabled = true;
  }

  /**
   * Append the action buttons. Call *after* any earlier triggers (e.g. the
   * 3D-Sim button) have been mounted into `element`, to preserve their order:
   * [3D Sim] … [Cut & fold].
   */
  appendActionButtons(): void {
    this.element.append(this.kirigamizeBtn);
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeBtn.addEventListener("click", () => handler());
  }

  setKirigamizeEnabled(enabled: boolean, busy = false): void {
    this.kirigamizeBtn.disabled = !enabled;
    this.kirigamizeBtn.setAttribute("aria-busy", String(busy));
    applyHeaderCopy(this.element);
  }
}
