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
  gapForLed,
  gapGraph,
  ledOf,
  nearestGap,
  pointInFace,
  tilePolys,
} from "../model/electronics.js";
import { type RoutedCircuit, EMPTY_ROUTE, batteryTerminals, planRoutes } from "../model/electronics-routing.js";
import type { FoldFile } from "../model/fold-file.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = 8; // mm — must match the SVG export so preview ↔ export register

type Tool = "led" | "battery";

export class ElectronicsModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly statusEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();

  private tool: Tool = "led";
  private fold: FoldFile | null = null;
  private faces: FlatFace[] = [];
  private tiles: TilePoly[] = [];
  private gaps: GapEdge[] = [];
  private points: Vec2[] = [];
  private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private circuit: Circuit = { leds: [], battery: null };
  private routed: RoutedCircuit = EMPTY_ROUTE;

  // Pan/zoom: `content` is the full pattern box (mm + margin); `view` is the visible window into it.
  private content = { w: 1, h: 1 };
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
            </span>
            <span class="el-group">
              <button type="button" class="el-clear" title="Remove all LEDs, the battery and routes">Clear</button>
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
      if (e.key === "Escape") this.close();
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
    this.faces = fold ? flatFaces(fold) : [];
    this.tiles = fold ? tilePolys(fold, this.faces) : [];
    this.gaps = fold ? gapGraph(fold, this.faces).gaps : [];
    this.points = fold ? flatPoints(fold) : [];
    this.circuit = { leds: [], battery: null };
    this.computeBounds();
    this.fitView();
    this.syncButtons();
    if (!this.overlay.hidden) this.render();
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
  }

  private onCanvasClick(e: MouseEvent): void {
    const flat = this.clientToFlat(e);
    if (!flat) return;
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
      if (!hit || hit.dist > this.pickRadius()) return;
      const led = ledOf(hit.gap.faceA, hit.gap.faceB);
      const has = this.circuit.leds.some((l) => l.a === led.a && l.b === led.b);
      this.circuit = {
        ...this.circuit,
        leds: has
          ? this.circuit.leds.filter((l) => !(l.a === led.a && l.b === led.b))
          : [...this.circuit.leds, led],
      };
    }
    this.emit();
  }

  /** How close (flat mm) a click must land to a hinge to drop an LED there. */
  private pickRadius(): number {
    const diag = Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    return Math.max(2, diag * 0.06);
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
    // Content is the PATTERN extent (no margin) so framing/zoom are relative to the pattern, not to
    // an absolute mm margin — kirigamized models can be a few mm across while AKDE models are ~80mm.
    this.content = { w: Math.max(maxX - minX, 1e-3), h: Math.max(maxY - minY, 1e-3) };
  }

  /** Flat mm → world (content) space: shift to a positive margin, flip Y like the export. */
  private tp(p: Vec2): Vec2 {
    return { x: p.x - this.bounds.minX + MARGIN, y: this.bounds.maxY - p.y + MARGIN };
  }

  /** Pointer client coords → flat mm (accounts for the live viewBox, so pan/zoom-safe). */
  private clientToFlat(e: MouseEvent): Vec2 | null {
    const w = this.clientToWorld(e);
    if (!w) return null;
    return { x: w.x + this.bounds.minX - MARGIN, y: this.bounds.maxY + MARGIN - w.y };
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
    const pad = Math.max(this.content.w, this.content.h) * 0.06;
    // The pattern occupies the world rect [MARGIN, MARGIN, content.w, content.h] (see `tp`).
    this.view = { x: MARGIN - pad, y: MARGIN - pad, w: this.content.w + 2 * pad, h: this.content.h + 2 * pad };
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
    const minW = Math.max(this.content.w, this.content.h) / 50;
    const maxW = Math.max(this.content.w, this.content.h) * 1.5;
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
    this.routed = this.fold ? planRoutes(this.faces, this.gaps, this.circuit) : EMPTY_ROUTE;
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
    // Copper tape, under the components so the pads and terminals stay readable on top of it.
    for (const t of this.routed.traces) {
      const cls = t.net === "pwr" ? "el-tape el-tape-pwr" : "el-tape el-tape-gnd";
      // Segment by segment rather than one polyline: butt caps then give each run square ends, so it reads
      // as a rectangle of tape at its real width instead of a rounded line.
      for (let k = 1; k < t.pts.length; k++) {
        const a = this.tp(t.pts[k - 1]!);
        const b = this.tp(t.pts[k]!);
        parts.push(
          `<path d="M ${ptStr(a)} L ${ptStr(b)}" class="${cls}" stroke-width="${fmt(this.tapeW())}" />`,
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
        const term = this.defaultTerminals(f.centroid);
        const rSq = this.markerR() * 0.95;
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

  /** Marker radius scaled to the pattern so it reads at any model size. */
  private markerR(): number {
    return this.diag() * 0.012;
  }

  /** The battery's two terminals. Shared with the router so the copper lands on the drawn squares. */
  private defaultTerminals(c: Vec2): { pwr: Vec2; gnd: Vec2 } {
    return batteryTerminals(c, this.diag());
  }

  /** Tape width, scaled to the pattern like every other marker here. Real copper tape is wide relative to
   *  these features, so this is deliberately chunky rather than a hairline. */
  private tapeW(): number {
    return this.diag() * 0.011;
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
    this.statusEl.textContent = msg;
  }
}

function cloneCircuit(c: Circuit): Circuit {
  return {
    leds: c.leds.map((l) => ({ a: l.a, b: l.b })),
    battery: c.battery ? { face: c.battery.face } : null,
  };
}

const isZero = (p: Vec2): boolean => p.x === 0 && p.y === 0;
const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "0");
const ptStr = (p: Vec2): string => `${fmt(p.x)} ${fmt(p.y)}`;
