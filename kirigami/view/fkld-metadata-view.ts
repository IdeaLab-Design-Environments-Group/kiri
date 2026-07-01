/**
 * FkldMetadataView — read-only metadata panel that sits beneath the
 * constraint checklist. The displayed values are sourced directly from
 * the FKLD JSON object (the canonical description of the current
 * pattern). KirigamiState is intentionally not consulted here: the view
 * is exactly what the exported `.fkld` file says it is, so anything the
 * file omits is also absent from the screen, and any drift between the
 * in-memory model and the on-disk format would surface immediately.
 *
 * The "what to show" logic lives in `fkld-metadata-summary.ts` as pure
 * functions so it can be unit-tested without a DOM. This file is only
 * responsible for turning those sections into HTML.
 */

import type { FkldFile } from "../model/fkld-export.js";
import {
  summarizeFkldForDisplay,
  type SummarySection,
} from "./fkld-metadata-summary.js";

export class FkldMetadataView {
  private readonly root: HTMLElement;
  private readonly bodyEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "panel fkld-metadata-panel";
    this.root.innerHTML = `
      <h2>FKLD pattern metadata</h2>
      <p class="fkld-meta-hint">Read straight from the FKLD object that drives the export — the file <em>is</em> the displayed pattern.</p>
      <div class="fkld-meta-body" role="group" aria-label="FKLD pattern metadata"></div>
    `;
    container.appendChild(this.root);
    this.bodyEl = this.root.querySelector(".fkld-meta-body")!;
  }

  /**
   * Render the panel from an FKLD object. Pass `null` to show the empty
   * state (used when inputs are invalid and no FoldNet can be built).
   */
  render(fkld: FkldFile | null): void {
    if (!fkld) {
      this.bodyEl.innerHTML = `<p class="fkld-meta-empty">No valid pattern — fix the inputs to populate the FKLD file.</p>`;
      return;
    }
    const sections = summarizeFkldForDisplay(fkld);
    this.bodyEl.innerHTML = sections.map(renderSection).join("");
  }
}

function renderSection(section: SummarySection): string {
  const body =
    section.rows.length > 0
      ? renderRows(section.rows)
      : `<p class="fkld-meta-empty">${escapeHtml(section.emptyMessage ?? "—")}</p>`;
  return `
    <section class="fkld-meta-section">
      <h3>${escapeHtml(section.title)}</h3>
      ${body}
    </section>
  `;
}

function renderRows(rows: SummarySection["rows"]): string {
  return (
    `<dl class="fkld-meta-list">` +
    rows
      .map(
        ({ term, value }) =>
          `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`,
      )
      .join("") +
    `</dl>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
