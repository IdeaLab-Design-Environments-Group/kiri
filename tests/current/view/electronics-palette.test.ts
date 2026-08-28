import { describe, expect, it } from "vitest";
import { LIBRARY } from "../../../src/model/library.js";
import {
  DEFAULT_LED,
  OFFERED,
  PART_BY_ID,
  UNSHELVED,
  ledPart,
  matches,
  paletteCount,
  shelfFor,
} from "../../../src/view/electronics-palette.js";

describe("electronics palette", () => {
  const shelved = LIBRARY.map((c) => ({ id: c.id, shelf: shelfFor(c.id) }));

  it("leaves nothing from the library on the catch-all shelf", () => {
    const stray = shelved.filter((s) => s.shelf === UNSHELVED).map((s) => s.id);
    expect(stray, `${stray.length} parts have no named shelf`).toEqual([]);
  });

  it("keeps every shelf small enough to scan", () => {
    const size = new Map<string, number>();
    for (const s of shelved) size.set(s.shelf, (size.get(s.shelf) ?? 0) + 1);
    const worst = [...size].sort((a, b) => b[1] - a[1])[0]!;
    expect(worst[1], `"${worst[0]}" holds ${worst[1]} parts`).toBeLessThanOrEqual(30);
    expect(size.size, "the library should fill most shelves").toBeGreaterThanOrEqual(10);
  });

  it("shelves a part by function before package shape", () => {
    expect(shelfFor("Multiplexer_8_1_Texas_CD74HC4051M96_SOIC_16")).toBe("Analog & logic ICs");
    expect(shelfFor("MotorDriver_BipolarStepper_Trinamic_TMC2226_HTSSOP_28_EP")).toBe("Motor drivers");
    expect(shelfFor("SOIC_8_3_9x4_9mm_P1_27mm")).toBe("IC packages");
    expect(shelfFor("SOT_23_5")).toBe("Diodes & transistors");
    expect(shelfFor("TSOT_23_5")).toBe("IC packages");
    expect(shelfFor("Fnord_Widget_9000")).toBe(UNSHELVED);
  });

  it("resolves saved LED ids and falls back for old or stale ids", () => {
    expect(DEFAULT_LED.id).toBe("LED_1206");
    expect(ledPart({ a: 0, b: 1 }).id).toBe("LED_1206");
    expect(ledPart({ a: 0, b: 1, component: "LED_0603" }).id).toBe("LED_0603");
    expect(ledPart({ a: 0, b: 1, component: "missing" }).id).toBe("LED_1206");
  });

  it("filters by id or note and reports counts without DOM", () => {
    const usb = PART_BY_ID.get("Conn_USB_C_Socket_Molex_2171790001")!;
    expect(matches(usb, ["usb", "molex"])).toBe(true);
    expect(matches(usb, ["definitely-not-present"])).toBe(false);
    expect(paletteCount(false, OFFERED.length, 0)).toBe(`${OFFERED.length} parts`);
    expect(paletteCount(true, 1, 0)).toBe("1 match");
  });
});
