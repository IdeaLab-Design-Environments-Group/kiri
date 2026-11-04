/**
 * **View** — the "Model" column: a file dropzone, a status line, the "Cut & fold" button and the "Derived"
 * facts list. Dumb: it renders what it's told (`renderFacts`, `setStatus`, `setCutAndFold`) and emits two
 * intents, a chosen file (`onFileChosen`) and "cut and fold this" (`onCutAndFold`). No parsing, no app state.
 *
 * "Cut & fold" sits here, under the file it acts on, and not in the header. The header is for going to
 * things (Simulate, Electronics, Export, Examples, Tutorials); this is the one action on the model itself,
 * so it belongs next to the model, and it said "press Cut & fold" in this column while the button was across
 * the screen. It is enabled only for a 3D mesh: a `.fkld` is already a pattern and there is nothing to cut.
 */
import type { StatusKind } from "../model/app-store.js";
import { el, heading, renderDefinitionList } from "./dom.js";

/** What the Cut & fold button shows: whether it can be pressed, and the one line saying why or what it does. */
export interface CutAndFoldState {
  enabled: boolean;
  busy?: boolean;
  hint: string;
}

export class ConvertPanel {
  readonly element: HTMLElement;
  private readonly cutBtn: HTMLButtonElement;
  private readonly cutHint: HTMLElement;
  private cutHandler: () => void = () => {};
  private readonly statusEl: HTMLElement;
  private readonly derivedList: HTMLDListElement;
  private readonly derivedEmpty: HTMLElement;
  private fileHandler: (file: File) => void = () => {};

  constructor() {
    this.element = el("section", "column convert-column");
    const panel = el("div", "panel");
    panel.append(heading("h2", "Model"));

    const dropzone = el("label", "dropzone") as HTMLLabelElement;
    const fileInput = el("input", "") as HTMLInputElement;
    fileInput.type = "file";
    fileInput.accept = ".fold,.fkld,.json,.obj,.stl";
    fileInput.hidden = true;
    const dzMain = el("span", "dropzone-main");
    dzMain.textContent = "drop your model here";
    const dzHint = el("span", "hint");
    dzHint.innerHTML =
      "or click to choose — <code>.fold</code> · <code>.fkld</code> · <code>.obj</code> · <code>.stl</code>";
    dropzone.append(fileInput, dzMain, dzHint);
    panel.append(dropzone);

    this.statusEl = el("p", "status");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.textContent = "no model loaded.";
    panel.append(this.statusEl);

    this.cutBtn = el("button", "export-trigger convert-cut") as HTMLButtonElement;
    this.cutBtn.type = "button";
    this.cutBtn.textContent = "Cut & fold";
    this.cutBtn.disabled = true;
    this.cutBtn.addEventListener("click", () => this.cutHandler());
    this.cutHint = el("p", "cut-hint");
    this.cutHint.textContent = "Load a 3D model (.obj or .stl) to turn it into a pattern.";
    panel.append(this.cutBtn, this.cutHint);

    // Collapsed: the table is for someone checking a file; the file name is already in the status line above.
    const derived = el("details", "derived");
    const derivedSummary = el("summary", "derived-summary");
    derivedSummary.textContent = "File details";
    derived.append(derivedSummary);
    this.derivedList = el("dl", "derived-list") as HTMLDListElement;
    this.derivedEmpty = el("p", "fkld-meta-empty");
    this.derivedEmpty.textContent = "load a model to see its facts.";
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

  /** Register what "Cut & fold" does. One handler: the controller gives it the pipeline. */
  onCutAndFold(handler: () => void): void {
    this.cutHandler = handler;
  }

  /** Enable or disable "Cut & fold", and say in one line what it does or why it cannot be pressed. */
  setCutAndFold(state: CutAndFoldState): void {
    this.cutBtn.disabled = !state.enabled;
    this.cutBtn.setAttribute("aria-busy", String(state.busy === true));
    this.cutHint.textContent = state.hint;
    this.cutBtn.title = state.hint;
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
