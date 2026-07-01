/**
 * **View** — the "Pattern editor" trigger + modal: the secondary design path.
 * An Origami-Simulator-style crease-pattern grid the user paints with a tool
 * palette (Mountain / Valley / Border / Cut / Facet / Erase), then commits as a
 * FKLD pattern that flows into the same viewer + 3D-Sim + export pipeline as a
 * kirigamized mesh.
 *
 * Dumb view: it owns a {@link PatternGrid} and its SVG rendering, and emits two
 * intents — `onUse(grid)` (build + show) and a `setSerializer` provider for the
 * in-modal `.fkld` download. The `fkld:` namespace and serialization live in the
 * service layer; this file never imports it (intents flow up via callbacks).
 */
import {
  PatternGrid,
  presetAccordion,
  presetCutWindow,
  presetWaterbomb,
  type CandidateEdge,
  type CreaseAssignment,
} from "../model/pattern-grid.js";

/** The active brush: a crease assignment, or the eraser. */
type Tool = CreaseAssignment | "E";

interface ToolSpec {
  tool: Tool;
  label: string;
  key: string;
}

const TOOLS: ToolSpec[] = [
  { tool: "M", label: "Mountain", key: "1" },
  { tool: "V", label: "Valley", key: "2" },
  { tool: "B", label: "Border", key: "3" },
  { tool: "C", label: "Cut", key: "4" },
  { tool: "F", label: "Facet", key: "5" },
  { tool: "E", label: "Erase", key: "0" },
];

const PRESETS: Record<string, (g: PatternGrid) => void> = {
  blank: (g) => g.clear(),
  accordion: presetAccordion,
  waterbomb: presetWaterbomb,
  cut: presetCutWindow,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = 18;

/** Returns a downloadable `.fkld` payload for the current grid, or null. */
export type PatternSerializer = (grid: PatternGrid) => { filename: string; text: string } | null;

export class PatternEditorModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly statusEl: HTMLElement;
  private readonly colsInput: HTMLInputElement;
  private readonly rowsInput: HTMLInputElement;
  private readonly cellInput: HTMLInputElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();

  private grid = new PatternGrid(6, 6, 10);
  private tool: Tool = "M";
  private painting = false;
  private lastKey = "";
  private scale = 48;
  /** Visible (coloured) line per canonical edge key, updated incrementally on paint. */
  private readonly visible = new Map<string, SVGLineElement>();

  private useHandler: (grid: PatternGrid) => void = () => {};
  private serializer: PatternSerializer | null = null;

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Pattern editor";
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal pe-modal" role="dialog" aria-modal="true" aria-label="Crease pattern editor">
        <header class="sim-modal-header">
          <span class="sim-modal-title">Pattern editor — draw a crease pattern → FKLD</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body pe-body">
          <div class="pe-toolbar">
            <span class="pe-group">
              <span class="pe-label">Brush</span>
              ${TOOLS.map(
                (t) =>
                  `<button type="button" class="pe-tool pe-tool-${t.tool}" data-tool="${t.tool}" title="${t.label} (${t.key})">${t.label}</button>`,
              ).join("")}
            </span>
            <span class="pe-group">
              <span class="pe-label">Grid</span>
              <label class="pe-num">cols<input type="number" class="pe-cols" min="1" max="40" /></label>
              <label class="pe-num">rows<input type="number" class="pe-rows" min="1" max="40" /></label>
              <label class="pe-num">mm<input type="number" class="pe-cell" min="1" step="1" /></label>
            </span>
            <span class="pe-group">
              <span class="pe-label">Preset</span>
              <select class="pe-preset">
                <option value="">— choose —</option>
                <option value="blank">Blank</option>
                <option value="accordion">Accordion (M/V pleats)</option>
                <option value="waterbomb">Waterbomb grid</option>
                <option value="cut">Cut window</option>
              </select>
              <button type="button" class="pe-clear">Clear</button>
            </span>
          </div>
          <div class="pe-canvas-wrap">
            <svg class="pe-svg" xmlns="${SVG_NS}" aria-label="Crease pattern canvas"></svg>
          </div>
          <p class="pe-legend">
            <span class="pe-key pe-key-M">—— mountain</span>
            <span class="pe-key pe-key-V">—— valley</span>
            <span class="pe-key pe-key-B">—— border</span>
            <span class="pe-key pe-key-C">—— cut</span>
            <span class="pe-key pe-key-F">—— facet</span>
            &nbsp;· click or drag edges to paint · unpainted perimeter auto-borders
          </p>
        </div>
        <footer class="sim-modal-footer">
          <span class="sim-status pe-status"></span>
          <button type="button" class="pe-download">Download .fkld</button>
          <button type="button" class="export-trigger pe-use">Use this pattern ▶</button>
        </footer>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.svg = this.overlay.querySelector(".pe-svg")!;
    this.statusEl = this.overlay.querySelector(".pe-status")!;
    this.colsInput = this.overlay.querySelector(".pe-cols")!;
    this.rowsInput = this.overlay.querySelector(".pe-rows")!;
    this.cellInput = this.overlay.querySelector(".pe-cell")!;
    for (const t of TOOLS) {
      const btn = this.overlay.querySelector<HTMLButtonElement>(`[data-tool="${t.tool}"]`)!;
      btn.addEventListener("click", () => this.selectTool(t.tool));
      this.toolButtons.set(t.tool, btn);
    }

    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.querySelector(".pe-clear")!.addEventListener("click", () => {
      this.grid.clear();
      this.rebuild();
      this.setStatus("Cleared.");
    });
    this.overlay.querySelector<HTMLSelectElement>(".pe-preset")!.addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      const fn = PRESETS[sel.value];
      if (fn) {
        fn(this.grid);
        this.rebuild();
        this.setStatus(`Loaded "${sel.options[sel.selectedIndex].text}" preset.`);
      }
      sel.value = "";
    });
    for (const input of [this.colsInput, this.rowsInput, this.cellInput])
      input.addEventListener("change", () => this.resizeFromInputs());

    this.overlay.querySelector(".pe-download")!.addEventListener("click", () => this.download());
    this.overlay.querySelector(".pe-use")!.addEventListener("click", () => this.useHandler(this.grid));

    // Painting: drag anywhere on the canvas; the element under the pointer drives it.
    this.svg.addEventListener("pointerdown", (e) => this.onPointer(e, true));
    this.svg.addEventListener("pointermove", (e) => this.onPointer(e, false));
    window.addEventListener("pointerup", () => {
      this.painting = false;
      this.lastKey = "";
    });

    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if (e.key === "Escape") return this.close();
      const spec = TOOLS.find((t) => t.key === e.key);
      if (spec) this.selectTool(spec.tool);
    });
  }

  // ---- public lifecycle (mirrors SimModal / ExportModal) -------------------

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  /** Register the handler invoked when the user commits the drawn pattern. */
  onUse(handler: (grid: PatternGrid) => void): void {
    this.useHandler = handler;
  }

  /** Provide the FKLD serializer for the in-modal download (keeps `@fkld` out of the view). */
  setSerializer(serializer: PatternSerializer): void {
    this.serializer = serializer;
  }

  open(): void {
    this.colsInput.value = String(this.grid.cols);
    this.rowsInput.value = String(this.grid.rows);
    this.cellInput.value = String(this.grid.cellMm);
    this.selectTool(this.tool);
    this.rebuild();
    this.setStatus("Pick a brush, then click or drag edges. Try a preset to start.");
    this.overlay.hidden = false;
  }

  close(): void {
    this.overlay.hidden = true;
  }

  // ---- editing -------------------------------------------------------------

  private selectTool(tool: Tool): void {
    this.tool = tool;
    for (const [t, btn] of this.toolButtons) btn.classList.toggle("is-active", t === tool);
  }

  private resizeFromInputs(): void {
    const cols = clampInt(this.colsInput.value, 6, 1, 40);
    const rows = clampInt(this.rowsInput.value, 6, 1, 40);
    const cell = clampInt(this.cellInput.value, 10, 1, 200);
    this.grid = new PatternGrid(cols, rows, cell);
    this.colsInput.value = String(this.grid.cols);
    this.rowsInput.value = String(this.grid.rows);
    this.cellInput.value = String(this.grid.cellMm);
    this.rebuild();
    this.setStatus(`Resized to ${cols}×${rows} (${cell} mm cells). Pattern reset.`);
  }

  private onPointer(e: PointerEvent, down: boolean): void {
    if (down) this.painting = true;
    if (!this.painting) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const key = (target as Element | null)?.getAttribute?.("data-key");
    if (!key || key === this.lastKey) return;
    const [a, b] = key.split(":").map(Number);
    this.grid.set(a, b, this.tool === "E" ? null : this.tool);
    this.lastKey = key;
    this.updateEdge(key, a, b, (target as Element).getAttribute("data-kind") as CandidateEdge["kind"]);
    this.reportCounts();
  }

  // ---- rendering -----------------------------------------------------------

  private rebuild(): void {
    const g = this.grid;
    this.scale = Math.max(10, Math.min(64, Math.floor(560 / Math.max(g.cols, g.rows))));
    const w = PAD * 2 + g.cols * this.scale;
    const h = PAD * 2 + g.rows * this.scale;
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.innerHTML = "";
    this.visible.clear();

    // Faint lattice dots for the grid look.
    for (let j = 0; j <= g.rows; j++)
      for (let i = 0; i <= g.cols; i++) {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(this.sx(i)));
        dot.setAttribute("cy", String(this.sy(j)));
        dot.setAttribute("r", "1.4");
        dot.setAttribute("class", "pe-dot");
        this.svg.appendChild(dot);
      }

    const candidates = g.candidates();
    // Visible (coloured) lines first…
    for (const c of candidates) {
      const key = canonical(c.a, c.b);
      const line = this.lineFor(c);
      line.setAttribute("class", this.edgeClass(c.a, c.b, c.kind));
      this.visible.set(key, line);
      this.svg.appendChild(line);
    }
    // …then fat transparent hit lines on top, carrying the edge id for elementFromPoint.
    for (const c of candidates) {
      const hit = this.lineFor(c);
      hit.setAttribute("class", "pe-hit");
      hit.setAttribute("data-key", canonical(c.a, c.b));
      hit.setAttribute("data-kind", c.kind);
      this.svg.appendChild(hit);
    }
  }

  private updateEdge(key: string, a: number, b: number, kind: CandidateEdge["kind"]): void {
    this.visible.get(key)?.setAttribute("class", this.edgeClass(a, b, kind));
  }

  private lineFor(c: CandidateEdge): SVGLineElement {
    const [ai, aj] = this.grid.ij(c.a);
    const [bi, bj] = this.grid.ij(c.b);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(this.sx(ai)));
    line.setAttribute("y1", String(this.sy(aj)));
    line.setAttribute("x2", String(this.sx(bi)));
    line.setAttribute("y2", String(this.sy(bj)));
    return line;
  }

  /** Effective class: user assignment wins; bare perimeter sides preview as "B"; else "none". */
  private edgeClass(a: number, b: number, kind: CandidateEdge["kind"]): string {
    const asg = this.grid.get(a, b);
    const eff = asg ?? (this.grid.isPerimeterSide(a, b) ? "B" : "none");
    return `pe-line pe-kind-${kind} pe-${eff}`;
  }

  private sx(i: number): number {
    return PAD + i * this.scale;
  }
  private sy(j: number): number {
    return PAD + (this.grid.rows - j) * this.scale; // flip so j increases up the screen
  }

  // ---- output --------------------------------------------------------------

  private download(): void {
    const payload = this.serializer?.(this.grid) ?? null;
    if (!payload) {
      this.setStatus("Nothing to export yet.");
      return;
    }
    const blob = new Blob([payload.text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.setStatus(`Downloaded ${payload.filename}.`);
  }

  private reportCounts(): void {
    const c = countAssignments(this.grid);
    this.setStatus(
      `${c.M} mountain · ${c.V} valley · ${c.C} cut · ${c.B} border · ${c.F} facet painted.`,
    );
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }
}

function canonical(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function clampInt(raw: string, fallback: number, lo: number, hi: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Tally painted (user-set) assignments for the live status line. */
function countAssignments(grid: PatternGrid): Record<CreaseAssignment, number> {
  const out: Record<CreaseAssignment, number> = { M: 0, V: 0, B: 0, C: 0, F: 0 };
  for (const c of grid.candidates()) {
    const asg = grid.get(c.a, c.b);
    if (asg) out[asg]++;
  }
  return out;
}
