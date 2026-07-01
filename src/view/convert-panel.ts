/**
 * **View** — the "Convert via Kirigamizer" column: a file dropzone, a status
 * line, and the "Derived" facts list. Dumb: it renders what it's told
 * (`renderFacts`, `setStatus`) and emits a single intent — a chosen file —
 * via `onFileChosen`. No parsing, no app state.
 */
import type { StatusKind } from "../model/app-store.js";
import { el, heading, renderDefinitionList } from "./dom.js";

export class ConvertPanel {
  readonly element: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly derivedList: HTMLDListElement;
  private readonly derivedEmpty: HTMLElement;
  private fileHandler: (file: File) => void = () => {};

  constructor() {
    this.element = el("section", "column convert-column");
    const panel = el("div", "panel");
    panel.append(heading("h2", "Convert via Kiro"));

    const dropzone = el("label", "dropzone") as HTMLLabelElement;
    const fileInput = el("input", "") as HTMLInputElement;
    fileInput.type = "file";
    fileInput.accept = ".fold,.fkld,.json,.obj,.stl";
    fileInput.hidden = true;
    const dzMain = el("span", "dropzone-main");
    dzMain.textContent = "Drop your model here";
    const dzHint = el("span", "hint");
    dzHint.innerHTML =
      "or click to choose — <code>.fold</code> · <code>.fkld</code> · <code>.obj</code> · <code>.stl</code>";
    dropzone.append(fileInput, dzMain, dzHint);
    panel.append(dropzone);

    this.statusEl = el("p", "status");
    this.statusEl.textContent = "No model loaded.";
    panel.append(this.statusEl);

    const derived = el("div", "derived");
    derived.append(heading("h3", "Derived"));
    this.derivedList = el("dl", "derived-list") as HTMLDListElement;
    this.derivedEmpty = el("p", "fkld-meta-empty");
    this.derivedEmpty.textContent = "Load a model to see its facts.";
    derived.append(this.derivedList, this.derivedEmpty);
    panel.append(derived);

    this.element.append(panel);

    // ---- intent wiring: dropzone / input / drag-and-drop → fileHandler ----
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) this.fileHandler(f);
    });
    (["dragenter", "dragover"] as const).forEach((t) =>
      dropzone.addEventListener(t, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      }),
    );
    (["dragleave", "drop"] as const).forEach((t) =>
      dropzone.addEventListener(t, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      }),
    );
    dropzone.addEventListener("drop", (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) this.fileHandler(f);
    });
  }

  /** Register the handler invoked when the user chooses/drops a file. */
  onFileChosen(handler: (file: File) => void): void {
    this.fileHandler = handler;
  }

  setStatus(msg: string, kind: StatusKind = ""): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = "status" + (kind ? " " + kind : "");
  }

  renderFacts(rows: [string, string][]): void {
    renderDefinitionList(this.derivedList, rows);
    this.derivedEmpty.hidden = rows.length > 0;
  }
}
