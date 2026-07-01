import type { KirigamiState } from "../model/types.js";
import type { PatternNet } from "../model/pattern.js";

export type { PatternNet, PatternSegment, PatternStrokeRole } from "../model/pattern.js";

/**
 * Center column: SVG pattern view.
 * Renders from `PatternNet` produced by `buildPatternNet(state)`.
 */
export class PatternCanvas {
  private readonly root: HTMLElement;
  private svgEl!: SVGSVGElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement("section");
    this.root.className = "panel pattern-panel";
    container.appendChild(this.root);
    this.root.innerHTML = `
      <h2>Pattern</h2>
      <div class="pattern-wrap">
        <svg class="pattern-svg" xmlns="http://www.w3.org/2000/svg" aria-label="Kirigami net pattern"></svg>
      </div>
      <p class="legend">
        <span class="legend-item legend-polygon">■ polygons (faces)</span>
        <span class="legend-item legend-molecule">—— molecules</span>
        <span class="legend-item legend-boundary">—— outline</span>
        <span class="legend-item legend-fold">- - - fold</span>
        <span class="legend-item legend-cut">---- cut</span>
      </p>
    `;
    this.svgEl = this.root.querySelector("svg")!;
  }

  render(_state: KirigamiState | null, net: PatternNet | null): void {
    if (!net) {
      this.svgEl.innerHTML = "";
      return;
    }
    const [x, y, w, h] = net.viewBox;
    this.svgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    this.svgEl.innerHTML = net.segments
      .map((seg) => {
        const fillRule =
          seg.role === "molecule-fill" ? ' fill-rule="evenodd"' : "";
        return `<path class="stroke-${seg.role}" d="${seg.d}"${fillRule} vector-effect="non-scaling-stroke" />`;
      })
      .join("\n");
  }
}
