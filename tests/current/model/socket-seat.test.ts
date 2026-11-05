import { describe, expect, it } from "vitest";
import { LIBRARY, footprintById } from "../../../src/model/library.js";
import type { PlacedPart } from "../../../src/model/electronics.js";
import { padPosition } from "../../../src/model/netlist.js";
import { mountingOf } from "../../../src/model/part-mounting.js";
import { withSocket } from "../../../src/model/socket-seat.js";

/**
 * A plug-in board placed with its socket (issue #36): the socket where the board was dropped, and the
 * board moved so each of its pins sits over the socket contact of the same number.
 */
describe("model/socket-seat", () => {
  const W = 0.05, MM = 5;
  const boards = LIBRARY.filter((c) => mountingOf(c.id).kind === "needs-socket").map((c) => c.id);

  /** For each pin the two share, the name of the socket contact nearest to the board's pin. */
  function nearestContacts(socket: PlacedPart, board: PlacedPart): [string, string][] {
    const sFp = footprintById(socket.component)!, bFp = footprintById(board.component)!;
    const contacts = Object.keys(sFp)
      .map((n) => ({ n, at: padPosition(socket, sFp, n, W, MM) }))
      .filter((c) => c.at !== null);
    const out: [string, string][] = [];
    for (const { n } of contacts) {
      const at = padPosition(board, bFp, n, W, MM);
      if (!at) continue;
      let best = contacts[0]!;
      for (const c of contacts) {
        if (Math.hypot(c.at!.x - at.x, c.at!.y - at.y) < Math.hypot(best.at!.x - at.x, best.at!.y - at.y)) best = c;
      }
      out.push([n, best.n]);
    }
    return out;
  }

  it("covers both board families", () => {
    expect(boards).toContain("SeeedStudio_XIAO_RP2040");
    expect(boards).toContain("RaspberryPi_PicoW_Combined");
  });

  for (const rot of [0, 90, 33]) {
    it(`puts every board pin over the socket contact of the same number at ${rot} degrees`, () => {
      for (const id of boards) {
        const placed = withSocket({ component: id, x: 1, y: 1, free: true, rot }, W, MM);
        expect(placed).toHaveLength(2);
        const [socket, board] = placed as [PlacedPart, PlacedPart];
        expect(socket.component).toBe((mountingOf(id) as { socket: string }).socket);
        expect(board.component).toBe(id);
        // The socket is where the author dropped the board, at the same angle and still free.
        expect(socket).toMatchObject({ x: 1, y: 1, free: true, rot });
        expect(board).toMatchObject({ free: true, rot });
        const pairs = nearestContacts(socket, board);
        expect(pairs.length, `${id} shares no pins with its socket`).toBeGreaterThanOrEqual(14);
        for (const [pin, over] of pairs) expect(over, `${id} pin ${pin}`).toBe(pin);
      }
    });
  }

  it("returns a part that needs no socket alone and unchanged", () => {
    for (const component of ["R_1206", "Module_XIAO_Generic_SocketSMD", "PinHeader_01x03_P2_54mm_Horizontal_SMD"]) {
      const part: PlacedPart = { component, x: 0.4, y: 0.7, free: true };
      expect(withSocket(part, W, MM)).toEqual([part]);
    }
  });

  it("returns an unknown part alone", () => {
    const part: PlacedPart = { component: "No_Such_Part", x: 0, y: 0, free: true };
    expect(withSocket(part, W, MM)).toEqual([part]);
  });
});
