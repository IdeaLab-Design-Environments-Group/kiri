import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { installDom } from "./mock-dom.js";

/**
 * The small UI and accessibility leftovers from the UX review (issue #64), driven through the page.
 */

const css = readFileSync("src/styles.css", "utf8");

/** The body of the first CSS rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

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

function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const { x: clientX, y: clientY } = modal.tp(flat);
  modal.svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  modal.svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}

function q(modal: any, sel: string): any {
  return modal.overlay.querySelector(sel);
}

function click(modal: any, sel: string, pick?: (b: any) => boolean): void {
  const all = modal.overlay.querySelectorAll(sel);
  (pick ? all.find(pick) : all[0]).dispatch("click", {});
}

afterEach(() => {
  delete (globalThis as any).document;
  delete (globalThis as any).window;
  delete (globalThis as any).location;
});

describe("#64 the status line never changes the canvas height", () => {
  it("is laid out as one line that ellipsises, whatever its length", () => {
    const status = rule(".el-footer-row .el-status");
    expect(status).toMatch(/white-space:\s*nowrap/);
    expect(status).toMatch(/text-overflow:\s*ellipsis/);
    expect(status).toMatch(/overflow:\s*hidden/);
    expect(status).toMatch(/min-width:\s*0/);
    // The row it sits in must not wrap the status onto a second line either.
    expect(rule(".el-footer-row")).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("carries the whole sentence in its title, for every way the line is written", () => {
    const modal = openOn(grid(100));
    const status = q(modal, ".el-status");
    expect(status.title).toBe(status.textContent);
    // A tap away from every fold writes its own line straight onto the status element.
    tapFlat(modal, { x: 50, y: 50 });
    expect(status.textContent).toMatch(/fold/);
    expect(status.title).toBe(status.textContent);
    // And a long routed line, after an LED and a battery.
    tapFlat(modal, { x: 100, y: 50 });
    click(modal, ".el-tool", (b) => b.dataset.tool === "battery");
    tapFlat(modal, { x: 150, y: 150 });
    click(modal, ".el-route");
    expect(status.textContent.length).toBeGreaterThan(40);
    expect(status.title).toBe(status.textContent);
  });
});
