import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { foldHover, foldInReach } from "../../../src/view/placement-guide.js";
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
    expect(hint.textContent).toContain("Parts go");

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

describe("view/electronics-modal > a tap away from a fold (#58)", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).location;
  });

  /** The middle of tile 0, which on the big grid is out of every fold's reach. */
  const MID = { x: 50, y: 50 };

  it("lights the fold a tap would place on, and nothing when none is in reach", () => {
    const modal = openOn(grid(100));
    const gap = modal.gaps[0];
    hoverFlat(modal, { x: gap.point.x + 1, y: gap.point.y + 1 });
    expect(modal.liveLayer().innerHTML).toContain("el-fold-hover");

    hoverFlat(modal, MID);
    expect(modal.liveLayer().innerHTML).not.toContain("el-fold-hover");
  });

  it("lights nothing while a tool that does not seat on a fold is armed", () => {
    const modal = openOn(grid(100));
    toolBtn(modal, "battery").click();
    hoverFlat(modal, modal.gaps[0].point);
    expect(modal.liveLayer().innerHTML).not.toContain("el-fold-hover");

    toolBtn(modal, "led").click();
    seatBtn(modal, "free").click();
    hoverFlat(modal, modal.gaps[0].point);
    expect(modal.liveLayer().innerHTML).not.toContain("el-fold-hover");
  });

  it("says why a tap out of reach placed nothing, and points at Seat", () => {
    const modal = openOn(grid(100));
    tapFlat(modal, MID);
    expect(modal.circuit.leds).toHaveLength(0);
    expect(status(modal)).toContain("Tap closer to a fold to place an LED");
    expect(status(modal)).toContain("on a tile");
  });

  it("does not change what a tap places: still nothing on a tile, still an LED on a fold", () => {
    const modal = openOn(grid(100));
    tapFlat(modal, MID);
    expect(modal.circuit.parts ?? []).toHaveLength(0);
    tapFlat(modal, modal.gaps[0].point);
    expect(modal.circuit.leds).toHaveLength(1);
    expect(status(modal)).not.toContain("Tap closer");
  });

  it("lights exactly the folds a tap would seat on, out to the edge of reach", () => {
    // The highlight and the tap read one rule, so "lit" and "would place" agree point for point.
    const modal = openOn(grid(100));
    const gap = modal.gaps[0];
    const reach = modal.pickRadius();
    const dir = gap.ends[0].x === gap.ends[1].x ? { x: 1, y: 0 } : { x: 0, y: 1 }; // across the hinge
    const at = (d: number) => ({ x: gap.point.x + dir.x * d, y: gap.point.y + dir.y * d });
    for (const [d, lit] of [[reach * 0.99, true], [reach * 1.01, false]] as const) {
      expect(foldInReach(modal.gaps, at(d), reach) !== null, `at ${d}`).toBe(lit);
      expect(foldHover(modal.gaps, at(d), reach, (p) => p) !== "", `at ${d}`).toBe(lit);
    }
    expect(foldInReach([], gap.point, reach), "no folds at all").toBeNull();
    tapFlat(modal, at(reach * 1.01));
    expect(modal.circuit.leds).toHaveLength(0);
    tapFlat(modal, at(reach * 0.99));
    expect(modal.circuit.leds).toHaveLength(1);
  });

  it("takes the highlight down when the pointer leaves the canvas", () => {
    const modal = openOn(grid(100));
    hoverFlat(modal, modal.gaps[0].point);
    expect(modal.liveLayer().innerHTML).toContain("el-fold-hover");
    modal.svg.dispatch("pointerleave", {});
    expect(modal.liveLayer().innerHTML).toBe("");
  });
});
