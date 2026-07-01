/**
 * **View** — the header action bar: "Create pyramid", "Load sample" and
 * "Kirigamize ▶" buttons, plus a slot for the 3D-Sim trigger. Emits intents
 * (`onCreatePyramid`, `onLoadSample`, `onKirigamize`) and exposes
 * `setKirigamizeEnabled`; it holds no app state.
 */
import { el } from "./dom.js";

export class HeaderActions {
  readonly element: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly sampleBtn: HTMLButtonElement;
  private readonly kirigamizeBtn: HTMLButtonElement;

  constructor() {
    this.element = el("div", "header-actions");
    this.createBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.createBtn.type = "button";
    this.createBtn.textContent = "Create pyramid";
    this.sampleBtn = el("button", "sim-trigger") as HTMLButtonElement;
    this.sampleBtn.type = "button";
    this.sampleBtn.textContent = "Load sample";
    this.kirigamizeBtn = el("button", "export-trigger") as HTMLButtonElement;
    this.kirigamizeBtn.type = "button";
    this.kirigamizeBtn.textContent = "Kirigamize ▶";
    this.kirigamizeBtn.disabled = true;
  }

  /**
   * Append the action buttons. Call *after* any earlier triggers (e.g. the
   * 3D-Sim button) have been mounted into `element`, to preserve their order:
   * [3D Sim] [Create pyramid] [Load sample] [Kirigamize ▶].
   */
  appendActionButtons(): void {
    this.element.append(this.createBtn, this.sampleBtn, this.kirigamizeBtn);
  }

  /** Generate an AKDE pyramid from the transferred creation pipeline. */
  onCreatePyramid(handler: () => void): void {
    this.createBtn.addEventListener("click", handler);
  }

  onLoadSample(handler: () => void): void {
    this.sampleBtn.addEventListener("click", handler);
  }

  onKirigamize(handler: () => void): void {
    this.kirigamizeBtn.addEventListener("click", () => handler());
  }

  setKirigamizeEnabled(enabled: boolean): void {
    this.kirigamizeBtn.disabled = !enabled;
  }
}
