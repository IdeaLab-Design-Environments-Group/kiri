/**
 * **View helper** — component palette catalog for the electronics page.
 *
 * This is deliberately DOM-free. The modal decides how to render a menu; this
 * module decides which library parts are offered, how they are shelved, and how
 * saved LED component ids resolve.
 */
import { netPlacement } from "../model/parts.js";
import { padAt, padNamed, type Footprint } from "../model/footprint.js";
import type { Component } from "../model/footprint.js";
import { BAT_COIN_20 } from "../model/library.js";
import { LIBRARY } from "../model/library.js";
import type { Led } from "../model/electronics.js";

const LED_IDS = ["LED_1206", "LED_0603"] as const;
const LED_PARTS: Component[] = LED_IDS.flatMap((id) => LIBRARY.filter((c) => c.id === id));
const LED_BY_ID = new Map(LED_PARTS.map((c) => [c.id, c]));

/** What an LED is when an older circuit does not name its component. */
export const DEFAULT_LED = LED_PARTS[0]!;

export function ledPart(led: Led): Component {
  return LED_BY_ID.get(led.component ?? "") ?? DEFAULT_LED;
}

export function ledPitch(fp: Footprint): number {
  try {
    return Math.abs(padAt(padNamed(fp, "2")).x - padAt(padNamed(fp, "1")).x);
  } catch {
    return 0;
  }
}

const FIXED_PLACEMENT = new Set<Footprint>([BAT_COIN_20]);

export const PART_GROUPS: { label: string; match: RegExp }[] = [
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

export const UNSHELVED = "Not yet shelved";

export function shelfFor(id: string): string {
  return PART_GROUPS.find((g) => g.match.test(id))!.label;
}

export const OFFERED: Component[] = [];
export const BLOCKED: { component: Component; why: string }[] = [];
export const PART_BY_ID = new Map<string, Component>();
export const GROUP_OF = new Map<string, string>();

export function admit(parts: readonly Component[]): void {
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

export function loadRestOfLibrary(): Promise<void> {
  return Promise.resolve();
}

export const BLOCKED_SHOWN = 12;

export function partLabel(c: Component): string {
  return c.note ? `${c.id} · ${c.note}` : c.id;
}

export function paletteCount(searching: boolean, shown: number, blocked: number): string {
  if (!searching) {
    const all = `${OFFERED.length} parts`;
    return blocked === 0 ? all : `${all} · ${BLOCKED.length} with no terminal to wire`;
  }
  const found = `${shown} match`;
  return blocked === 0 ? found : `${found} · ${blocked} with no terminal to wire`;
}

export function matches(c: Component, terms: string[]): boolean {
  const hay = `${c.id} ${c.note}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
