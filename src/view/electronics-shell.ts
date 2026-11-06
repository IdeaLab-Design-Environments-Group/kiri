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
      <div class="el-page-inner" role="region" aria-label="electronics editor">
        <header class="el-page-header">
          <button type="button" class="el-back sim-modal-close" aria-label="back to the model">← Model</button>
          <span class="el-page-title">Electronics</span>
        </header>
        <div class="el-body">
          <div class="el-toolbar">
            <div class="el-toolbar-row">
              <span class="el-group">
                <span class="el-group-label">Place</span>
                <span class="el-seg">
                  <button type="button" class="el-tool" data-tool="led" title="place an LED — tap near a fold, or anywhere on a tile when Parts go is on a tile">LED</button>
                  <button type="button" class="el-tool" data-tool="battery" title="place the battery — click a tile">battery</button>
                  <button type="button" class="el-tool" data-tool="wire" title="draw copper by hand — tap to lay a vertex, tap the last one (or Enter) to finish, Backspace to take one back, X+tap to drop one, Delete to remove the selected wire">wire</button>
                </span>
              </span>
              <span class="el-group el-parts">
                <label class="el-group-label el-part-label" for="el-part-search">part</label>
                <span class="el-part-picker">
                  <span class="el-part-fields">
                    <input type="search" id="el-part-search" class="el-part-search" placeholder="search by name or package" aria-label="search the component library" autocomplete="off" role="combobox" aria-controls="el-part-menu" aria-expanded="false" aria-autocomplete="list">
                    <span class="el-part-menu-wrap">
                      <button type="button" class="el-part-trigger" aria-haspopup="listbox" aria-controls="el-part-menu" aria-expanded="false" title="browse the library by shelf, or type in the search box beside it: both open this one list. Pick a part, then tap the sheet to place it"></button>
                      <div class="el-part-menu" id="el-part-menu" role="listbox" aria-label="component library" hidden></div>
                      <select id="el-part" class="el-part" hidden title="pick a library part, then click either rail to place it. The copper is broken there, so the tape does not short the part out"></select>
                    </span>
                  </span>
                  <span class="el-part-count" aria-live="polite"></span>
                </span>
              </span>
              <span class="el-group el-place-modes">
                <span class="el-group-label" id="el-lbl-seat">Parts go</span>
                <span class="el-hint" id="el-desc-seat" hidden>Where the next LED or part is put. Across a fold: a tap near a fold puts it across the hinge, a pad on each tile. On a tile: a tap anywhere on a tile puts it there, wired by nets or hand-drawn copper.</span>
                <span class="el-seg" role="group" aria-labelledby="el-lbl-seat">
                  <button type="button" class="el-place" data-place="gap" id="el-seat-gap" aria-labelledby="el-lbl-seat el-seat-gap" aria-describedby="el-desc-seat" title="across a fold: a tap near a fold puts the LED or part across the hinge, a pad on each tile. A tap away from every fold places nothing">across a fold</button>
                  <button type="button" class="el-place" data-place="free" id="el-seat-free" aria-labelledby="el-lbl-seat el-seat-free" aria-describedby="el-desc-seat" title="on a tile: a tap anywhere on a tile puts the LED or part there. Its pads are wired by nets or by hand-drawn copper">on a tile</button>
                </span>
              </span>
            </div>
            <div class="el-toolbar-row">
              <span class="el-group el-build-modes">
                <span class="el-group-label" id="el-lbl-build">Sheet</span>
                <span class="el-hint" id="el-desc-build" hidden>What the pattern is made of. Vinyl or paper is one sheet scored at the creases, so copper may run anywhere. 3D-printed tiles have a bare hinge gap between them, which an LED bridges.</span>
                <span class="el-seg" role="group" aria-labelledby="el-lbl-build">
                  <button type="button" class="el-build" data-material="vinyl" id="el-build-vinyl" aria-labelledby="el-lbl-build el-build-vinyl" aria-describedby="el-desc-build" title="vinyl / paper: one continuous sheet, scored at the creases. Nothing is cut away, so the copper may run anywhere and a crease is priced by its assignment">vinyl / paper</button>
                  <button type="button" class="el-build" data-material="printed" id="el-build-printed" aria-labelledby="el-lbl-build el-build-printed" aria-describedby="el-desc-build" title="3D-printed: rigid tiles with a bare hinge gap between them. The gaps are what an LED bridges, and their measured width is what the crease strain is computed from">3D-printed tiles</button>
                </span>
              </span>
              <span class="el-group el-face-modes">
                <span class="el-group-label" id="el-lbl-side">Copper on</span>
                <span class="el-hint" id="el-desc-side" hidden>Which face of the sheet you are laying copper on. Each face is its own circuit with its own parts, nets and wires.</span>
                <span class="el-seg" role="group" aria-labelledby="el-lbl-side">
                  <button type="button" class="el-face" data-side="inside" id="el-side-inside" aria-labelledby="el-lbl-side el-side-inside" aria-describedby="el-desc-side" title="edit the inside face's copper — its own circuit, independent of the outside">inside face</button>
                  <button type="button" class="el-face" data-side="outside" id="el-side-outside" aria-labelledby="el-lbl-side el-side-outside" aria-describedby="el-desc-side" title="edit the outside face's copper — its own circuit, independent of the inside">outside face</button>
                </span>
              </span>
              <span class="el-group el-group-end">
                <button type="button" class="el-clear" title="remove all LEDs, the battery and routes">clear all</button>
              </span>
            </div>
          </div>
          <div class="el-workspace">
            <aside class="el-side" aria-label="nets and pads">
              <div class="el-side-sect">
                <div class="el-side-head">
                  <span class="el-side-title">Nets</span>
                  <span class="el-side-tally" aria-live="polite"></span>
                  <button type="button" class="el-net-add" aria-label="new net" title="declare a net. Names are yours — PWR, GND, SDA — and a pad is wired by putting it on one">+</button>
                </div>
                <input type="text" class="el-net-new" placeholder="new net name" aria-label="new net name" autocomplete="off">
                <div class="el-net-list" role="tree" aria-label="declared nets"></div>
              </div>
              <div class="el-side-sect el-wire-sect" hidden>
                <div class="el-side-head"><span class="el-side-title">Wire</span></div>
                <p class="el-wire-note" id="el-wire-note">Tap a wire to select it, then set its width or delete it here.</p>
                <label class="el-wire-width-row" title="the selected wire's tape width. Empty means the plan's own width">
                  <span>width</span>
                  <input type="number" class="el-wire-width" min="0.5" max="10" step="0.1" placeholder="auto" aria-label="selected wire width in millimetres" aria-describedby="el-wire-note" autocomplete="off" disabled>
                  <span>mm</span>
                </label>
                <button type="button" class="el-wire-delete" disabled title="delete the selected hand-drawn wire (Backspace or Delete)">delete wire</button>
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
              <div class="el-route-hint" role="status" hidden>Not routed yet — press Route</div>
              <div class="el-empty-hint" role="status"></div>
              <svg class="el-svg" xmlns="${SVG_NS}" aria-label="electronics flat-pattern canvas"></svg>
            </div>
            <aside class="el-tools" aria-label="view and output">
              <div class="el-side-sect el-route-modes">
                <div class="el-side-head"><span class="el-side-title">Route</span></div>
                <span class="el-seg">
                  <button type="button" class="el-auto" data-auto="on" title="re-plan the copper on every edit that moves it. Wiring a net still waits for Route">auto</button>
                  <button type="button" class="el-auto" data-auto="off" title="the default: leave the copper alone while you place and wire things. The canvas keeps showing the last plan until you press Route">manual</button>
                </span>
                <button type="button" class="el-route" title="re-plan the copper now">route now</button>
                <button type="button" class="el-route-clear" title="remove the planned copper only. Parts, nets and hand-drawn wires stay">clear routes</button>
              </div>
              <div class="el-side-sect el-view-modes">
                <div class="el-side-head"><span class="el-side-title" id="el-lbl-view">Show copper as</span></div>
                <span class="el-hint" id="el-desc-view" hidden>How the copper is drawn here. Strips: every run as its own piece. Carrier frame: one frame holding every run in place on thin tabs.</span>
                <span class="el-seg" role="group" aria-labelledby="el-lbl-view">
                  <button type="button" class="el-view" data-view="strips" id="el-view-strips" aria-labelledby="el-lbl-view el-view-strips" aria-describedby="el-desc-view" title="show the copper as separate strips">strips</button>
                  <button type="button" class="el-view" data-view="carrier" id="el-view-carrier" aria-labelledby="el-lbl-view el-view-carrier" aria-describedby="el-desc-view" title="show the copper as one carrier frame holding every trace in place">carrier frame</button>
                </span>
                <span class="el-seg">
                  <button type="button" class="el-zoom-out" title="zoom out" aria-label="zoom out">−</button>
                  <button type="button" class="el-zoom-in" title="zoom in" aria-label="zoom in">+</button>
                  <button type="button" class="el-fit" title="fit to screen">fit</button>
                </span>
              </div>
              <div class="el-side-sect el-export-sect">
                <div class="el-side-head"><span class="el-side-title">Export</span></div>
                <div class="el-export-grid">
                  <span></span><span class="el-export-col">inside</span><span class="el-export-col">outside</span>
                  <span class="el-export-row" title="every copper run as its own piece to cut">strips</span>
                  <button type="button" class="el-export" data-side="inside" aria-label="download the inside copper as separate strips (SVG)" title="download the inside's copper as separate strips to cut">SVG</button>
                  <button type="button" class="el-export" data-side="outside" aria-label="download the outside copper as separate strips (SVG)" title="download the outside's copper as separate strips to cut">SVG</button>
                  <span class="el-export-row" title="one frame that holds every copper run in place on thin tabs">carrier frame</span>
                  <button type="button" class="el-export-carrier" data-side="inside" aria-label="download the inside carrier frame (SVG)" title="download the inside's carrier frame: align it, stick the traces down, snip the tabs">SVG</button>
                  <button type="button" class="el-export-carrier" data-side="outside" aria-label="download the outside carrier frame (SVG)" title="download the outside's carrier frame: align it, stick the traces down, snip the tabs">SVG</button>
                </div>
                <p class="el-export-note" role="status" hidden></p>
                <span class="el-sub-label">mirror the cut</span>
                <span class="el-seg">
                  <button type="button" class="el-mirror" data-axis="x" title="mirror the cut left-right — for cutting through the backing or laying the tape adhesive side up" aria-pressed="false">⇄ left-right</button>
                  <button type="button" class="el-mirror" data-axis="y" title="mirror the cut top-bottom" aria-pressed="false">⇅ top-bottom</button>
                </span>
              </div>
              <div class="el-side-sect el-form-sect">
                <div class="el-side-head"><span class="el-side-title">Fold</span></div>
                <button type="button" class="el-form" title="fold this build in 3D with the copper on it — the same simulation the model page opens, in the material selected here">preview folded form</button>
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
            <span class="sim-status el-status" role="status"></span>
          </div>
        </div>
      </div>
  `;
}
