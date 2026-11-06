import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { installDom } from "./mock-dom.js";

/**
 * The editor's first step, and what a tap away from a fold does (issues #57 and #58).
 *
 * Driven through the page itself: the empty-state line on the canvas, the LED button in the Place group,
 * the fold lit under the pointer, and the status line after a tap that places nothing.
 */

/** A 2x2 grid of square faces `side` units wide: four tiles, hinges between neighbours. At side 1 the
 *  pick radius floors wider than the sheet, so every tap is "near a fold"; at 100 the middle of a tile is
 *  well out of reach. */
function grid(side: number): FoldFile {
  const s = side;
  return {
    vertices_coords: [
      [0, 0], [s, 0], [2 * s, 0],
      [0, s], [s, s], [2 * s, s],
      [0, 2 * s], [s, 2 * s], [2 * s, 2 * s],
    ],
    faces_vertices: [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [3, 4, 7, 6],
      [4, 5, 8, 7],
    ],
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

/** A tap at a flat-pattern point, through the modal's own flat-to-world transform. */
function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const { x: clientX, y: clientY } = modal.tp(flat);
  modal.svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  modal.svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}

/** The pointer passing over a flat-pattern point with no button down. */
function hoverFlat(modal: any, flat: { x: number; y: number }): void {
  const { x: clientX, y: clientY } = modal.tp(flat);
  modal.svg.dispatch("pointermove", { clientX, clientY, pointerId: 1 });
}

function toolBtn(modal: any, tool: string): any {
  return modal.overlay.querySelectorAll(".el-tool").find((b: any) => b.dataset.tool === tool);
}

function seatBtn(modal: any, place: "gap" | "free"): any {
  return modal.overlay.querySelectorAll(".el-place").find((b: any) => b.dataset.place === place);
}

function status(modal: any): string {
  return modal.overlay.querySelector(".el-status").textContent;
}

describe("view/electronics-modal > first step (#57)", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).location;
  });

  it("writes the first step on the canvas while nothing is placed, and takes it down after", () => {
    const modal = openOn(grid(1));
    const hint = modal.overlay.querySelector(".el-empty-hint");
    expect(hint, "no empty-state line on the canvas").toBeTruthy();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("Tap near a fold to place an LED");
    expect(hint.textContent).toContain("battery");
    // The control that decides where an LED can go is named where the rule is stated.
    expect(hint.textContent).toContain("Seat");

    tapFlat(modal, modal.gaps[0].point);
    expect(modal.circuit.leds).toHaveLength(1);
    expect(hint.hidden, "the first step stayed up after the first LED").toBe(true);
  });

  it("states the on-a-tile rule when Seat is set to on a tile", () => {
    const modal = openOn(grid(1));
    seatBtn(modal, "free").click();
    const hint = modal.overlay.querySelector(".el-empty-hint");
    expect(hint.textContent).toContain("Tap a tile to place an LED");
    expect(hint.textContent).not.toContain("near a fold to place");
  });

  it("says what each Seat choice does to an LED on the control itself", () => {
    const modal = openOn(grid(1));
    expect(seatBtn(modal, "gap").getAttribute("title")).toMatch(/LED/);
    expect(seatBtn(modal, "free").getAttribute("title")).toMatch(/LED/);
  });

  it("offers LED in the Place group, and pressing it arms the LED tool again", () => {
    const modal = openOn(grid(1));
    const led = toolBtn(modal, "led");
    expect(led, "no LED button in the Place group").toBeTruthy();
    expect(led.textContent).toBe("LED");
    // The LED tool is the default, so the button reads as armed before anything is touched.
    expect(led.classList.contains("is-active")).toBe(true);

    toolBtn(modal, "battery").click();
    expect(led.classList.contains("is-active")).toBe(false);
    led.click();
    expect(led.classList.contains("is-active")).toBe(true);
    expect(toolBtn(modal, "battery").classList.contains("is-active")).toBe(false);

    tapFlat(modal, modal.gaps[0].point);
    expect(modal.circuit.leds, "the LED button armed something that placed no LED").toHaveLength(1);
    expect(modal.circuit.battery).toBeFalsy();
  });
});
