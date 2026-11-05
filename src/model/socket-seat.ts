/**
 * **Model** — a plug-in board placed together with the socket it goes in (issue #36).
 *
 * There is no notion of one part sitting on another: a socket and its board are two ordinary placed
 * parts. What makes them a pair is only where they are. The socket goes where the author dropped the
 * board, and the board is moved so its pins land on the socket's contacts of the same numbers.
 *
 * Dropping both on the same point is not enough. Each footprint is anchored on its own pads (see
 * `electronics-parts.ts › placementOf`), and the socket's gull-wing contacts are not the board's
 * castellations, so the same point puts the XIAO board a whole pin pitch off its socket. Both parts get
 * the same angle, so their frames turn together and the offset between matching pins is one vector: the
 * difference of their mean positions over the pin names they share.
 */
import type { PlacedPart } from "./electronics.js";
import { footprintById } from "./library.js";
import { padPosition } from "./netlist.js";
import { mountingOf } from "./part-mounting.js";

/**
 * The parts to place for `part` with its socket: `[socket, board]`, the board moved onto the socket.
 * A part that needs no socket, or whose socket or footprint the library lacks, is returned alone.
 */
export function withSocket(part: PlacedPart, tapeW: number, tapeMm: number): PlacedPart[] {
  const m = mountingOf(part.component);
  const boardFp = footprintById(part.component);
  const socketFp = m.kind === "needs-socket" ? footprintById(m.socket) : undefined;
  if (m.kind !== "needs-socket" || !boardFp || !socketFp) return [part];
  const socket: PlacedPart = { ...part, component: m.socket };
  let dx = 0, dy = 0, shared = 0;
  for (const name of Object.keys(socketFp)) {
    const s = padPosition(socket, socketFp, name, tapeW, tapeMm);
    const b = padPosition(part, boardFp, name, tapeW, tapeMm);
    if (!s || !b) continue;
    dx += s.x - b.x;
    dy += s.y - b.y;
    shared++;
  }
  if (shared === 0) return [socket, part];
  return [socket, { ...part, x: part.x + dx / shared, y: part.y + dy / shared }];
}
