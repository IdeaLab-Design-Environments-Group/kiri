/**
 * **Model** — pure commands for editing an electronics {@link Circuit}.
 *
 * The electronics page owns gestures and DOM. It should not also own the rules
 * for preserving circuit fields, reindexing terminals, or cycling orientation.
 * Commands keep those mutations small, named, and testable while staying in the
 * model layer.
 */
import {
  BATTERY_GND_PAD,
  BATTERY_PART,
  BATTERY_PWR_PAD,
  type Circuit,
  type Led,
  type Net,
  type PartFlip,
  type PlacedPart,
  type Resistor,
  type Switch,
  type Terminal,
} from "./electronics.js";
import { GND_NET_ID, PWR_NET_ID } from "./net-palette.js";
import type { ManualWire, WireVertex } from "./manual-wire.js";
import type { ManualJump } from "./manual-jump.js";

export interface CircuitCommand {
  apply(circuit: Circuit): Circuit;
}

export type PartListKind = "part" | "resistor" | "switch";

export interface PartSelection {
  kind: PartListKind;
  index: number;
}

export function editCircuit(circuit: Circuit, command: CircuitCommand): Circuit {
  return command.apply(circuit);
}

export function replaceCircuit(next: Circuit): CircuitCommand {
  return { apply: () => next };
}

export function clearPlacedCircuit(keepNets: Net[]): CircuitCommand {
  return { apply: () => ({ leds: [], battery: null, nets: keepNets, terminals: [] }) };
}

export function appendLed(led: Led): CircuitCommand {
  return { apply: (c) => ({ ...c, leds: [...c.leds, led] }) };
}

export function appendPlacedPart(part: PlacedPart): CircuitCommand {
  return { apply: (c) => ({ ...c, parts: [...(c.parts ?? []), part] }) };
}

export function appendLegacyPart(kind: Exclude<PartListKind, "part">, point: Resistor | Switch): CircuitCommand {
  const field = fieldFor(kind);
  return { apply: (c) => ({ ...c, [field]: [...legacyItems(c, kind), point] }) };
}

/**
 * Put the battery on this face, or take it off the face it is already on.
 *
 * Its two terminals come and go with it. They are seeded on PWR and GND, which is not a guess about the
 * author's circuit the way a placed part's pads would be: a battery's `+` IS the PWR rail and its `−` IS
 * GND — that is what the bus router does with it, and what the sheet draws. Storing them is what puts the
 * battery in the parts list with pads the author can read, and re-point, like any other part's.
 *
 * Seeded only into a circuit that has declared those two nets. A file from before the netlist existed has
 * no `nets` at all, and a terminal naming a net that is not there is a fault, not a wiring.
 */
export function toggleBattery(face: number): CircuitCommand {
  return {
    apply: (c) => {
      const off = c.battery?.face === face;
      const others = (c.terminals ?? []).filter((t) => t.part !== BATTERY_PART);
      const declared = new Set((c.nets ?? []).map((n) => n.id));
      const seeded = declared.has(PWR_NET_ID) && declared.has(GND_NET_ID)
        ? [
          { part: BATTERY_PART, pad: BATTERY_PWR_PAD, net: PWR_NET_ID },
          { part: BATTERY_PART, pad: BATTERY_GND_PAD, net: GND_NET_ID },
        ]
        : [];
      return {
        ...c,
        battery: off ? null : { face },
        terminals: off ? others : [...others, ...seeded],
      };
    },
  };
}

export function addNet(net: Net): CircuitCommand {
  return { apply: (c) => ({ ...c, nets: [...(c.nets ?? []), net] }) };
}

export function renameNet(id: string, name: string): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      nets: (c.nets ?? []).map((n) => (n.id === id ? { ...n, name } : n)),
    }),
  };
}

export function recolourNet(id: string, color: string): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      nets: (c.nets ?? []).map((n) => (n.id === id ? { ...n, color } : n)),
    }),
  };
}

export function deleteNet(id: string): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      nets: (c.nets ?? []).filter((n) => n.id !== id),
      terminals: (c.terminals ?? []).filter((t) => t.net !== id),
    }),
  };
}

export function assignPad(part: number, pad: string, net: string): CircuitCommand {
  return {
    apply: (c) => {
      const rest = (c.terminals ?? []).filter((t) => !(t.part === part && t.pad === pad));
      return { ...c, terminals: net ? [...rest, { part, pad, net }] : rest };
    },
  };
}

export function removeSelectedPart(sel: PartSelection): CircuitCommand {
  return {
    apply: (c) => {
      if (sel.kind === "part") {
        if (!(c.parts ?? [])[sel.index]) return c;
        return {
          ...c,
          parts: (c.parts ?? []).filter((_, i) => i !== sel.index),
          terminals: reindexTerminals(c.terminals ?? [], sel.index),
          jumps: reindexJumps(c.jumps ?? [], sel.index),
        };
      }
      const field = fieldFor(sel.kind);
      const items = legacyItems(c, sel.kind);
      if (!items[sel.index]) return c;
      return { ...c, [field]: items.filter((_, i) => i !== sel.index) };
    },
  };
}

export function removeLed(index: number): CircuitCommand {
  return {
    apply: (c) => c.leds[index] ? { ...c, leds: c.leds.filter((_, i) => i !== index) } : c,
  };
}

export function movePlacedPart(index: number, dx: number, dy: number): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      parts: (c.parts ?? []).map((p, i) =>
        i === index ? { ...p, x: p.x + dx, y: p.y + dy } : p),
    }),
  };
}

export function rotateFreePart(index: number, degrees = 90): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      parts: (c.parts ?? []).map((p, i) =>
        i === index ? { ...p, rot: (((p.rot ?? 0) + degrees) % 360 + 360) % 360 } : p),
    }),
  };
}

export function cycleLedFlip(index: number, plannedFlip: boolean): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      leds: c.leds.map((led, i) => {
        if (i !== index) return led;
        return withCycledFlip(led, plannedFlip);
      }),
    }),
  };
}

export function cyclePartFlip(sel: PartSelection, plannedFlip: boolean): CircuitCommand {
  return {
    apply: (c) => {
      const field = fieldFor(sel.kind);
      const items = itemsFor(c, sel.kind);
      return {
        ...c,
        [field]: items.map((item, i) => (i === sel.index ? withCycledFlip(item, plannedFlip) : item)),
      };
    },
  };
}

export function appendJump(jump: ManualJump): CircuitCommand {
  return { apply: (c) => ({ ...c, jumps: [...(c.jumps ?? []), jump] }) };
}

export function removeJump(id: string): CircuitCommand {
  return { apply: (c) => ({ ...c, jumps: (c.jumps ?? []).filter((j) => j.id !== id) }) };
}

/** Re-anchor one end of a jump. The other end, and the net, are left exactly as they were. */
export function moveJumpEnd(id: string, end: "a" | "b", v: WireVertex): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      jumps: (c.jumps ?? []).map((j) => (j.id === id ? { ...j, [end]: { ...v } } : j)),
    }),
  };
}

/** Put a jump on a net, or take it off one — an empty id clears the field back to the id fallback. */
export function renetJump(id: string, net: string): CircuitCommand {
  return {
    apply: (c) => ({
      ...c,
      jumps: (c.jumps ?? []).map((j) => {
        if (j.id !== id) return j;
        if (!net) { const { net: _drop, ...rest } = j; return rest; }
        return { ...j, net };
      }),
    }),
  };
}

export function cloneCircuit(c: Circuit): Circuit {
  const { leds, battery, resistors, switches, parts, nets, terminals, wires, jumps, ...rest } = c;
  return {
    ...rest,
    leds: leds.map((l) => ({
      a: l.a,
      b: l.b,
      ...(l.flip === undefined ? {} : { flip: l.flip }),
      ...(l.component === undefined ? {} : { component: l.component }),
    })),
    battery: battery ? { face: battery.face } : null,
    resistors: (resistors ?? []).map(withFlip),
    switches: (switches ?? []).map(withFlip),
    parts: (parts ?? []).map(clonePlacedPart),
    nets: (nets ?? []).map((n) => (n.color === undefined
      ? { id: n.id, name: n.name }
      : { id: n.id, name: n.name, color: n.color })),
    terminals: (terminals ?? []).map((t) => ({ part: t.part, pad: t.pad, net: t.net })),
    wires: (wires ?? []).map(cloneWire),
    jumps: (jumps ?? []).map(cloneJump),
  };
}

/**
 * What becomes of the jumps when the part at `removed` is deleted.
 *
 * A jump anchored to that part is **deleted with it**, which is the opposite of what a drawn wire does. A
 * wire keeps its dangling vertex so the author can re-attach it, and the stretch that survives still draws;
 * a jump has exactly two ends and no middle, so one end short it is not a connection, draws as nothing, and
 * offers the author nothing to grab in order to re-attach it. Keeping it would only leave invisible entries
 * in the circuit that the next export has to filter out again. Jumps anchored elsewhere are kept, with pad
 * references above the hole shifted down, exactly as {@link reindexTerminals} shifts terminals.
 */
export function reindexJumps(jumps: ManualJump[], removed: number): ManualJump[] {
  const onRemoved = (v: WireVertex): boolean => v.kind === "pad" && v.part === removed;
  const shift = (v: WireVertex): WireVertex =>
    v.kind === "pad" && v.part > removed ? { ...v, part: v.part - 1 } : v;
  return jumps
    .filter((j) => !onRemoved(j.a) && !onRemoved(j.b))
    .map((j) => ({ ...j, a: shift(j.a), b: shift(j.b) }));
}

export function reindexTerminals(terminals: Terminal[], removed: number): Terminal[] {
  return terminals
    .filter((t) => t.part !== removed)
    .map((t) => (t.part > removed ? { ...t, part: t.part - 1 } : t));
}

function fieldFor(kind: PartListKind): "parts" | "resistors" | "switches" {
  if (kind === "part") return "parts";
  return kind === "switch" ? "switches" : "resistors";
}

function itemsFor(c: Circuit, kind: PartListKind): (PlacedPart | Resistor | Switch)[] {
  if (kind === "part") return c.parts ?? [];
  return legacyItems(c, kind);
}

function legacyItems(c: Circuit, kind: Exclude<PartListKind, "part">): (Resistor | Switch)[] {
  return kind === "switch" ? c.switches ?? [] : c.resistors ?? [];
}

function withCycledFlip<T extends { flip?: PartFlip }>(item: T, plannedFlip: boolean): T {
  if (item.flip !== undefined) {
    const { flip: _drop, ...rest } = item;
    return rest as T;
  }
  return { ...item, flip: !plannedFlip };
}

function withFlip<T extends { x: number; y: number; flip?: PartFlip }>(p: T): T {
  return p.flip === undefined ? { x: p.x, y: p.y } as T : { x: p.x, y: p.y, flip: p.flip } as T;
}

function clonePlacedPart(p: PlacedPart): PlacedPart {
  return {
    component: p.component,
    x: p.x,
    y: p.y,
    ...(p.flip === undefined ? {} : { flip: p.flip }),
    ...(p.free ? { free: true } : {}),
    ...(p.rot === undefined ? {} : { rot: p.rot }),
  };
}

function cloneJump(j: ManualJump): ManualJump {
  const out: ManualJump = { id: j.id, a: { ...j.a }, b: { ...j.b } };
  if (j.net !== undefined) out.net = j.net;
  return out;
}

function cloneWire(w: ManualWire): ManualWire {
  const out: ManualWire = { id: w.id, pts: w.pts.map((v) => ({ ...v })) };
  if (w.net !== undefined) out.net = w.net;
  if (w.width !== undefined) out.width = w.width;
  return out;
}
