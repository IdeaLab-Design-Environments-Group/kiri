/**
 * **View helper** — the presenters behind the electronics modal's side panels and status line.
 *
 * Deliberately DOM-free, and deliberately `this`-free. Everything here answers "what should the UI
 * show?" from plain data: a {@link Circuit}, a {@link RoutedCircuit}, and whatever view state the
 * question needs (which branches are open, what is selected). The modal takes the rows and strings
 * these return and writes them into elements — it decides nothing about their content.
 *
 * The split exists because the two halves fail differently. A wrong row is a wrong sentence shown to
 * an author, and it is worth a test that reads like the sentence; a wrong `appendChild` is a layout
 * bug you see the moment you look at the panel. Mixing them meant every question about the first kind
 * had to be asked through a mock DOM.
 */
import type { Circuit } from "../model/electronics.js";
import type { RoutedCircuit } from "../model/electronics-routing.js";
import type { Vec2 } from "../model/electronics.js";
import { GND_NET_ID, PWR_NET_ID, netColour } from "../model/net-palette.js";
import { designators } from "../model/part-render.js";
import { terminals } from "../model/footprint.js";
import { PART_BY_ID } from "./electronics-palette.js";
import { ERRORS } from "../model/wire-rules.js";

const isZero = (p: Vec2): boolean => p.x === 0 && p.y === 0;

/**
 * One row under a net in the panel.
 *
 * `derived` rows state what the bus router did with the battery and the hinge-LEDs. They are rendered and
 * counted like any other row and are **not** stored on the circuit, cannot be unwired, and carry no
 * `part`/`pad` — there is no `Circuit.parts` index for a battery or a hinge-LED to point at.
 */
export interface NetRow {
  net: string;
  /** What the author reads — `R1 · 2` for a wired pad, `Battery +` for a derived one. */
  label: string;
  derived: boolean;
  part?: number;
  pad?: string;
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
 * the moment the router flipped one. That is also why these are read off `routed` and recomputed
 * every render rather than cached.
 *
 * Nothing is claimed for copper that did not arrive: an unreachable LED, or a plan that has not run,
 * contributes no rows. A row saying PWR where the tape never reached is worse than no row.
 */
export function derivedNetRows(circuit: Circuit, routed: RoutedCircuit): NetRow[] {
  const nets = circuit.nets ?? [];
  const have = new Set(nets.map((n) => n.id));
  if (!have.has(PWR_NET_ID) || !have.has(GND_NET_ID)) return [];
  if (!routed.traces.length) return []; // nothing has been routed; claim nothing
  const rows: NetRow[] = [];
  if (circuit.battery) {
    rows.push({ net: PWR_NET_ID, label: "Battery +", derived: true });
    rows.push({ net: GND_NET_ID, label: "Battery −", derived: true });
  }
  circuit.leds.forEach((_led, i) => {
    if (routed.unreachable.includes(i)) return;
    const pads = routed.pads[i];
    if (!pads || (isZero(pads.pwr) && isZero(pads.gnd))) return;
    rows.push({ net: PWR_NET_ID, label: `LED ${i + 1} +`, derived: true });
    rows.push({ net: GND_NET_ID, label: `LED ${i + 1} −`, derived: true });
  });
  return rows;
}

/**
 * Every row the panel shows for the nets: what the author wired, and what the bus wired for them.
 *
 * Deliberately NOT folded into `circuit.terminals`, which four mutation paths read — `assignPad`,
 * `deleteNet`, `reindexTerminals` and the placement default all rebuild `circuit.terminals` from it, so
 * a derived row passing through there would be written to the circuit on the next edit. That is the one
 * thing these rows must never do.
 */
export function netPanelRows(circuit: Circuit, routed: RoutedCircuit): NetRow[] {
  const tags = designators(circuit.parts ?? []);
  const stored = (circuit.terminals ?? []).map((t) => ({
    net: t.net,
    label: `${tags[t.part] ?? `part ${t.part}`} · ${t.pad}`,
    derived: false,
    part: t.part,
    pad: t.pad,
  }));
  return [...stored, ...derivedNetRows(circuit, routed)];
}

/**
 * The marker for a net the router could not finish, or null when it did.
 *
 * A count, not a bare warning sign: "2" beside a net of five pads is the number the author has to act
 * on, and the reason is on the marker itself rather than in a panel somewhere else.
 */
export function strandedOn(routed: RoutedCircuit, netId: string): { count: number; why: string } | null {
  const on = (routed.nets ?? []).find((n) => n.id === netId);
  if (!on || !on.stranded.length) return null;
  return {
    count: on.stranded.length,
    why: on.why ?? `${on.stranded.length} terminals could not be reached`,
  };
}

/** One net's row in the tree, and the child rows hanging off it. */
export interface NetPanelRow {
  id: string;
  name: string;
  /** The net's own colour, already resolved through the palette's index fallback. */
  colour: string;
  open: boolean;
  /** The rows under it — stored pads and derived router rows alike. */
  pads: NetRow[];
  /** The twisty: what it reads, whether it can be pressed, and what it says to a screen reader. */
  twist: { glyph: string; disabled: boolean; label: string; title: string };
  tally: { text: string; title: string };
  stranded: { count: number; why: string } | null;
  colourTitle: string;
  colourLabel: string;
  nameLabel: string;
  deleteTitle: string;
}

/** The header count above the tree: how many nets are declared. */
export function netTally(circuit: Circuit): { text: string; title: string } {
  const n = (circuit.nets ?? []).length;
  return { text: String(n), title: `${n} net${n === 1 ? "" : "s"} declared` };
}

/**
 * What the nets tree shows, one entry per declared net, in declaration order.
 *
 * Rows, not stored terminals: the battery and the hinge-LEDs are on PWR and GND by construction and
 * have nothing stored, so counting `circuit.terminals` alone reported `PWR 0 · GND 0` on a circuit
 * that was fully routed. See {@link derivedNetRows}.
 *
 * `stranded` is what the router made of this net, where it could not finish it. `planNets` has always
 * written a `stranded` list and a sentence saying why, and nothing has ever read either: a net that lost
 * a terminal to another net's copper looked, in this panel, exactly like a net that was fully wired.
 * That is the failure this editor is least able to afford, because the circuit it draws is complete and
 * the one you build from it is not.
 */
export function buildNetRows(
  circuit: Circuit,
  routed: RoutedCircuit,
  openNets: ReadonlySet<string>,
): NetPanelRow[] {
  const wired = netPanelRows(circuit, routed);
  return (circuit.nets ?? []).map((net, i) => {
    const on = wired.filter((t) => t.net === net.id);
    const open = openNets.has(net.id);
    return {
      id: net.id,
      name: net.name,
      colour: netColour(net, i),
      open,
      pads: on,
      // The twisty, exactly as a file tree spells it. Disabled with nothing under it rather than hidden:
      // a control that vanishes moves every row beside it, and the rows have to line up to read as a tree.
      twist: {
        glyph: on.length === 0 ? "·" : open ? "▾" : "▸",
        disabled: on.length === 0,
        label: on.length === 0
          ? `${net.name} has no pads`
          : open ? `Collapse ${net.name}` : `Expand ${net.name}`,
        title: on.length === 0
          ? "No pads on this net yet"
          : open ? "Hide this net's pads" : "Show this net's pads",
      },
      tally: {
        text: String(on.length),
        title: `${on.length} pad${on.length === 1 ? "" : "s"} on this net`,
      },
      stranded: strandedOn(routed, net.id),
      colourTitle: `Colour for ${net.name}`,
      colourLabel: `Colour for net ${net.name}`,
      nameLabel: `Net name: ${net.name}`,
      deleteTitle: `Delete the net ${net.name}, and unwire its pads`,
    };
  });
}

/** One placed library part's row in the parts panel. */
export interface PartPanelRow {
  index: number;
  /** The designator the author reads on the canvas — `R1`, `U2`. */
  tag: string;
  /** The part's own note, or its id when it has none, or the raw component id for an unknown part. */
  note: string;
  /** How many of the part's terminals are on a net, and how many it has. */
  wired: { on: number; pads: number; text: string; title: string };
  /** Nothing wired is the state worth marking, for the same reason an unassigned pad is marked. */
  unassigned: boolean;
  /** Both ways round: the canvas selection lights the row, and pressing the row selects on the canvas. */
  active: boolean;
  title: string;
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
 * No delete control is offered on purpose: removal goes through `removeSelected` into `reindexTerminals`,
 * and a second door into that path wants its own tests rather than riding along with a panel that
 * displays.
 */
export function buildPartRows(
  circuit: Circuit,
  selected: { kind: string; index: number } | null,
): PartPanelRow[] {
  const parts = circuit.parts ?? [];
  const tags = designators(parts);
  const stored = circuit.terminals ?? [];
  return parts.map((part, i) => {
    const comp = PART_BY_ID.get(part.component);
    const pads = comp ? terminals(comp.footprint).length : 0;
    const on = stored.filter((t) => t.part === i).length;
    const tag = tags[i] ?? `part ${i + 1}`;
    return {
      index: i,
      tag,
      note: comp ? comp.note || comp.id : part.component,
      wired: {
        on,
        pads,
        text: `${on}/${pads}`,
        title: `${on} of ${pads} pad${pads === 1 ? "" : "s"} on a net`,
      },
      unassigned: pads > 0 && on === 0,
      active: selected?.kind === "part" && selected.index === i,
      title: `${tag} — ${comp?.note || part.component}`,
    };
  });
}

/** The header count above the parts list. */
export function partsTally(circuit: Circuit): { text: string; title: string } {
  const n = (circuit.parts ?? []).length;
  return { text: String(n), title: `${n} part${n === 1 ? "" : "s"} placed` };
}

/** One pad row under the selected part. */
export interface PadPanelRow {
  pad: string;
  /** The name of the net it is on, or `""` when it is on nothing. */
  netName: string;
  /** That net's colour, or null when the pad is on nothing — the dot is held at zero size instead. */
  colour: string | null;
  padTitle: string;
  /** The last row closes the guide line, exactly as a file tree closes a branch. */
  last: boolean;
}

/** Everything the pads panel needs, or null when there is nothing to show it for. */
export interface PadPanel {
  /** Which part these pads belong to, as the panel heading reads it. */
  heading: string;
  /** The declared net names, for the shared datalist. */
  suggestions: string[];
  rows: PadPanelRow[];
}

/**
 * The selected part's pads, each with the net it is on.
 *
 * Only a library part has pads to offer: an LED straddles a hinge with its polarity decided by the
 * router, and the two legacy lists carry no component id to read a footprint from. Null for all of them
 * — the panel is hidden rather than showing an empty row, which would read as "this part has no pads".
 *
 * The names come from `terminals(fp)` — the same reading the renderer and the router use — so a
 * mounting peg is never offered as something to wire.
 *
 * Null too for a selection that no longer indexes a part: deleting the selected part leaves the index
 * behind for one render, and a panel that read off it would show another part's pads under the old name.
 */
export function buildPadRows(
  circuit: Circuit,
  selected: { kind: string; index: number } | null,
): PadPanel | null {
  const part = selected?.kind === "part" ? (circuit.parts ?? [])[selected.index] : undefined;
  const comp = part ? PART_BY_ID.get(part.component) : undefined;
  if (!selected || !part || !comp) return null;
  const nets = circuit.nets ?? [];
  const stored = circuit.terminals ?? [];
  const pads = terminals(comp.footprint);
  return {
    heading: `${comp.id} pads`,
    suggestions: nets.map((n) => n.name),
    rows: pads.map(([padName], i) => {
      const on = stored.find((t) => t.part === selected.index && t.pad === padName)?.net ?? "";
      const at = nets.findIndex((n) => n.id === on);
      const net = at < 0 ? undefined : nets[at]!;
      return {
        pad: padName,
        netName: net?.name ?? "",
        // The net's own colour, so a glance down the column groups the pads without reading a word of
        // it. Null when the pad is on nothing, so the names stay aligned rather than shifting.
        colour: net ? netColour(net, at) : null,
        padTitle: `Pad ${padName}`,
        last: i === pads.length - 1,
      };
    }),
  };
}

/**
 * What is wrong with the netlist itself, as one sentence.
 *
 * Six kinds of fault are resolved and reported by `resolveNetlist`, carried out through `planRoutes` as
 * `netFaults` — and read by nothing until now. A pad on a net that no longer exists, or a pad wired to
 * two nets, simply did not route and said nothing about it.
 */
export function netlistTrouble(circuit: Circuit, routed: RoutedCircuit): string {
  // An UNWIRED net is not a fault. `resolveNetlist` reports "fewer than two terminals" for both a net
  // with one pad on it and a net with none, because for its purposes they are the same thing — neither
  // can be routed. For an author they are opposite: one pad on a net is a mistake worth pointing at, and
  // no pads is a net they have declared and not got to yet. A fresh circuit is seeded with PWR and GND,
  // so reporting the empty case would greet every new pattern with two faults it did not cause.
  const wired = new Set((circuit.terminals ?? []).map((t) => t.net));
  const faults = (routed.netFaults ?? []).filter(
    (f) => !(f.kind === "single-terminal-net" && f.net != null && !wired.has(f.net)),
  );
  const stranded = (routed.nets ?? []).reduce((a, n) => a + n.stranded.length, 0);
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

/**
 * Everything the status line is read off, as plain data.
 *
 * The counts the modal cannot get from the circuit alone are passed in rather than recomputed here:
 * `routedPartCount` is how many library parts the router actually placed (the circuit's own list
 * includes the ones that did not fit), and the wire fields are the {@link WireTool}'s live reading of
 * the wire under the hand, which exists nowhere on the circuit.
 */
export interface StatusInput {
  circuit: Circuit;
  routed: RoutedCircuit;
  /** `routedParts().length` — what the plan placed, not what the circuit holds. */
  routedPartCount: number;
  /** How many hand-drawn wires the circuit carries. */
  wireCount: number;
  /** Whether the wire tool has the canvas. Its hints only make sense while it does. */
  wiring: boolean;
  wireFaults: readonly { kind: string; why: string }[];
  wireDrawing: boolean;
  stale: boolean;
  autoRoute: boolean;
  /** Everything placed on a rail — what {@link placedCount} counts. */
  placedCount: number;
  selected: { kind: "led" | "part" | "resistor" | "switch"; index: number } | null;
  /** The selected item itself, or undefined when the index no longer names one. */
  picked: { flip?: boolean } | undefined;
}

/**
 * The whole status line, as one sentence.
 *
 * Assembled in one place because the clauses are ordered on purpose and the order is the message: the
 * counts come first, then what is wrong with the netlist, then whether the copper on screen is even
 * current, and only then the selection hint. A clause appended somewhere else would read as an
 * afterthought to whatever happened to precede it.
 */
export function statusLine(input: StatusInput): string {
  const { circuit, routed } = input;
  const n = circuit.leds.length;
  const batt = circuit.battery ? "battery set" : "no battery";
  let msg = `${n} LED${n === 1 ? "" : "s"} · ${batt}`;
  if (!circuit.battery && n > 0) msg += " · add a battery";
  // Two faults, said apart. An LED the copper cannot get to and an LED whose package will not sit on its
  // hinge were both reported as "unreachable", and they send the author to different places: one is
  // solved by moving the LED or bridging by hand, the other by a smaller package. On some patterns every
  // failure is the second kind — akde-square-pyramid loses 8 of 12 that way and none the other — so the
  // single word was wrong every time it appeared there.
  const unseated = (routed.unseated ?? []).length;
  const un = routed.unreachable.length - unseated;
  if (un > 0 && circuit.battery) msg += ` · ${un} unreachable`;
  if (unseated > 0) {
    msg += ` · ${unseated} ${unseated === 1 ? "LED does" : "LEDs do"} not fit on ${unseated === 1 ? "its" : "their"} hinge`;
  }
  // A part that would not fit is dropped by the router, and without this it disappeared without a word:
  // the click registered, the circuit kept it, and nothing appeared on the canvas.
  const short = [
    ["switch", (circuit.switches ?? []).length - routed.switches.length],
    ["resistor", (circuit.resistors ?? []).length - routed.resistors.length],
    ["part", (circuit.parts ?? []).length - input.routedPartCount],
  ] as const;
  for (const [what, missing] of short) {
    if (missing > 0) {
      msg += ` · ${missing} ${what}${missing === 1 ? "" : "s"} did not fit — that run is too short for the part`;
    }
  }
  // Hand-drawn copper, and what is wrong with the wire being drawn. The faults are the tool's own
  // reading, taken as each vertex is laid — a wire that cannot be built should say so while there is
  // still a hand on it, not once it is copper.
  const wires = input.wireCount;
  if (wires > 0) msg += ` · ${wires} hand wire${wires === 1 ? "" : "s"}`;
  if (input.wiring) {
    // An error and a warning are different things and must not read alike: an ERROR means the wire
    // cannot be cut, a WARNING means it can and will cost something — a weaker sheet, a harder weed, a
    // shorter fold life. The rule is `wire-rules.ts`'s, read rather than restated, so the line the
    // author sees agrees with `isBuildable` by construction.
    const faults = input.wireFaults;
    const bad = faults.filter((f) => ERRORS.has(f.kind as never));
    msg += bad.length
      ? ` · this wire cannot be cut: ${bad[0]!.why}`
      : faults.length
        ? ` · ${faults.length} warning${faults.length === 1 ? "" : "s"}, still cuttable: ${faults[0]!.why}`
        : input.wireDrawing
          ? " · tap to lay a point, tap the last one or press Enter to finish"
          : " · tap the pattern to start a wire";
  }
  msg += netlistTrouble(circuit, routed);
  // Ahead of the selection hint, because it is about the whole drawing rather than about one part: what
  // is on the canvas is copper for an earlier circuit, and every count above it was read off that plan.
  if (input.stale) msg += " · copper is out of date — press Route";
  else if (!input.autoRoute) msg += " · routing on request";
  const sel = input.selected;
  const picked = input.picked;
  if (sel && picked) {
    const what = sel.kind === "led"
      ? "LED"
      : sel.kind === "part"
        ? PART_BY_ID.get((circuit.parts ?? [])[sel.index]!.component)?.note ?? "Part"
        : sel.kind === "resistor" ? "Resistor" : "Switch";
    msg += ` · ${what} ${sel.index + 1} selected — R to turn it round, Delete to remove`;
    msg += picked.flip !== undefined
      ? " (orientation fixed — R again to let the router choose)"
      : " (router chooses)";
  } else if (n > 0 || input.placedCount > 0) {
    msg += " · click a component to select it";
  }
  return msg;
}
