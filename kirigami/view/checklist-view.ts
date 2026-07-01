import type { ConstraintState } from "../model/types.js";

/** Center column: constraint checklist from `ConstraintState[]` (read-only checkboxes). */
export class ChecklistView {
  private readonly root: HTMLElement;
  private listEl!: HTMLUListElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "panel checklist-panel";
    container.appendChild(this.root);
    this.root.innerHTML = `
      <h2>Constraints</h2>
      <ul class="constraint-list" role="list" aria-label="Constraint checklist"></ul>
    `;
    this.listEl = this.root.querySelector(".constraint-list")!;
  }

  render(constraints: ConstraintState[]): void {
    this.listEl.innerHTML = constraints
      .map((c) => {
        const checked = c.satisfied ? "checked" : "";
        const rowClass = c.satisfied ? "constraint-row constraint-ok" : "constraint-row constraint-fail";
        const title = c.message ? ` title="${escapeAttr(c.message)}"` : "";
        return `
          <li class="${rowClass}" data-id="${c.id}"${title}>
            <label>
              <input type="checkbox" disabled ${checked} aria-readonly="true" aria-label="${escapeAttr(c.label)}" />
              <span class="constraint-id">${c.id}</span>
              <span class="constraint-label">${escapeHtml(c.label)}</span>
            </label>
            <span class="constraint-residual">${formatResidual(c)}</span>
          </li>
        `;
      })
      .join("");
  }
}

function formatResidual(c: ConstraintState): string {
  if (c.residual < 1e-12) return "";
  return `|residual| ${c.residual.toExponential(2)}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(s: string): string {
  return escapeAttr(s);
}
