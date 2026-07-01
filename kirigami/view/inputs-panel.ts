import type { KirigamiInputs } from "../model/types.js";

export type InputsChangeHandler = () => void;

export interface InputsPanelDerivedField {
  termHtml: string;
  valueText: string;
}

export interface InputsPanelRenderModel {
  derived: InputsPanelDerivedField[];
  apexHeightError: string | null;
  materialThicknessError: string | null;
}

/** Left column: user inputs (N, L, H) and read-only derived quantities. */
export class InputsPanel {
  private readonly root: HTMLElement;
  private readonly changeHandlers: InputsChangeHandler[] = [];
  private edgeCountInput!: HTMLInputElement;
  private edgeLengthInput!: HTMLInputElement;
  private outerEdgeLengthInput!: HTMLInputElement;
  private totalCurvatureInput!: HTMLInputElement;
  private materialThicknessInput!: HTMLInputElement;
  private apexHeightErrorEl!: HTMLElement;
  private materialThicknessErrorEl!: HTMLElement;
  private derivedEl!: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "panel inputs-panel";
    container.appendChild(this.root);
    this.build();
  }

  onChange(handler: InputsChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  getInputs(): KirigamiInputs {
    return {
      edgeCount: Math.max(3, Math.round(Number(this.edgeCountInput.value) || 3)),
      edgeLength: Math.max(0, Number(this.edgeLengthInput.value) || 0),
      outerEdgeLength: Math.max(0, Number(this.outerEdgeLengthInput.value) || 0),
      totalCurvature: Number(this.totalCurvatureInput.value) || 0,
      materialThickness: Number(this.materialThicknessInput.value) || 0,
    };
  }

  setInputs(inputs: KirigamiInputs): void {
    this.edgeCountInput.value = String(inputs.edgeCount);
    this.edgeLengthInput.value = String(inputs.edgeLength);
    this.outerEdgeLengthInput.value = String(
      inputs.outerEdgeLength ?? inputs.edgeLength,
    );
    this.totalCurvatureInput.value = inputs.totalCurvature.toFixed(2);
    this.materialThicknessInput.value = String(inputs.materialThickness);
  }

  render(model: InputsPanelRenderModel): void {
    if (model.derived.length === 0) {
      this.derivedEl.innerHTML = "";
    } else {
      this.derivedEl.innerHTML = `
        <h3>Derived</h3>
        <dl class="derived-list">
          ${model.derived
            .map(
              (field) => `<dt>${field.termHtml}</dt><dd>${field.valueText}</dd>`,
            )
            .join("")}
        </dl>
      `;
    }

    this.applyFieldError(
      this.apexHeightErrorEl,
      this.totalCurvatureInput,
      model.apexHeightError,
    );
    this.applyFieldError(
      this.materialThicknessErrorEl,
      this.materialThicknessInput,
      model.materialThicknessError,
    );
  }

  private build(): void {
    this.root.innerHTML = `
      <h2>Inputs</h2>
      <form class="inputs-form" novalidate>
        <label>
          Edge count N
          <input type="number" name="edgeCount" min="3" step="1" value="6" />
        </label>
        <label>
          Edge length L (mm)
          <input type="number" name="edgeLength" min="0" step="0.1" value="100" />
        </label>
        <label>
          Outer edge length L<sub>o</sub> (mm)
          <input type="number" name="outerEdgeLength" min="0" step="0.1" value="100" />
          <span class="hint">Outer perimeter edge of each face; molecules absorb the rest</span>
        </label>
        <label class="apex-height-field">
          Apex height K<sub>tot</sub> = H (mm, vertical)
          <input type="number" name="totalCurvature" step="0.1" value="0" />
          <span class="hint">Vertical altitude above base — not slant s</span>
          <span class="input-error apex-height-error" role="alert" hidden></span>
        </label>
        <label class="material-thickness-field">
          Material thickness T (mm)
          <input type="number" name="materialThickness" min="0" step="0.05" value="0" />
          <span class="hint">Sets major-cut radius r<sub>apex</sub> = T / sin(θ/2)</span>
          <span class="input-error material-thickness-error" role="alert" hidden></span>
        </label>
      </form>
      <div class="derived-mount"></div>
    `;

    const form = this.root.querySelector(".inputs-form")!;
    this.edgeCountInput = form.querySelector('[name="edgeCount"]') as HTMLInputElement;
    this.edgeLengthInput = form.querySelector('[name="edgeLength"]') as HTMLInputElement;
    this.outerEdgeLengthInput = form.querySelector(
      '[name="outerEdgeLength"]',
    ) as HTMLInputElement;
    this.totalCurvatureInput = form.querySelector(
      '[name="totalCurvature"]',
    ) as HTMLInputElement;
    this.materialThicknessInput = form.querySelector(
      '[name="materialThickness"]',
    ) as HTMLInputElement;
    this.apexHeightErrorEl = form.querySelector(".apex-height-error") as HTMLElement;
    this.materialThicknessErrorEl = form.querySelector(
      ".material-thickness-error",
    ) as HTMLElement;

    const mount = this.root.querySelector(".derived-mount");
    this.derivedEl = document.createElement("div");
    this.derivedEl.className = "derived";
    mount?.replaceWith(this.derivedEl);

    const emit = () => {
      for (const handler of this.changeHandlers) handler();
    };
    form.addEventListener("input", emit);
    form.addEventListener("change", emit);
  }

  private applyFieldError(
    errorEl: HTMLElement,
    inputEl: HTMLInputElement,
    error: string | null,
  ): void {
    if (error) {
      errorEl.textContent = error;
      errorEl.hidden = false;
      inputEl.setAttribute("aria-invalid", "true");
    } else {
      errorEl.textContent = "";
      errorEl.hidden = true;
      inputEl.removeAttribute("aria-invalid");
    }
  }
}
