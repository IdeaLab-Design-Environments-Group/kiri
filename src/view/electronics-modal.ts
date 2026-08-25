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
  type Led,
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
  type Net,
  type PlacedPart,
  type Terminal,
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
import {
  GND_NET_ID,
  PWR_NET_ID,
  netColour,
  nextNetColour,
  withDefaultNets,
} from "../model/net-palette.js";
import { defaultTerminals } from "../model/netlist.js";
import { printScale } from "../model/print-scale.js";
import { DEFAULT_SHEET, type SheetSpec } from "../model/fold-strain.js";
import { netPlacement, placement } from "../model/parts.js";
import { type Footprint, padAt, padNamed, terminals } from "../model/footprint.js";
import { type Component, BAT_COIN_20, R_1206, SW_SPDT } from "../model/footprints.generated.js";
import { LIBRARY, footprintById } from "../model/library.js";
import {
  type RoutedCircuit,
  type Terminals,
  type Trace2D,
  EMPTY_ROUTE,
  tapeMmFor,
  tapeWidthFor,
  batteryTerminals,
  partFit,
  planRoutes,
} from "../model/electronics-routing.js";
import { TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import { type ManualWire, type WireContext, manualTraces } from "../model/manual-wire.js";
import { ERRORS } from "../model/wire-rules.js";
import { WireTool, type WireHost } from "./wire-tool.js";
import type { FoldFile } from "../model/fold-file.js";
import { HOME, currentRoute, goToRoute, onRouteChange } from "./route.js";

/** The page this editor lives at. `#/electronics`, and the Back button is the way out. */
const ROUTE = "electronics";

const SVG_NS = "http://www.w3.org/2000/svg";
const MARGIN = 8; // mm — must match the SVG export so preview ↔ export register

/**
 * What the next click on the canvas does.
 *
 * `led` and `battery` are placements of their own — an LED straddles a hinge and the battery pins to a
 * face, so neither is a part in series on a rail. `wire` places nothing at all: it hands the canvas to
 * {@link WireTool}, which draws copper by hand rather than asking the router for it. `resistor` and
 * `switch` are the two parts that predate
 * the library and keep their own fields on the {@link Circuit}; they are no longer offered in the palette
 * (the library's own `R_1206` and `SW_SPDT` place the same parts through the generic path) but the tools
 * stay so a circuit authored before the library still edits. Every other value is a `Component.id`.
 */
type Tool = "led" | "battery" | "wire" | "resistor" | "switch" | (string & {});

/**
 * Where the next component goes, independent of WHICH component it is.
 *
 * These used to be baked into the component: an LED always straddled a hinge, everything else always went
 * on a rail or on a tile. That is a rule about the part, and it was the wrong rule — an LED is not
 * *definitionally* a fold-bridging thing, it was simply the first part this editor could place, and a
 * hinge is where a kirigami sheet wants copper to cross. Meanwhile a two-pad chip has exactly as much
 * reason to bridge a fold as an LED does, and no way to be asked to.
 *
 * So the choice is the author's and it is the same choice for every part:
 * - `gap` — across a fold, a pad either side of the hinge. The router owns which side is which.
 * - `free` — standing on a tile where it was dropped, wired by declared nets or hand-drawn copper.
 */
type PlaceMode = "gap" | "free";

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

/**
 * One row under a net in the panel.
 *
 * `derived` rows state what the bus router did with the battery and the hinge-LEDs. They are rendered and
 * counted like any other row and are **not** stored on the circuit, cannot be unwired, and carry no
 * `part`/`pad` — there is no `Circuit.parts` index for a battery or a hinge-LED to point at.
 */
interface NetRow {
  net: string;
  /** What the author reads — `R1 · 2` for a wired pad, `Battery +` for a derived one. */
  label: string;
  derived: boolean;
  part?: number;
  pad?: string;
}

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

/**
 * The smallest a selection ring may be drawn, in sheet millimetres.
 *
 * The ring is sized off the copper the part bridges, which is the right size for anything on a rail. It
 * is the wrong size for the smallest parts: an `LED_0603`'s pads are 0.8mm and its legs 1.5mm apart, so
 * a ring proportional to the part alone would be a dot inside the part rather than a mark around it.
 * The floor is what a 1206 LED's ring has always come out at, so nothing already on screen moves.
 */
const SELECT_RING_FLOOR_MM = 1.7;

/**
 * The library parts the LED tool can place, in the order the picker offers them. The first is what an
 * LED with no `component` of its own means, so a circuit authored before there was a choice still loads
 * as the 1206 it was drawn as.
 *
 * Named rather than matched on `/^LED/`, because the list is a claim about what the LED tool can seat on
 * a hinge — two pads at a pitch a tile gap can be opened out to — and not everything the library calls
 * an LED would qualify.
 */
const LED_IDS = ["LED_1206", "LED_0603"] as const;

/** Those parts, resolved against the library once. */
const LED_PARTS: Component[] = LED_IDS.flatMap((id) => LIBRARY.filter((c) => c.id === id));
const LED_BY_ID = new Map(LED_PARTS.map((c) => [c.id, c]));
/** What an LED is when it does not say — see {@link LED_IDS}. */
const DEFAULT_LED = LED_PARTS[0]!;

/** The library part a placed LED is, falling back to the default for an id the library no longer has. */
function ledPart(led: Led): Component {
  return LED_BY_ID.get(led.component ?? "") ?? DEFAULT_LED;
}

/**
 * Centre to centre between an LED's two terminals, in millimetres — the part's own, off its footprint.
 *
 * Wanted only where there is no copper to draw the part on — see {@link ElectronicsModal.ledPads}. Where
 * there is, the pads are the router's, and the pitch is already in them.
 */
function ledPitch(fp: Footprint): number {
  try {
    return Math.abs(padAt(padNamed(fp, "2")).x - padAt(padNamed(fp, "1")).x);
  } catch {
    return 0;
  }
}

/** The parts the two fixed tools already place, so the palette does not offer them a second time.
 *
 *  Every LED footprint is here, not just the default one. An LED straddles a hinge with PWR on one pad
 *  and GND on the other, so neither placement rule excludes it — `netPlacement` asks only for a terminal
 *  to wire, and `placement()` before it said yes to any two-pad part. Offered in the palette, an LED
 *  would be placed along a rail with both its pads on one net. The LED tool is the only way to place one. */
const FIXED_PLACEMENT = new Set<Footprint>([...LED_PARTS.map((c) => c.footprint), BAT_COIN_20]);

/**
 * How the palette shelves the parts it offers, first match winning.
 *
 * Presentation only, and name-based because the FabLib's filenames are the only thing there is to
 * shelve by — a footprint carries its geometry, not its aisle. Forty entries in one scroll is a wall;
 * forty in nine shelves of five is a menu.
 *
 * The catch-all used to be a shelf called "Other", and once every part in the library became placeable
 * it held 53 of the 129 — a wall of microcontrollers, sensors and bare IC packages behind a heading that
 * said nothing about any of them, which is the one shelf a person cannot skim. The rules below name what
 * is actually in there, so the fallback now catches nothing at all; it stays only so that a part added to
 * the library is somewhere rather than nowhere, and its heading says so plainly.
 *
 * Order is the specification: first match wins, so a narrow rule has to precede a wide one. `SOT_23_5`
 * is a transistor and `TSOT_23_5` a package outline; a sensor in an SOIC is shelved by what it does, not
 * by what it is moulded in — which is only true while the sensor rule comes first.
 */
const PART_GROUPS: { label: string; match: RegExp }[] = [
  { label: "LEDs", match: /^LED/ },
  { label: "Resistors", match: /^R_/ },
  { label: "Capacitors", match: /^CP?_/ },
  { label: "Inductors", match: /^L_/ },
  { label: "Crystals & oscillators", match: /^(Crystal|ECS_|Osc)/ },
  { label: "Diodes & transistors", match: /^(Diode|SOD|SOT|TO[-_]|Q_|Bridge)/ },
  { label: "Switches & buttons", match: /^(Switch|SW_|Button|Jumper|Potentiometer)/ },
  { label: "Microcontrollers & modules", match: /^(ESP32|ESP_WROOM|RaspberryPi|SeeedStudio|Module_|Microchip_)/ },
  { label: "Sensors", match: /^(Sensor_|ST_VL|Mic_MEMS)/ },
  { label: "Motor drivers", match: /^MotorDriver/ },
  { label: "Analog & logic ICs", match: /^(Amplifier|OpAmp|Comparator|LevelShifter|Multiplexer)/ },
  { label: "Headers & sockets", match: /^(PinHeader|PinSocket|Header)/ },
  { label: "Connectors & terminals", match: /^(Conn|TerminalBlock|MicroSD)/ },
  { label: "Power", match: /^(Battery|BAT_)|PWRJack/ },
  { label: "IC packages", match: /^(QFN|TQFP|TSOT|TSSOP|SOIC|SSOP|HSOP|HTSSOP|VFLGA|WSON|SMD_)/ },
  { label: "Not yet shelved", match: /^/ },
];

/** The catch-all's heading, which {@link PART_GROUPS} is expected to leave empty. */
export const UNSHELVED = "Not yet shelved";

/** Which shelf a part's id falls on. Exported so the shelving can be checked without a DOM. */
export function shelfFor(id: string): string {
  return PART_GROUPS.find((g) => g.match.test(id))!.label;
}

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
    const p = netPlacement(c.footprint);
    if (!p.placeable) {
      BLOCKED.push({ component: c, why: p.why });
      continue;
    }
    OFFERED.push(c);
    PART_BY_ID.set(c.id, c);
    GROUP_OF.set(c.id, shelfFor(c.id));
  }
  OFFERED.sort((a, b) => a.id.localeCompare(b.id));
  BLOCKED.sort((a, b) => a.component.id.localeCompare(b.component.id));
}

admit(LIBRARY);

/**
 * The library is whole and already here.
 *
 * It used to arrive in two halves, the second fetched the first time this page opened, and this returned
 * the request so a caller could wait for it. The split is gone — `library.ts` joins the two generated
 * modules statically — but the wait is kept, resolved, because "the picker is ready" is a real thing for
 * a caller to await and it costs a promise that is already settled.
 */
function loadRestOfLibrary(): Promise<void> {
  return Promise.resolve();
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
 * The line beside the picker: how much of the library is on offer.
 *
 * It used to exist to say that most of the library was NOT on offer — a rail can only pass through a
 * part with two or three terminals, so two thirds of the FabLib sat unplaceable and a picker that simply
 * omitted them would read as a library missing its parts. With nets, a part is a set of pads to wire
 * rather than something a rail passes through, so everything with a terminal is placeable and the line
 * has only the good news left to give: how many there are, and that typing finds them.
 */
function paletteCount(searching: boolean, shown: number, blocked: number): string {
  if (!searching) {
    const all = `${OFFERED.length} parts — search by name or package`;
    return blocked === 0 ? all : `${all} · ${BLOCKED.length} with no terminal to wire`;
  }
  const found = `${shown} match`;
  return blocked === 0 ? found : `${found} · ${blocked} with no terminal to wire`;
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
  /** Copper the author draws themselves. Armed by the `wire` tool; inert — every handler returns false —
   *  whenever it is not, which is what lets the guards at the head of the pointer handlers be one line. */
  private readonly wire: WireTool;
  private readonly viewButtons = new Map<ViewMode, HTMLButtonElement>();
  private readonly placeButtons = new Map<PlaceMode, HTMLButtonElement>();
  private readonly mirrorButtons = new Map<keyof Mirror, HTMLButtonElement>();
  /** The library picker — one control for the whole library, so a part added to it costs no toolbar room. */
  private readonly partSelect: HTMLSelectElement;
  /**
   * Which LED the LED tool places — its own picker, beside the LED button.
   *
   * Deliberately not a row in the library picker next to it. That picker is filtered by
   * {@link placement}, which answers "can a rail pass through this part"; an LED's answer is yes and its
   * meaning is no, because it bridges PWR to GND across a hinge rather than sitting in a break in one
   * rail. Putting it there would make it placeable on a rail, where both its pads would land on the same
   * net. Nor a button per footprint: a second LED package costs a row here and no toolbar room, which is
   * the same reason the library has one picker rather than a button per footprint.
   *
   * Changing it arms the LED tool, so choosing a package and clicking a hinge is one gesture — the rule
   * the library picker already follows.
   */
  private readonly ledSelect: HTMLSelectElement;
  /** Narrows the picker. At this many footprints the list is longer than the screen and the names are things
   *  like `Switch_Slide_RightAngle_CnK_AYZ0102AGRLC_7.2x3mm`; typing is the only way in. */
  private readonly partSearch: HTMLInputElement;
  /** Says how much of the library the picker is showing, and how much of it can never be shown. */
  private readonly partCount: HTMLElement;
  /** The button that opens the library menu, showing what is armed. */
  private readonly partTrigger: HTMLButtonElement;
  /** The menu itself: shelves that open one at a time under the trigger. */
  private readonly partMenu: HTMLElement;
  /** Which shelves the author has opened. Closed is the default — see {@link fillMenu}. */
  private readonly openShelves = new Set<string>();
  private menuOpen = false;
  /** Set by a click inside the menu, read and cleared by the document-level close. The mock DOM in the
   *  tests has no event bubbling, and `stopPropagation` on a real click would be a lie either way: the
   *  menu is not trying to swallow the click, only to say it was its own. */
  private menuClickGuard = false;
  /** The nets sidebar: what is declared, and the pads of whatever part is selected. */
  private readonly netList: HTMLElement;
  private readonly netNew: HTMLInputElement;
  private readonly netTally: HTMLElement;
  private readonly partsGroup: HTMLElement;
  private readonly partsTally: HTMLElement;
  private readonly partList: HTMLElement;
  private readonly padsGroup: HTMLElement;
  private readonly padPart: HTMLElement;
  private readonly padList: HTMLElement;
  /**
   * Which nets are opened out to show their terminals.
   *
   * Held by net id and outside the circuit, because it is not a property of the circuit: which branches
   * a file tree has open is the reader's business and does not belong in what gets saved or handed to
   * the router. Ids of deleted nets are harmless — nothing looks them up — and are cleared on delete
   * anyway so the set cannot grow without bound over a long session.
   */
  private readonly openNets = new Set<string>();
  /** Settles once the lazily-loaded half of the library has reached the picker. */
  private libraryReady: Promise<void> = Promise.resolve();

  private tool: Tool = "led";
  /**
   * Gap by default, because that is what the editor did before there was a choice, and because on a
   * kirigami sheet a fold is where copper most wants to cross. It is a default now, not a law.
   */
  private placeMode: PlaceMode = "gap";
  private viewMode: ViewMode = "strips";
  /** Which way the cut is flipped — off by default, so the file matches the design unless asked otherwise. */
  private mirror: Mirror = { x: false, y: false };
  /** The sheet a scale-less pattern is cut at, from the export menu's print size. Held here because both
   *  the routing and every dimension drawn are derived from it. */
  private sheetMm: number | undefined;
  /**
   * The sheet's physical properties — thickness, foil, fatigue, and which tape to plan for.
   *
   * **One field, read by all three of `replan`, `tapeW` and `tapeMm`, and that is the whole point.** Under
   * `tapeChoice: "area"` the tape width depends on the sheet, so a spec that reached the router without
   * reaching the two width readers would have the router plan at one width while the canvas and the folded
   * preview drew at another — silently, each internally consistent. Passing a literal `undefined` at each
   * site made that divergence structural; sharing one field makes it impossible.
   *
   * Nothing sets it yet: no part of the app constructs a `SheetSpec`, so this is `DEFAULT_SHEET` and the
   * router plans for the {@link TAPE_MM} roll exactly as before. This is where one arrives when it does.
   *
   * Named `sheetSpec` rather than `sheet` because {@link sheet} is already the preview's page box.
   */
  private sheetSpec: SheetSpec = DEFAULT_SHEET;
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
  private circuit: Circuit = withDefaultNets({ leds: [], battery: null });
  private routed: RoutedCircuit = EMPTY_ROUTE;

  // Pan/zoom: `contentBox()` is the drawn pattern box in sheet mm; `view` is the visible window into it.
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private pan: { x: number; y: number; moved: number } | null = null;
  /** A free part being dragged: which one, where the grab started, and where the cursor is now. */
  private partDrag: { index: number; from: Vec2; at: Vec2 } | null = null;
  /** The zoom step the parts were last painted at — see {@link zoomStep}. */
  private drawnZoomStep = NaN;

  private editHandler: (circuit: Circuit) => void = () => {};

  constructor() {
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "sim-trigger";
    this.trigger.textContent = "Electronics";
    this.trigger.disabled = true;
    // Navigation now, not "open a dialog": clicking it goes to the editor's page, and the URL says so.
    this.trigger.className = "sim-trigger el-nav";
    this.trigger.addEventListener("click", () => this.open());

    // A page in the site, not a dialog over it. `role="dialog" aria-modal="true"` said the rest of the
    // page did not exist while this was up, which was true of a modal and is a lie about a page — a
    // screen reader would be told the header and the model behind it are gone. It is a `main` region with
    // a heading, reached by a route, left by Back.
    this.overlay = document.createElement("div");
    this.overlay.className = "el-page";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
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
                  <button type="button" class="el-tool" data-tool="led" title="Add an LED — click a gap between two tiles">LED</button>
                  <button type="button" class="el-tool" data-tool="battery" title="Place the battery — click a tile">Battery</button>
                  <button type="button" class="el-tool" data-tool="wire" title="Draw copper by hand — tap to lay a vertex, tap the last one (or Enter) to finish, Backspace to take one back, X+tap to drop one, Delete to remove the selected wire">Wire</button>
                </span>
                <select class="el-led-part" aria-label="Which LED footprint to place" title="Which LED to place. It straddles a hinge with PWR on one pad and GND on the other, so it is not placed from the library picker beside it — that one is for parts in series on a rail"></select>
              </span>
              <span class="el-group el-parts">
                <label class="el-group-label el-part-label" for="el-part">Part</label>
                <span class="el-part-picker">
                  <span class="el-part-fields">
                    <input type="search" id="el-part-search" class="el-part-search" placeholder="Search the library" aria-label="Search the component library" autocomplete="off">
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
              <span class="el-group el-view-modes">
                <span class="el-group-label">Copper</span>
                <span class="el-seg">
                  <button type="button" class="el-view" data-view="traces" title="Show the copper as separate strips">Strips</button>
                  <button type="button" class="el-view" data-view="carrier" title="Show the copper as one carrier frame holding every trace in place">Carrier</button>
                </span>
              </span>
              <span class="el-group el-mirror-modes">
                <span class="el-group-label">Mirror</span>
                <span class="el-seg">
                  <button type="button" class="el-mirror" data-axis="x" title="Mirror the cut left-right — for cutting through the backing or laying the tape adhesive side up" aria-pressed="false">⇄ Left-right</button>
                  <button type="button" class="el-mirror" data-axis="y" title="Mirror the cut top-bottom" aria-pressed="false">⇅ Top-bottom</button>
                </span>
              </span>
              <span class="el-group">
                <span class="el-group-label">Export</span>
                <span class="el-seg">
                  <button type="button" class="el-export" title="Download the copper as separate strips to cut">Strips SVG</button>
                  <button type="button" class="el-export-carrier" title="Download one carrier frame holding every trace in place: align it, stick the traces down, snip the tabs">Carrier SVG</button>
                </span>
              </span>
              <span class="el-group el-view-group">
                <span class="el-group-label">Zoom</span>
                <span class="el-seg">
                  <button type="button" class="el-zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
                  <button type="button" class="el-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
                  <button type="button" class="el-fit" title="Fit to screen">Fit</button>
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
          </div>
          <div class="el-footer-row">
            <p class="el-legend">
              <span class="el-key"><i class="el-swatch el-key-pwr"></i>PWR tape</span>
              <span class="el-key"><i class="el-swatch el-key-gnd"></i>GND tape</span>
              <span class="el-key"><i class="el-swatch el-key-batt"></i>Battery</span>
              <span class="el-key"><i class="el-swatch" style="background:${PCB_COLOURS.mask}"></i>Part pad — drawn, not cut</span>
              <span class="el-key"><i class="el-swatch" style="background:${PCB_COLOURS.componentLabel}"></i>Part label (R1)</span>
              <span class="el-key"><i class="el-swatch el-swatch-ring el-key-led"></i>LED the copper never reached</span>
            </p>
            <span class="sim-status el-status"></span>
          </div>
        </div>
      </div>
    `;
    // Beside the model page, not inside it and not after the footer. `#app` keeps existing while the
    // editor is up — `installResizableLayout` is bound to it — and is hidden by a class on `<body>`.
    // Nothing here may move the viewer's iframe: hiding an ancestor keeps its document, but re-parenting
    // it reloads the FKLD preview and it comes back blank.
    const appRoot = document.querySelector("#app");
    if (appRoot && typeof (appRoot as HTMLElement).insertAdjacentElement === "function") {
      (appRoot as HTMLElement).insertAdjacentElement("afterend", this.overlay);
    } else {
      document.body.appendChild(this.overlay);
    }

    this.svg = this.overlay.querySelector(".el-svg")!;
    // Built as soon as there is a canvas to hand it, and never later: `draw()` repaints the live layer
    // through it, so a tool that arrived after the first render would be a null check in the draw path.
    this.wire = new WireTool(this.wireHost());
    this.statusEl = this.overlay.querySelector(".el-status")!;
    this.partSelect = this.overlay.querySelector(".el-part")!;
    this.partSearch = this.overlay.querySelector(".el-part-search")!;
    this.partCount = this.overlay.querySelector(".el-part-count")!;
    this.partTrigger = this.overlay.querySelector(".el-part-trigger")!;
    this.partMenu = this.overlay.querySelector(".el-part-menu")!;
    this.netList = this.overlay.querySelector(".el-net-list")!;
    this.netNew = this.overlay.querySelector(".el-net-new")!;
    this.netTally = this.overlay.querySelector(".el-side-tally")!;
    // Its own class rather than a second `.el-side-tally`: the nets tally is looked up by that class and
    // takes the first in document order, so a bare copy here would be a trap for whoever adds a section
    // above it later.
    this.partsGroup = this.overlay.querySelector(".el-placed")!;
    this.partsTally = this.overlay.querySelector(".el-placed-tally")!;
    this.partList = this.overlay.querySelector(".el-placed-list")!;
    this.padsGroup = this.overlay.querySelector(".el-pads")!;
    this.padPart = this.overlay.querySelector(".el-pad-part")!;
    this.padList = this.overlay.querySelector(".el-pad-list")!;
    this.overlay.querySelector(".el-net-add")!.addEventListener("click", () => this.addNet());
    this.netNew.addEventListener("keydown", (e: KeyboardEvent) => {
      // Enter in the box is the same as pressing Add: typing a name and pressing return is how every
      // other "add one of these" field in the world works.
      if (e.key === "Enter") this.addNet();
    });
    this.partTrigger.addEventListener("click", () => this.toggleMenu());
    // A click anywhere else puts the menu away. The guard above is what tells "anywhere else" from a
    // click on the menu's own shelves and rows.
    document.addEventListener("click", () => {
      if (this.menuClickGuard) this.menuClickGuard = false;
      else if (this.menuOpen) this.setMenuOpen(false);
    });
    this.ledSelect = this.overlay.querySelector(".el-led-part")!;
    this.fillLedPicker();
    // Picking an LED package IS choosing the LED tool, exactly as picking a library part arms that part —
    // otherwise choosing a 0603 and clicking a hinge would place whatever was armed before.
    for (const ev of ["change", "click"]) {
      this.ledSelect.addEventListener(ev, () => this.selectTool("led"));
    }
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
    for (const ev of ["input", "search"]) {
      this.partSearch.addEventListener(ev, () => {
        // Typing is a way into the list, so the list comes out to meet it: the menu opens on the first
        // keystroke and the shelves that match open with it (see {@link fillMenu}).
        this.fillPalette();
        if (this.partSearch.value.trim()) this.setMenuOpen(true);
      });
    }
    this.partSearch.addEventListener("click", () => (this.menuClickGuard = true));

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
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-place")) {
      const mode = btn.dataset.place === "free" ? "free" : "gap";
      btn.addEventListener("click", () => this.selectPlaceMode(mode));
      this.placeButtons.set(mode, btn);
    }
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>(".el-mirror")) {
      const axis = btn.dataset.axis === "y" ? "y" : "x";
      btn.addEventListener("click", () => this.toggleMirror(axis));
      this.mirrorButtons.set(axis, btn);
    }
    this.overlay.querySelector(".el-zoom-in")!.addEventListener("click", () => this.zoomBy(1.25));
    this.overlay.querySelector(".el-zoom-out")!.addEventListener("click", () => this.zoomBy(0.8));
    this.overlay.querySelector(".el-fit")!.addEventListener("click", () => this.fitView());
    this.overlay.querySelector(".el-back")!.addEventListener("click", () => this.goBack());
    // Pointer = pan (drag) or place (tap). Wheel = zoom toward the cursor.
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("pointercancel", () => (this.pan = null));
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // `X` is a held modifier of the wire tool, so its release matters as much as its press.
    document.addEventListener("keyup", (e) => {
      if (!this.overlay.hidden) this.wire.onKey(e);
    });
    document.addEventListener("keydown", (e) => {
      if (this.overlay.hidden) return;
      if (this.wire.onKey(e)) return this.renderStatus();
      if (e.key === "Escape") {
        // Escape puts the parts menu away and stops there. It used to leave the editor, which was right
        // for a dialog and wrong for a page: a page is not dismissible, and Escape wiping out the view
        // you navigated to is the sort of thing that loses work. Back is the way out.
        if (this.menuOpen) this.setMenuOpen(false);
        return;
      }
      if (e.key === "r" || e.key === "R") {
        this.rotateSelected();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") this.removeSelected();
    });

    // Last in the constructor, and deliberately so: showing the page runs the whole render path, and from
    // any earlier line half the fields it touches do not exist yet. A deep link used to arrive mid-build.
    //
    // Back, Forward, and a `#/electronics` pasted into the address bar all arrive through here...
    onRouteChange((route) => this.syncRoute(route));
    // ...and a document loaded straight at the editor's URL starts on the editor, rather than on the
    // model page with the address bar claiming otherwise.
    if (currentRoute() === ROUTE) this.show();
  }

  /**
   * Show or hide the editor to match the URL.
   *
   * Registered on `hashchange`, so the Back button, the Forward button and a pasted `#/electronics` all
   * arrive here. It is the only thing that decides whether the page is up, which is what stops the URL
   * and the screen from disagreeing.
   */
  private syncRoute(route: string): void {
    if (route === ROUTE) this.show();
    else this.hide();
  }

  /** Put the editor page up, and the model page away. */
  private show(): void {
    if (!this.overlay.hidden) return;
    this.selectTool(this.tool);
    this.syncButtons();
    this.render();
    this.overlay.hidden = false;
    document.body?.classList.add("is-electronics");
    this.trigger.classList.add("is-active");
    // The rest of the library is not in the main bundle. Ask for it now rather than at start-up, and
    // redraw the picker when it lands, so a search can turn up the parts that cannot be placed and say
    // why. Held so a caller — a test, mostly — can wait for the library to be whole.
    this.libraryReady = loadRestOfLibrary().then(() => this.fillPalette());
    this.emit(); // ask the controller for a fresh plan now that we're showing
  }

  /** Take the editor page down, and the model page back. */
  private hide(): void {
    this.overlay.hidden = true;
    document.body?.classList.remove("is-electronics");
    this.trigger.classList.remove("is-active");
  }

  /** Leave the editor for the model page. What the Back control does; the browser's own Back does the
   *  same thing through {@link syncRoute}. */
  private goBack(): void {
    goToRoute(HOME);
    this.hide();
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
    // Seeded, not empty: a circuit always has the battery's two rails to wire to, and an author who
    // opens a fresh pattern and finds no nets at all has to invent PWR and GND before they can put a
    // single pad on anything. Deleting one is still theirs to do — `withDefaultNets` only ever seeds a
    // circuit that has never declared a net, so a deletion is not undone on the next pattern.
    this.circuit = withDefaultNets({ leds: [], battery: null });
    this.openNets.clear();
    this.selected = null;
    this.computeBounds();
    this.fitView();
    this.syncButtons();
    // The sidebar as well as the canvas: a new pattern resets the circuit, so leaving it painted would
    // list the old pattern's parts and offer the pads of one that no longer exists.
    if (!this.overlay.hidden) {
      this.renderNets();
      this.render();
    }
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

  /**
   * Go to the editor's page.
   *
   * The URL is written first so that Back has somewhere to return to, then the page is shown directly
   * rather than waiting for `hashchange` — the event does not exist where there is no URL, and a caller
   * that asked for the editor should get it either way.
   */
  open(): void {
    goToRoute(ROUTE);
    this.show();
  }

  /** Leave the editor. Kept for the callers that had it; it is the Back control's own path. */
  close(): void {
    this.goBack();
  }

  // ---- editing -------------------------------------------------------------

  /** Switch between the two ways of showing (and cutting) the copper. */
  private selectView(mode: ViewMode): void {
    this.viewMode = mode;
    this.render();
  }

  /**
   * Choose where the next component goes. Nothing already placed moves — this is about the next click.
   *
   * Left alone deliberately: the armed tool. Mode and component are two independent questions now, and
   * resetting the part every time the mode changed would make choosing a socket and then choosing where to
   * put it impossible in that order.
   */
  private selectPlaceMode(mode: PlaceMode): void {
    this.placeMode = mode;
    this.syncButtons();
    this.renderStatus();
  }

  /** Flip the cut about one axis, or unflip it. The circuit itself is untouched — the same LEDs on the same
   *  tiles, drawn and cut from the other side. */
  private toggleMirror(axis: keyof Mirror): void {
    this.mirror = { ...this.mirror, [axis]: !this.mirror[axis] };
    this.syncButtons();
    this.render();
  }

  private selectTool(tool: Tool): void {
    // Arming anything is the end of browsing the library, whichever control did it.
    if (this.menuOpen) this.setMenuOpen(false);
    this.tool = tool;
    // The wire tool owns the canvas while it is armed, and hands it straight back: disarming abandons a
    // part-drawn wire rather than committing copper the author walked away from.
    this.wire.setActive(tool === "wire");
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
   * are only listed while searching; every one of them at once would put the wall straight back.
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
    this.fillMenu(shown, blocked, terms.length > 0, armed);
    this.partCount.textContent = paletteCount(terms.length > 0, shown.length, blocked.length);
  }

  /**
   * Build the library menu: a shelf per group, each one closed until it is asked for.
   *
   * A native `<select>` cannot do this. It opens as one flat scroll — every offered part at once, with
   * the group headings as unclickable dividers — so the list you have to read to find a capacitor is the
   * whole library every time. Here a shelf is a button: shut, it is one line saying how many parts are
   * behind it; open, it is those parts and nothing else's.
   *
   * The `<select>` stays in the DOM beside it, hidden, and is still what holds the value. It is the model
   * this menu writes to, so `change` fires exactly as it always did, the keyboard has something real to
   * land on, and nothing downstream of the picker had to learn that the menu exists.
   *
   * Which shelves are open:
   *   - searching, every shelf with a hit — typing is a request to see the matches, not to go hunting
   *     for them behind eight more clicks;
   *   - otherwise, the ones the author opened, plus the one holding the armed part, so opening the menu
   *     always shows you where you are.
   */
  private fillMenu(
    shown: Component[], blocked: { component: Component; why: string }[], searching: boolean,
    armed: Component | undefined,
  ): void {
    this.partMenu.innerHTML = "";
    this.partTrigger.textContent = armed ? partLabel(armed) : "Pick a part…";
    this.partTrigger.classList.toggle("is-empty", !armed);

    for (const { label } of PART_GROUPS) {
      const on = shown.filter((c) => GROUP_OF.get(c.id) === label);
      if (on.length === 0) continue;
      const holdsArmed = armed !== undefined && on.includes(armed);
      const open = searching || this.openShelves.has(label) || holdsArmed;
      const body = this.addShelf(label, on.length, open);
      for (const c of on) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "el-part-row";
        row.dataset.id = c.id;
        row.textContent = partLabel(c);
        row.setAttribute("role", "option");
        const isArmed = c === armed;
        row.setAttribute("aria-selected", isArmed ? "true" : "false");
        row.classList.toggle("is-armed", isArmed);
        row.addEventListener("click", () => this.chooseFromMenu(c.id));
        body.appendChild(row);
      }
    }
    if (shown.length === 0) this.addShelf("No part matches", 0, false, true);
    if (blocked.length > 0) {
      // Open on sight: it exists only because a search turned up something the rail cannot pass through,
      // and shut behind a click it would read as "no such part".
      const body = this.addShelf("In the library, but with no terminal to wire", blocked.length, true, true);
      for (const b of blocked.slice(0, BLOCKED_SHOWN)) {
        body.appendChild(this.deadRow(`${b.component.id} — ${b.why}`));
      }
      if (blocked.length > BLOCKED_SHOWN) {
        body.appendChild(this.deadRow(`…and ${blocked.length - BLOCKED_SHOWN} more`));
      }
    }
  }

  /** One shelf: its heading button and the (possibly hidden) box its parts hang in, which is returned. */
  private addShelf(label: string, count: number, open: boolean, dead = false): HTMLElement {
    const shelf = document.createElement("div");
    shelf.className = "el-part-shelf";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "el-part-shelf-head";
    head.textContent = label;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    head.classList.toggle("is-open", open);
    head.disabled = dead;
    if (count > 0) {
      const tally = document.createElement("span");
      tally.className = "el-part-shelf-count";
      tally.textContent = String(count);
      head.appendChild(tally);
    }
    if (!dead) head.addEventListener("click", () => this.toggleShelf(label));
    const body = document.createElement("div");
    body.className = "el-part-shelf-body";
    body.hidden = !open;
    shelf.appendChild(head);
    shelf.appendChild(body);
    this.partMenu.appendChild(shelf);
    return body;
  }

  /** A row that names a part the picker cannot arm — the reason it cannot, spelled out. */
  private deadRow(text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "el-part-row is-dead";
    row.textContent = text;
    return row;
  }

  /** Open a shut shelf, or shut an open one. The menu stays up: shelving is browsing, not choosing. */
  private toggleShelf(label: string): void {
    this.menuClickGuard = true;
    if (this.openShelves.has(label)) this.openShelves.delete(label);
    else this.openShelves.add(label);
    this.fillPalette();
  }

  /** Arm the part on a menu row, and put the menu away — that one WAS the choice. */
  private chooseFromMenu(id: string): void {
    this.menuClickGuard = true;
    this.partSelect.value = id;
    this.armPicked();
    this.setMenuOpen(false);
    this.fillPalette();
  }

  private toggleMenu(): void {
    this.menuClickGuard = true;
    this.setMenuOpen(!this.menuOpen);
  }

  /** Show or hide the menu, keeping the trigger's own state in step with it. */
  private setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.partMenu.hidden = !open;
    this.partTrigger.setAttribute("aria-expanded", open ? "true" : "false");
    this.partTrigger.classList.toggle("is-open", open);
    if (open) this.fillPalette();
  }

  /**
   * Fill the LED picker from {@link LED_PARTS}, and select the default.
   *
   * Short enough to need no search and no shelves: it is the LED packages, not the library.
   */
  private fillLedPicker(): void {
    this.ledSelect.innerHTML = "";
    for (const c of LED_PARTS) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = partLabel(c);
      this.ledSelect.appendChild(opt);
    }
    this.ledSelect.value = DEFAULT_LED.id;
  }

  /** Which LED the next tap on a hinge places. */
  private armedLed(): Component {
    return LED_BY_ID.get(this.ledSelect.value) ?? DEFAULT_LED;
  }

  /**
   * A newly placed LED, carrying its package.
   *
   * The default is written as an ABSENCE, not as `component: "LED_1206"`. An LED with no component means
   * the 1206, so saying it out loud would only make circuits authored before the choice existed serialise
   * differently from identical ones authored after it.
   */
  private newLed(a: number, b: number): Led {
    const id = this.armedLed().id;
    return id === DEFAULT_LED.id ? { a, b } : { a, b, component: id };
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
    // The declared nets survive: they are names the author chose, they cost nothing to keep, and the
    // parts they were wired to are what Clear is for. Their terminals cannot survive — the parts are gone.
    this.circuit = { leds: [], battery: null, nets: this.nets(), terminals: [] };
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
    this.partTrigger.classList.toggle("is-active", part !== null);
    if (part) this.partSelect.value = part.id;
    // And the LED picker is the LED tool's active control, for the same reason.
    this.ledSelect.classList.toggle("is-active", this.tool === "led");
    for (const [m, btn] of this.viewButtons) btn.classList.toggle("is-active", m === this.viewMode);
    for (const [m, btn] of this.placeButtons) {
      btn.classList.toggle("is-active", m === this.placeMode);
      btn.setAttribute("aria-pressed", m === this.placeMode ? "true" : "false");
    }
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
      // The pad panel follows the selection: it is the selected part's pads it is offering.
      this.renderSide();
      this.render();
      return;
    }
    const part = this.activePart();
    if (part) {
      // Near a rail, the part goes IN it: stored as a point and snapped to the nearest run when the plan is
      // built, exactly as a resistor is, because the routes move whenever the circuit does and an index
      // along one would name different copper after.
      //
      // Away from every rail it goes ON the sheet instead. That used to be a dead click — no part, no
      // message, nothing — which reads as a broken palette rather than as a rule, and it made two thirds of
      // the library unplaceable in practice: a rail passes through at most three terminals, so a USB socket
      // or a module could only ever stand free. A free part has no copper cut for it and is wired through
      // declared nets or by hand-drawn runs.
      const placed = this.circuit.parts ?? [];
      // Across a fold, if that is what was asked for: the part is stood on the hinge itself and turned to
      // cross it, so a pad lands on each tile. Stored `free` — no rail is cut for it — with the angle the
      // hinge gives it, which is the one thing about a fold-crossing part the author should not have to
      // work out by hand.
      if (this.placeMode === "gap") {
        const hit = nearestGap(this.gaps, flat);
        if (!hit || hit.dist > this.pickRadius()) return;
        const [p, q] = hit.gap.ends;
        // Perpendicular to the hinge: the part crosses it rather than lying along it, which would put both
        // pads on the same tile and bridge nothing.
        const rot = ((Math.atan2(q.x - p.x, -(q.y - p.y)) * 180) / Math.PI + 360) % 360;
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        this.circuit = {
          ...this.circuit,
          parts: [...placed, { component: part.id, x: mid.x, y: mid.y, free: true, rot }],
        };
        this.selected = { kind: "part", index: placed.length };
        this.emit();
        return;
      }
      const near = this.nearestOnRail(flat);
      // Proximity only gets a say for a part a rail could actually pass through. `placement` refuses
      // anything past three terminals — a rail arrives, crosses the part, and leaves, and a twenty-six-way
      // socket has no meaning spliced into a run of tape — so for most of the library there is no seat to
      // land near and the part always stands free. Asking "is it near copper?" first would seat a USB
      // socket in a rail on a small pattern, where `pickRadius`'s floor is wider than the whole sheet.
      const canSeat = placement(part.footprint).placeable;
      const onRail = canSeat && near && near.dist <= this.pickRadius();
      // On the sheet at all, though: a click in the margin is still a miss, and silently dropping a part in
      // empty space would put copper where there is nothing to stick it to.
      if (!onRail && pointInFace(this.faces, flat) < 0) return;
      const seat: PlacedPart = onRail
        ? { component: part.id, x: near!.point.x, y: near!.point.y }
        : { component: part.id, x: flat.x, y: flat.y, free: true };
      this.circuit = { ...this.circuit, parts: [...placed, seat] };
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
    } else if (this.placeMode === "free") {
      // An LED asked for on a tile is an ordinary free part carrying an LED footprint. It gets no `Led`
      // entry, so the router does not bridge it across a hinge and does not decide which leg is PWR — which
      // side is positive stops being a routing outcome and becomes something the author holds.
      //
      // Holding it does not mean having to state it. The two pads land on PWR and GND, the LED's own way
      // round, and the author changes either from the pads panel — a default, not a decision taken from
      // them. Landing unwired meant every LED placed on a tile needed two manual assignments before it
      // could light, which is a chore rather than a choice.
      const id = this.armedLed().id;
      if (pointInFace(this.faces, flat) < 0) {
        this.selected = null;
        this.renderSide();
        this.render();
        return;
      }
      const placed = this.circuit.parts ?? [];
      this.circuit = {
        ...this.circuit,
        parts: [...placed, { component: id, x: flat.x, y: flat.y, free: true }],
        terminals: [...this.netTerminals(), ...this.defaultLedTerminals(placed.length, id)],
      };
      this.selected = { kind: "part", index: placed.length };
    } else {
      // LEDs straddle a gap: snap the click to the nearest hinge between two tiles.
      const hit = nearestGap(this.gaps, flat);
      if (!hit || hit.dist > this.pickRadius()) {
        this.selected = null; // a tap on bare cloth clears the selection
        this.renderSide();
        this.render();
        return;
      }
      const seat = ledOf(hit.gap.faceA, hit.gap.faceB);
      const led = this.newLed(seat.a, seat.b);
      const at = this.circuit.leds.findIndex((l) => l.a === led.a && l.b === led.b);
      if (at >= 0) {
        // An LED already here: select it, so it can be rotated or removed. Tapping it no longer deletes it —
        // deleting on the same gesture that selects would make rotating one impossible.
        this.selected = { kind: "led", index: at };
        this.renderSide();
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
  private routedParts(): { component: string; a: Vec2; b: Vec2; flip?: boolean; source?: number }[] {
    return [...(this.routed.parts ?? []), ...this.freeParts()];
  }

  /**
   * The parts standing on the sheet, given the same `a`/`b` a seated part gets from the run it breaks.
   *
   * A seated part takes its segment from the copper: the router cuts a gap and hands back the two cut ends,
   * and every drawing and export downstream works from those. A free part has no run to take one from, so
   * one is made here from the place the author put it and the angle they turned it to — the part's own
   * `partFit.gap` long, centred on the drop point. That is the same length the rail would have removed for
   * it, so a part reads at the same size whether it is standing on the sheet or sitting in a rail.
   *
   * Built here rather than in the router because the router is not asked about these parts at all: it skips
   * them when it cuts rails, which is the whole point of `free`. Without this they would be placed, stored,
   * exported in the netlist — and invisible on the canvas, which is the worst of all the options.
   */
  private freeParts(): { component: string; a: Vec2; b: Vec2; flip?: boolean; source?: number }[] {
    const toFlat = (mm: number): number => (mm * this.tapeW()) / this.tapeMm();
    const out: { component: string; a: Vec2; b: Vec2; flip?: boolean; source?: number }[] = [];
    (this.circuit.parts ?? []).forEach((p, source) => {
      if (!p.free) return;
      const fp = footprintById(p.component);
      if (!fp) return; // a part the library no longer has, left undrawn rather than guessed at
      const half = toFlat(partFit(fp).gap) / 2;
      const th = ((p.rot ?? 0) * Math.PI) / 180;
      const ux = Math.cos(th), uy = Math.sin(th);
      out.push({
        component: p.component,
        a: { x: p.x - ux * half, y: p.y - uy * half },
        b: { x: p.x + ux * half, y: p.y + uy * half },
        ...(p.flip === undefined ? {} : { flip: p.flip }),
        source,
      });
    });
    return out;
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
    const toFlat = (mm: number): number => (mm * this.tapeW()) / this.tapeMm();
    const fit = fp ? partFit(fp) : null;
    const along = fit ? Math.max(fit.gap, fit.before + fit.after) : 0;
    return Math.max(toFlat(PART_PICK_FLOOR_MM), toFlat(along) / 2);
  }

  // ---- hand-drawn wires ----------------------------------------------------

  /**
   * Everything {@link WireTool} needs of this editor, in the editor's own terms.
   *
   * Every member is a method that already existed. The tool never holds a value read out of here — it
   * calls back on each gesture — so a pattern reloaded or a part moved under a half-drawn wire is seen
   * rather than remembered.
   */
  private wireHost(): WireHost {
    return {
      clientToFlat: (e) => this.clientToFlat(e as MouseEvent),
      tp: (p) => this.tp(p),
      // The part pick-up radius, not the hinge one: a wire attaches to a pad, and {@link pickRadius} is
      // six percent of the whole pattern — a snap that wide would put every tap on the nearest terminal.
      snapRadiusFlat: () => this.partPickRadius(null),
      circuit: () => this.circuit,
      commit: (next) => {
        this.circuit = next;
        this.emit();
      },
      context: () => this.wireContext(),
      live: () => this.liveLayer(),
      routed: () => this.routed,
    };
  }

  /** The pattern a wire's ends resolve against — the same faces, gaps and tape width the router plans on. */
  private wireContext(): WireContext {
    return { faces: this.faces, gaps: this.gaps, circuit: this.circuit, tapeW: this.tapeW() };
  }

  /**
   * All the copper on the sheet: the runs the router planned, and the ones the author drew.
   *
   * Everything that makes a cutting file takes this rather than `routed.traces`. A hand-drawn wire is
   * copper — it is cut from the same tape, at the same width, by the same blade — and a file built from
   * the plan alone would leave the author holding a canvas that shows a wire and a sheet that has none.
   * `manualTraces` hands back plain {@link Trace2D}s precisely so no export needs a branch for them.
   *
   * NOT what the router sees. `planRoutes` does not read `circuit.wires`, so it still plans as though the
   * drawn copper were not there; that gap is known and is not this method's to close.
   */
  private allTraces(): Trace2D[] {
    return [...this.routed.traces, ...manualTraces(this.wireContext())];
  }

  /**
   * How many drawn wires the strips file cannot carry.
   *
   * That file has exactly two cut layers, `pwr` and `gnd`, and takes a run onto one of them by matching
   * `Trace2D.net` against those two names. A wire the author drew between two free points carries its own
   * id, and one drawn between the pads of a declared net carries that net's id — neither is `pwr` or
   * `gnd`, so neither lands on a layer and both are dropped from the file without a word.
   *
   * Counted here so the status line can say so. Silence is the one thing this must not do: the canvas has
   * already told the author the copper exists.
   */
  private unlayeredWires(): number {
    return manualTraces(this.wireContext())
      .filter((t) => t.net !== "pwr" && t.net !== "gnd").length;
  }

  /**
   * The overlay group the wire tool paints into, and nothing else writes to.
   *
   * Re-queried on every call rather than held: `draw()` rewrites the canvas wholesale, so the element
   * this returns is a different one after every repaint. Before the first draw there is no canvas at all,
   * and a throwaway object stands in — arming the tool must not depend on having been rendered first.
   */
  private liveLayer(): { innerHTML: string } {
    return (this.svg.querySelector(".el-live") as { innerHTML: string } | null) ?? { innerHTML: "" };
  }

  /** The wires the author has drawn. */
  private wires(): ManualWire[] {
    return this.circuit.wires ?? [];
  }

  // ---- nets ---------------------------------------------------------------

  /**
   * Draw the nets bar: the declared nets, and the pads of whatever part is selected.
   *
   * Built here rather than in `render()` because it is DOM, not canvas — it changes when the circuit
   * changes, not when the view pans.
   */
  private renderNets(): void {
    this.netList.innerHTML = "";
    const nets = this.nets();
    // Rows, not stored terminals: the battery and the hinge-LEDs are on PWR and GND by construction and
    // have nothing stored, so counting `circuit.terminals` alone reported `PWR 0 · GND 0` on a circuit
    // that was fully routed. See {@link derivedRows}.
    const wired = this.panelRows();
    this.netTally.textContent = String(nets.length);
    this.netTally.title = `${nets.length} net${nets.length === 1 ? "" : "s"} declared`;
    if (nets.length === 0) {
      // An empty tree, said out loud. A blank panel reads as broken; this reads as "nothing here yet",
      // which is the true statement and points at the box that fixes it.
      const empty = document.createElement("p");
      empty.className = "el-side-empty";
      empty.textContent = "No nets yet — name one above to declare it.";
      this.netList.appendChild(empty);
      this.renderSide();
      return;
    }
    nets.forEach((net, i) => {
      const on = wired.filter((t) => t.net === net.id);
      const open = this.openNets.has(net.id);
      const colour = netColour(net, i);

      const row = document.createElement("div");
      row.className = "el-net";
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-expanded", open ? "true" : "false");

      // The twisty, exactly as a file tree spells it. Disabled with nothing under it rather than hidden:
      // a control that vanishes moves every row beside it, and the rows have to line up to read as a tree.
      const twist = document.createElement("button");
      twist.type = "button";
      twist.className = "el-net-twist";
      twist.textContent = on.length === 0 ? "·" : open ? "▾" : "▸";
      twist.disabled = on.length === 0;
      twist.setAttribute(
        "aria-label",
        on.length === 0 ? `${net.name} has no pads` : open ? `Collapse ${net.name}` : `Expand ${net.name}`,
      );
      twist.title = on.length === 0
        ? "No pads on this net yet"
        : open ? "Hide this net's pads" : "Show this net's pads";
      twist.addEventListener("click", () => this.toggleNetOpen(net.id));

      // A real colour input, not a menu of swatches: the browser already has a colour picker, it is the
      // one the author knows, and it does not cap them at whatever ten colours seemed like enough here.
      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.className = "el-net-colour";
      swatch.value = colour;
      swatch.dataset.net = net.id;
      swatch.title = `Colour for ${net.name}`;
      swatch.setAttribute("aria-label", `Colour for net ${net.name}`);
      swatch.addEventListener("change", () => this.recolourNet(net.id, swatch.value));

      // The name is an input, not a label: renaming is the common edit and a row you have to open a
      // dialog to rename is a row nobody renames.
      const name = document.createElement("input");
      name.type = "text";
      name.className = "el-net-name";
      name.value = net.name;
      name.dataset.net = net.id;
      name.setAttribute("aria-label", `Net name: ${net.name}`);
      name.addEventListener("change", () => this.renameNet(net.id, name.value));

      const tally = document.createElement("span");
      tally.className = "el-net-count";
      tally.textContent = String(on.length);
      tally.title = `${on.length} pad${on.length === 1 ? "" : "s"} on this net`;

      // What the router made of this net, where it could not finish it. `planNets` has always written a
      // `stranded` list and a sentence saying why, and nothing has ever read either: a net that lost a
      // terminal to another net's copper looked, in this panel, exactly like a net that was fully wired.
      // That is the failure this editor is least able to afford, because the circuit it draws is complete
      // and the one you build from it is not.
      const short = this.strandedOn(net.id);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "el-net-del";
      del.textContent = "×";
      del.title = `Delete the net ${net.name}, and unwire its pads`;
      del.addEventListener("click", () => this.deleteNet(net.id));

      row.appendChild(twist);
      row.appendChild(swatch);
      row.appendChild(name);
      row.appendChild(tally);
      if (short) row.appendChild(short);
      row.appendChild(del);
      this.netList.appendChild(row);

      if (open && on.length) this.netList.appendChild(this.netChildren(on, colour));
    });
    this.renderSide();
  }

  /**
   * The pads on one net, as the tree's child rows.
   *
   * Named by designator and pad — `R1 · 2` — because that is what the author reads on the canvas beside
   * the part. `Terminal.part` is an index into `circuit.parts`, and an index means nothing to a person
   * looking at a board.
   */
  private netChildren(on: NetRow[], colour: string): HTMLElement {
    const kids = document.createElement("div");
    kids.className = "el-net-kids";
    kids.setAttribute("role", "group");
    for (const t of on) {
      const kid = document.createElement("div");
      kid.className = t.derived ? "el-net-kid is-derived" : "el-net-kid";
      kid.setAttribute("role", "treeitem");
      const dot = document.createElement("i");
      dot.className = "el-net-kid-dot";
      dot.setAttribute("style", `background:${colour}`);
      const label = document.createElement("span");
      label.className = "el-net-kid-name";
      label.textContent = t.label;
      kid.appendChild(dot);
      kid.appendChild(label);
      if (t.derived) {
        // No control, because there is nothing here the author decides: this row states what the router
        // did. Offered an × they would take the battery off GND, the next replan would put it back, and
        // the app would look broken while behaving correctly.
        label.title = `${t.label} — wired by the router, not by hand`;
        const note = document.createElement("span");
        note.className = "el-net-kid-note";
        note.textContent = "router";
        kid.appendChild(note);
      } else {
        label.title = `Pad ${t.pad} of ${t.label.split(" · ")[0]}`;
        const off = document.createElement("button");
        off.type = "button";
        off.className = "el-net-kid-off";
        off.textContent = "×";
        off.title = `Take ${t.label} off this net`;
        off.setAttribute("aria-label", `Unwire ${t.label} from this net`);
        off.addEventListener("click", () => this.assignPad(t.part!, t.pad!, ""));
        kid.appendChild(off);
      }
      kids.appendChild(kid);
    }
    return kids;
  }

  /** Open or close one net's branch. View state only — nothing here reaches the circuit or the router. */
  private toggleNetOpen(id: string): void {
    if (this.openNets.has(id)) this.openNets.delete(id);
    else this.openNets.add(id);
    this.renderNets();
  }

  /**
   * Recolour a net.
   *
   * Goes through `emit()` like every other edit, because the colour is saved with the circuit and the
   * canvas draws the copper in it — a colour changed only in the sidebar would leave the two disagreeing
   * until the next unrelated edit repainted one of them.
   */
  private recolourNet(id: string, raw: string): void {
    const colour = (raw ?? "").trim();
    if (!colour) return;
    this.circuit = {
      ...this.circuit,
      nets: this.nets().map((n) => (n.id === id ? { ...n, color: colour } : n)),
    };
    this.emit();
  }

  /**
   * The selected part's pads, each with the net it is on.
   *
   * Only a library part has pads to offer: an LED straddles a hinge with its polarity decided by the
   * router, and the two legacy lists carry no component id to read a footprint from. The panel is hidden
   * for all of them rather than showing an empty row, which would read as "this part has no pads".
   *
   * The names come from `terminals(fp)` — the same reading the renderer and the router use — so a
   * mounting peg is never offered as something to wire.
   */
  /**
   * The whole sidebar below the nets: the parts placed, and then the pads of whichever one is selected.
   *
   * One call rather than two at every site, because the two panels are not independent — the pads panel
   * shows the selection, and the parts list is where the selection is now made.
   */
  private renderSide(): void {
    this.renderParts();
    this.renderPads();
  }

  /**
   * Every library part placed on the sheet, one row each.
   *
   * Without this the pads panel was the only place a part existed in the sidebar, and it shows the
   * SELECTED part alone — so placing a second part took the first one's pads, and the net dropdowns that
   * are the only way to wire them, out of the panel entirely. The part was still there and still stored
   * (nothing is lost from `circuit.terminals`), but the only way back to it was to find it on the canvas
   * and click it. With free placement dropping 26-way sockets anywhere on the sheet that is the ordinary
   * case, not an edge one.
   *
   * The count on each row is how many of the part's terminals are on a net. That is the number the author
   * is working through, and until now it was not shown anywhere.
   *
   * No delete control here on purpose: removal goes through `removeSelected` into `reindexTerminals`, and
   * a second door into that path wants its own tests rather than riding along with a panel that displays.
   */
  private renderParts(): void {
    this.partList.innerHTML = "";
    const parts = this.circuit.parts ?? [];
    if (parts.length === 0) {
      this.partsGroup.hidden = true;
      return;
    }
    this.partsGroup.hidden = false;
    this.partsTally.textContent = String(parts.length);
    this.partsTally.title = `${parts.length} part${parts.length === 1 ? "" : "s"} placed`;
    const tags = designators(parts);
    const sel = this.partSelection();
    parts.forEach((part, i) => {
      const comp = PART_BY_ID.get(part.component);
      const pads = comp ? terminals(comp.footprint).length : 0;
      const on = this.netTerminals().filter((t) => t.part === i).length;

      const row = document.createElement("button");
      row.type = "button";
      // `el-placed`, not `el-part`: the palette menu's rows are already `.el-part-row`, and a second set
      // under the same class made every library row answer a query meant for the placed ones.
      row.className = "el-placed-row";
      row.setAttribute("role", "listitem");
      row.dataset.part = String(i);
      // Both ways round: the canvas selection lights the row, and pressing the row selects on the canvas.
      const active = sel?.kind === "part" && sel.index === i;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-pressed", active ? "true" : "false");

      const tag = document.createElement("span");
      tag.className = "el-placed-tag";
      tag.textContent = tags[i] ?? `part ${i + 1}`;

      const note = document.createElement("span");
      note.className = "el-placed-note";
      note.textContent = comp ? comp.note || comp.id : part.component;

      const count = document.createElement("span");
      count.className = "el-placed-wired";
      count.textContent = `${on}/${pads}`;
      count.title = `${on} of ${pads} pad${pads === 1 ? "" : "s"} on a net`;
      // Nothing wired is the state worth marking, for the same reason an unassigned pad is marked.
      count.classList.toggle("is-unassigned", pads > 0 && on === 0);

      row.title = `${tags[i] ?? `part ${i + 1}`} — ${comp?.note || part.component}`;
      row.addEventListener("click", () => this.selectPart(i));
      row.appendChild(tag);
      row.appendChild(note);
      row.appendChild(count);
      this.partList.appendChild(row);
    });
  }

  /** Select a placed part from the list, exactly as clicking it on the canvas does. */
  private selectPart(index: number): void {
    if (!(this.circuit.parts ?? [])[index]) return;
    this.selected = { kind: "part", index };
    this.renderSide();
    this.render();
  }

  private renderPads(): void {
    this.padList.innerHTML = "";
    const sel = this.partSelection();
    const part = sel?.kind === "part" ? (this.circuit.parts ?? [])[sel.index] : undefined;
    const comp = part ? PART_BY_ID.get(part.component) : undefined;
    if (!sel || !part || !comp) {
      this.padsGroup.hidden = true;
      return;
    }
    this.padsGroup.hidden = false;
    this.padPart.textContent = `${comp.id} pads`;
    for (const [padName] of terminals(comp.footprint)) {
      const row = document.createElement("label");
      row.className = "el-pad";
      const tag = document.createElement("span");
      tag.className = "el-pad-name";
      tag.textContent = padName;
      const pick = document.createElement("select");
      pick.className = "el-pad-net";
      pick.dataset.pad = padName;
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "—";
      pick.appendChild(none);
      for (const net of this.nets()) {
        const opt = document.createElement("option");
        opt.value = net.id;
        opt.textContent = net.name;
        pick.appendChild(opt);
      }
      const on = this.padNet(sel.index, padName);
      pick.value = on;
      // An unassigned pad is the likeliest authoring mistake, so it is marked rather than merely blank.
      row.classList.toggle("is-unassigned", on === "");
      pick.addEventListener("change", () => this.assignPad(sel.index, padName, pick.value));
      row.appendChild(tag);
      row.appendChild(pick);
      this.padList.appendChild(row);
    }
  }

  /** The nets the author has declared, in declaration order. */
  private nets(): Net[] {
    return this.circuit.nets ?? [];
  }

  /**
   * The colour to fill a run of copper with, or null to leave it to the stylesheet.
   *
   * Null for the bus's own two rails even though nets called PWR and GND are seeded under those very
   * ids: the bus's copper is not the declared net's copper — `routeDeclaredNets` keeps them apart — and
   * recolouring the rails from the sidebar would say they were the same piece of tape.
   */
  private netFill(netId: string): string | null {
    if (netId === "pwr" || netId === "gnd") return null;
    const i = this.nets().findIndex((n) => n.id === netId);
    return i < 0 ? null : netColour(this.nets()[i]!, i);
  }

  /** Every pad assignment. `Terminal.part` indexes `circuit.parts` — see {@link removeSelected}. */
  private netTerminals(): Terminal[] {
    return this.circuit.terminals ?? [];
  }

  /**
   * Declare a net from the name box.
   *
   * The name is the author's and must be unique, because it is what they will read on a pad; the `id` is
   * minted here, never shown, and never changes — {@link Terminal.net} points at it, so a rename that
   * moved the id would quietly unwire every pad on the net.
   */
  private addNet(): void {
    const name = this.netNew.value.trim();
    if (!name) return;
    if (this.nameTaken(name, null)) {
      this.statusEl.textContent = `There is already a net called ${name} — names have to be unique`;
      return;
    }
    const ids = new Set(this.nets().map((n) => n.id));
    let n = 1;
    while (ids.has(`n${n}`)) n++;
    // Coloured on the way in, not when it is first drawn: the colour is saved with the circuit, so
    // minting it at draw time would give the same net a different colour in a file that was reopened
    // before it was ever painted.
    const colour = nextNetColour(this.nets().map((x, i) => netColour(x, i)));
    this.circuit = { ...this.circuit, nets: [...this.nets(), { id: `n${n}`, name, color: colour }] };
    this.netNew.value = "";
    this.emit();
  }

  /** Rename a net in place, keeping its id — and so keeping every pad already on it. */
  private renameNet(id: string, raw: string): void {
    const name = raw.trim();
    const was = this.nets().find((n) => n.id === id);
    if (!was) return;
    if (!name || this.nameTaken(name, id)) {
      this.statusEl.textContent = !name
        ? "A net needs a name"
        : `There is already a net called ${name} — names have to be unique`;
      this.renderNets(); // put the box back to the name that actually holds
      return;
    }
    this.circuit = {
      ...this.circuit,
      nets: this.nets().map((n) => (n.id === id ? { ...n, name } : n)),
    };
    this.emit();
  }

  /** Whether a name is already in use, ignoring the net being renamed. Case-insensitive: two nets called
   *  `SDA` and `sda` are a typo, not a design. */
  private nameTaken(name: string, exceptId: string | null): boolean {
    const key = name.toLowerCase();
    return this.nets().some((n) => n.id !== exceptId && n.name.toLowerCase() === key);
  }

  /** Delete a net, and with it every pad assignment that named it — a terminal pointing at a net that is
   *  gone is a fault, and leaving one behind would report as a fault the author did not cause. */
  private deleteNet(id: string): void {
    const on = this.netTerminals().filter((t) => t.net === id).length;
    const net = this.nets().find((n) => n.id === id);
    this.openNets.delete(id);
    this.circuit = {
      ...this.circuit,
      nets: this.nets().filter((n) => n.id !== id),
      terminals: this.netTerminals().filter((t) => t.net !== id),
    };
    this.emit();
    // After the emit, not before: `render()` rewrites the status line from the circuit, so a message set
    // first is overwritten by the redraw it triggers.
    if (net) {
      this.statusEl.textContent = on > 0
        ? `Deleted net ${net.name} and unwired ${on} pad${on === 1 ? "" : "s"}`
        : `Deleted net ${net.name}`;
    }
  }

  /**
   * Put one pad of one placed part on a net, or take it off.
   *
   * A pad is on at most one net: assigning replaces whatever it had. That is the same rule a schematic
   * has, and the alternative — a pad on two nets — is a short the router would dutifully build.
   */
  private assignPad(part: number, pad: string, net: string): void {
    // Open the branch the pad lands on, so the row that just appeared is one the author can see. A tree
    // that silently gains a hidden child is a tree that looks like nothing happened.
    if (net) this.openNets.add(net);
    const rest = this.netTerminals().filter((t) => !(t.part === part && t.pad === pad));
    this.circuit = {
      ...this.circuit,
      terminals: net ? [...rest, { part, pad, net }] : rest,
    };
    this.emit();
  }

  /**
   * Fix up the terminals after the part at `removed` is deleted.
   *
   * Drop the ones that were on it, and bring every index above it down by one. Missing this is the
   * failure the contract warned about: nothing errors, the netlist still resolves, and it wires pads that
   * belong to a different part.
   */
  private reindexTerminals(removed: number): void {
    const kept = this.netTerminals()
      .filter((t) => t.part !== removed)
      .map((t) => (t.part > removed ? { ...t, part: t.part - 1 } : t));
    if (kept.length !== this.netTerminals().length || kept.some((t, i) => t !== this.netTerminals()[i])) {
      this.circuit = { ...this.circuit, terminals: kept };
    }
  }

  /**
   * The nets a newly placed LED's pads should start on.
   *
   * Two decisions, kept in the two places they belong. **Which parts get a default at all** is a placement
   * question and lives here: only an LED, because its pads are an anode and a cathode and PWR/GND is the
   * only pair it can light on. A free resistor's two pads carry no polarity, and a twenty-six-way socket
   * would be a circuit the author never drew.
   *
   * **What the default IS** is a netlist question and lives in `netlist.ts › defaultTerminals`, which
   * refuses anything but a two-terminal part and refuses to point at rails the author has deleted. Calling
   * it rather than restating it keeps one rule in one place — the same reason `acrossPart` is read by both
   * the router and the drawing instead of each having its own version.
   */
  private defaultLedTerminals(part: number, component: string): Terminal[] {
    const fp = footprintById(component);
    if (!fp || !LED_BY_ID.has(component)) return [];
    return defaultTerminals(part, fp, this.nets());
  }

  /**
   * The battery's and the hinge-LEDs' membership of PWR and GND, as rows to show and never to store.
   *
   * Both are on those two nets by construction — the bus router puts them there — but the panel could
   * only ever show STORED assignments, so a circuit with a battery and a routed LED read `PWR 0 · GND 0`.
   * To the person looking at it, a rail that says 0 is not wired: the construction is invisible and
   * therefore, for their purposes, absent.
   *
   * **Derived, never stored.** For a hinge-LED, which leg is PWR is a routing OUTPUT — `planRoutes`
   * searches over `flip[]` — so it is only knowable after routing and would disagree with any stored value
   * the moment the router flipped one. That is also why these are read off `this.routed` and recomputed
   * every render rather than cached.
   *
   * Nothing is claimed for copper that did not arrive: an unreachable LED, or a plan that has not run,
   * contributes no rows. A row saying PWR where the tape never reached is worse than no row.
   */
  private derivedRows(): NetRow[] {
    const have = new Set(this.nets().map((n) => n.id));
    if (!have.has(PWR_NET_ID) || !have.has(GND_NET_ID)) return [];
    if (!this.routed.traces.length) return []; // nothing has been routed; claim nothing
    const rows: NetRow[] = [];
    if (this.circuit.battery) {
      rows.push({ net: PWR_NET_ID, label: "Battery +", derived: true });
      rows.push({ net: GND_NET_ID, label: "Battery −", derived: true });
    }
    this.circuit.leds.forEach((_led, i) => {
      if (this.routed.unreachable.includes(i)) return;
      const pads = this.routed.pads[i];
      if (!pads || (isZero(pads.pwr) && isZero(pads.gnd))) return;
      rows.push({ net: PWR_NET_ID, label: `LED ${i + 1} +`, derived: true });
      rows.push({ net: GND_NET_ID, label: `LED ${i + 1} −`, derived: true });
    });
    return rows;
  }

  /**
   * Every row the panel shows for the nets: what the author wired, and what the bus wired for them.
   *
   * Deliberately NOT folded into {@link netTerminals}, which four mutation paths read — `assignPad`,
   * `deleteNet`, `reindexTerminals` and the placement default all rebuild `circuit.terminals` from it, so
   * a derived row passing through there would be written to the circuit on the next edit. That is the one
   * thing these rows must never do.
   */
  private panelRows(): NetRow[] {
    const tags = designators(this.circuit.parts ?? []);
    const stored = this.netTerminals().map((t) => ({
      net: t.net,
      label: `${tags[t.part] ?? `part ${t.part}`} · ${t.pad}`,
      derived: false,
      part: t.part,
      pad: t.pad,
    }));
    return [...stored, ...this.derivedRows()];
  }

  /**
   * The marker for a net the router could not finish, or null when it did.
   *
   * A count, not a bare warning sign: "2" beside a net of five pads is the number the author has to act
   * on, and the reason is on the marker itself rather than in a panel somewhere else.
   */
  private strandedOn(netId: string): HTMLElement | null {
    const routed = (this.routed.nets ?? []).find((n) => n.id === netId);
    if (!routed || !routed.stranded.length) return null;
    const warn = document.createElement("span");
    warn.className = "el-net-short";
    warn.textContent = String(routed.stranded.length);
    warn.title = routed.why ?? `${routed.stranded.length} terminals could not be reached`;
    warn.setAttribute("aria-label", warn.title);
    return warn;
  }

  /**
   * What is wrong with the netlist itself, as one sentence.
   *
   * Six kinds of fault are resolved and reported by `resolveNetlist`, carried out through `planRoutes` as
   * `netFaults` — and read by nothing until now. A pad on a net that no longer exists, or a pad wired to
   * two nets, simply did not route and said nothing about it.
   */
  private netlistTrouble(): string {
    // An UNWIRED net is not a fault. `resolveNetlist` reports "fewer than two terminals" for both a net
    // with one pad on it and a net with none, because for its purposes they are the same thing — neither
    // can be routed. For an author they are opposite: one pad on a net is a mistake worth pointing at, and
    // no pads is a net they have declared and not got to yet. A fresh circuit is seeded with PWR and GND,
    // so reporting the empty case would greet every new pattern with two faults it did not cause.
    const wired = new Set(this.netTerminals().map((t) => t.net));
    const faults = (this.routed.netFaults ?? []).filter(
      (f) => !(f.kind === "single-terminal-net" && f.net != null && !wired.has(f.net)),
    );
    const stranded = (this.routed.nets ?? []).reduce((a, n) => a + n.stranded.length, 0);
    const parts: string[] = [];
    if (faults.length) {
      parts.push(
        `${faults.length} netlist fault${faults.length === 1 ? "" : "s"}: ${faults[0]!.why}`,
      );
    }
    if (stranded) {
      parts.push(
        `${stranded} terminal${stranded === 1 ? "" : "s"} could not be reached without crossing another net`,
      );
    }
    return parts.length ? ` · ${parts.join(" · ")}` : "";
  }

  /** Which net a pad is on, or "" for unassigned. */
  private padNet(part: number, pad: string): string {
    return this.netTerminals().find((t) => t.part === part && t.pad === pad)?.net ?? "";
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

  /** Download the copper as a cutting file, at the width the preview draws — planned and drawn alike. */
  private exportCopper(): void {
    const traces = this.allTraces();
    // Hand-drawn copper counts. A sheet carrying only wires the author drew has real copper on it, and
    // refusing to export one while telling them to place a battery was blaming them for a file we simply
    // were not building.
    if (!this.fold || !traces.length) {
      this.statusEl.textContent = "Nothing to export — place a battery and at least one LED, or draw a wire";
      return;
    }
    const out = buildCopperSvgExport(
      this.fold, traces, this.tapeW(), "kiri", this.routed.pads, this.mirror, this.sheetMm, this.routed.resistors, this.routed.switches, this.routedParts(),
    );
    this.download(out.filename, out.svg);
    const { pwr, gnd } = out.counts;
    const w = Math.round(out.widthMm * 100) / 100;
    let msg =
      `Exported ${out.filename} — ${pwr} PWR strip${pwr === 1 ? "" : "s"}, ` +
      `${gnd} GND strip${gnd === 1 ? "" : "s"}, ${w}mm wide${this.mirrorNote()}`;
    // The strip width follows the pattern, and a flat pattern need not be at a physical scale.
    if (out.tooNarrow) msg += " — too narrow to cut; scale the pattern up before cutting";
    // And the drawn wires this file could not take. The strips file cuts two layers, PWR and GND, and a
    // wire on neither is left out of it — see {@link unlayeredWires}. Said out loud, with the way out,
    // because the canvas has already shown the author that copper and they would otherwise find it missing
    // on the mat.
    const missed = this.unlayeredWires();
    if (missed > 0) {
      msg +=
        ` — warning: ${missed} drawn wire${missed === 1 ? " is" : "s are"} not in this file;` +
        ` the strips file cuts PWR and GND only, so draw a wire from a battery terminal to put it on a rail` +
        ` (the carrier file carries them all)`;
    }
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
      // A part standing on the sheet turns; a part sitting in a rail flips.
      //
      // They are different operations because the two parts are held differently. A seated part's angle
      // belongs to the run it breaks — the router chose it — so the only thing left for the author to say is
      // which way round the part goes ON that run, which is `flip`. A free part has no run and no angle but
      // the one it is given, so R turns it a quarter at a time, all the way round and back to where it
      // started. Flipping one instead would mirror its pads about a break that does not exist.
      const free = part.kind === "part" ? (this.circuit.parts ?? [])[part.index] : undefined;
      if (free?.free) {
        this.circuit = {
          ...this.circuit,
          parts: (this.circuit.parts ?? []).map((p, i) =>
            i === part.index ? { ...p, rot: (((p.rot ?? 0) + 90) % 360 + 360) % 360 } : p),
        };
        this.emit();
        return;
      }
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
      // `Terminal.part` is an INDEX into `circuit.parts`, so removing one shifts every part above it and
      // silently re-points their terminals at their neighbours — a netlist that still resolves and wires
      // the wrong pads. Its own terminals go with it; the ones above it come down one.
      if (part.kind === "part") this.reindexTerminals(sel.index);
    }
    this.selected = null;
    this.emit();
  }

  /** Draw the edit, then notify the controller so it stores the circuit.
   *  The redraw must happen here: the controller does not push anything back, so an edit that only
   *  emitted would update `this.circuit` and never appear on screen. */
  private emit(): void {
    // The canvas first, because `render()` re-plans and the nets panel reads the plan: the battery's and
    // each hinge-LED's rows are derived from `this.routed` (see {@link derivedRows}). Painted first, the
    // panel showed the plan from BEFORE this edit — one behind, so a freshly placed LED contributed
    // nothing to its rails' counts until the next unrelated edit repainted them.
    this.render();
    this.renderNets();
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
    // Every guard hands the gesture to the wire tool and then rewrites the status line, because the tool
    // repaints only its own layer: the status is written by `draw()`, which a gesture deliberately never
    // calls, so without this the line saying a wire cannot be cut would appear one edit late — after the
    // copper was committed, which is exactly when it is no longer useful.
    if (this.wire.onPointerDown(e)) return this.renderStatus();
    // A click on the canvas is a placement, and it puts the library away first.
    if (this.menuOpen) this.setMenuOpen(false);
    if (e.button !== 0) return;
    // Grabbing a free part moves it, and is checked BEFORE the pan is armed for the same reason the wire
    // tool is: once `this.pan` is set the gesture is a pan, and a part under the cursor would never get a
    // chance at it. Only free parts move — a seated one is held by the run it breaks, and dragging it would
    // be asking the router to re-cut copper somewhere else, which is what placing it again already does.
    // Whatever tool is armed, because there is no neutral one to switch to — the editor always has a
    // placement tool active. That is not a compromise: pressing ON a part is already unambiguous, and
    // `onCanvasClick` has always treated a click on a part as selecting it rather than dropping a second
    // one on top. This is that same rule, carried through the whole gesture instead of only its end.
    const flat = this.clientToFlat(e);
    const hit = flat ? this.partAt(flat) : null;
    if (flat && hit && hit.kind === "part" && (this.circuit.parts ?? [])[hit.index]?.free) {
      this.partDrag = { index: hit.index, from: flat, at: flat };
      this.selected = hit;
      // The sidebar follows the press, not just the click. Selecting here and repainting only the canvas
      // left the parts list and the pads panel showing the PREVIOUS part for the whole gesture — and for
      // a press that never moves, for good, since a drag that goes nowhere commits nothing.
      this.renderSide();
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    this.pan = { x: e.clientX, y: e.clientY, moved: 0 };
    this.svg.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.wire.onPointerMove(e)) return this.renderStatus();
    // A part being dragged paints into the live layer and nowhere else. Committing on every move would
    // re-plan the whole circuit — most of a second — for each of the dozens of events in one drag, which is
    // the same reason the wire tool commits on pointer-up. The part stays drawn where it was until the drag
    // lands, so the ghost shows where it is going and the original shows where it came from.
    if (this.partDrag) {
      const flat = this.clientToFlat(e);
      if (flat) {
        this.partDrag.at = flat;
        this.paintPartGhost();
      }
      return;
    }
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
    if (this.wire.onPointerUp(e)) return this.renderStatus();
    const drag = this.partDrag;
    this.partDrag = null;
    if (drag) {
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
      this.liveLayer().innerHTML = "";
      const dx = drag.at.x - drag.from.x, dy = drag.at.y - drag.from.y;
      // A press that never moved is a selection, not a move: committing it would re-plan the circuit to put
      // the part back exactly where it already is, and cost most of a second doing it.
      if (Math.hypot(dx, dy) < 1e-9) return this.render();
      this.circuit = {
        ...this.circuit,
        parts: (this.circuit.parts ?? []).map((q, i) =>
          i === drag.index ? { ...q, x: q.x + dx, y: q.y + dy } : q),
      };
      this.emit();
      return;
    }
    const p = this.pan;
    this.pan = null;
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    // A near-stationary press is a tap → place a component; a drag was a pan.
    if (p && p.moved < 5) this.onCanvasClick(e);
  }

  // ---- rendering -----------------------------------------------------------

  /** Re-plan copper for the current circuit. Cheap enough to do on every edit. */
  private replan(): void {
    this.routed = this.fold
      ? planRoutes(this.faces, this.gaps, this.circuit, this.sheetMm, this.sheetSpec)
      : EMPTY_ROUTE;
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
    if (this.viewMode === "carrier" && this.allTraces().length) {
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
      // A declared net is drawn in the colour the author gave it; the bus's two rails keep their classes.
      // Both are needed: the bus is not in `circuit.nets` at all, so there is no colour to look up for it,
      // and every declared net that is not one of the two rails would otherwise be painted GND black.
      const fill = this.netFill(t.net);
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
      const paint = fill ? ` fill="${fill}"` : "";
      parts.push(
        `<path d="${[sub(outer), ...mine.map(sub)].join(" ")}" class="${cls}"${paint} fill-rule="evenodd" />`,
      );
    }
    // Copper the author drew by hand: over the planned tape, under the parts. Drawn as the outline that
    // will be cut, exactly as a planned run is — a hand-drawn wire is the same tape, and a stroked
    // centreline would show the canvas a shape the cut file does not contain.
    for (const t of manualTraces(this.wireContext())) {
      const ring = stripOutline(t, this.tapeW(), this.routed.pads);
      if (ring.length < 3) continue;
      const d = "M " + ring.map((p, k) => (k === 0 ? "" : "L ") + ptStr(this.tp(p))).join(" ") + " Z";
      parts.push(`<path d="${d}" class="el-tape el-wire-copper" />`);
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
      parts.push(this.selectionRing(this.tp(selSpan.a), this.tp(selSpan.b), "el-part-selected"));
    }
    this.drawnZoomStep = this.zoomStep();
    // An LED is drawn above, with every other part, as the footprint that will be cut — two real pads at
    // the part's own size, each carrying its terminal's name. Polarity comes out of that for free: the
    // anode is pad `1` and the router's PWR pad is where it is drawn, so the drawing says which way round
    // to fit the part without a colour of its own.
    //
    // What is left here is the two marks that are about the LED's state rather than its shape: the ring on
    // the selected one, and the ring on one the copper never reached.
    this.circuit.leds.forEach((led, i) => {
      const pads = this.ledPads(led, i);
      if (!pads) return;
      const a = this.tp(pads.pwr), b = this.tp(pads.gnd);
      if (this.routed.unreachable.includes(i)) {
        parts.push(this.selectionRing(a, b, "el-led-orphan"));
      }
      if (this.selected?.kind === "led" && this.selected.index === i) {
        parts.push(this.selectionRing(a, b, "el-led-selected"));
      }
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
    // Two groups, and the split is what makes drawing a wire feel like drawing rather than waiting. The
    // static half is everything above: the pattern, the plan and the parts, repainted wholesale on an edit
    // or a zoom, exactly as it always was. The live half is the wire tool's alone — one wire's worth of
    // nodes, rewritten on every pointer move — because a full re-plan is most of a second and a drag that
    // re-planned would be a drag that stutters. The tool commits on pointer *up*, once.
    this.svg.innerHTML = `<g class="el-static">${parts.join("")}</g><g class="el-live"></g>`;
    // The live layer was just thrown away with the rest of the canvas, so put it back.
    this.wire.paint();
    this.renderStatus();
  }

  /**
   * A ring round the two ends a component bridges, big enough to sit outside it.
   *
   * One helper because it is one mark: the same circle whether it rings a part broken into a rail or an
   * LED sat on a hinge, differing only in the class. Sized off the component's own span, floored at
   * {@link SELECT_RING_FLOOR_MM} so the smallest parts still get a ring rather than a dot inside them.
   */
  private selectionRing(a: Vec2, b: Vec2, cls: string): string {
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = Math.max(Math.hypot(b.x - a.x, b.y - a.y) * 0.75, SELECT_RING_FLOOR_MM);
    return `<circle cx="${fmt(c.x)}" cy="${fmt(c.y)}" r="${fmt(r)}" class="${cls}" />`;
  }

  /**
   * Where an LED's two pads sit, in flat-pattern units, or null if its hinge is gone.
   *
   * The router's pads, when it has them, because those are the copper the part has to land on — and
   * polarity with them: `pwr` is whichever leg it put PWR on, which is where the anode goes.
   *
   * With no copper — an LED the router could not reach, or could not seat the part on — the part is drawn
   * at its OWN pitch, straddling the middle of the hinge. Not at the hinge's dents, which is what it used
   * to be: those are 5.8mm apart on `house.fkld` and an `LED_0603`'s legs are 1.5mm, so drawing it there
   * showed a part stretched to four times its length. The point of drawing the footprint at all is that
   * what is on the canvas is the part that gets fitted, and that has to hold when it is not routed too.
   */
  private ledPads(led: Led, i: number): { pwr: Vec2; gnd: Vec2 } | null {
    const gap = gapForLed(this.gaps, led);
    if (!gap) return null;
    const planned = this.routed.pads[i];
    if (planned && !isZero(planned.pwr) && !isZero(planned.gnd)) {
      return { pwr: planned.pwr, gnd: planned.gnd };
    }
    // Along the hinge's own two legs where they differ, so an unrouted LED lies the way a routed one on
    // that hinge would; across the shared edge where the hinge has pinched to nothing and they do not.
    let ax = gap.legA.x - gap.legB.x, ay = gap.legA.y - gap.legB.y;
    if (Math.hypot(ax, ay) < 1e-6) {
      const [e0, e1] = gap.ends;
      ax = -(e1.y - e0.y); ay = e1.x - e0.x;
    }
    const al = Math.hypot(ax, ay) || 1;
    ax /= al; ay /= al;
    // Flat-pattern units, not millimetres: everything this returns is put through `tp()`, which scales by
    // the print size. The half-pitch is the part's, in sheet millimetres, so it has to come back out of
    // that scale first — the old marker-sized fallback did not, and on `house.fkld`, where a millimetre of
    // sheet is a thirtieth of a pattern unit, it put the two pads 49mm apart on a 1.5mm part.
    const sep = ledPitch(ledPart(led).footprint) / 2 / (this.scale() || 1);
    const mid = gap.point;
    return {
      pwr: { x: mid.x + ax * sep, y: mid.y + ay * sep },
      gnd: { x: mid.x - ax * sep, y: mid.y - ay * sep },
    };
  }

  /** A placed library part's drawn shape, in the sheet millimetres the canvas works in. */
  /**
   * The dragged part, drawn at the cursor, into the live layer only.
   *
   * Deliberately the part's own outline rather than a box or a crosshair: where a twenty-six-way socket's
   * pads will land is the whole question being asked during the drag, and a marker that does not show them
   * answers it only once the drag is over and the circuit has been re-planned.
   */
  private paintPartGhost(): void {
    const d = this.partDrag;
    if (!d) return;
    const part = (this.circuit.parts ?? [])[d.index];
    const fp = part ? footprintById(part.component) : null;
    if (!part || !fp) return;
    const dx = d.at.x - d.from.x, dy = d.at.y - d.from.y;
    const half = ((partFit(fp).gap * this.tapeW()) / this.tapeMm()) / 2;
    const th = ((part.rot ?? 0) * Math.PI) / 180;
    const ux = Math.cos(th), uy = Math.sin(th);
    const c = { x: part.x + dx, y: part.y + dy };
    const shape = partShape(
      fp,
      this.tp({ x: c.x - ux * half, y: c.y - uy * half }),
      this.tp({ x: c.x + ux * half, y: c.y + uy * half }),
      part.flip,
    );
    if (!shape) return;
    // No designator on a ghost: the label belongs to the part where it is, and a second copy of `U1`
    // floating at the cursor reads as a second part rather than as the same one on its way somewhere.
    this.liveLayer().innerHTML =
      `<g class="el-part-ghost">${partSvg(fp, shape, "", { labels: false }).join("")}</g>`;
  }

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
    // And the LEDs, last — the same order the cut files take them in, so an LED numbered `LED1` here is
    // `LED1` in the file too. An LED is not a series part, but it is a two-pad part bridging a break like
    // any other, so `partShape`'s in-line form draws it: pad 1 on the PWR end, pad 2 on the GND end.
    //
    // No `flip` is passed, and that is not an omission. `flip` is which way round the part sits on a
    // break; an LED's anode always goes to PWR, and the author's turn has already been spent deciding
    // which of the hinge's two legs PWR is. Passing it again would turn the part a second time.
    this.circuit.leds.forEach((led, i) => {
      const pads = this.ledPads(led, i);
      if (!pads) return;
      const c = ledPart(led);
      add(c.id, c.footprint, partShape(c.footprint, this.tp(pads.pwr), this.tp(pads.gnd)));
    });
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
      // The same traces the carrier FILE is built from, drawn wires and all. The preview drifting from the
      // file is the exact failure this function exists to prevent, and leaving the wires out of one but not
      // the other would put it straight back.
      this.fold, this.allTraces(), this.tapeW(), "kiri", this.keepOff(), this.mirror, this.sheetMm,
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
    const traces = this.allTraces();
    if (!this.fold || !traces.length) {
      this.statusEl.textContent = "Nothing to export — place a battery and at least one LED, or draw a wire";
      return;
    }
    // Every trace, drawn ones included — and unlike the strips file the carrier takes them whatever net
    // they are on, because it holds runs in a frame rather than sorting them onto two cut layers.
    const out = buildCopperCarrierExport(
      this.fold, traces, this.tapeW(), "kiri", this.keepOff(), this.mirror, this.sheetMm,
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


  /** The battery's two terminals. Shared with the router so the copper lands on the drawn squares. */
  private defaultTerminals(c: Vec2, poly?: Vec2[]): Terminals {
    // The tape width MUST be the router's, not the default: the terminal spacing is derived from it, so a
    // different width here draws the two pads somewhere the copper never goes. On a pattern read as a 130mm
    // sheet the default 6.5 put them several pattern-widths off the tile — off-canvas entirely.
    return batteryTerminals(c, this.diag(), poly, this.tapeW());
  }

  /** Tape width. Shared with the router, so the strips drawn are the strips it planned clearances for. */
  private tapeW(): number {
    return tapeWidthFor(this.faces, this.sheetMm, this.sheetSpec, this.circuit);
  }

  /** The same tape in millimetres. `tapeW() / tapeMm()` is this pattern's scale, and any millimetre figure
   *  converted with `TAPE_MM` instead would be off by whatever roll the router actually chose. */
  private tapeMm(): number {
    return tapeMmFor(this.faces, this.sheetMm, this.sheetSpec, this.circuit);
  }

  private diag(): number {
    return Math.hypot(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY) || 1;
  }

  private renderStatus(): void {
    const n = this.circuit.leds.length;
    const batt = this.circuit.battery ? "battery set" : "no battery";
    let msg = `${n} LED${n === 1 ? "" : "s"} · ${batt}`;
    if (!this.circuit.battery && n > 0) msg += " · add a battery";
    // Two faults, said apart. An LED the copper cannot get to and an LED whose package will not sit on its
    // hinge were both reported as "unreachable", and they send the author to different places: one is
    // solved by moving the LED or bridging by hand, the other by a smaller package. On some patterns every
    // failure is the second kind — akde-square-pyramid loses 8 of 12 that way and none the other — so the
    // single word was wrong every time it appeared there.
    const unseated = (this.routed.unseated ?? []).length;
    const un = this.routed.unreachable.length - unseated;
    if (un > 0 && this.circuit.battery) msg += ` · ${un} unreachable`;
    if (unseated > 0) {
      msg += ` · ${unseated} ${unseated === 1 ? "LED does" : "LEDs do"} not fit on ${unseated === 1 ? "its" : "their"} hinge`;
    }
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
    // Hand-drawn copper, and what is wrong with the wire being drawn. The faults are the tool's own
    // reading, taken as each vertex is laid — a wire that cannot be built should say so while there is
    // still a hand on it, not once it is copper.
    const wires = this.wires().length;
    if (wires > 0) msg += ` · ${wires} hand wire${wires === 1 ? "" : "s"}`;
    if (this.tool === "wire") {
      // An error and a warning are different things and must not read alike: an ERROR means the wire
      // cannot be cut, a WARNING means it can and will cost something — a weaker sheet, a harder weed, a
      // shorter fold life. The rule is `wire-rules.ts`'s, read rather than restated, so the line the
      // author sees agrees with `isBuildable` by construction.
      const faults = this.wire.faults();
      const bad = faults.filter((f) => ERRORS.has(f.kind));
      msg += bad.length
        ? ` · this wire cannot be cut: ${bad[0]!.why}`
        : faults.length
          ? ` · ${faults.length} warning${faults.length === 1 ? "" : "s"}, still cuttable: ${faults[0]!.why}`
          : this.wire.drawing()
            ? " · tap to lay a point, tap the last one or press Enter to finish"
            : " · tap the pattern to start a wire";
    }
    msg += this.netlistTrouble();
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

/**
 * A circuit safe to hand to the store: every array and object copied, so an edit here cannot reach back
 * into what the controller already holds.
 *
 * **Read this before adding a field to `Circuit`.** This function has silently eaten six fields — `flip`,
 * `component`, `nets`/`terminals`, `wires`, `free`, `color` — and each one had the same symptom: the value
 * drew on the canvas and was simply not there one hop later. Nothing throws. Nothing logs.
 *
 * Six times is not six mistakes, it is the shape of a hand-written whitelist over a model that gains a
 * field every few hours. So the default is inverted: everything this function does not deep-copy by name
 * is carried through by `...rest`, and a newly added field survives without anyone remembering it.
 *
 * `...rest` carries **by reference**, which is exact for a primitive and not good enough for a nested
 * structure — a new array field would be shared with the modal's own circuit rather than copied. That is
 * still strictly better than losing it, and the round-trip test in the suite is what tells you a field has
 * arrived and wants a real copy here.
 */
function cloneCircuit(c: Circuit): Circuit {
  // Everything named here is deep-copied below; `rest` is whatever the model has gained since.
  const { leds, battery, resistors, switches, parts, nets, terminals, wires, ...rest } = c;
  return {
    ...rest,
    // `flip` travels with the LED: it is the author's decision about which way round the part goes, and a
    // clone that dropped it would lose the rotation the moment the circuit reached the store. So does
    // `component`, for the same reason and with the same trap: dropped, every 0603 would reach the store
    // as the default 1206 and be routed to a pitch its legs cannot reach. Both are written only where the
    // author actually chose one, so an unturned 1206 clones to exactly the `{a, b}` it always did.
    leds: leds.map((l) => ({
      a: l.a,
      b: l.b,
      ...(l.flip === undefined ? {} : { flip: l.flip }),
      ...(l.component === undefined ? {} : { component: l.component }),
    })),
    battery: battery ? { face: battery.face } : null,
    // Likewise the resistors: a clone that dropped them would draw one on the canvas and lose it the moment
    // the circuit reached the store — gone from the folded model, and from the next render back.
    // `flip` travels with each of them for the same reason it travels with an LED: it is the author's
    // decision about which way round the part goes, and a clone that dropped it would lose the turn the
    // moment the circuit reached the store.
    resistors: (resistors ?? []).map(withFlip),
    switches: (switches ?? []).map(withFlip),
    // And every library part, which is the same trap once more: a clone that dropped `parts` would draw
    // one on the canvas and lose it the moment the circuit reached the store.
    // `free` and `rot` travel too, and for the sharper version of the same reason: a free part that lost
    // its flag would come back as a part in series, and the router would cut a rail for it somewhere the
    // author never put it. Written only where they are set, so a seated part clones to the same object it
    // always did and the recorded geometry above stays exact.
    parts: (parts ?? []).map((p) => ({
      component: p.component,
      ...withFlip(p),
      ...(p.free ? { free: true } : {}),
      ...(p.rot === undefined ? {} : { rot: p.rot }),
    })),
    // And the netlist, which is the same trap once more and a worse one: a clone that dropped these would
    // show the nets in the bar and lose every one of them the moment the circuit reached the store.
    // `color` travels with the net for the same reason `flip` travels with a part: the author chose it,
    // and a clone that dropped it would show the colour in the sidebar and lose it the moment the circuit
    // reached the store. Written only where there is one, so a circuit authored before colours existed
    // still clones to exactly the `{ id, name }` it always did.
    nets: (nets ?? []).map((n) => (n.color === undefined
      ? { id: n.id, name: n.name }
      : { id: n.id, name: n.name, color: n.color })),
    terminals: (terminals ?? []).map((t) => ({ part: t.part, pad: t.pad, net: t.net })),
    // And the hand-drawn wires, which is the same trap a fourth time: this function copies field by field
    // and silently drops anything it does not name, so a wire left out here would draw on the canvas and
    // vanish the instant the circuit went round through the store. `net` and `width` travel only where the
    // wire actually carries one — an absent `net` MEANS "a net of its own" (see {@link ManualWire.net}),
    // so writing `undefined` in would be a different wire from the one the author drew.
    wires: (wires ?? []).map(cloneWire),
  };
}

/** One hand-drawn wire, copied down to its vertices so the stored circuit shares nothing with the editor's. */
function cloneWire(w: ManualWire): ManualWire {
  const out: ManualWire = { id: w.id, pts: w.pts.map((v) => ({ ...v })) };
  if (w.net !== undefined) out.net = w.net;
  if (w.width !== undefined) out.width = w.width;
  return out;
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
