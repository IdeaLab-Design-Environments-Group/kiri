/**
 * **View helper** — the electronics editor's static markup.
 *
 * Split out of `electronics-modal.ts` when the toolbar gained the Side segment and the two extra export
 * buttons: it is a hundred and thirty lines of declarative HTML with three interpolations, all module
 * constants, and it was the largest thing in that file with no behaviour in it at all. Kept whole rather
 * than assembled from per-group helpers, because the grouping and the order of the toolbar rows is the
 * thing a reader comes here to see, and a builder would scatter it.
 *
 * The modal still owns every listener: this returns a string and knows nothing about what is bound to it.
 */
import { SVGPCB_COLOURS } from "../model/part-render.js";

/** Moved here with the markup: the canvas element it namespaces is declared below and nowhere else. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** The editor's whole shell — header, toolbar, canvas and sidebar — as one HTML string. */
export function shellMarkup(): string {
  return `
      <div class="el-page-inner" role="region" aria-label="Electronics editor">
        <header class="el-page-header">
          <button type="button" class="el-back sim-modal-close" aria-label="Back to the model">← Model</button>
          <span class="el-page-title">Electronics</span>
        </header>
        <div class="el-body">
          <div class="el-toolbar">
            <div class="el-toolbar-row">
              <span class="el-group">
                <span class="el-group-label">Place</span>
                <span class="el-seg">
                  <button type="button" class="el-tool" data-tool="battery" title="Place the battery — click a tile">Battery</button>
                  <button type="button" class="el-tool" data-tool="wire" title="Draw copper by hand — tap to lay a vertex, tap the last one (or Enter) to finish, Backspace to take one back, X+tap to drop one, Delete to remove the selected wire">Wire</button>
                </span>
              </span>
              <span class="el-group el-parts">
                <label class="el-group-label el-part-label" for="el-part">Part</label>
                <span class="el-part-picker">
                  <span class="el-part-fields">
                    <input type="search" id="el-part-search" class="el-part-search" placeholder="Search by name or package" aria-label="Search the component library" autocomplete="off">
                    <span class="el-part-menu-wrap">
                      <button type="button" class="el-part-trigger" aria-haspopup="listbox" aria-expanded="false" title="Pick a library part, then click either rail to place it. The copper is broken there, so the tape does not short the part out"></button>
                      <div class="el-part-menu" role="listbox" aria-label="Component library" hidden></div>
                      <select id="el-part" class="el-part" aria-hidden="true" tabindex="-1" title="Pick a library part, then click either rail to place it. The copper is broken there, so the tape does not short the part out"></select>
                    </span>
                  </span>
                  <span class="el-part-count" aria-live="polite"></span>
                </span>
              </span>
            </div>
            <div class="el-toolbar-row">
              <span class="el-group el-place-modes">
                <span class="el-group-label">Seat</span>
                <span class="el-seg">
                  <button type="button" class="el-place" data-place="gap" title="Across a fold: the component bridges the hinge between two tiles, a pad on each side">Across a fold</button>
                  <button type="button" class="el-place" data-place="free" title="On a tile: the component stands where you put it, and its pads are wired by nets or by hand-drawn copper">On a tile</button>
                </span>
              </span>
              <span class="el-group el-face-modes">
                <span class="el-group-label">Side</span>
                <span class="el-seg">
                  <button type="button" class="el-face" data-side="inside" title="Edit the inside face's copper — its own circuit, independent of the outside">Inside</button>
                  <button type="button" class="el-face" data-side="outside" title="Edit the outside face's copper — its own circuit, independent of the inside">Outside</button>
                </span>
              </span>
              <span class="el-group el-group-end">
                <button type="button" class="el-clear" title="Remove all LEDs, the battery and routes">Clear all</button>
              </span>
            </div>
          </div>
          <div class="el-workspace">
            <aside class="el-side" aria-label="Nets and pads">
              <div class="el-side-sect">
                <div class="el-side-head">
                  <span class="el-side-title">Nets</span>
                  <span class="el-side-tally" aria-live="polite"></span>
                  <button type="button" class="el-net-add" aria-label="New net" title="Declare a net. Names are yours — PWR, GND, SDA — and a pad is wired by putting it on one">+</button>
                </div>
                <input type="text" class="el-net-new" placeholder="New net name" aria-label="New net name" autocomplete="off">
                <div class="el-net-list" role="tree" aria-label="Declared nets"></div>
              </div>
              <div class="el-side-sect el-placed" hidden>
                <div class="el-side-head">
                  <span class="el-side-title">Parts</span>
                  <span class="el-side-tally el-placed-tally" aria-live="polite"></span>
                </div>
                <div class="el-placed-list" role="list"></div>
              </div>
              <div class="el-side-sect el-pads" hidden>
                <div class="el-side-head">
                  <span class="el-side-title el-pad-part"></span>
                </div>
                <div class="el-pad-list"></div>
              </div>
            </aside>
            <div class="el-canvas-wrap">
              <svg class="el-svg" xmlns="${SVG_NS}" aria-label="Electronics flat-pattern canvas"></svg>
            </div>
            <aside class="el-tools" aria-label="View and output">
              <div class="el-side-sect el-view-modes">
                <div class="el-side-head"><span class="el-side-title">Copper</span></div>
                <span class="el-seg">
                  <button type="button" class="el-view" data-view="traces" title="Show the copper as separate strips">Strips</button>
                  <button type="button" class="el-view" data-view="carrier" title="Show the copper as one carrier frame holding every trace in place">Carrier</button>
                </span>
              </div>
              <div class="el-side-sect el-route-modes">
                <div class="el-side-head"><span class="el-side-title">Route</span></div>
                <span class="el-seg">
                  <button type="button" class="el-auto" data-auto="on" title="Re-plan the copper on every edit, as it has always been">Auto</button>
                  <button type="button" class="el-auto" data-auto="off" title="Leave the copper alone while you place and move things. The canvas keeps showing the last plan until you press Route">Manual</button>
                </span>
                <button type="button" class="el-route" title="Re-plan the copper now">Route</button>
              </div>
              <div class="el-side-sect el-mirror-modes">
                <div class="el-side-head"><span class="el-side-title">Mirror</span></div>
                <span class="el-seg">
                  <button type="button" class="el-mirror" data-axis="x" title="Mirror the cut left-right — for cutting through the backing or laying the tape adhesive side up" aria-pressed="false">⇄ Left-right</button>
                  <button type="button" class="el-mirror" data-axis="y" title="Mirror the cut top-bottom" aria-pressed="false">⇅ Top-bottom</button>
                </span>
              </div>
              <div class="el-side-sect el-export-sect">
                <div class="el-side-head"><span class="el-side-title">Export</span></div>
                <button type="button" class="el-export" data-side="inside" title="Download the inside's copper as separate strips to cut">Strips — Inside</button>
                <button type="button" class="el-export" data-side="outside" title="Download the outside's copper as separate strips to cut">Strips — Outside</button>
                <button type="button" class="el-export-carrier" data-side="inside" title="Download the inside's carrier frame: align it, stick the traces down, snip the tabs">Carrier — Inside</button>
                <button type="button" class="el-export-carrier" data-side="outside" title="Download the outside's carrier frame: align it, stick the traces down, snip the tabs">Carrier — Outside</button>
              </div>
              <div class="el-side-sect el-view-group">
                <div class="el-side-head"><span class="el-side-title">Zoom</span></div>
                <span class="el-seg">
                  <button type="button" class="el-zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
                  <button type="button" class="el-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
                  <button type="button" class="el-fit" title="Fit to screen">Fit</button>
                </span>
              </div>
            </aside>
          </div>
          <div class="el-footer-row">
            <p class="el-legend">
              <span class="el-key"><i class="el-swatch el-key-pwr"></i>PWR tape</span>
              <span class="el-key"><i class="el-swatch el-key-gnd"></i>GND tape</span>
              <span class="el-key"><i class="el-swatch el-key-batt"></i>Battery</span>
              <span class="el-key"><i class="el-swatch" style="background:${SVGPCB_COLOURS.mask}"></i>Part pad — drawn, not cut</span>
              <span class="el-key"><i class="el-swatch" style="background:${SVGPCB_COLOURS.componentLabel}"></i>Part label (R1)</span>
              <span class="el-key"><i class="el-swatch el-swatch-ring el-key-led"></i>LED the copper never reached</span>
            </p>
            <span class="sim-status el-status"></span>
          </div>
        </div>
      </div>
  `;
}
