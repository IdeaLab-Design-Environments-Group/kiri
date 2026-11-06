import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { describeSpot } from "../../../src/view/canvas-cursor.js";
import { installDom } from "./mock-dom.js";

/**
 * The Electronics editor by keyboard alone (issue #64).
 *
 * Measured before: the canvas was not focusable at all, so a keyboard could arm a tool and do nothing with
 * it. Now Tab reaches the canvas, the arrow keys move a cursor over the pattern, and Enter or Space does
 * what a tap at the cursor would — place an LED on the fold it lights, put the battery on the tile under
 * it, lay a wire point.
 */

/** A 2x2 grid of square faces `side` units wide: four tiles, hinges between neighbours. */
function grid(side: number): FoldFile {
  const s = side;
  return {
    vertices_coords: [
      [0, 0], [s, 0], [2 * s, 0],
      [0, s], [s, s], [2 * s, s],
      [0, 2 * s], [s, 2 * s], [2 * s, 2 * s],
    ],
    faces_vertices: [[0, 1, 4, 3], [1, 2, 5, 4], [3, 4, 7, 6], [4, 5, 8, 7]],
    edges_vertices: [[1, 4], [3, 4], [4, 5], [4, 7]],
    edges_assignment: ["M", "M", "M", "M"],
  } as unknown as FoldFile;
}

function openOn(fold: FoldFile): any {
  const { document } = installDom();
  const modal = new ElectronicsModal() as any;
  modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
  modal.setEnabled(true);
  modal.setPattern(fold);
  modal.open();
  return modal;
}

/** A key pressed while the canvas has focus. */
function key(modal: any, k: string, shiftKey = false): void {
  (globalThis as any).document.dispatch("keydown", { key: k, shiftKey, target: modal.svg, preventDefault() {} });
}

/** Tab onto the canvas. */
function focusCanvas(modal: any): void {
  modal.svg.dispatch("focus", {});
}

/** Walk the cursor to a flat-pattern point with the arrow keys alone, and say where it ended up. */
function walkTo(modal: any, target: { x: number; y: number }): { x: number; y: number } {
  for (let i = 0; i < 400; i++) {
    const at = modal.cursorFlat();
    const w = modal.tp(at), t = modal.tp(target);
    const dx = t.x - w.x, dy = t.y - w.y;
    const step = modal.cursor.step();
    if (Math.abs(dx) <= step / 2 && Math.abs(dy) <= step / 2) return at;
    if (Math.abs(dx) > step / 2) key(modal, dx > 0 ? "ArrowRight" : "ArrowLeft");
    else key(modal, dy > 0 ? "ArrowDown" : "ArrowUp");
  }
  throw new Error("the cursor never got there");
}

function toolBtn(modal: any, tool: string): any {
  return modal.overlay.querySelectorAll(".el-tool").find((b: any) => b.dataset.tool === tool);
}

describe("view/canvas-cursor > describeSpot", () => {
  const spot = { tool: "led", mode: "gap" as const, onPart: null, onFold: false, onTile: true };
  it("says what Enter would do for each tool and seat", () => {
    expect(describeSpot({ ...spot, onFold: true })).toBe("On a fold. Enter places an LED across it.");
    expect(describeSpot(spot)).toMatch(/away from every fold/);
    expect(describeSpot({ ...spot, mode: "free" })).toBe("On a tile. Enter places an LED here.");
    expect(describeSpot({ ...spot, tool: "battery" })).toBe("On a tile. Enter puts the battery here.");
    expect(describeSpot({ ...spot, tool: "wire" })).toMatch(/Space lays a wire point/);
    expect(describeSpot({ ...spot, onPart: "LED 1", onFold: true })).toMatch(/^On LED 1\. Enter picks it up/);
  });
  it("says so when the cursor is off the sheet", () => {
    for (const tool of ["led", "battery", "wire", "R_1206"]) {
      expect(describeSpot({ ...spot, tool, onTile: false })).toMatch(/Off the sheet/);
    }
  });
});

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).location;
});

describe("view/electronics-modal > keyboard (#64)", () => {
  it("makes the canvas a Tab stop that says how to use it", () => {
    const modal = openOn(grid(100));
    expect(modal.svg.getAttribute("tabindex")).toBe("0");
    expect(modal.svg.getAttribute("role")).toBe("application");
    const help = modal.overlay.children.find((c: any) => c.attributes.id === modal.svg.getAttribute("aria-describedby"));
    expect(help?.textContent).toMatch(/arrow/i);
    expect(help?.textContent).toMatch(/Enter/);
  });

  it("shows a cursor on the pattern when the canvas takes focus, and the arrows move it", () => {
    const modal = openOn(grid(100));
    focusCanvas(modal);
    expect(modal.svg.querySelector(".el-cursor-mark"), "no cursor drawn").toBeTruthy();
    const start = modal.cursorFlat();
    key(modal, "ArrowRight");
    const right = modal.cursorFlat();
    expect(right.x).toBeGreaterThan(start.x);
    key(modal, "ArrowLeft");
    expect(modal.cursorFlat().x).toBeCloseTo(start.x, 9);
    // Shift takes bigger steps.
    key(modal, "ArrowRight", true);
    expect(modal.cursorFlat().x - start.x).toBeGreaterThan((right.x - start.x) * 4);
  });

  it("places an LED and a battery with the keyboard alone", () => {
    const modal = openOn(grid(100));
    focusCanvas(modal);
    // The LED tool is armed by default. Walk to the fold between the top two tiles and press Enter.
    walkTo(modal, modal.gaps[0].point);
    expect(modal.overlay.querySelector(".el-cursor-say").textContent).toMatch(/fold/i);
    key(modal, "Enter");
    expect(modal.circuit.leds, "Enter at a fold placed no LED").toHaveLength(1);

    // Pressing the battery button is a click, keyboard or not. Then to the middle of a tile, and Space.
    toolBtn(modal, "battery").dispatch("click", {});
    focusCanvas(modal);
    walkTo(modal, { x: 50, y: 150 });
    expect(modal.overlay.querySelector(".el-cursor-say").textContent).toMatch(/tile/i);
    key(modal, " ");
    expect(modal.circuit.battery, "Space on a tile placed no battery").toBeTruthy();
  });

  it("lets Escape put a selection down, and R and Delete still reach the selected part", () => {
    const modal = openOn(grid(100));
    focusCanvas(modal);
    walkTo(modal, modal.gaps[0].point);
    key(modal, "Enter");
    expect(modal.selected).toEqual({ kind: "led", index: 0 });
    key(modal, "Escape");
    expect(modal.selected).toBeNull();
    // Enter on the LED picks it up again, and Delete takes it off.
    key(modal, "Enter");
    expect(modal.selected).toEqual({ kind: "led", index: 0 });
    key(modal, "Delete");
    expect(modal.circuit.leds).toHaveLength(0);
  });

  it("draws a wire by keyboard: Space lays each point, Enter finishes", () => {
    const modal = openOn(grid(100));
    toolBtn(modal, "wire").dispatch("click", {});
    focusCanvas(modal);
    walkTo(modal, { x: 30, y: 30 });
    key(modal, " ");
    walkTo(modal, { x: 170, y: 30 });
    key(modal, " ");
    key(modal, "Enter");
    expect(modal.circuit.wires ?? [], "no wire was laid").toHaveLength(1);
  });

  it("leaves the arrow keys alone when the canvas does not have focus", () => {
    const modal = openOn(grid(100));
    focusCanvas(modal);
    const start = modal.cursorFlat();
    (globalThis as any).document.dispatch("keydown", { key: "ArrowRight", target: { tagName: "BUTTON" }, preventDefault() {} });
    expect(modal.cursorFlat()).toEqual(start);
    // And blurring the canvas takes the cursor off it.
    modal.svg.dispatch("blur", {});
    expect(modal.svg.querySelector(".el-cursor-mark")).toBeFalsy();
  });
});
