import { describe, expect, it } from "vitest";
import { LIBRARY, componentById } from "../../../src/model/library.js";
import { mountingHint, mountingOf } from "../../../src/model/part-mounting.js";

/**
 * Which header or socket a part needs (issue #36).
 *
 * The library only holds two sockets that a specific other part plugs into, so the rule is small. What
 * these tests guard is that it stays tied to the library: every socket it names exists, every module
 * family it names has members, and a new part lands in a class rather than falling through unnoticed.
 */
describe("model/part-mounting", () => {
  const classes = LIBRARY.map((c) => ({ id: c.id, m: mountingOf(c.id) }));
  const ofKind = (kind: string) => classes.filter((x) => x.m.kind === kind).map((x) => x.id);

  it("puts a XIAO board in the XIAO socket and a Pico W in the Pico W socket", () => {
    for (const id of ["SeeedStudio_XIAO_ESP32C3", "SeeedStudio_XIAO_ESP32S3", "SeeedStudio_XIAO_RP2040", "SeeedStudio_XIAO_SAMD21"]) {
      expect(mountingOf(id)).toEqual({ kind: "needs-socket", socket: "Module_XIAO_Generic_SocketSMD" });
    }
    expect(mountingOf("RaspberryPi_PicoW_Combined"))
      .toEqual({ kind: "needs-socket", socket: "RaspberryPi_PicoW_SocketSMD" });
  });

  it("names every socket it asks for, and that socket is in the library", () => {
    for (const { id, m } of classes) {
      if (m.kind !== "needs-socket") continue;
      expect(componentById(m.socket), `${id} asks for missing ${m.socket}`).toBeDefined();
      expect(mountingOf(m.socket).kind, `${m.socket} is not classed as a socket`).toBe("socket");
    }
  });

  it("gives each socket at least one part from the library that goes in it", () => {
    for (const socket of ofKind("socket")) {
      const takers = classes.filter((x) => x.m.kind === "needs-socket" && x.m.socket === socket);
      expect(takers.length, `${socket} holds nothing in the library`).toBeGreaterThan(0);
    }
  });

  it("only seats a module in a socket with no more pads than the module has", () => {
    // A cheap check that the table pairs the right things: the female header has one pad per module pin,
    // and every module footprint here has at least those (its castellations, plus pads underneath).
    for (const { id, m } of classes) {
      if (m.kind !== "needs-socket") continue;
      const own = Object.keys(componentById(id)!.footprint).length;
      const socket = Object.keys(componentById(m.socket)!.footprint).length;
      expect(socket, `${m.socket} has more pads than ${id}`).toBeLessThanOrEqual(own);
    }
  });

  it("classes headers, sockets and connectors as connectors", () => {
    for (const id of [
      "PinHeader_01x02_P2_54mm_Horizontal_SMD", "PinSocket_01x03_P2_54mm_Vertical_SMD",
      "Header_JST_PH_1x02_P2mm_Vertical_SMD", "Conn_USB_C_Socket_Molex_2171790001",
      "TerminalBlock_1pos_Metz_SM99S01VBNN05G7", "MicroSD_Amphenol_114_00841_68",
      "CUIDevices_PJ_002AH_SMT_TR_PWRJack_2x5_5mm",
    ]) {
      expect(mountingOf(id).kind, id).toBe("connector");
    }
  });

  it("leaves SMD parts and solder-down modules standing on their own", () => {
    for (const id of ["R_1206", "LED_0603", "SOT_23_3", "ESP32_WROOM_32E", "Module_Wio_SX1262", "BAT_COIN_20"]) {
      expect(mountingOf(id).kind, id).toBe("standalone");
    }
  });

  it("never calls a part standalone when its name says it is a header, socket, connector or plug-in board", () => {
    // The walk that keeps a newly generated part honest: if its id reads like one of these, the
    // classifier has to have put it somewhere other than "stands on its own".
    const suspect = /PinHeader|PinSocket|Header_|^Conn_|Socket|TerminalBlock|XIAO|Pico/;
    const missed = classes.filter((x) => suspect.test(x.id) && x.m.kind === "standalone").map((x) => x.id);
    expect(missed).toEqual([]);
  });

  it("treats an unknown id as standing on its own", () => {
    expect(mountingOf("")).toEqual({ kind: "standalone" });
    expect(mountingOf("NoSuchPart")).toEqual({ kind: "standalone" });
  });

  it("splits the 129-part library into the four classes", () => {
    expect(classes.length).toBe(129);
    expect(ofKind("needs-socket").length).toBe(5);
    expect(ofKind("socket").length).toBe(2);
    expect(ofKind("connector").length).toBe(43);
    expect(ofKind("standalone").length).toBe(79);
  });

  it("says in words what each class needs", () => {
    expect(mountingHint(mountingOf("SeeedStudio_XIAO_RP2040"))).toBe("goes in socket Module_XIAO_Generic_SocketSMD");
    expect(mountingHint(mountingOf("RaspberryPi_PicoW_SocketSMD"))).toBe("socket for Raspberry Pi Pico W");
    expect(mountingHint(mountingOf("Module_XIAO_Generic_SocketSMD"))).toBe("socket for Seeed XIAO boards");
    expect(mountingHint(mountingOf("PinHeader_01x02_P2_54mm_Horizontal_SMD"))).toBe("connector, mounts on its own");
    expect(mountingHint(mountingOf("R_1206"))).toBe("no header needed");
  });
});
