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
  type ResistorShape,
  mirrorPoint,
  partShape,
  resistorShape,
  stripOutline,
  switchShape,
} from "../model/copper-svg-export.js";
import { PCB_COLOURS, designators, partSvg } from "../model/part-render.js";
import { printScale } from "../model/print-scale.js";
import { LED, placement } from "../model/parts.js";
import type { Footprint } from "../model/footprint.js";
import { type Component, BAT_COIN_20, COMPONENTS, R_1206, SW_SPDT } from "../model/footprints.generated.js";
import {
  type RoutedCircuit,
  type Terminals,
  EMPTY_ROUTE,
  TAPE_MM,
  tapeWidthFor,
  batteryTerminals,
  partFit,
  planRoutes,
} from "../model/electronics-routing.js";
import { TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import type { FoldFile } from "../model/fold-file.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = 8; // mm — must match the SVG export so preview ↔ export register

/**
 * What the next click on the canvas does.
 *
 * `led` and `battery` are placements of their own — an LED straddles a hinge and the battery pins to a
 * face, so neither is a part in series on a rail. `resistor` and `switch` are the two parts that predate
 * the library and keep their own fields on the {@link Circuit}; they are no longer offered in the palette
 * (the library's own `R_1206` and `SW_SPDT` place the same parts through the generic path) but the tools
 * stay so a circuit authored before the library still edits. Every other value is a `Component.id`.
 */
type Tool = "led" | "battery" | "resistor" | "switch" | (string & {});

/**
 * What the last tap picked up.
 *
 * `kind` names the list on the {@link Circuit} that `index` is into: an LED, a library part, or one of the
 * two legacy lists. Every one of them selects, turns round and deletes by the same three gestures — a
 * capacitor is no less a component than an LED, and having only LEDs answer to them was the odd part.
 */
type Selection = { kind: "led" | PartKind; index: number };

/** The three kinds that sit in series on a rail — everything but the LED, which straddles a hinge. */
type PartKind = "part" | "resistor" | "switch";

/** A selection known to be one of those. */
type PartSelection = { kind: PartKind; index: number };

/** The `Circuit` field each selectable-part kind lives in. LEDs are not here: they are placed on a hinge
 *  rather than on a rail, and are handled on their own throughout. */
const PART_FIELD = { part: "parts", resistor: "resistors", switch: "switches" } as const;

/** A part in series on a rail, whichever of the three lists it came from. */
type PlacedOnRail = { x: number; y: number; flip?: boolean };

/**
 * The smallest a placed part's pick-up target may be, in millimetres of the sheet.
 *
 * A tap picks a part up when it lands within the part's own extent along the rail, so that two parts a few
 * millimetres apart are two targets and not one. That leaves a 1206 chip a 3mm target, which is small but
 * honest; this floor keeps anything smaller from becoming unpickable.
 */
const PART_PICK_FLOOR_MM = 2;

/** The parts the two fixed tools already place, so the palette does not offer them a second time. */
const FIXED_PLACEMENT = new Set<Footprint>([LED.footprint, BAT_COIN_20]);

/**
 * How the palette shelves the parts it offers, first match winning.
 *
 * Presentation only, and name-based because the FabLib's filenames are the only thing there is to
 * shelve by — a footprint carries its geometry, not its aisle. Forty entries in one scroll is a wall;
 * forty in nine shelves of five is a menu. Anything the table does not recognise lands under "Other"
 * rather than vanishing, so a part added to the library is always somewhere.
 */
const PART_GROUPS: { label: string; match: RegExp }[] = [
  { label: "LEDs", match: /^LED/ },
  { label: "Resistors", match: /^R_/ },
  { label: "Capacitors", match: /^CP?_/ },
  { label: "Diodes & transistors", match: /^(Diode|SOD|SOT|TO[-_]|Q_|Bridge)/ },
  { label: "Switches & buttons", match: /^(Switch|SW_|Button|Jumper|Potentiometer)/ },
  { label: "Headers & sockets", match: /^(PinHeader|PinSocket|Header)/ },
  { label: "Connectors & terminals", match: /^(Conn|TerminalBlock)/ },
  { label: "Power", match: /^(Battery|BAT_)/ },
  { label: "Other", match: /^/ },
];

/**
 * The palette's contents: the library parts that go in series on a rail, and the ones that do not with
 * the reason ready to read out.
 *
 * The rule is {@link placement}'s, not this file's. It is the same reading of a footprint that
 * `partFit` and `acrossPart` route and draw by, so the palette cannot offer a part the router would
 * then refuse — which is the whole reason it does not live here.
 *
 * These grow: the library arrives in two halves, and {@link admit} is asked the same question about
 * both. Which half a part came from decides only when it loads, never whether it can be placed.
 */
const OFFERED: Component[] = [];
const BLOCKED: { component: Component; why: string }[] = [];
const PART_BY_ID = new Map<string, Component>();
/** Which shelf each offered part sits on, worked out once as it is admitted. */
const GROUP_OF = new Map<string, string>();

/**
 * Sort a batch of library parts onto the shelves, or onto the list of what cannot be placed.
 *
 * Idempotent by id, so loading the second half twice cannot double the list, and sorted afterwards so
 * the picker reads the same however the halves arrived.
 */
function admit(parts: readonly Component[]): void {
  const known = new Set([...PART_BY_ID.keys(), ...BLOCKED.map((b) => b.component.id)]);
  for (const c of parts) {
    if (FIXED_PLACEMENT.has(c.footprint) || known.has(c.id)) continue;
    known.add(c.id);
    const p = placement(c.footprint);
    if (!p.placeable) {
      BLOCKED.push({ component: c, why: p.why });
      continue;
    }
    OFFERED.push(c);
    PART_BY_ID.set(c.id, c);
    GROUP_OF.set(c.id, PART_GROUPS.find((g) => g.match.test(c.id))!.label);
  }
  OFFERED.sort((a, b) => a.id.localeCompare(b.id));
  BLOCKED.sort((a, b) => a.component.id.localeCompare(b.component.id));
}

admit(COMPONENTS);

/**
 * Fetch the half of the library that is not in the main bundle.
 *
 * A megabyte of pad outlines for parts that cannot be placed has no business in the initial download,
 * so the generator emits them separately — but they still have to be *findable*, or a user hunting for
 * a USB socket concludes the app is broken rather than that the part cannot be wired this way. So the
 * modal pulls them in the first time it opens, and the picker grows when they land.
 *
 * Fetched once, and a failure is not fatal: the palette carries on offering what it already has.
 */
let restRequest: Promise<void> | null = null;
function loadRestOfLibrary(): Promise<void> {
  restRequest ??= import("../model/footprints.rest.generated.js")
    .then((m) => admit(m.REST_COMPONENTS))
    .catch(() => {});
  return restRequest;
}

/**
 * How many parts the palette will spell out when a search turns up ones it cannot place.
 *
 * Enough to see that the thing you searched for is in the library, short enough that the answer stays a
 * glance. The tail is counted rather than listed.
 */
const BLOCKED_SHOWN = 12;

/**
 * What a part is called in the picker: its library id, then the human note.
 *
 * The id leads because it is the half that is unique. The FabLib's notes come from the footprints' own
 * `descr`, and four different pin headers all describe themselves as "Through hole straight pin
 * header" — put that first and a shelf reads as the same row four times over, with the part number cut
 * off the end. The id sorts sensibly within a shelf too. The note follows it, and both are searched.
 */
function partLabel(c: Component): string {
  return c.note ? `${c.id} · ${c.note}` : c.id;
}

/**
 * The line beside the picker: how much of the library is on offer, and how much of it never can be.
 *
 * It is there so the picker is never read as the whole library. Most of the FabLib cannot go in series
 * on a rail, and a list that simply omitted those would have a user conclude the parts are missing
 * rather than unusable — so the count says out loud that there are more, and that searching finds them.
 */
function paletteCount(searching: boolean, shown: number, blocked: number): string {
  if (!searching) {
    const rest = BLOCKED.length;
    const all = `${OFFERED.length} of ${OFFERED.length + rest} parts go in series on a rail`;
    return rest === 0 ? all : `${all} — search to see the other ${rest}`;
  }
  const found = `${shown} match`;
  return blocked === 0 ? found : `${found} · ${blocked} in the library but not placeable`;
}

/** Whether every whitespace-separated term of `query` appears in the part's note or id. */
function matches(c: Component, terms: string[]): boolean {
  const hay = `${c.id} ${c.note}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** How the copper is shown, matching the two ways it can be cut.
 *
 *  `strips` is the copper as separate pieces. `carrier` is the 3-layer build: one piece of copper cut as a
 *  frame around the unfolded pattern with every trace held inside it on thin tabs, so the traces arrive
 *  already positioned — align the frame, press them down, snip the tabs, lift the frame away. */
type ViewMode = "strips" | "carrier";

/**
 * How much of the view a pad must be worth before its own name is written on it.
 *
 * Deliberately well above the point where the text is merely emittable. A pin name is written *inside* the
 * pad it names, so a barely-legible one is worse than none: it covers the copper, which is the thing the
 * drawing exists to show. The designator has no such problem — it sits beside the part in clear space — so
 * the two appear at different zooms, and this is the later of them.
 */
const PAD_LABEL_VIEW_FRACTION = 0.035;

/** The canvas width in pixels to assume when the element cannot say (a headless DOM, mostly). */
const CANVAS_PX = 900;

/**
 * How many screen pixels one "rendered millimetre" is taken to be.
 *
 * {@link partSvg} suppresses text below a floor expressed in rendered millimetres — the size the label
 * comes out at, not the size it is in the sheet — and `scale` is what tells it the two differ. On a screen
 * the honest conversion is about four pixels to the millimetre, but four pixels of text is not a word.
 * Eighteen is where, looking at the rendered canvas, a glyph stops being a smear and starts being a
 * character — at Fit on a whole sheet nothing is written at all, which is right, because there is nothing
 * there big enough to write on.
 */
const PX_PER_RENDERED_MM = 18;

export class ElectronicsModal {
  private readonly overlay: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly svg: SVGSVGElement;
  private readonly statusEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly viewButtons = new Map<ViewMode, HTMLButtonElement>();
  private readonly mirrorButtons = new Map<keyof Mirror, HTMLButtonElement>();
  /** The library picker — one control for the whole library, so a part added to it costs no toolbar room. */
  private readonly partSelect: HTMLSelectElement;
  /** Narrows the picker. At 159 footprints the list is longer than the screen and the names are things
   *  like `Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm`; typing is the only way in. */
  private readonly partSearch: HTMLInputElement;
  /** Says how much of the library the picker is showing, and how much of it can never be shown. */
  private readonly partCount: HTMLElement;
  /** Settles once the lazily-loaded half of the library has reached the picker. */
  private libraryReady: Promise<void> = Promise.resolve();

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
  /** What the cursor's last tap picked up — an LED or a part on a rail — or null. */
  private selected: Selection | null = null;
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
  /** The zoom step the parts were last painted at — see {@link zoomStep}. */
  private drawnZoomStep = NaN;

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
            <span class="el-group el-parts">
              <label class="el-part-label" for="el-part">Part</label>
              <input type="search" id="el-part-search" class="el-part-search" placeholder="Search the library" aria-label="Search the component library" autocomplete="off">
              <select id="el-part" class="el-part" title="Pick a library part, then click either rail to place it. The copper is broken there, so the tape does not short the part out"></select>
              <span class="el-part-count" aria-live="polite"></span>
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
              <span class="el-key el-key-pad" style="color:${PCB_COLOURS.mask}">▮ Part pad, as it is cut</span>
              <span class="el-key el-key-des" style="color:${PCB_COLOURS.componentLabel}">R1 Part label</span>
            </p>
            <span class="sim-status el-status"></span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.svg = this.overlay.querySelector(".el-svg")!;
    this.statusEl = this.overlay.querySelector(".el-status")!;
    this.partSelect = this.overlay.querySelector(".el-part")!;
    this.partSearch = this.overlay.querySelector(".el-part-search")!;
    this.partCount = this.overlay.querySelector(".el-part-count")!;
    this.fillPalette();
    // The browser would default a select to its first option; say so explicitly, so `value` names a real
    // part before anyone has touched it and the two agree from the start.
    this.partSelect.value = OFFERED[0]?.id ?? "";
    // Picking a part IS choosing the tool — there is no separate "place a part" button to arm first. A
    // plain click re-arms it too, so coming back from the LED tool is one gesture rather than two.
    this.partSelect.addEventListener("change", () => this.armPicked());
    this.partSelect.addEventListener("click", () => this.armPicked());
    // Typing narrows the list; it never arms anything. Re-arming on every keystroke would change what the
    // next click on the canvas places while the user is still reading the names.
    for (const ev of ["input", "search"]) this.partSearch.addEventListener(ev, () => this.fillPalette());

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
    this.selected = null;
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
    // The rest of the library is not in the main bundle. Ask for it now rather than at start-up, and
    // redraw the picker when it lands, so a search can turn up the parts that cannot be placed and say
    // why. Held so a caller — a test, mostly — can wait for the library to be whole.
    this.libraryReady = loadRestOfLibrary().then(() => this.fillPalette());
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
    this.syncButtons();
  }

  /**
   * Arm whatever the picker is showing — but only if it is a part that can actually be placed.
   *
   * The picker also carries rows for parts the rail cannot pass through, so that searching for a USB
   * socket finds it and says why it is not on offer. Those rows are disabled and carry no value, and a
   * browser that lets one through anyway must not leave the canvas armed with a tool that places
   * nothing.
   */
  private armPicked(): void {
    const id = this.partSelect.value;
    if (PART_BY_ID.has(id)) this.selectTool(id);
  }

  /**
   * Rebuild the picker from the search box.
   *
   * Two things have to be true at once. The list has to be short enough to read — hence the search, and
   * hence the shelves, which turn forty-odd names into eight groups of five. And a part the rail cannot
   * pass through has to be *findable*, not absent: hunting for a connector and getting an empty list
   * reads as a broken app, so a search that turns one up lists it, greyed out, under the reason. They
   * are only listed while searching; all 117 of them at once would put the wall straight back.
   *
   * The armed part is always in the list even when the search excludes it, so narrowing the view never
   * silently disagrees with what the next click will place.
   */
  private fillPalette(): void {
    const terms = this.partSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const armed = PART_BY_ID.get(this.tool);
    const shown = OFFERED.filter((c) => c === armed || matches(c, terms));
    const blocked = terms.length ? BLOCKED.filter((b) => matches(b.component, terms)) : [];

    this.partSelect.innerHTML = "";
    for (const { label } of PART_GROUPS) {
      const on = shown.filter((c) => GROUP_OF.get(c.id) === label);
      if (on.length === 0) continue;
      const group = this.addGroup(label);
      for (const c of on) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = partLabel(c);
        group.appendChild(opt);
      }
    }
    if (shown.length === 0) this.addGroup("No part matches").disabled = true;
    if (blocked.length > 0) {
      const group = this.addGroup("In the library, but not in series on a rail");
      group.disabled = true;
      for (const b of blocked.slice(0, BLOCKED_SHOWN)) {
        const opt = document.createElement("option");
        opt.disabled = true;
        opt.textContent = `${b.component.id} — ${b.why}`;
        group.appendChild(opt);
      }
      if (blocked.length > BLOCKED_SHOWN) {
        const more = document.createElement("option");
        more.disabled = true;
        more.textContent = `…and ${blocked.length - BLOCKED_SHOWN} more`;
        group.appendChild(more);
      }
    }
    // A rebuilt select forgets its selection, and the armed part is always present, so say it again.
    if (armed) this.partSelect.value = armed.id;
    this.partCount.textContent = paletteCount(terms.length > 0, shown.length, blocked.length);
  }

  /** One shelf in the picker, appended and returned so its parts can be hung on it. */
  private addGroup(label: string): HTMLOptGroupElement {
    const group = document.createElement("optgroup");
    group.setAttribute("label", label);
    this.partSelect.appendChild(group);
    return group;
  }

  /** The library part the current tool places, or null when the tool is not a part tool. */
  private activePart(): { id: string; footprint: Footprint } | null {
    return PART_BY_ID.get(this.tool) ?? null;
  }

  private clear(): void {
    this.circuit = { leds: [], battery: null };
    this.selected = null;
    this.syncButtons();
    this.emit();
  }

  /** Reflect active state on the toggle-ish toolbar buttons. */
  private syncButtons(): void {
    for (const [t, btn] of this.toolButtons) btn.classList.toggle("is-active", t === this.tool);
    // The picker is the palette's active control whenever a part tool is armed, and it shows which part.
    const part = this.activePart();
    this.partSelect.classList.toggle("is-active", part !== null);
    if (part) this.partSelect.value = part.id;
    for (const [m, btn] of this.viewButtons) btn.classList.toggle("is-active", m === this.viewMode);
    for (const [axis, btn] of this.mirrorButtons) {
      btn.classList.toggle("is-active", this.mirror[axis]);
      btn.setAttribute("aria-pressed", this.mirror[axis] ? "true" : "false");
    }
  }

  private onCanvasClick(e: MouseEvent): void {
    const flat = this.clientToFlat(e);
    if (!flat) return;
    // A tap on a part already placed picks that part up, whatever tool is armed — the same gesture as
    // tapping an LED, and for the same reason: deleting on the gesture that selects leaves no way to pick
    // one up in order to turn it round. Delete takes it off. It comes before placing, so the target a part
    // occupies is its own; the rest of the rail is still free to drop another one on.
    const onPart = this.partAt(flat);
    if (onPart) {
      this.selected = onPart;
      this.render();
      return;
    }
    const part = this.activePart();
    if (part) {
      // Stored as a point and snapped to the nearest run when the plan is built, exactly as a resistor is:
      // the routes move whenever the circuit does, so an index along one would name different copper after.
      const near = this.nearestOnRail(flat);
      if (!near || near.dist > this.pickRadius()) return;
      const placed = this.circuit.parts ?? [];
      this.circuit = {
        ...this.circuit,
        parts: [...placed, { component: part.id, x: near.point.x, y: near.point.y }],
      };
      this.selected = { kind: "part", index: placed.length };
      this.emit();
      return;
    }
    if (this.tool === "resistor" || this.tool === "switch") {
      // The click is stored as a point and snapped to the nearest run when the plan is built — the routes
      // move whenever the circuit does, so an index along one would name different copper afterwards.
      const near = this.nearestOnRail(flat);
      if (!near || near.dist > this.pickRadius()) return;
      const key = this.tool === "switch" ? "switches" : "resistors";
      const existing = (this.tool === "switch" ? this.circuit.switches : this.circuit.resistors) ?? [];
      this.circuit = { ...this.circuit, [key]: [...existing, { x: near.point.x, y: near.point.y }] };
      this.selected = { kind: this.tool === "switch" ? "switch" : "resistor", index: existing.length };
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
        this.selected = null; // a tap on bare cloth clears the selection
        this.render();
        return;
      }
      const led = ledOf(hit.gap.faceA, hit.gap.faceB);
      const at = this.circuit.leds.findIndex((l) => l.a === led.a && l.b === led.b);
      if (at >= 0) {
        // An LED already here: select it, so it can be rotated or removed. Tapping it no longer deletes it —
        // deleting on the same gesture that selects would make rotating one impossible.
        this.selected = { kind: "led", index: at };
        this.render();
        return;
      }
      this.circuit = { ...this.circuit, leds: [...this.circuit.leds, led] };
      this.selected = { kind: "led", index: this.circuit.leds.length - 1 };
    }
    this.emit();
  }

  /** Where the router put each placed library part. Defensive against an older plan object that predates
   *  the field, so a stale route cannot crash the canvas. */
  private routedParts(): { component: string; a: Vec2; b: Vec2; flip?: boolean }[] {
    return this.routed.parts ?? [];
  }

  /** How many parts are on rails, over all three lists — what makes the hint worth showing. */
  private placedCount(): number {
    return (this.circuit.parts ?? []).length
      + (this.circuit.resistors ?? []).length
      + (this.circuit.switches ?? []).length;
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

  /**
   * The part a tap at `p` lands on, or null — searched over every list, nearest first.
   *
   * Each part's target is its own size on the sheet, not a fraction of the pattern. It was the latter, and
   * that is what made a second part impossible to place: on any pattern the target was several times the
   * part, so the tap meant to drop a second capacitor beside the first landed on the first and took it off
   * again. Every attempt at two of anything left one.
   */
  private partAt(p: Vec2): Selection | null {
    let best: Selection | null = null;
    let bestD = Infinity;
    const consider = (kind: Selection["kind"], i: number, at: PlacedOnRail, fp: Footprint | null): void => {
      const d = Math.hypot(at.x - p.x, at.y - p.y);
      if (d > this.partPickRadius(fp) || d >= bestD) return;
      bestD = d;
      best = { kind, index: i };
    };
    (this.circuit.parts ?? []).forEach((q, i) =>
      consider("part", i, q, PART_BY_ID.get(q.component)?.footprint ?? null));
    (this.circuit.resistors ?? []).forEach((q, i) => consider("resistor", i, q, R_1206));
    (this.circuit.switches ?? []).forEach((q, i) => consider("switch", i, q, SW_SPDT));
    return best;
  }

  /** How near a tap must land to a part's own point to pick it up: half the part's extent along the rail,
   *  in the flat pattern's units, and never below {@link PART_PICK_FLOOR_MM}. */
  private partPickRadius(fp: Footprint | null): number {
    const toFlat = (mm: number): number => (mm * this.tapeW()) / TAPE_MM;
    const fit = fp ? partFit(fp) : null;
    const along = fit ? Math.max(fit.gap, fit.before + fit.after) : 0;
    return Math.max(toFlat(PART_PICK_FLOOR_MM), toFlat(along) / 2);
  }

  /** The selection where it is a part on a rail, or null when it is an LED or nothing. */
  private partSelection(): PartSelection | null {
    const sel = this.selected;
    return sel && sel.kind !== "led" ? { kind: sel.kind, index: sel.index } : null;
  }

  /** The circuit list a selection indexes into, with the field it is stored under. */
  private listFor(kind: PartKind): {
    field: (typeof PART_FIELD)[keyof typeof PART_FIELD];
    items: PlacedOnRail[];
  } {
    const field = PART_FIELD[kind];
    return { field, items: (this.circuit[field] ?? []) as PlacedOnRail[] };
  }

  /** Where the router put the selected part, so the canvas can ring the copper it actually broke. */
  private routedSpanFor(sel: PartSelection): { a: Vec2; b: Vec2 } | null {
    const from = sel.kind === "part"
      ? this.routedParts()
      : sel.kind === "resistor" ? this.routed.resistors : this.routed.switches;
    return (from as { a: Vec2; b: Vec2; source?: number }[]).find((s) => s.source === sel.index) ?? null;
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
      this.fold, this.routed.traces, this.tapeW(), "kiri", this.routed.pads, this.mirror, this.sheetMm, this.routed.resistors, this.routed.switches, this.routedParts(),
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
    const sel = this.selected;
    const part = this.partSelection();
    if (part) {
      this.turnPartRound(part);
      return;
    }
    const led = sel ? this.circuit.leds[sel.index] : undefined;
    if (!led || !sel) {
      this.statusEl.textContent = "Select a component first, then press R to turn it round";
      return;
    }
    // R cycles: the router's choice -> turned round -> back to the router's choice.
    //
    // The third step matters. Fixing an orientation forbids the router from turning that LED, and turning one
    // the wrong way can force a PWR/GND crossing that it would otherwise have avoided -- so there has to be a
    // way to hand the decision back. Without it the first press was permanent.
    const next: boolean | undefined =
      led.flip === undefined ? !this.plannedFlip(sel.index) : undefined;
    this.circuit = {
      ...this.circuit,
      leds: this.circuit.leds.map((l, i) => {
        if (i !== sel.index) return l;
        const { flip: _drop, ...rest } = l;
        return next === undefined ? rest : { ...rest, flip: next };
      }),
    };
    this.emit();
  }

  /**
   * Turn the selected part round.
   *
   * On a part the rail steps across — a switch — that is which side of the rail its idle terminal is
   * stranded on. On one in line with the rail it is which of its terminals lands on which cut end, which
   * matters to anything polarised and to nothing else.
   *
   * It cycles exactly as an LED does: the router's choice, then turned from it, then back to the router's
   * choice. Fixing an orientation forbids the router from picking a better one, so there has to be a way
   * to hand the decision back.
   */
  private turnPartRound(sel: PartSelection): void {
    const { field, items } = this.listFor(sel.kind);
    const item = items[sel.index];
    if (!item) {
      this.statusEl.textContent = "Select a component first, then press R to turn it round";
      return;
    }
    const next: boolean | undefined = item.flip === undefined ? !this.plannedPartFlip(sel) : undefined;
    this.circuit = {
      ...this.circuit,
      [field]: items.map((q, i) => {
        if (i !== sel.index) return q;
        const { flip: _drop, ...rest } = q;
        return next === undefined ? rest : { ...rest, flip: next };
      }),
    };
    this.emit();
  }

  /** Which way the router currently has this part, so the first turn turns it from what is on screen. */
  private plannedPartFlip(sel: PartSelection): boolean {
    const from = sel.kind === "part"
      ? this.routedParts()
      : sel.kind === "resistor" ? this.routed.resistors : this.routed.switches;
    return (from as { flip?: boolean; source?: number }[]).find((s) => s.source === sel.index)?.flip ?? false;
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
    const sel = this.selected;
    if (!sel) return;
    const part = this.partSelection();
    if (!part) {
      if (!this.circuit.leds[sel.index]) return;
      this.circuit = { ...this.circuit, leds: this.circuit.leds.filter((_, i) => i !== sel.index) };
    } else {
      const { field, items } = this.listFor(part.kind);
      if (!items[sel.index]) return;
      this.circuit = { ...this.circuit, [field]: items.filter((_, i) => i !== sel.index) };
    }
    this.selected = null;
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
    // A part's text is sized against the view, so a big enough zoom change has to repaint it — that is how a
    // pin name appears once its pad is large enough to hold one. Only when the step actually changes: a
    // wheel gesture is dozens of events, and rebuilding the whole canvas on each of them is not free.
    if (this.zoomStep() !== this.drawnZoomStep) this.draw();
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
    this.draw();
  }

  /** Repaint from the plan already in hand. A zoom changes what the canvas shows without changing the
   *  circuit, and re-routing to answer one wheel tick would be work for nothing. */
  private draw(): void {
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
    const windows = [
      ...this.routed.switches.map((w) => switchShape(this.tp(w.a), this.tp(w.b), w.flip)?.notch),
      ...this.routedParts().map((p) => this.partShapeOf(p)?.notch),
    ].filter((n): n is Vec2[] => !!n && n.length >= 3);

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
    // Every part, drawn from its own footprint by the same `partSvg` the cut files use: each terminal as the
    // pad that will actually be cut, in copper and mask, with the part's designator beside it. Drawn as the
    // real thing rather than a cartoon body, so the canvas and the cut files cannot say different things.
    const drawn = this.drawnParts();
    if (drawn.length) {
      const tags = designators(drawn);
      // One group so the text can be given a halo in CSS without touching any of the palette's own colours.
      parts.push(`<g class="el-part-marks">`);
      drawn.forEach((d, i) => {
        parts.push(...partSvg(d.footprint, d.shape, tags[i]!, {
          labels: this.padLabelsFit(d.shape),
          scale: this.renderScale(),
        }));
      });
      parts.push(`</g>`);
    }
    // The selected part, ringed on the copper the router actually broke for it — the same mark an LED gets.
    const selPart = this.partSelection();
    const selSpan = selPart ? this.routedSpanFor(selPart) : null;
    if (selSpan) {
      const a = this.tp(selSpan.a), b = this.tp(selSpan.b);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Big enough to sit outside the part it rings: its own span, or an LED's marker where that is bigger.
      const r = Math.max(Math.hypot(b.x - a.x, b.y - a.y) * 0.75, this.markerR() * 1.5);
      parts.push(`<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(r)}" class="el-part-selected" />`);
    }
    this.drawnZoomStep = this.zoomStep();
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
      if (this.selected?.kind === "led" && this.selected.index === i) {
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

  /** A placed library part's drawn shape, in the sheet millimetres the canvas works in. */
  private partShapeOf(p: { component: string; a: Vec2; b: Vec2; flip?: boolean }): ResistorShape | null {
    const fp = PART_BY_ID.get(p.component)?.footprint;
    return fp ? partShape(fp, this.tp(p.a), this.tp(p.b), p.flip) : null;
  }

  /**
   * Every part on the canvas, in the order the cut files take them, each with the footprint it is drawn
   * from. One list, because the designators have to be assigned across all of it at once: `R1` on the
   * canvas and `R2` in the file for the same part would be worse than no label at all.
   *
   * `resistors` and `switches` predate the library and carry no component id of their own, so they name
   * the part they have always been — the same two footprints the palette now places generically.
   */
  private drawnParts(): { component: string; footprint: Footprint; shape: ResistorShape }[] {
    const out: { component: string; footprint: Footprint; shape: ResistorShape }[] = [];
    const add = (component: string, footprint: Footprint, shape: ResistorShape | null): void => {
      if (shape) out.push({ component, footprint, shape });
    };
    for (const r of this.routed.resistors) {
      // The same shape the cut files draw, so the canvas cannot drift from them.
      add("R_1206", R_1206, resistorShape(this.tp(r.a), this.tp(r.b)));
    }
    for (const w of this.routed.switches) {
      add("SW_SPDT", SW_SPDT, switchShape(this.tp(w.a), this.tp(w.b), w.flip));
    }
    // And every other library part, drawn from its own footprint by the one generic shape — so a part the
    // library gains appears here with nothing added to this file.
    for (const p of this.routedParts()) {
      const fp = PART_BY_ID.get(p.component)?.footprint;
      if (fp) add(p.component, fp, this.partShapeOf(p));
    }
    return out;
  }

  /**
   * Whether a part's pads are big enough on screen to carry their own pin names.
   *
   * The canvas fits itself to the whole sheet, and a 1206 pad on an AKDE pattern is well under a percent
   * of it — a "1" written on that pad is a two-pixel smudge that hides the pad instead of naming it. So the
   * names are a zoom-in: they appear once a pad is worth a few percent of the view, by which point the
   * character inside it is comfortably a character. The designator comes back sooner, because it sits
   * beside the part rather than on it and nothing is lost behind it.
   */
  private padLabelsFit(sh: ResistorShape): boolean {
    return padMinOf(sh) >= this.view.w * PAD_LABEL_VIEW_FRACTION;
  }

  /**
   * Rendered units per sheet millimetre: how big a millimetre of the sheet actually comes out on screen.
   *
   * {@link partSvg} sizes its text from the pads and drops it when the result would be too small to read,
   * and this is what lets it know how small that is here. The canvas fits the whole sheet, so a millimetre
   * of a 380mm pattern is a couple of pixels and a pin name on a 1206 pad is a two-pixel smudge — the same
   * drawing that is perfectly legible in the cut file, which is printed at its real size. Zooming in raises
   * it, which is exactly when the names become worth showing.
   */
  private renderScale(): number {
    const px = (this.svg as { clientWidth?: number }).clientWidth || CANVAS_PX;
    return px / Math.max(this.view.w, 1e-9) / PX_PER_RENDERED_MM;
  }

  /** The zoom, quantised into 1.25x steps — one press of the zoom buttons. Both label decisions above are
   *  monotone in `view.w` alone, so this is exactly when the parts need repainting. */
  private zoomStep(): number {
    return Math.round(Math.log(Math.max(this.view.w, 1e-9)) / Math.log(1.25));
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
      this.routed.pads, this.routed.resistors, this.routed.switches, this.routedParts(),
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
      this.routed.pads, this.routed.resistors, this.routed.switches, this.routedParts(),
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


  /**
   * An LED pad's radius, in sheet millimetres: the 1206 footprint's own pad, read from the part's KiCad
   * file by `ocaml/kicad.ml`. Taken across the smaller of the pad's two dimensions, since the marker is
   * drawn round. Derived rather than written down, so a change of part carries through.
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
      ["part", (this.circuit.parts ?? []).length - this.routedParts().length],
    ] as const;
    for (const [what, missing] of short) {
      if (missing > 0) {
        msg += ` · ${missing} ${what}${missing === 1 ? "" : "s"} did not fit — that run is too short for the part`;
      }
    }
    const sel = this.selected;
    const selPart = this.partSelection();
    const picked = sel
      ? selPart
        ? this.listFor(selPart.kind).items[selPart.index]
        : this.circuit.leds[sel.index]
      : undefined;
    if (sel && picked) {
      const what = sel.kind === "led"
        ? "LED"
        : sel.kind === "part"
          ? PART_BY_ID.get((this.circuit.parts ?? [])[sel.index]!.component)?.note ?? "Part"
          : sel.kind === "resistor" ? "Resistor" : "Switch";
      msg += ` · ${what} ${sel.index + 1} selected — R to turn it round, Delete to remove`;
      msg += picked.flip !== undefined
        ? " (orientation fixed — R again to let the router choose)"
        : " (router chooses)";
    } else if (n > 0 || this.placedCount() > 0) {
      msg += " · click a component to select it";
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
    // `flip` travels with each of them for the same reason it travels with an LED: it is the author's
    // decision about which way round the part goes, and a clone that dropped it would lose the turn the
    // moment the circuit reached the store.
    resistors: (c.resistors ?? []).map(withFlip),
    switches: (c.switches ?? []).map(withFlip),
    // And every library part, which is the same trap once more: a clone that dropped `parts` would draw
    // one on the canvas and lose it the moment the circuit reached the store.
    parts: (c.parts ?? []).map((p) => ({ component: p.component, ...withFlip(p) })),
  };
}

/** A placed part's point, keeping the authored turn only where there is one — an absent `flip` means the
 *  router chooses, and writing `undefined` in would be a different thing from leaving it out. */
function withFlip<T extends PlacedOnRail>(p: T): PlacedOnRail {
  return p.flip === undefined ? { x: p.x, y: p.y } : { x: p.x, y: p.y, flip: p.flip };
}

/**
 * The smallest dimension of any of a part's pads, in the sheet millimetres the view is measured in.
 *
 * A lead is the pad's rectangle: a segment across the run, with a width along it. The smaller of those two
 * is what has to hold a character, so it is what decides whether a name fits on the pad.
 */
function padMinOf(sh: ResistorShape): number {
  let m = Infinity;
  for (const l of sh.leads) {
    m = Math.min(m, l.width, Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y));
  }
  return Number.isFinite(m) ? m : 0;
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
