import { afterEach, describe, expect, it } from "vitest";
import { ElectronicsModal } from "../../../src/view/electronics-modal.js";
import type { FoldFile } from "../../../src/model/fold-file.js";
import { installDom } from "./mock-dom.js";

/** A 2x2 grid of unit quads: four faces, hinges between neighbours. */
function grid2x2(): FoldFile {
  return {
    vertices_coords: [
      [0, 0], [1, 0], [2, 0],
      [0, 1], [1, 1], [2, 1],
      [0, 2], [1, 2], [2, 2],
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

/** Drive a tap at a flat-pattern point: the mock CTM is the identity, so world == client coords. */
function tapFlat(modal: any, flat: { x: number; y: number }): void {
  const svg = modal.svg;
  const b = modal.bounds;
  const MARGIN = 8;
  // Inverse of `clientToFlat`.
  const clientX = flat.x - b.minX + MARGIN;
  const clientY = b.maxY + MARGIN - flat.y;
  svg.dispatch("pointerdown", { button: 0, clientX, clientY, pointerId: 1 });
  svg.dispatch("pointerup", { button: 0, clientX, clientY, pointerId: 1 });
}

function openOn(fold: FoldFile): { modal: any; edits: unknown[] } {
  const { document } = installDom();
  const modal = new ElectronicsModal() as any;
  modal.mountTrigger(document.createElement("div") as unknown as HTMLElement);
  const edits: unknown[] = [];
  modal.onEdit((c: unknown) => edits.push(c));
  modal.setEnabled(true);
  modal.setPattern(fold);
  modal.open();
  return { modal, edits };
}

describe("view/electronics-modal", () => {
  afterEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it("draws a placed battery immediately, without the controller pushing anything back", () => {
    const { modal, edits } = openOn(grid2x2());
    const before = modal.svg.innerHTML;
    const base = edits.length; // open() emits once so the controller has the initial circuit

    modal.selectTool("battery");
    tapFlat(modal, { x: 0.5, y: 0.5 }); // inside face 0

    // The edit reached the controller...
    expect(edits).toHaveLength(base + 1);
    expect((edits[base] as any).battery).toEqual({ face: 0 });
    // ...and, the actual regression, it is on screen. Nothing re-renders the modal for us.
    expect(modal.svg.innerHTML).not.toBe(before);
    expect(modal.svg.innerHTML).toContain("el-batt-pwr");
    expect(modal.svg.innerHTML).toContain("el-batt-gnd");
  });

  it("draws a placed LED's two pads immediately", () => {
    const { modal, edits } = openOn(grid2x2());

    modal.selectTool("led");
    const base = edits.length;
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);

    expect(edits).toHaveLength(base + 1);
    expect((edits[base] as any).leds).toHaveLength(1);
    expect(modal.svg.innerHTML).toContain("el-led-pwr");
    expect(modal.svg.innerHTML).toContain("el-led-gnd");
  });

  it("removes the drawn component when the same spot is tapped again", () => {
    const { modal } = openOn(grid2x2());

    modal.selectTool("led");
    const gap = modal.gaps[0];
    tapFlat(modal, gap.point);
    expect(modal.svg.innerHTML).toContain("el-led-pwr");

    tapFlat(modal, gap.point);
    expect(modal.svg.innerHTML).not.toContain("el-led-pwr");
  });

  it("treats a drag as a pan, not a placement", () => {
    const { modal, edits } = openOn(grid2x2());
    modal.selectTool("battery");
    const base = edits.length;
    const svg = modal.svg;
    svg.dispatch("pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    svg.dispatch("pointermove", { button: 0, clientX: 90, clientY: 90, pointerId: 1 });
    svg.dispatch("pointerup", { button: 0, clientX: 90, clientY: 90, pointerId: 1 });
    expect(edits).toHaveLength(base); // no new edit: the drag panned
  });
});
