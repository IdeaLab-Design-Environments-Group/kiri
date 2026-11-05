/**
 * **Model** — which header or socket a library part needs, if any (issue #36).
 *
 * Read from what the library actually holds, not from a general idea of electronics. Almost every part
 * here is an SMD footprint whose pads solder straight onto the copper tape, so it stands on its own.
 * The exceptions are plug-in boards for which the library carries the matching female-header socket:
 * the Seeed XIAO boards and the Raspberry Pi Pico W. Those go in their socket, so the board can come
 * out again. ESP32/ESP8266 and radio modules are solder-down modules with no socket in the library, so
 * they stand on their own too; inventing a socket for them would offer a part that does not exist.
 *
 * Four classes:
 *   - `needs-socket` — a plug-in board, and the library id of the socket it goes in;
 *   - `socket`       — one of those sockets;
 *   - `connector`    — pin headers, pin sockets, JST headers, jacks, terminals, card holders: the
 *                      thing other parts or wires plug into, itself soldered on;
 *   - `standalone`   — everything else.
 *
 * {@link MODULE_SOCKETS} is the only hand-written pairing. Its tests walk the whole library, so a new
 * board or socket that reads like one but is not classified fails there.
 */

export type Mounting =
  | { kind: "needs-socket"; socket: string }
  | { kind: "socket"; family: string }
  | { kind: "connector" }
  | { kind: "standalone" };

/** Each plug-in board family in the library, and the socket footprint it goes in. */
const MODULE_SOCKETS: { family: string; boards: RegExp; socket: string }[] = [
  { family: "Seeed XIAO boards", boards: /^SeeedStudio_XIAO_/, socket: "Module_XIAO_Generic_SocketSMD" },
  { family: "Raspberry Pi Pico W", boards: /^RaspberryPi_PicoW_Combined$/, socket: "RaspberryPi_PicoW_SocketSMD" },
];

/** Ids of parts that are themselves the thing something plugs into. */
const CONNECTOR = /^(PinHeader_|PinSocket_|Header_|Conn_|TerminalBlock_|MicroSD_)|PWRJack/;

/** How the part with this id is mounted. An unknown id stands on its own. */
export function mountingOf(id: string): Mounting {
  for (const m of MODULE_SOCKETS) {
    if (id === m.socket) return { kind: "socket", family: m.family };
    if (m.boards.test(id)) return { kind: "needs-socket", socket: m.socket };
  }
  return CONNECTOR.test(id) ? { kind: "connector" } : { kind: "standalone" };
}

/** The short phrase shown beside a part in the library menu. */
export function mountingHint(m: Mounting): string {
  switch (m.kind) {
    case "needs-socket": return `goes in socket ${m.socket}`;
    case "socket": return `socket for ${m.family}`;
    case "connector": return "connector, mounts on its own";
    case "standalone": return "no header needed";
  }
}
