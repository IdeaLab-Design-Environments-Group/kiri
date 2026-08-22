/**
 * **View** — the "Electronics" trigger + modal: a 2D flat-pattern interface for
 * laying out LEDs and the battery, with their copper tape auto-routed live.
 *
 * The user clicks a gap to drop an LED bridging two tiles (or a tile to place the battery), and the modal
 * emits the authored {@link Circuit} via `onEdit`. Copper is re-planned on every edit — there is no
 * "route" button to press — so the tape follows the components as they are placed.
 *
 * Polarity is the router's to decide, not the author's: it reports which pad it landed PWR on, and the
 * preview draws that, so the pad colours say which way round to fit each component.
 *
 * All geometry is the flat pattern's 2D mm coords (the SVG export frame).
 */
import {
  type Circuit,
  type FlatFace,
  type GapEdge,
  type TilePoly,
  type Vec2,
  flatFaces,
  flatPoints,
  dist2,
  gapForLed,
  gapGraph,
  ledOf,
  nearestGap,
  pointInFace,
  tilePolys,
} from "../model/electronics.js";
import {
  type Mirror,
  buildCopperCarrierExport,
  buildCopperSvgExport,
  mirrorPoint,
  resistorShape,
  stripOutline,
  switchShape,
} from "../model/copper-svg-export.js";
import { printScale } from "../model/print-scale.js";
import { LED } from "../model/parts.js";
import {
  type RoutedCircuit,
  type Terminals,
  EMPTY_ROUTE,
  tapeWidthFor,
  batteryTerminals,
  planRoutes,
} from "../model/electronics-routing.js";
import { TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import type { FoldFile } from "../model/fold-file.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = 8; // mm — must match the SVG export so preview ↔ export register

type Tool = "led" | "battery" | "resistor" | "switch";

/** How the copper is shown, matching the two ways it can be cut.
 *
 *  `strips` is the copper as separate pieces. `carrier` is the 3-layer build: one piece of copper cut as a
 *  frame around the unfolded pattern with every trace held inside it on thin tabs, so the traces arrive
 *  already positioned — align the frame, press them down, snip the tabs, lift the frame away. */
type ViewMode = "strips" | "carrier";

export class ElectronicsModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly statusEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly viewButtons = new Map<ViewMode, HTMLButtonElement>();
  private readonly mirrorButtons = new Map<keyof Mirror, HTMLButtonElement>();

  private tool: Tool = "led";
  private viewMode: ViewMode = "strips";
  /** Which way the cut is flipped — off by default, so the file matches the design unless asked otherwise. */
  private mirror: Mirror = { x: false, y: false };
  /** The sheet a scale-less pattern is cut at, from the export menu's print size. Held here because both
   *  the routing and every dimension drawn are derived from it. */
  private sheetMm: number | undefined;
  /** Inter-tile gap (shrink-toward-centroid fraction), driven by the sim's Gap slider. The tiles drawn
   *  here and the gaps an LED bridges are the same geometry the printed build is cut at, so this has to
   *  track that slider or the placement surface disagrees with what gets printed. */
  private tileGap = TILE_INSET_FRAC;
  /** Index into `circuit.leds` of the LED under the cursor's last tap, or -1. */
  private selected = -1;
  private fold: FoldFile | null = null;
  private faces: FlatFace[] = [];
  private tiles: TilePoly[] = [];
  private gaps: GapEdge[] = [];
  private points: Vec2[] = [];
  private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private circuit: Circuit = { leds: [], battery: null };
  private routed: RoutedCircuit = EMPTY_ROUTE;

  // Pan/zoom: `contentBox()` is the drawn pattern box in sheet mm; `view` is the visible window into it.
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private pan: { x: number; y: number; moved: number } | null = null;

  private editHandler: (circuit: Circuit) => void = () => {};

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Electronics";
    this.trigger.disabled = true;
    this.trigger.addEventListener("click", () => this.open());

    this.overlay = document.createElement("div");
    this.overlay.className = "sim-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="sim-modal el-modal" role="dialog" aria-modal="true" aria-label="LED electronics editor">
        <header class="sim-modal-header">
          <span class="sim-modal-title">Electronics</span>
          <button type="button" class="sim-modal-close" aria-label="Close">×</button>
        </header>
        <div class="sim-modal-body el-body">
          <div class="el-toolbar">
            <span class="el-group">
              <button type="button" class="el-tool" data-tool="led" title="Add an LED — click a gap between two tiles">LED</button>
              <button type="button" class="el-tool" data-tool="battery" title="Place the battery — click a tile">Battery</button>
              <button type="button" class="el-tool" data-tool="resistor" title="Add a series resistor — click on either rail. The copper is broken there, so the tape does not short the resistor out">Resistor</button>
              <button type="button" class="el-tool" data-tool="switch" title="Add a 1x03 switch — click either rail. The copper is broken by one pin pitch: two pins land one side of it, one the other">Switch</button>
            </span>
            <span class="el-group">
              <button type="button" class="el-clear" title="Remove all LEDs, the battery and routes">Clear</button>
            </span>
            <span class="el-group el-view-modes">
              <button type="button" class="el-view" data-view="traces" title="Show the copper as separate strips">Strips</button>
              <button type="button" class="el-view" data-view="carrier" title="Show the copper as one carrier frame holding every trace in place">Carrier</button>
            </span>
            <span class="el-group el-mirror-modes">
              <button type="button" class="el-mirror" data-axis="x" title="Mirror the cut left-right — for cutting through the backing or laying the tape adhesive side up" aria-pressed="false">Mirror ⇄</button>
              <button type="button" class="el-mirror" data-axis="y" title="Mirror the cut top-bottom" aria-pressed="false">Mirror ⇅</button>
            </span>
            <span class="el-group">
              <button type="button" class="el-export" title="Download the copper as separate strips to cut">Export SVG</button>
              <button type="button" class="el-export-carrier" title="Download one carrier frame holding every trace in place: align it, stick the traces down, snip the tabs">Export carrier</button>
            </span>
            <span class="el-group el-view-group">
              <button type="button" class="el-zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
              <button type="button" class="el-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
              <button type="button" class="el-fit" title="Fit to screen">Fit</button>
            </span>
          </div>
          <div class="el-canvas-wrap">
            <svg class="el-svg" xmlns="${SVG_NS}" aria-label="Electronics flat-pattern canvas"></svg>
          </div>
          <div class="el-footer-row">
            <p class="el-legend">
              <span class="el-key el-key-led">● LED</span>
              <span class="el-key el-key-pwr">▬ PWR</span>
              <span class="el-key el-key-gnd">▬ GND</span>
              <span class="el-key el-key-batt">▮ Battery</span>
              <span class="el-key el-key-res">▬ Resistor</span>
              <span class="el-key el-key-res">▤ Switch</span>
            </p>
            <span class="sim-status el-status"></span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.svg = this.overlay.querySelector(".el-svg")!;
    this.statusEl = this.overlay.querySelector(".el-status")!;

    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-tool")) {
      const tool = btn.dataset.tool as Tool;
      btn.addEventListener("click", () => this.selectTool(tool));
      this.toolButtons.set(tool, btn);
    }
    this.overlay.querySelector(".el-clear")!.addEventListener("click", () => this.clear());
    this.overlay.querySelector(".el-export")!.addEventListener("click", () => this.exportCopper());
    this.overlay.querySelector(".el-export-carrier")!.addEventListener("click", () => this.exportCarrier());
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-view")) {
      const mode = btn.dataset.view as ViewMode;
      btn.addEventListener("click", () => this.selectView(mode));
      this.viewButtons.set(mode, btn);
    }
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-mirror")) {
      const axis = btn.dataset.axis === "y" ? "y" : "x";
      btn.addEventListener("click", () => this.toggleMirror(axis));
      this.mirrorButtons.set(axis, btn);
    }
    this.overlay.querySelector(".el-zoom-in")!.addEventListener("click", () => this.zoomBy(1.25));
    this.overlay.querySelector(".el-zoom-out")!.addEventListener("click", () => this.zoomBy(0.8));
    this.overlay.querySelector(".el-fit")!.addEventListener("click", () => this.fitView());
    this.overlay.querySelector(".sim-modal-close")!.addEventListener("click", () => this.close());
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    // Pointer = pan (drag) or place (tap). Wheel = zoom toward the cursor.
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("pointercancel", () => (this.pan = null));
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if (e.key === "Escape") {
        this.close();
        return;
      }
      if (e.key === "r" || e.key === "R") {
        this.rotateSelected();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") this.removeSelected();
    });
  }

  // ---- public lifecycle (mirrors SimModal / ExportModal) -------------------

  mountTrigger(container: HTMLElement): void {
    container.appendChild(this.trigger);
  }

  setEnabled(enabled: boolean): void {
    this.trigger.disabled = !enabled;
  }

  /** Register the handler invoked whenever the authored circuit changes. */
  onEdit(handler: (circuit: Circuit) => void): void {
    this.editHandler = handler;
  }

  /** Provide the current flat pattern to lay electronics on (clears the circuit if it changed). */
  setPattern(fold: FoldFile | null): void {
    if (fold === this.fold) return;
    this.fold = fold;
    this.rebuildGeometry();
    this.circuit = { leds: [], battery: null };
    this.computeBounds();
    this.fitView();
    this.syncButtons();
    if (!this.overlay.hidden) this.render();
  }

  /**
   * Set the inter-tile gap, from the sim's Gap slider (via the store).
   *
   * The gray tiles and the diamonds between them are derived from it, and those diamonds are the gaps an
   * LED bridges — so a wider gap moves every leg pad and every tile edge the router keeps clear of. Held
   * in lock-step with the sim and the STL export: one gap, one build.
   *
   * Components survive the change: an LED is stored as the pair of faces it straddles, not as a point, so
   * it stays on its gap and simply re-lands on the new leg pads.
   */
  setTileGap(gap: number): void {
    if (gap === this.tileGap) return;
    this.tileGap = gap;
    this.rebuildGeometry();
    // Redraw, don't `emit()`: the circuit itself did not change, and this is called from the controller's
    // own render pass -- emitting would re-enter the store mid-render for a component list that is identical.
    if (!this.overlay.hidden) this.render();
  }

  /** Derive the drawn/clickable geometry from the current pattern and gap. */
  private rebuildGeometry(): void {
    const fold = this.fold;
    this.faces = fold ? flatFaces(fold) : [];
    this.tiles = fold ? tilePolys(fold, this.faces, this.tileGap) : [];
    this.gaps = fold ? gapGraph(fold, this.faces, this.tileGap).gaps : [];
    this.points = fold ? flatPoints(fold) : [];
  }

  /** Set the size the pattern is printed and cut at. Re-plans: the tape is the same 3.25mm of copper
   *  whatever the sheet, so a bigger sheet is relatively narrower tape and a different route. */
  setPrintSize(mm: number): void {
    if (mm === this.sheetMm) return;
    const was = this.scale();
    this.sheetMm = mm;
    // Everything drawn is scaled by `scale()`, so when that moves the framing has to move with it or the view
    // keeps a window sized for the old sheet. Only when it actually moves: on a pattern already at a physical
    // size the print size scales nothing, and refitting would discard the user's pan and zoom for no reason.
    if (this.scale() !== was) this.fitView();
    if (!this.overlay.hidden) this.emit();
  }

  open(): void {
    this.selectTool(this.tool);
    this.syncButtons();
    this.render();
    this.overlay.hidden = false;
    this.emit(); // ask the controller for a fresh plan now that we're visible
  }

  close(): void {
    this.overlay.hidden = true;
  }

  // ---- editing -------------------------------------------------------------

  /** Switch between the two ways of showing (and cutting) the copper. */
  private selectView(mode: ViewMode): void {
    this.viewMode = mode;
    this.render();
  }

  /** Flip the cut about one axis, or unflip it. The circuit itself is untouched — the same LEDs on the same
   *  tiles, drawn and cut from the other side. */
  private toggleMirror(axis: keyof Mirror): void {
    this.mirror = { ...this.mirror, [axis]: !this.mirror[axis] };
    this.syncButtons();
    this.render();
  }

  private selectTool(tool: Tool): void {
    this.tool = tool;
    for (const [t, btn] of this.toolButtons) btn.classList.toggle("is-active", t === tool);
  }

  private clear(): void {
    this.circuit = { leds: [], battery: null };
    this.syncButtons();
    this.emit();
  }

  /** Reflect active state on the toggle-ish toolbar buttons. */
  private syncButtons(): void {
    for (const [t, btn] of this.toolButtons) btn.classList.toggle("is-active", t === this.tool);
    for (const [m, btn] of this.viewButtons) btn.classList.toggle("is-active", m === this.viewMode);
    for (const [axis, btn] of this.mirrorButtons) {
      btn.classList.toggle("is-active", this.mirror[axis]);
      btn.setAttribute("aria-pressed", this.mirror[axis] ? "true" : "false");
    }
  }

  private onCanvasClick(e: MouseEvent): void {
    const flat = this.clientToFlat(e);
    if (!flat) return;
    if (this.tool === "resistor" || this.tool === "switch") {
      // The click is stored as a point and snapped to the nearest run when the plan is built — the routes
      // move whenever the circuit does, so an index along one would name different copper afterwards.
      const near = this.nearestOnRail(flat);
      if (!near || near.dist > this.pickRadius()) return;
      const key = this.tool === "switch" ? "switches" : "resistors";
      const existing = (this.tool === "switch" ? this.circuit.switches : this.circuit.resistors) ?? [];
      // Clicking an existing one takes it off again, as clicking the battery's own tile does.
      const hit = existing.findIndex((r) => Math.hypot(r.x - flat.x, r.y - flat.y) <= this.pickRadius() / 2);
      this.circuit = {
        ...this.circuit,
        [key]: hit >= 0
          ? existing.filter((_, i) => i !== hit)
          : [...existing, { x: near.point.x, y: near.point.y }],
      };
      this.emit();
      return;
    }
    if (this.tool === "battery") {
      // Toggle the single battery on/off the clicked face (it tapes onto a gray tile).
      const face = pointInFace(this.faces, flat);
      if (face < 0) return;
      this.circuit = {
        ...this.circuit,
        battery: this.circuit.battery?.face === face ? null : { face },
      };
    } else {
      // LEDs straddle a gap: snap the click to the nearest hinge between two tiles.
      const hit = nearestGap(this.gaps, flat);
      if (!hit || hit.dist > this.pickRadius()) {
        this.selected = -1; // a tap on bare cloth clears the selection
        this.render();
        return;
      }
      const led = ledOf(hit.gap.faceA, hit.gap.faceB);
      const at = this.circuit.leds.findIndex((l) => l.a === led.a && l.b === led.b);
      if (at >= 0) {
        // An LED already here: select it, so it can be rotated or removed. Tapping it no longer deletes it —
        // deleting on the same gesture that selects would make rotating one impossible.
        this.selected = at;
        this.render();
        return;
      }
      this.circuit = { ...this.circuit, leds: [...this.circuit.leds, led] };
      this.selected = this.circuit.leds.length - 1;
    }
    this.emit();
  }

  /** The nearest point on any run to `p` — where a resistor would break the copper. Either rail: a
   *  resistor in series limits the current the same on the way out as on the way back. */
  private nearestOnRail(p: Vec2): { point: Vec2; dist: number } | null {
    let best: { point: Vec2; dist: number } | null = null;
    for (const t of this.routed.traces) {
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1]!, b = t.pts[i]!;
        const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        if (l2 < 1e-18) continue;
        const u = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        const q = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (!best || d < best.dist) best = { point: q, dist: d };
      }
    }
    return best;
  }

  /** How close (flat mm) a click must land to a hinge to drop an LED there. */
  private pickRadius(): number {
    const diag = Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    return Math.max(2, diag * 0.06);
  }

  /** Download the planned copper as a cutting file, at the width the preview draws. */
  private exportCopper(): void {
    if (!this.fold || !this.routed.traces.length) {
      this.statusEl.textContent = "Nothing to export — place a battery and at least one LED first";
      return;
    }
    const out = buildCopperSvgExport(
      this.fold, this.routed.traces, this.tapeW(), "kiri", this.routed.pads, this.mirror, this.sheetMm, this.routed.resistors, this.partSize(), this.routed.switches,
    );
    this.download(out.filename, out.svg);
    const { pwr, gnd } = out.counts;
    const w = Math.round(out.widthMm * 100) / 100;
    let msg =
      `Exported ${out.filename} — ${pwr} PWR strip${pwr === 1 ? "" : "s"}, ` +
      `${gnd} GND strip${gnd === 1 ? "" : "s"}, ${w}mm wide${this.mirrorNote()}`;
    // The strip width follows the pattern, and a flat pattern need not be at a physical scale.
    if (out.tooNarrow) msg += " — too narrow to cut; scale the pattern up before cutting";
    this.statusEl.textContent = msg;
  }

  /** Turn the selected LED round: swap which of its two pads is `+`.
   *
   *  This also fixes the orientation. Polarity is otherwise the router's to choose — it flips LEDs to clear
   *  crossings — so without pinning it the router would be free to turn the LED straight back. */
  private rotateSelected(): void {
    const led = this.circuit.leds[this.selected];
    if (!led) {
      this.statusEl.textContent = "Select an LED first, then press R to turn it round";
      return;
    }
    // R cycles: the router's choice -> turned round -> back to the router's choice.
    //
    // The third step matters. Fixing an orientation forbids the router from turning that LED, and turning one
    // the wrong way can force a PWR/GND crossing that it would otherwise have avoided -- so there has to be a
    // way to hand the decision back. Without it the first press was permanent.
    const next: boolean | undefined =
      led.flip === undefined ? !this.plannedFlip(this.selected) : undefined;
    this.circuit = {
      ...this.circuit,
      leds: this.circuit.leds.map((l, i) => {
        if (i !== this.selected) return l;
        const { flip: _drop, ...rest } = l;
        return next === undefined ? rest : { ...rest, flip: next };
      }),
    };
    this.emit();
  }

  /** Which way the router currently has this LED, so the first rotate turns it from what is on screen. */
  private plannedFlip(i: number): boolean {
    const led = this.circuit.leds[i];
    const gap = led ? gapForLed(this.gaps, led) : null;
    const pads = this.routed.pads[i];
    if (!gap || !pads) return false;
    return dist2(pads.pwr, gap.legB) < dist2(pads.pwr, gap.legA);
  }

  private removeSelected(): void {
    if (!this.circuit.leds[this.selected]) return;
    this.circuit = {
      ...this.circuit,
      leds: this.circuit.leds.filter((_, i) => i !== this.selected),
    };
    this.selected = -1;
    this.emit();
  }

  /** Draw the edit, then notify the controller so it stores the circuit.
   *  The redraw must happen here: the controller does not push anything back, so an edit that only
   *  emitted would update `this.circuit` and never appear on screen. */
  private emit(): void {
    this.render();
    this.editHandler(cloneCircuit(this.circuit));
  }

  // ---- geometry ------------------------------------------------------------

  private computeBounds(): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    this.bounds = { minX, minY, maxX, maxY };
  }

  /** The drawn pattern box, in the sheet millimetres `tp()` works in — the extent to frame and to clamp the
   *  zoom against. No margin, so framing and zoom stay relative to the pattern rather than to an absolute mm
   *  border: kirigamized models can be a few mm across while AKDE models are ~380mm.
   *
   *  Derived, not stored. It has to agree with `tp()`, and `tp()` scales by the print size, which arrives
   *  after the bounds are computed (`setPrintSize`) and changes again whenever the export menu does. A stored
   *  box was the bug: it held the raw pattern extent while the canvas drew that extent times `scale()`, so on
   *  a scale-less pattern -- house at 4 units, cut at 130mm -- Fit framed a 4mm window of a 130mm drawing,
   *  showing an empty corner of the sheet, and the zoom-out clamp would not open up far enough to find it. */
  private contentBox(): { w: number; h: number } {
    const k = this.scale();
    return {
      w: Math.max((this.bounds.maxX - this.bounds.minX) * k, 1e-3),
      h: Math.max((this.bounds.maxY - this.bounds.minY) * k, 1e-3),
    };
  }

  /** Millimetres of sheet per unit of pattern, as the export uses. The canvas works in sheet millimetres
   *  so that the carrier -- whose geometry is read straight out of the export -- lands on the traces drawn
   *  beside it. A uniform scale changes nothing on screen, since the view is fitted to its own contents. */
  private scale(): number {
    return this.fold ? printScale(this.fold, this.sheetMm) : 1;
  }

  /** The sheet the preview shares with the export: the pattern plus a margin on every side. */
  private sheet(): { w: number; h: number } {
    const k = this.scale();
    return {
      w: (this.bounds.maxX - this.bounds.minX) * k + 2 * MARGIN,
      h: (this.bounds.maxY - this.bounds.minY) * k + 2 * MARGIN,
    };
  }

  /** Flat mm → world (content) space: shift to a positive margin, flip Y like the export, then apply the
   *  same mirror the export will. The canvas has to show the mirrored layout, not merely export one: this is
   *  where the LEDs get placed, and placing them against an unmirrored picture of a mirrored cut is how you
   *  end up with a board that is right in the editor and reversed on the mat. */
  private tp(p: Vec2): Vec2 {
    const { w, h } = this.sheet();
    const k = this.scale();
    return mirrorPoint(
      { x: (p.x - this.bounds.minX) * k + MARGIN, y: (this.bounds.maxY - p.y) * k + MARGIN },
      w,
      h,
      this.mirror,
    );
  }

  /** Pointer client coords → flat mm (accounts for the live viewBox, so pan/zoom-safe). */
  private clientToFlat(e: MouseEvent): Vec2 | null {
    const w = this.clientToWorld(e);
    if (!w) return null;
    // Undo the mirror first — reflection is its own inverse, so the same call takes it back off — then undo
    // the shift and flip. Without this a click would land on the unmirrored twin of the tile under the cursor.
    const sheet = this.sheet();
    const s = mirrorPoint(w, sheet.w, sheet.h, this.mirror);
    const k = this.scale();
    return {
      x: (s.x - MARGIN) / k + this.bounds.minX,
      y: this.bounds.maxY - (s.y - MARGIN) / k,
    };
  }

  /** Pointer client coords → world (content/viewBox) space via the live screen CTM. */
  private clientToWorld(e: MouseEvent): Vec2 | null {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const pt = this.svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());
    return { x: loc.x, y: loc.y };
  }

  // ---- pan / zoom ----------------------------------------------------------

  /** Reset the view to frame the whole pattern with a small relative pad (uniform at any mm scale). */
  private fitView(): void {
    const content = this.contentBox();
    const pad = Math.max(content.w, content.h) * 0.06;
    // The pattern occupies the world rect [MARGIN, MARGIN, content.w, content.h] (see `tp`).
    this.view = { x: MARGIN - pad, y: MARGIN - pad, w: content.w + 2 * pad, h: content.h + 2 * pad };
    this.applyViewBox();
  }

  /** Push the current `view` window onto the SVG viewBox (preserveAspectRatio keeps it undistorted). */
  private applyViewBox(): void {
    const v = this.view;
    this.svg.setAttribute("viewBox", `${fmt(v.x)} ${fmt(v.y)} ${fmt(v.w)} ${fmt(v.h)}`);
  }

  /** Zoom by `factor` (>1 in, <1 out) about a world point (defaults to the view centre). */
  private zoomBy(factor: number, about?: Vec2): void {
    const v = this.view;
    const c = about ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    // Clamp so we never zoom past ~50× in or past the whole content (with slack) out.
    const content = this.contentBox();
    const minW = Math.max(content.w, content.h) / 50;
    const maxW = Math.max(content.w, content.h) * 1.5;
    let nw = v.w / factor;
    nw = Math.min(maxW, Math.max(minW, nw));
    const scale = nw / v.w;
    const nh = v.h * scale;
    // Keep the `about` point fixed under the cursor.
    this.view = { x: c.x - (c.x - v.x) * scale, y: c.y - (c.y - v.y) * scale, w: nw, h: nh };
    this.applyViewBox();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const about = this.clientToWorld(e) ?? undefined;
    this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, about);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pan = { x: e.clientX, y: e.clientY, moved: 0 };
    this.svg.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pan) return;
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return;
    const dxPix = e.clientX - this.pan.x;
    const dyPix = e.clientY - this.pan.y;
    // px → world: ctm.a / ctm.d are world-units-per-pixel inverses (pixels per world unit).
    this.view.x -= dxPix / (ctm.a || 1);
    this.view.y -= dyPix / (ctm.d || 1);
    this.applyViewBox();
    this.pan.moved += Math.abs(dxPix) + Math.abs(dyPix);
    this.pan.x = e.clientX;
    this.pan.y = e.clientY;
  }

  private onPointerUp(e: PointerEvent): void {
    const p = this.pan;
    this.pan = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    // A near-stationary press is a tap → place a component; a drag was a pan.
    if (p && p.moved < 5) this.onCanvasClick(e);
  }

  // ---- rendering -----------------------------------------------------------

  /** Re-plan copper for the current circuit. Cheap enough to do on every edit. */
  private replan(): void {
    this.routed = this.fold ? planRoutes(this.faces, this.gaps, this.circuit, this.sheetMm) : EMPTY_ROUTE;
  }

  private render(): void {
    this.replan();
    this.applyViewBox(); // keep the current pan/zoom window across re-renders

    const parts: string[] = [];
    // Cloth backing (the full flat faces) under everything — the fabric the tiles sit on.
    for (const f of this.faces) {
      if (f.poly.length < 3) continue;
      const d = "M " + f.poly.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z";
      parts.push(`<path d="${d}" class="el-cloth" />`);
    }
    // Gray rigid tiles (the 3D-printed inset polygons, flat at 0% fold) — what gets cut. The empty
    // diamonds between them are the gaps an LED bridges.
    for (const t of this.tiles) {
      if (t.ring.length < 3) continue;
      const d = "M " + t.ring.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z";
      parts.push(`<path d="${d}" class="el-tile" />`);
    }
    // In carrier view, the frame and its tabs — the single piece of copper the traces arrive on.
    if (this.viewMode === "carrier" && this.routed.traces.length) {
      parts.push(...this.carrierParts());
    }
    // Windows to take out of the copper: an SPDT's idle throw needs bare pattern under it, or the part is
    // wired to the rail in both positions and switches nothing. The canvas has to cut them too — showing
    // unbroken tape there is showing a circuit that does not exist.
    const windows = this.routed.switches
      .map((w) => switchShape(this.tp(w.a), this.tp(w.b), this.tapeW() * this.scale(), this.partSize(), w.flip)?.notch)
      .filter((n): n is Vec2[] => !!n && n.length >= 3);

    // Copper tape, under the components so the pads and terminals stay readable on top of it.
    for (const t of this.routed.traces) {
      const cls = t.net === "pwr" ? "el-tape el-tape-pwr" : "el-tape el-tape-gnd";
      // One path per run, not one per segment. Drawing each segment separately gave every bend a seam, so a
      // single continuous strip read as a row of loose rectangles -- which is what it is not: each run is one
      // piece of tape, and the joins are mitred corners in it.
      if (t.pts.length < 2) continue;
      // The outline that will be cut, not a stroke down the middle of it. Drawing the centreline at a
      // constant width hid the one thing the cut file has to get right -- the narrowing that keeps the two
      // nets apart under a chip -- so the canvas showed clean tape where the copper actually met.
      const ring = stripOutline(t, this.tapeW(), this.routed.pads);
      if (ring.length < 3) continue;
      const outer = ring.map((p) => this.tp(p));
      const sub = (r: Vec2[]): string =>
        "M " + r.map((p, k) => (k === 0 ? "" : "L ") + ptStr(p)).join(" ") + " Z";
      // Any window falling inside this strip rides on its path, so `evenodd` reads it as a hole rather than
      // as more copper. A separate path would simply lie on top and hide nothing.
      const mine = windows.filter((n) => inRing(centreOf(n), outer));
      parts.push(
        `<path d="${[sub(outer), ...mine.map(sub)].join(" ")}" class="${cls}" fill-rule="evenodd" />`,
      );
    }
    // The resistors, over the breaks they bridge: grey leads onto the copper either side, black body across
    // the bare pattern between them, where there is deliberately no copper at all.
    for (const r of this.routed.resistors) {
      // The same shape the cut files draw, so the canvas cannot drift from them.
      const sh = resistorShape(this.tp(r.a), this.tp(r.b), this.tapeW() * this.scale(), this.partSize());
      if (!sh) continue;
      const { leads, body } = sh;
      for (const l of leads) {
        parts.push(
          `<line x1="${fmt(l.a.x)}" y1="${fmt(l.a.y)}" x2="${fmt(l.b.x)}" y2="${fmt(l.b.y)}" class="el-res-lead" stroke-width="${fmt(l.width)}" />`,
        );
      }
      parts.push(
        `<rect x="${fmt(body.x)}" y="${fmt(body.y)}" width="${fmt(body.w)}" height="${fmt(body.h)}" rx="${fmt(body.h * 0.18)}" class="el-res-body" transform="rotate(${fmt(body.angle)} ${fmt(body.cx)} ${fmt(body.cy)})" />`,
      );
    }
    for (const w of this.routed.switches) {
      const sh = switchShape(this.tp(w.a), this.tp(w.b), this.tapeW() * this.scale(), this.partSize(), w.flip);
      if (!sh) continue;
      // Housing first, then the legs and the mounting holes over it — the order the cut files use. A part's
      // legs do run under its body, but every terminal of this one falls inside the housing's outline, so
      // drawing the body last hid all three: the one thing you look at a footprint to see.
      const bd = sh.body;
      parts.push(
        `<rect x="${fmt(bd.x)}" y="${fmt(bd.y)}" width="${fmt(bd.w)}" height="${fmt(bd.h)}" rx="${fmt(bd.h * 0.18)}" class="el-res-body" transform="rotate(${fmt(bd.angle)} ${fmt(bd.cx)} ${fmt(bd.cy)})" />`,
      );
      for (const l of sh.leads) {
        parts.push(
          `<line x1="${fmt(l.a.x)}" y1="${fmt(l.a.y)}" x2="${fmt(l.b.x)}" y2="${fmt(l.b.y)}" class="el-res-lead" stroke-width="${fmt(l.width)}" />`,
        );
      }
      for (const h of sh.holes ?? []) {
        parts.push(
          `<circle cx="${fmt(h.c.x)}" cy="${fmt(h.c.y)}" r="${fmt(h.r)}" class="el-res-hole" stroke-width="${fmt(h.r * 0.5)}" />`,
        );
      }
    }
    // Each LED is two distinct pads straddling its hinge — a PWR (+) pad toward face `a` and a GND (−)
    // pad toward face `b` — bridged by the LED chip. An LED whose gap no longer exists has nowhere to
    // sit and is drawn as an orphan.
    this.circuit.leds.forEach((led, i) => {
      const gap = gapForLed(this.gaps, led);
      if (!gap) return;
      const orphan = this.routed.unreachable.includes(i);
      const mid = gap.point;
      // Polarity is whatever the router landed on, so the drawn `+`/`−` is the orientation to build.
      const planned = this.routed.pads[i];
      const pwrLeg = planned && !isZero(planned.pwr) ? planned.pwr : gap.legA;
      const gndLeg = planned && !isZero(planned.gnd) ? planned.gnd : gap.legB;
      const r = this.markerR();
      const rPad = r * 0.62;
      // Pads sit on the pinched leg positions — where a conductor would have to land. Degenerate pinch →
      // straddle the hinge perpendicular so the two are still distinguishable.
      let pwrPt = pwrLeg, gndPt = gndLeg;
      if (Math.hypot(pwrLeg.x - gndLeg.x, pwrLeg.y - gndLeg.y) < 1e-6) {
        const [e0, e1] = gap.ends; // perpendicular to the shared edge
        let ax = -(e1.y - e0.y), ay = e1.x - e0.x;
        const al = Math.hypot(ax, ay) || 1;
        ax /= al; ay /= al;
        const sep = r * 1.25;
        pwrPt = { x: mid.x + ax * sep, y: mid.y + ay * sep };
        gndPt = { x: mid.x - ax * sep, y: mid.y - ay * sep };
      }
      const pwr = this.tp(pwrPt);
      const gnd = this.tp(gndPt);
      const o = orphan ? " el-led-orphan" : "";
      if (i === this.selected) {
        const mid2 = { x: (pwr.x + gnd.x) / 2, y: (pwr.y + gnd.y) / 2 };
        parts.push(
          `<circle cx="${fmt(mid2.x)}" cy="${fmt(mid2.y)}" r="${fmt(r * 1.5)}" class="el-led-selected" />`,
        );
      }
      // LED chip bridging the two pads, then the two coloured pads on top.
      parts.push(
        `<line x1="${fmt(pwr.x)}" y1="${fmt(pwr.y)}" x2="${fmt(gnd.x)}" y2="${fmt(gnd.y)}" class="el-led-body${o}" stroke-width="${fmt(rPad * 0.9)}" />`,
      );
      parts.push(`<circle cx="${fmt(pwr.x)}" cy="${fmt(pwr.y)}" r="${fmt(rPad)}" class="el-led-pwr${o}" />`);
      parts.push(`<circle cx="${fmt(gnd.x)}" cy="${fmt(gnd.y)}" r="${fmt(rPad)}" class="el-led-gnd${o}" />`);
    });
    // Battery: two terminal squares — PWR (+) red and GND (−) dark — so each net leaves its own pad.
    if (this.circuit.battery) {
      const f = this.faces[this.circuit.battery.face];
      if (f) {
        const term = this.defaultTerminals(f.centroid, f.poly);
        // The size the router settled on, which may be smaller than the wanted one where the tile is tight —
        // the drawn pad and the planned pad have to be the same pad.
        const rSq = term.half * this.scale();
        const sq = (p: Vec2, cls: string, sign: string): void => {
          const c = this.tp(p);
          parts.push(
            `<rect x="${fmt(c.x - rSq)}" y="${fmt(c.y - rSq)}" width="${fmt(2 * rSq)}" height="${fmt(2 * rSq)}" rx="${fmt(rSq * 0.22)}" class="${cls}" />`,
          );
          parts.push(`<text x="${fmt(c.x)}" y="${fmt(c.y)}" class="el-batt-sign" font-size="${fmt(rSq * 1.5)}">${sign}</text>`);
        };
        sq(term.gnd, "el-batt el-batt-gnd", "−");
        sq(term.pwr, "el-batt el-batt-pwr", "+");
      }
    }
    this.svg.innerHTML = parts.join("");
    this.renderStatus();
  }

  /** The carrier frame and its tabs, taken from the export itself.
   *
   *  Deriving them again here would let the preview drift from the file — and it did: the export learned to bend
   *  tabs around the other net while this still drew a straight line to the nearest wall. The preview's world
   *  coordinates are the export's sheet coordinates (same margin, same bounds, same Y-flip), so the geometry
   *  needs no conversion. */
  private carrierParts(): string[] {
    if (!this.fold) return [];
    const out = buildCopperCarrierExport(
      this.fold, this.routed.traces, this.tapeW(), "kiri", this.keepOff(), this.mirror, this.sheetMm,
      this.routed.pads, this.routed.resistors, this.partSize(), this.routed.switches,
    );
    const ring = (r: { x0: number; y0: number; x1: number; y1: number }): string => {
      const c = [
        { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
      ];
      return "M " + c.map((p, i) => (i === 0 ? "" : "L ") + ptStr(p)).join(" ") + " Z";
    };
    const parts: string[] = [
      // The frame: outer edge with the window as a hole, so it reads as a border rather than a filled sheet.
      `<path d="${ring(out.frame.outer)} ${ring(out.frame.window)}" class="el-carrier" fill-rule="evenodd" />`,
    ];
    for (const path of out.tabPaths) {
      if (path.length < 2) continue;
      const d = "M " + path.map((p, i) => (i === 0 ? "" : "L ") + ptStr(p)).join(" ");
      parts.push(`<path d="${d}" class="el-carrier-tab" fill="none" stroke-width="${fmt(this.tapeW() * this.scale())}" />`);
    }
    return parts;
  }

  /** Pads and battery terminals — the spots a carrier tab must not grip, since a tab there sits under the
   *  component and snipping it would cut at the pad. */
  private keepOff(): Vec2[] {
    const out: Vec2[] = [];
    for (const p of this.routed.pads) {
      if (!isZero(p.pwr)) out.push(p.pwr);
      if (!isZero(p.gnd)) out.push(p.gnd);
    }
    const batt = this.circuit.battery;
    const face = batt ? this.faces[batt.face] : null;
    if (face) {
      const t = this.defaultTerminals(face.centroid, face.poly);
      out.push(t.pwr, t.gnd);
    }
    return out;
  }

  /** Download the carrier: one piece of copper with every trace held in place. */
  private exportCarrier(): void {
    if (!this.fold || !this.routed.traces.length) {
      this.statusEl.textContent = "Nothing to export — place a battery and at least one LED first";
      return;
    }
    const out = buildCopperCarrierExport(
      this.fold, this.routed.traces, this.tapeW(), "kiri", this.keepOff(), this.mirror, this.sheetMm,
      this.routed.pads, this.routed.resistors, this.partSize(), this.routed.switches,
    );
    this.download(out.filename, out.svg);
    const w = Math.round(out.widthMm * 100) / 100;
    let msg =
      `Exported ${out.filename} — one frame holding ${out.counts.traces} trace` +
      `${out.counts.traces === 1 ? "" : "s"}, ${out.counts.tabs} tab` +
      `${out.counts.tabs === 1 ? "" : "s"} to snip, ${w}mm wide${this.mirrorNote()}`;
    if (out.padTabs > 0) {
      msg += ` — ${out.padTabs} tab${out.padTabs === 1 ? "" : "s"} grip a pad (run too short to grip elsewhere)`;
    }
    if (out.componentTabs > 0) {
      msg += ` — warning: ${out.componentTabs} tab${out.componentTabs === 1 ? "" : "s"} pass over a component`;
    }
    if (out.crossingTabs > 0) {
      msg += ` — warning: ${out.crossingTabs} tab${out.crossingTabs === 1 ? "" : "s"} cross another trace`;
    }
    if (out.unclosedCuts > 0) {
      // The carrier is cut as a solid shape. Where a stretch of its edge would not close into a loop it is
      // drawn as a plain line instead: it still cuts, but that part arrives as line art rather than copper,
      // and in software that reads shapes it will look like an outline. Worth saying, since the file opens
      // looking almost right.
      msg +=
        ` — ${out.unclosedCuts} cut${out.unclosedCuts === 1 ? "" : "s"} could not be closed into a shape` +
        ` and ${out.unclosedCuts === 1 ? "is" : "are"} drawn as ${out.unclosedCuts === 1 ? "a line" : "lines"}`;
    }
    if (out.tooNarrow) msg += " — too narrow to cut; scale the pattern up before cutting";
    this.statusEl.textContent = msg;
  }

  /** Says so when the file just saved is a mirror image, since the shape alone will not tell you. */
  private mirrorNote(): string {
    if (!this.mirror.x && !this.mirror.y) return "";
    const axes = [this.mirror.x ? "left-right" : "", this.mirror.y ? "top-bottom" : ""].filter(Boolean);
    return ` — mirrored ${axes.join(" and ")}`;
  }

  private download(filename: string, svg: string): void {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** How wide a part is drawn across its run: an LED's two pads span this, so a resistor beside one comes
   *  out the same size rather than to its own scale. */
  private partSize(): number {
    return this.ledPad() * 2;
  }

  /**
   * An LED pad's radius, in sheet millimetres: the 1206 footprint's own pad, read from the part's KiCad file by way of
   * `ocaml/footprints.ml` — `.064 x .068in`, so 1.63 by 1.73mm. Taken as a radius across the smaller of the
   * two, since the pad is drawn round.
   *
   * A real part at a real size, rather than a marker scaled to the pattern. It stays legible because the
   * canvas is in millimetres and fits itself to the sheet: on a big pattern the part is genuinely small,
   * which is the truth of it.
   */
  private ledPad(): number {
    return Math.min(LED.pad.w, LED.pad.h) / 2;
  }

  /** Marker radius: the LED's pad, with the ring and chip drawn in proportion to it. */
  private markerR(): number {
    return this.ledPad() / 0.62;
  }

  /** The battery's two terminals. Shared with the router so the copper lands on the drawn squares. */
  private defaultTerminals(c: Vec2, poly?: Vec2[]): Terminals {
    // The tape width MUST be the router's, not the default: the terminal spacing is derived from it, so a
    // different width here draws the two pads somewhere the copper never goes. On a pattern read as a 130mm
    // sheet the default 6.5 put them several pattern-widths off the tile — off-canvas entirely.
    return batteryTerminals(c, this.diag(), poly, this.tapeW());
  }

  /** Tape width. Shared with the router, so the strips drawn are the strips it planned clearances for. */
  private tapeW(): number {
    return tapeWidthFor(this.faces, this.sheetMm);
  }

  private diag(): number {
    return Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY) || 1;
  }

  private renderStatus(): void {
    const n = this.circuit.leds.length;
    const batt = this.circuit.battery ? "battery set" : "no battery";
    let msg = `${n} LED${n === 1 ? "" : "s"} · ${batt}`;
    if (!this.circuit.battery && n > 0) msg += " · add a battery";
    const un = this.routed.unreachable.length;
    if (un > 0 && this.circuit.battery) msg += ` · ${un} unreachable`;
    // A part that would not fit is dropped by the router, and without this it disappeared without a word:
    // the click registered, the circuit kept it, and nothing appeared on the canvas.
    const short = [
      ["switch", (this.circuit.switches ?? []).length - this.routed.switches.length],
      ["resistor", (this.circuit.resistors ?? []).length - this.routed.resistors.length],
    ] as const;
    for (const [what, missing] of short) {
      if (missing > 0) {
        msg += ` · ${missing} ${what}${missing === 1 ? "" : "s"} did not fit — that run is too short for the part`;
      }
    }
    if (this.circuit.leds[this.selected]) {
      const fixed = this.circuit.leds[this.selected]!.flip !== undefined;
      msg += ` · LED ${this.selected + 1} selected — R to turn it round, Delete to remove`;
      msg += fixed ? " (orientation fixed — R again to let the router choose)" : " (router chooses)";
    } else if (n > 0) {
      msg += " · click an LED to select it";
    }
    this.statusEl.textContent = msg;
  }
}

function cloneCircuit(c: Circuit): Circuit {
  return {
    // `flip` travels with the LED: it is the author's decision about which way round the part goes, and a
    // clone that dropped it would lose the rotation the moment the circuit reached the store.
    leds: c.leds.map((l) => (l.flip === undefined ? { a: l.a, b: l.b } : { a: l.a, b: l.b, flip: l.flip })),
    battery: c.battery ? { face: c.battery.face } : null,
    // Likewise the resistors: a clone that dropped them would draw one on the canvas and lose it the moment
    // the circuit reached the store — gone from the folded model, and from the next render back.
    resistors: (c.resistors ?? []).map((r) => ({ x: r.x, y: r.y })),
    switches: (c.switches ?? []).map((r) => ({ x: r.x, y: r.y })),
  };
}

const isZero = (p: Vec2): boolean => p.x === 0 && p.y === 0;
const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");
const ptStr = (p: Vec2): string => `${fmt(p.x)} ${fmt(p.y)}`;

/** The average of a ring's corners — good enough to say which strip a small window sits in. */
function centreOf(ring: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

/** Winding containment, matching the export's. */
function inRing(p: Vec2, ring: Vec2[]): boolean {
  let w = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
  }
  return w;
}
